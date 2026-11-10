import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { myGamesDir } from "../utils/game-paths.js";
import type { Config } from "../config.js";
import { readGproj, resolveGproj } from "../workbench/cli.js";
import { findPids, killPids, spawnDetached, newestDir, sleep, clientProcesses, isAlive, refusedArg, DISABLE_CRASH_REPORTER, NO_THROW } from "../utils/process.js";
import { runErrors } from "../utils/logwatch.js";
import { OWNER, pidInstanceFile, scan, planStop, instanceTable, writeInstance } from "../utils/instances.js";
import { procWatchLines } from "../watchdog/proc-watch.js";
import { isMissionHeader, watchStarted } from "./mission-server.js";

const GAME_EXE = "ArmaReforgerSteam.exe";
const GAME_DIAG_EXE = "ArmaReforgerSteamDiag.exe"; // needed for -client / -world
const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });

/**
 * The log folder a client started at `startedAt` (epoch ms) wrote in the shared logs root: the folder named `logs_YYYY-MM-DD_HH-MM-SS`
 * (local time) from 1 s before (names cut to the second) to 10 s after that start. The client has no profile of its own to find it by.
 */
export function clientLogDir(root: string, startedAt: number): string | undefined {
  if (!existsSync(root)) return undefined;
  const name = readdirSync(root).find((n) => {
    const m = /^logs_(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)$/.exec(n);
    const t = m && new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() - startedAt;
    return t !== null && t >= -1000 && t <= 10_000;
  });
  return name && join(root, name);
}

export function registerGame(server: McpServer, config: Config): void {
  server.registerTool(
    "game",
    {
      description:
        "Start / stop the Arma Reforger game client for testing: load local packed addons (built with `mod` build), " +
        "join a server directly (connect=IP[:port], e.g. the local `server start`), or open a world straight away. " +
        "A {GUID}Missions/Name.conf mission header is accepted as `world` and passed as `-server {GUID}path`, as `mission_server` does for a dedicated server; " +
        "what a game client does with it is unconfirmed: Bohemia documents `-server <world>` for the game executable only with a .ent world, and nothing about a header. " +
        "'logs' tails the client console log (script errors at runtime). " +
        "The client runs with -noThrow (no error dialogs), and the status reply reports the script exceptions (VM exceptions) and crash.log of each client this MCP started. " +
        "On Windows a watcher is started for every client it launches: if a VM exception window stays open on it, that process (and only that one) is ended and its logs are saved; the status reply shows what the watcher did.",
      inputSchema: {
        action: z.enum(["launch", "stop", "status", "logs"]),
        addons: z.array(z.string()).optional().describe("(launch) Local addon folder names to load from their packed build"),
        connect: z.string().optional().describe("(launch) Join this server, e.g. '127.0.0.1' or '127.0.0.1:2001' (uses the Diag exe)"),
        world: z.string().optional().describe("(launch) World to load on start, e.g. 'worlds/MP/MPTest.ent', or a mission header '{GUID}Missions/Name.conf' (uses the Diag exe; a header needs its {GUID})"),
        windowed: z.boolean().optional().describe("(launch) Windowed mode"),
        extraArgs: z.array(z.string()).optional().describe("(launch) Extra CLI args"),
        force: z.boolean().optional().describe("(stop) Kill instead of asking to close. Still only clients this MCP started"),
        adoptOrphans: z.boolean().optional().describe("(stop) Also stop clients left by an ended MCP session"),
        lines: z.number().int().min(1).max(2000).default(80),
        errorsOnly: z.boolean().optional().describe("(logs) Only (E)/(W)/(F) lines"),
      },
    },
    async (a) => {
      const logsDir = join(myGamesDir(), "ArmaReforger", "logs");
      const running = () => [...findPids(GAME_EXE), ...findPids(GAME_DIAG_EXE)];
      try {
        if (a.action === "launch") {
          // connect and world reach the argv too: a host[:port], and a .ent world or a {GUID}Missions/*.conf header, nothing else.
          // A letter or digit first, so neither can be read as a flag (-createDB, -logsDir).
          const port = a.connect?.match(/^[A-Za-z0-9][\w.-]*(?::(\d{1,5}))?$/);
          if (a.connect && (!port || (port[1] !== undefined && (Number(port[1]) < 1 || Number(port[1]) > 65535)))) {
            return text(`connect must be host or host:port (port 1-65535), e.g. 127.0.0.1:2001: ${a.connect}`, true);
          }
          // A mission header goes as `-server {GUID}path`, the form mission_server uses; its {GUID} is required (a path-only name crashes or is ignored).
          const header = a.world && /\.conf$/i.test(a.world) ? a.world : undefined;
          if (header && !isMissionHeader(header)) {
            return text(`A mission header must be {GUID}path .conf, for example {0123456789ABCDEF}Missions/Name.conf: a path-only resource name crashes or is ignored. Got: ${a.world}`, true);
          }
          if (a.world && !header && (!/^(\{[0-9A-Fa-f]{16}\})?[A-Za-z0-9][\w./-]*\.ent$/i.test(a.world) || a.world.split("/").includes(".."))) {
            return text(`world must be a .ent resource path, e.g. worlds/MP/MPTest.ent, or a {GUID}path .conf mission header: ${a.world}`, true);
          }
          const badArg = refusedArg(a.extraArgs ?? []);
          if (badArg) return text(`extraArgs may not contain ${badArg}: write-path flags (-profile, -logsDir, -addonDownloadDir, -addonTempDir, -saveDir, -cfg) and quotes are refused.`, true);
          if (running().length) return text("The game is already running: `game stop` first.", true);
          const diag = !!(a.connect || a.world);
          const exe = join(config.gamePath, diag ? GAME_DIAG_EXE : GAME_EXE);
          if (!existsSync(exe)) return text(`Not found: ${exe} (set ENFUSION_GAME_PATH)`, true);
          const args: string[] = ["-noSplash", NO_THROW, DISABLE_CRASH_REPORTER];
          const guids: string[] = [];
          for (const name of a.addons ?? []) {
            const gproj = resolveGproj(config, name);
            const id = gproj ? readGproj(gproj).id || name : name;
            const packed = join(config.packedPath, id);
            const g = existsSync(packed) ? readdirSync(packed).find((f) => f.endsWith(".gproj")) : undefined;
            if (!g || !existsSync(join(packed, "data.pak"))) return text(`Addon "${name}" is not packed in ${packed}. Run \`mod\` action build first.`, true);
            guids.push(readGproj(join(packed, g)).guid);
          }
          if (guids.length) args.push("-addonsDir", config.packedPath, "-addons", guids.join(","));
          if (a.connect) args.push("-client", a.connect);
          if (header) args.push("-server", header);
          else if (a.world) args.push("-world", a.world);
          if (a.windowed) args.push("-window");
          args.push(...(a.extraArgs ?? []));
          const started = Date.now();
          const pid = spawnDetached(exe, args, config.gamePath);
          const instance = pidInstanceFile(config.clientProfilesRoot, pid);
          writeInstance(instance, {
            kind: "client", name: "default", pid, ownerPid: OWNER.pid, ownerStartedAt: OWNER.startedAt, startedAt: started, exe,
          });
          watchStarted({ pid, kind: "client", instance, logsRoot: logsDir }, config);
          await sleep(3000);
          return text(`**Game launched** (pid ${pid})\n\n${diag ? GAME_DIAG_EXE : GAME_EXE} ${args.join(" ")}`);
        }

        if (a.action === "stop") {
          const entries = scan(clientProcesses(), { clientRoot: config.clientProfilesRoot });
          const { stop } = planStop(entries, { adoptOrphans: a.adoptOrphans, roots: [config.clientProfilesRoot] });
          const others = entries.filter((e) => !stop.includes(e));
          const untouched = others.length
            ? `\nNot touched: ${others.length} game client(s) not started by this MCP session (pid ${others.map((e) => e.proc.pid).join(", ")}).`
            : "";
          if (!stop.length) return text("No game client started by this MCP is running." + untouched);
          killPids(stop.map((e) => e.proc.pid), a.force, true);
          for (let i = 0; i < 20 && stop.some((e) => isAlive(e.proc.pid)); i++) await sleep(500);
          for (const e of stop) if (!isAlive(e.proc.pid)) rmSync(e.file!, { force: true });
          const still = stop.filter((e) => isAlive(e.proc.pid));
          return still.length
            ? text(`Game client still running (pid ${still.map((e) => e.proc.pid).join(", ")}): retry with force=true.${untouched}`, true)
            : text(`**Game closed** (pid ${stop.map((e) => e.proc.pid).join(", ")}).${untouched}`);
        }

        if (a.action === "status") {
          const entries = scan(clientProcesses(), { clientRoot: config.clientProfilesRoot });
          const reports = entries.flatMap((e) => {
            const dir = e.cls === "own" && e.inst ? clientLogDir(logsDir, e.inst.startedAt) : undefined;
            const r = dir ? runErrors(dir) : "";
            return r ? [`**Client pid ${e.proc.pid}**\n${r}`] : [];
          });
          return text(
            `Game: ${entries.length ? `${entries.length} client(s) running, ${entries.filter((e) => e.cls === "own").length} started by this MCP` : "not running"}\n` +
            `Install: ${config.gamePath}\nLogs: ${newestDir(logsDir) ?? logsDir}${entries.length ? `\n\n${instanceTable(entries)}` : ""}` +
            (reports.length ? `\n\n${reports.join("\n\n")}` : "") +
            procWatchLines({ root: config.clientProfilesRoot }).map((l) => `\n${l}`).join("")
          );
        }

        // logs
        const dir = newestDir(logsDir);
        const file = dir ? join(dir, "console.log") : "";
        if (!file || !existsSync(file)) return text(`No client logs in ${logsDir}.`, true);
        const all = readFileSync(file, "utf-8").split(/\r?\n/);
        const shown = (a.errorsOnly ? all.filter((l) => /\((E|W|F)\)/.test(l)) : all).slice(-a.lines);
        return text(`**${file}**\n\n\`\`\`\n${shown.join("\n")}\n\`\`\``);
      } catch (e) {
        return text(`game ${a.action} failed: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
  );
}
