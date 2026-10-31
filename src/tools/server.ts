import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { MCP_HOME, type Config } from "../config.js";
import { generateServerConfig, validateAgainstSchema } from "../templates/server-config.js";
import { gameGuidMap } from "../pak/rdb.js";
import { baseReader } from "./config-override.js";
import { readGproj, resolveGproj } from "../workbench/cli.js";
import { forbiddenRoot } from "../utils/safe-path.js";
import { protectedAddonOf } from "../utils/game-paths.js";
import { findPids, killPids, spawnDetached, newestDir, sleep, serverProcesses, processInfo, isAlive, argValue } from "../utils/process.js";
import { INSTANCE_FILE, OWNER, scan, planStop, instanceTable, writeInstance, type Entry } from "../utils/instances.js";

const IS_WIN = process.platform === "win32";
const SERVER_APP_ID = "1874900"; // Arma Reforger Dedicated Server (anonymous login)
const SERVER_EXE = IS_WIN ? "ArmaReforgerServer.exe" : "ArmaReforgerServer";
const SERVER_DIAG_EXE = IS_WIN ? "ArmaReforgerServerDiag.exe" : "ArmaReforgerServerDiag";
const STEAMCMD_EXE = IS_WIN ? "steamcmd.exe" : "steamcmd.sh";
const STEAMCMD_URL = IS_WIN
  ? "https://steamcdn-media.akamaihd.net/client/installer/steamcmd.zip"
  : "https://steamcdn-media.akamaihd.net/client/installer/steamcmd_linux.tar.gz";

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });

/** Extract a .zip or .tar.gz with tar; paths go as arguments, never through a shell. */
export function unpack(archive: string, dir: string): void {
  // Windows 10+ ships bsdtar, which reads zip; a Git or MSYS tar earlier on PATH would not.
  const tar = IS_WIN ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
  execFileSync(tar, ["-xf", archive, "-C", dir], { windowsHide: true });
}

async function ensureSteamcmd(config: Config): Promise<string> {
  const exe = join(config.steamcmdPath, STEAMCMD_EXE);
  if (existsSync(exe)) return exe;
  mkdirSync(config.steamcmdPath, { recursive: true });
  const res = await fetch(STEAMCMD_URL);
  if (!res.ok) throw new Error(`Downloading SteamCMD failed: HTTP ${res.status}`);
  const archive = join(config.steamcmdPath, IS_WIN ? "steamcmd.zip" : "steamcmd.tar.gz");
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  unpack(archive, config.steamcmdPath);
  if (!existsSync(exe)) throw new Error(`SteamCMD archive did not contain ${STEAMCMD_EXE}`);
  return exe;
}

/** server.json schema shipped with the game data (backend/DSConfigSchema.json). */
function loadSchema(config: Config): Record<string, any> | null {
  const t = baseReader(config)("backend/DSConfigSchema.json");
  return t ? JSON.parse(t) : null;
}

export function serverLogsDir(config: Config): string {
  return join(config.serverProfilePath, "logs");
}

function tail(file: string, lines: number, filter?: RegExp): string {
  if (!existsSync(file)) return "(no log yet)";
  const all = readFileSync(file, "utf-8").split(/\r?\n/);
  return (filter ? all.filter((l) => filter.test(l)) : all).slice(-lines).join("\n");
}

export function listScenarios(config: Config): Array<{ id: string; name: string }> {
  const read = baseReader(config);
  const out: Array<{ id: string; name: string }> = [];
  for (const e of gameGuidMap(config.gamePath).values()) {
    if (!/^Missions\/[^/]+\.conf$/i.test(e.path)) continue;
    const t = read(e.path) ?? "";
    if (!/SCR_MissionHeader|MissionHeader/.test(t.slice(0, 300))) continue;
    out.push({ id: `{${e.guid}}${e.path}`, name: t.match(/m_sName\s+"([^"]+)"/)?.[1] ?? "" });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const sameDir = (a: string | undefined, b: string) => !!a && relative(resolve(a), resolve(b)) === "";

/**
 * Ask the server to close, wait graceSec, then kill that PID tree. The console server ignores the
 * close request (B-011), so in practice it ends forced after the grace time.
 */
async function stopServer(e: Entry, force: boolean, graceSec: number): Promise<{ method: string; seconds: number }> {
  const pid = e.proc.pid;
  const t0 = Date.now();
  const waitGone = async (ms: number) => {
    for (const end = Date.now() + ms; isAlive(pid) && Date.now() < end; ) await sleep(500);
    return !isAlive(pid);
  };
  let method: string;
  if (force) {
    killPids([pid], true, true);
    method = (await waitGone(10_000)) ? "forced (force=true)" : "still running";
  } else {
    killPids([pid], false, true);
    // Re-check identity before the kill: the PID may have been reused while we waited.
    const now = (await waitGone(graceSec * 1000)) ? undefined : processInfo(pid);
    if (!isAlive(pid)) method = "closed on request";
    // No row while the PID lives means the process query failed: keep the record, kill nothing on a guess.
    else if (!now) method = "still running";
    else if (now.created !== e.proc.created) method = "exited (PID reused)";
    else {
      killPids([pid], true, true);
      method = (await waitGone(10_000)) ? `forced after ${graceSec} s grace` : "still running";
    }
  }
  if (method !== "still running" && e.file) rmSync(e.file, { force: true });
  return { method, seconds: (Date.now() - t0) / 1000 };
}

export function registerServer(server: McpServer, config: Config): void {
  server.registerTool(
    "server",
    {
      description:
        "Run an Arma Reforger dedicated server locally for testing mods: 'install'/'update' (SteamCMD, anonymous, app 1874900; " +
        "downloads SteamCMD itself), 'config' (write server.json from options, validated against the game's own schema), " +
        "'validate' (check any server.json), 'start' (with local packed addons and/or Workshop mods), 'stop', 'status', " +
        "'logs' (tail / errors only), 'scenarios' (all scenario IDs of the game).",
      inputSchema: {
        action: z.enum(["install", "update", "config", "validate", "start", "stop", "status", "logs", "scenarios"]),
        configPath: z.string().optional().describe("(start/validate/config) server.json path. Default <serverProfilePath>/server.json. config/start replace only that default; any other path must not exist yet"),
        // config options
        name: z.string().optional().describe("(config/start) Server name"),
        scenarioId: z.string().optional().describe("(config/start) e.g. {ECC61978EDCC2B5A}Missions/23_Campaign.conf (see action scenarios)"),
        maxPlayers: z.number().int().min(1).max(256).optional(),
        port: z.number().int().optional().describe("UDP game port (default 2001)"),
        password: z.string().optional(),
        passwordAdmin: z.string().optional().describe("Admin login password (#login in chat)"),
        admins: z.array(z.string()).optional().describe("Admin identity IDs"),
        visible: z.boolean().optional().describe("List in the server browser (default false)"),
        crossPlatform: z.boolean().optional(),
        battlEye: z.boolean().optional(),
        workshopMods: z.array(z.object({ modId: z.string(), name: z.string().optional(), version: z.string().optional() })).optional()
          .describe("(config/start) Published Workshop mods to download and load"),
        rconPassword: z.string().optional().describe("Enable RCON with this password"),
        autoSaveInterval: z.number().optional().describe("Persistence autosave interval in minutes"),
        aiLimit: z.number().int().optional(),
        // start options
        addons: z.array(z.string()).optional()
          .describe("(start) Local addon folder names to load from their packed build (run `mod` build first)"),
        extraArgs: z.array(z.string()).optional().describe("(start) Extra server CLI args, e.g. ['-maxFPS','60']"),
        // stop/logs
        force: z.boolean().optional().describe("(stop) Kill at once instead of asking first. Still only servers this MCP started"),
        instance: z.string().optional().describe("(stop) Instance name; default all servers this MCP started (the single instance is 'default')"),
        graceSec: z.number().min(0).max(120).default(10).describe("(stop) Seconds to wait after the close request before killing"),
        adoptOrphans: z.boolean().optional().describe("(stop) Also stop servers left by an ended MCP session under this MCP's server profile"),
        lines: z.number().int().min(1).max(2000).default(80).describe("(logs) Lines to show"),
        errorsOnly: z.boolean().optional().describe("(logs) Only (E)/(W)/(F) lines"),
        filter: z.string().optional().describe("(scenarios/logs) Regex filter"),
      },
    },
    async (a) => {
      try {
        const exe = join(config.serverPath, SERVER_EXE);
        const defaultCfg = join(config.serverProfilePath, "server.json");
        const cfgPath = a.configPath ?? defaultCfg;

        if (a.action === "install" || a.action === "update") {
          // The Steam client owns installs under steamapps\common; SteamCMD validate would rewrite them behind its back.
          if (/[\\/]steamapps[\\/]common[\\/]/i.test(resolve(config.serverPath) + "/")) {
            return text(`Refused: ${config.serverPath} is a Steam client install. Update it from Steam, or set ENFUSION_SERVER_PATH to a folder of its own for SteamCMD, for example ${join(MCP_HOME, "server")}.`, true);
          }
          const steamcmd = await ensureSteamcmd(config);
          mkdirSync(config.serverPath, { recursive: true });
          const log = join(config.steamcmdPath, "install-server.log");
          writeFileSync(log, "");
          const pid = spawnDetached(steamcmd, ["+force_install_dir", config.serverPath, "+login", "anonymous", "+app_update", SERVER_APP_ID, "validate", "+quit"], config.steamcmdPath, log);
          return text(
            `**Server ${a.action} started** (SteamCMD pid ${pid}) → \`${config.serverPath}\`\n\n` +
            `The download is several GB and runs in the background. Follow it with \`server status\`; ` +
            `it is done when \`${SERVER_EXE}\` exists and the log says "Success! App '${SERVER_APP_ID}' fully installed".\nLog: ${log}`
          );
        }

        if (a.action === "scenarios") {
          const re = a.filter ? new RegExp(a.filter, "i") : null;
          const list = listScenarios(config).filter((s) => !re || re.test(s.id) || re.test(s.name));
          return text(`**${list.length} scenarios**\n\n${list.map((s) => `- \`${s.id}\`${s.name ? `: ${s.name}` : ""}`).join("\n")}`);
        }

        if (a.action === "validate") {
          if (!existsSync(cfgPath)) return text(`Not found: ${cfgPath}`, true);
          const schema = loadSchema(config);
          if (!schema) return text("Could not read backend/DSConfigSchema.json from the game data.", true);
          let json: unknown;
          try { json = JSON.parse(readFileSync(cfgPath, "utf-8")); } catch (e) { return text(`Invalid JSON: ${e}`, true); }
          const errs = validateAgainstSchema(json, schema);
          return text(errs.length ? `**${errs.length} problem(s)** in ${cfgPath}\n\n${errs.map((e) => `- ${e}`).join("\n")}` : `**Valid**: ${cfgPath} matches the server schema.`, errs.length > 0);
        }

        if (a.action === "config" || (a.action === "start" && (a.name || a.scenarioId || !existsSync(cfgPath)))) {
          const json = generateServerConfig({
            name: a.name ?? "Enfusion MCP test server",
            scenarioId: a.scenarioId, maxPlayers: a.maxPlayers, port: a.port, password: a.password,
            passwordAdmin: a.passwordAdmin, admins: a.admins, visible: a.visible, crossPlatform: a.crossPlatform,
            battlEye: a.battlEye, mods: a.workshopMods, rconPassword: a.rconPassword, autoSaveInterval: a.autoSaveInterval, aiLimit: a.aiLimit,
          });
          const schema = loadSchema(config);
          const errs = schema ? validateAgainstSchema(JSON.parse(json), schema) : [];
          if (errs.length) return text(`Generated config is invalid:\n${errs.map((e) => `- ${e}`).join("\n")}`, true);
          // Only the MCP's own server.json is replaced; any other path must be new and outside installs and caches.
          const own = sameDir(cfgPath, defaultCfg);
          const root = own ? null : forbiddenRoot(config, cfgPath);
          const prot = own ? null : protectedAddonOf(config, cfgPath);
          const refuse = own ? ""
            : existsSync(cfgPath) ? `${cfgPath} already exists and is not this MCP's server.json`
            : root ? `${cfgPath} is inside ${root}`
            : prot ? `${cfgPath} is inside the protected addon ${prot} (ENFUSION_PROTECTED_ADDONS)`
            : "";
          if (refuse) return text(`**server.json not written**: ${refuse}. Omit configPath or pass a new file path.\n\n\`\`\`json\n${json}\n\`\`\``, true);
          mkdirSync(join(cfgPath, ".."), { recursive: true });
          writeFileSync(cfgPath, json, "utf-8");
          if (a.action === "config") return text(`**server.json written** → \`${cfgPath}\`${schema ? " (schema-valid)" : ""}\n\n\`\`\`json\n${json}\n\`\`\``);
        }

        if (a.action === "start") {
          if (!existsSync(exe)) return text(`Dedicated server not installed at ${config.serverPath}. Run \`server install\` first (or set ENFUSION_SERVER_PATH).`, true);
          // Every MCP session defaults to the same profile folder, so a server there from any session would be clobbered.
          const busy = scan(serverProcesses()).filter((e) => e.cls === "own" || sameDir(argValue(e.proc.cmd, "-profile"), config.serverProfilePath));
          if (busy.length) return text(`A dedicated server using ${config.serverProfilePath} is already running (pid ${busy.map((e) => e.proc.pid).join(", ")}). Run \`server stop\` first.`, true);
          const args = ["-profile", config.serverProfilePath, "-maxFPS", "60", "-logStats", "60000", "-noThrow"];
          const guids: string[] = [];
          for (const name of a.addons ?? []) {
            const gproj = resolveGproj(config, name);
            const id = gproj ? readGproj(gproj).id || name : name;
            const packed = join(config.packedPath, id);
            if (!existsSync(join(packed, "data.pak"))) return text(`Addon "${name}" has no packed build in ${packed}. Run \`mod\` action build first.`, true);
            const g = readdirSync(packed).find((f) => f.endsWith(".gproj"));
            guids.push(readGproj(join(packed, g!)).guid);
          }
          let note = "";
          const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf-8")) : {};
          let port: number = cfg.bindPort ?? 2001;
          if (guids.length) {
            // The server refuses -addons together with -config, and mods listed in server.json must be on the
            // Workshop, so local builds start in -server mode (server.json settings other than scenario/port are not used).
            const scenario = a.scenarioId ?? cfg.game?.scenarioId;
            if (!scenario) return text("Local addons need a scenario: pass scenarioId (see `server scenarios`) or write one with `server config`.", true);
            port = a.port ?? port;
            // -bindPort is ignored without a config file; -addr sets the port, on loopback only.
            args.unshift("-server", scenario, "-addr", `127.0.0.1:${port}`);
            args.push("-addonsDir", config.packedPath, "-addons", guids.join(","));
            note = "\n\nStarted in -server mode because local addons cannot be loaded through -config. Only the scenario and port from server.json apply.";
          } else {
            args.unshift("-config", cfgPath);
          }
          args.push(...(a.extraArgs ?? []));
          mkdirSync(config.serverProfilePath, { recursive: true });
          const started = Date.now();
          // The Diag server matches the Diag client that `game launch` uses to connect (the server rejects a dev/retail mix).
          const diagExe = join(config.serverPath, SERVER_DIAG_EXE);
          const runExe = existsSync(diagExe) ? diagExe : exe;
          const pid = spawnDetached(runExe, args, config.serverPath);
          writeInstance(join(config.serverProfilePath, INSTANCE_FILE), {
            kind: "server", name: "default", pid, ownerPid: OWNER.pid, ownerStartedAt: OWNER.startedAt,
            startedAt: started, exe: runExe, port, profileDir: config.serverProfilePath,
          });
          await sleep(8000);
          const logDir = newestDir(serverLogsDir(config), started - 5000);
          const alive = isAlive(pid);
          return text(
            `**Server ${alive ? "running" : "exited early"}** (pid ${pid})\n\nCommand: ${basename(runExe)} ${args.join(" ")}\n` +
            (logDir ? `Logs: ${logDir}\n\n\`\`\`\n${tail(join(logDir, "console.log"), 25)}\n\`\`\`` : "") +
            `\n\nJoin from the game: \`game launch\` with connect=127.0.0.1:${port} (and the same local addons).${note}`,
            !alive
          );
        }

        if (a.action === "stop") {
          const entries = scan(serverProcesses());
          const plan = planStop(entries, { instance: a.instance, adoptOrphans: a.adoptOrphans, roots: [config.serverProfilePath] });
          const others = entries.filter((e) => !plan.stop.includes(e));
          const untouched = others.length
            ? `\nNot touched: ${others.length} server(s) not started by this MCP session (pid ${others.map((e) => e.proc.pid).join(", ")}).`
            : "";
          if (plan.error) return text(plan.error + untouched, true);
          if (!plan.stop.length) return text("No server started by this MCP is running." + untouched);
          const rows: string[] = [];
          let failed = 0;
          for (const e of plan.stop) {
            const r = await stopServer(e, a.force ?? false, a.graceSec);
            if (r.method === "still running") failed++;
            rows.push(`| ${e.inst!.name} | ${e.proc.pid} | ${e.cls} | ${r.method} | ${r.seconds.toFixed(1)} | ${newestDir(join(dirname(e.file!), "logs")) ?? ""} |`);
          }
          return text(
            `**Stopped ${rows.length - failed} of ${rows.length} server(s)**\n\n| instance | pid | class | method | seconds | log |\n|---|---|---|---|---|---|\n${rows.join("\n")}${untouched}`,
            failed > 0
          );
        }

        if (a.action === "status") {
          const entries = scan(serverProcesses());
          const logDir = newestDir(serverLogsDir(config));
          const installLog = join(config.steamcmdPath, "install-server.log");
          const installing = findPids(STEAMCMD_EXE).length > 0;
          return text([
            `**Dedicated server**`,
            `- Installed: ${existsSync(exe) ? `yes (${config.serverPath})` : "no: `server install`"}`,
            `- SteamCMD: ${installing ? "running (install/update in progress)" : existsSync(join(config.steamcmdPath, STEAMCMD_EXE)) ? "present" : "not downloaded"}`,
            `- Running: ${entries.length ? `${entries.length} server(s) on this PC, ${entries.filter((e) => e.cls === "own").length} started by this MCP` : "no"}`,
            `- Config: ${existsSync(cfgPath) ? cfgPath : "none yet (`server config`)"}`,
            `- Profile: ${config.serverProfilePath}`,
            logDir ? `- Latest log: ${logDir}` : "",
            existsSync(installLog) ? `\nInstall log (last lines):\n\`\`\`\n${tail(installLog, 8)}\n\`\`\`` : "",
            entries.length ? `\n${instanceTable(entries)}` : "",
          ].filter(Boolean).join("\n"));
        }

        if (a.action === "logs") {
          const logDir = newestDir(serverLogsDir(config));
          if (!logDir) return text(`No server logs in ${serverLogsDir(config)} yet.`, true);
          const re = a.errorsOnly ? /\((E|W|F)\)/ : a.filter ? new RegExp(a.filter, "i") : undefined;
          return text(`**${join(logDir, "console.log")}**\n\n\`\`\`\n${tail(join(logDir, "console.log"), a.lines, re)}\n\`\`\``);
        }

        return text(`Unknown action ${a.action}`, true);
      } catch (e) {
        return text(`server ${a.action} failed: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
  );
}
