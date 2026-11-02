import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { MCP_HOME, type Config } from "../config.js";
import { findGproj } from "../utils/game-paths.js";
import { readGproj } from "../workbench/cli.js";
import { argValue, clientProcesses, isAlive, killPids, serverProcesses, sleep, spawnDetached } from "../utils/process.js";
import { INSTANCE_FILE, OWNER, instanceTable, isUnder, planStop, scan, writeInstance, type Entry } from "../utils/instances.js";
import { DEFAULT_FAIL_PATTERNS, resolveLogFile, waitFor } from "../utils/logwatch.js";
import { documentsDir, findMissionHeader } from "./server-params.js";

/** Everything this tool starts lives here, one folder per port: server/, peer<n>/, run.json. */
export const MISSION_ROOT = join(MCP_HOME, "mission-server");
const GAME_STATE = /OnGameStateChanged = GAME\b/;
// Flags the tool sets itself; extraArgs may not override them.
const OWN_FLAGS = /^-(profile|addr|addonsdir|addons|server|client|gproj|config|missionheader|bindport)$/i;

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });

export interface Run {
  port: number;
  gproj: string;
  world: string;
  header?: string;
  addonsDirs: string[];
  addons: string[];
}

/** The server command line, as the Dedicated Server Tool builds it (SCR_DedicatedServerPlugin.c), with our own port and an absolute profile. */
export function serverArgs(r: Run, profile: string, extra: string[] = []): string[] {
  return [
    "-gproj", r.gproj, "-server", r.world, ...(r.header ? ["-MissionHeader", r.header] : []),
    "-addonsDir", r.addonsDirs.join(","), "-addons", r.addons.join(","),
    "-addr", `127.0.0.1:${r.port}`, "-profile", profile, "-nothrow", "-maxFPS", "60", ...extra,
  ];
}

/** A peer's command line: the plugin's PeerConfig defaults, plus the server address (the plugin passes a bare -client). */
export function peerArgs(r: Run, profile: string): string[] {
  return [
    "-gproj", r.gproj, "-addonsDir", r.addonsDirs.join(","), "-addons", r.addons.join(","),
    "-window", "-forceupdate", "-nofocus", "-client", `127.0.0.1:${r.port}`, "-rpl-reconnect", "-rpl-timeout-disable", "-profile", profile,
  ];
}

export interface StartArgs {
  world: string;
  missionHeader?: string;
  addons?: string[];
  addonsDirs?: string[];
  port: number;
}

/** Checks the inputs and works out the run, or says why not. Every value here ends up in a process argv. */
export function planRun(a: StartArgs, config: Pick<Config, "projectPath" | "addonsDir">, docs = documentsDir): Run | string {
  if (!isAbsolute(a.world) || !/\.ent$/i.test(a.world) || !existsSync(a.world)) return `world must be an existing absolute .ent path: ${a.world}`;
  const found = findMissionHeader(a.world);
  if (!found.addon) return `No .gproj above ${a.world}: the world must be inside an unpacked addon.`;
  const gproj = findGproj(found.addon)!;
  const world = relative(found.addon, a.world).replace(/\\/g, "/");
  if (/[",]/.test(world)) return `World path has a quote or comma: ${world}`;
  // The plugin passes ResourceName.GetPath(): the addon-relative path without the {GUID}.
  const header = (a.missionHeader ?? found.header)?.replace(/^\{[0-9A-Fa-f]{16}\}/, "");
  if (header !== undefined && (!/^[\w ./-]+\.conf$/i.test(header) || header.split("/").includes(".."))) return `missionHeader is not a .conf resource path: ${a.missionHeader}`;
  const addons = a.addons ?? [readGproj(gproj).id];
  if (!addons.length || addons.some((id) => !/^[\w.-]+$/.test(id))) return `addons must be addon IDs (letters, digits, . _ -): ${addons.join(", ")}`;
  // Default as wb_launch: ENFUSION_ADDONS_DIR when set, else the guide's Params (projects plus the Workbench addons folder).
  const dirs = a.addonsDirs ??
    (config.addonsDir
      ? config.addonsDir.split(",").map((d) => d.trim()).filter(Boolean)
      : [config.projectPath, join(docs(), "My Games", "ArmaReforgerWorkbench", "addons")].filter((d) => existsSync(d)));
  // The world's own addon must be found: add its parent folder when no listed folder holds it.
  if (!dirs.some((d) => isUnder(found.addon!, d))) dirs.push(dirname(found.addon));
  const bad = dirs.find((d) => !isAbsolute(d) || /[",\r\n]/.test(d) || !existsSync(d));
  if (bad) return `addonsDirs must be existing absolute folders without quotes or commas: ${bad}`;
  return { port: a.port, gproj, world, header, addonsDirs: dirs, addons };
}

/** extraArgs that are plain tokens and leave the tool's own flags alone. */
export function checkExtra(extra: string[]): string | undefined {
  const bad = extra.find((x) => OWN_FLAGS.test(x) || /["\r\n]/.test(x));
  return bad ? `extraArgs may not contain ${bad} (the tool sets -profile, -addr, -addonsDir, -addons, -server, -client, -gproj itself; no quotes)` : undefined;
}

const portDir = (port: number) => join(MISSION_ROOT, String(port));
const readRun = (port: number): Run | undefined => {
  try {
    return JSON.parse(readFileSync(join(portDir(port), "run.json"), "utf-8")) as Run;
  } catch {
    return undefined;
  }
};
/** This tool's processes (instance file under MISSION_ROOT, or under one port's folder). */
const mine = (root = MISSION_ROOT): Entry[] => [...scan(serverProcesses()), ...scan(clientProcesses())].filter((e) => e.file && isUnder(e.file, root));

function startPeer(r: Run, config: Config): { n: number; pid: number; args: string[] } | string {
  const exe = join(config.gamePath, "ArmaReforgerSteamDiag.exe");
  if (!existsSync(exe)) return `Not found: ${exe} (set ENFUSION_GAME_PATH)`;
  const used = existsSync(portDir(r.port)) ? readdirSync(portDir(r.port)).map((f) => /^peer(\d+)$/.exec(f)?.[1]).filter(Boolean).map(Number) : [];
  const n = Math.max(0, ...used) + 1;
  const profile = join(portDir(r.port), `peer${n}`);
  mkdirSync(profile, { recursive: true });
  const args = peerArgs(r, profile);
  const started = Date.now();
  const pid = spawnDetached(exe, args, config.gamePath);
  writeInstance(join(profile, INSTANCE_FILE), {
    kind: "client", name: `mission-${r.port}-peer${n}`, pid, ownerPid: OWNER.pid, ownerStartedAt: OWNER.startedAt, startedAt: started, exe, port: r.port, profileDir: profile,
  });
  return { n, pid, args };
}

export function registerMissionServer(server: McpServer, config: Config): void {
  server.registerTool(
    "mission_server",
    {
      description:
        "Run a mission the way Workbench's Dedicated Server Tool does, without Workbench: an ArmaReforgerServerDiag server on the mission world and " +
        "its Mission Header, with unpacked addons from -addonsDir, on its own loopback port and profile, plus Diag game clients that join it. " +
        "start (server, waits for the GAME state, then peers), join (one more client, the guide's Start only clients), status, stop (only its own processes). " +
        "Starts processes: ask the user (or the Workbench lock owner) first, and keep within the CPU and port slots they give.",
      inputSchema: {
        action: z.enum(["start", "join", "status", "stop"]),
        world: z.string().optional().describe("(start) Absolute path of the mission .ent inside an unpacked addon"),
        missionHeader: z.string().optional().describe("(start) Header .conf as {GUID}path or path; default the one whose World is this .ent (server_params)"),
        addons: z.array(z.string()).optional().describe("(start) Addon IDs for -addons; default the world's addon (the server resolves its dependencies)"),
        addonsDirs: z.array(z.string()).optional().describe("(start) Folders for -addonsDir (read only); default ENFUSION_ADDONS_DIR, else the project folder and the Workbench addons folder"),
        port: z.number().int().min(1024).max(65535).optional().describe("Loopback game port (-addr 127.0.0.1:<port>), one run per port; start and join default to 2521, stop without it stops every run of this tool"),
        peers: z.number().int().min(0).max(4).default(0).describe("(start) Game clients to start once the server is in GAME"),
        extraArgs: z.array(z.string()).optional().describe("(start) Extra server args, e.g. ['-jobsysShortWorkerCount','2']"),
        timeoutSec: z.number().int().min(10).max(600).default(180).describe("(start) How long to wait for the GAME state"),
        adoptOrphans: z.boolean().optional().describe("(stop) Also stop processes this tool started from an MCP session that has ended"),
      },
    },
    async (a) => {
      try {
        const port = a.port ?? 2521;
        if (a.action === "start") {
          if (!a.world) return text("start needs world", true);
          const run = planRun({ world: a.world, missionHeader: a.missionHeader, addons: a.addons, addonsDirs: a.addonsDirs, port }, config);
          if (typeof run === "string") return text(run, true);
          const extraErr = checkExtra(a.extraArgs ?? []);
          if (extraErr) return text(extraErr, true);
          const exe = join(config.serverPath, "ArmaReforgerServerDiag.exe");
          if (!existsSync(exe)) return text(`Not found: ${exe} (set ENFUSION_SERVER_PATH)`, true);
          const taken = serverProcesses().find((p) => argValue(p.cmd, "-addr")?.endsWith(`:${port}`));
          if (taken) return text(`Port ${port} is already used by server PID ${taken.pid}. Pick another port or stop that run (only this tool's own runs are stopped by mission_server stop).`, true);
          if (mine(portDir(port)).length) return text(`A mission_server run on port ${port} is still running: stop it first.`, true);

          const profile = join(portDir(port), "server");
          mkdirSync(profile, { recursive: true });
          const args = serverArgs(run, profile, a.extraArgs);
          const started = Date.now();
          const pid = spawnDetached(exe, args, config.serverPath);
          writeInstance(join(profile, INSTANCE_FILE), {
            kind: "server", name: `mission-${port}`, pid, ownerPid: OWNER.pid, ownerStartedAt: OWNER.startedAt, startedAt: started, exe, port, profileDir: profile,
          });
          writeFileSync(join(portDir(port), "run.json"), JSON.stringify(run, null, 2));
          const w = await waitFor({
            log: () => resolveLogFile({ dir: profile, file: "console", newerThan: started - 5000 }),
            patterns: [{ name: "game", regex: GAME_STATE }],
            failPatterns: DEFAULT_FAIL_PATTERNS,
            from: "start",
            pid,
            timeoutMs: a.timeoutSec * 1000,
          });
          const head = `Server PID ${pid} on 127.0.0.1:${port}\nCommand: ${basename(exe)} ${args.join(" ")}\nLog: ${w.file ?? "(none yet)"}`;
          if (w.status !== "matched") {
            const why = w.status === "failed" ? `stopped on: ${w.fatal[0]?.line}` : w.status === "exited" ? "the server exited" : `no GAME state within ${a.timeoutSec} s`;
            return text(`**Server not ready** (${why}). No peers started.${isAlive(pid) ? " It is still running: mission_server stop." : ""}\n\n${head}`, true);
          }
          const peers: string[] = [];
          for (let i = 0; i < a.peers; i++) {
            const p = startPeer(run, config);
            if (typeof p === "string") return text(`**Server in GAME**, but a peer could not start: ${p}\n\n${head}\n${peers.join("\n")}`, true);
            peers.push(`Peer ${p.n}: PID ${p.pid}`);
            await sleep(2000);
          }
          return text(`**Server in GAME** after ${w.elapsedSec.toFixed(0)} s (${w.matched[0].line.trim()})\n\n${head}${peers.length ? `\n\n${peers.join("\n")}\nPeer command: ArmaReforgerSteamDiag.exe ${peerArgs(run, "<peer profile>").join(" ")}` : ""}`);
        }

        if (a.action === "join") {
          const run = readRun(port);
          const srv = mine(portDir(port)).find((e) => e.inst?.kind === "server" && e.cls === "own");
          if (!run || !srv) return text(`No mission_server run of this MCP session on port ${port}.`, true);
          const p = startPeer(run, config);
          if (typeof p === "string") return text(p, true);
          return text(`**Peer ${p.n} started** (PID ${p.pid}) and joins 127.0.0.1:${port}.\nCommand: ArmaReforgerSteamDiag.exe ${p.args.join(" ")}`);
        }

        if (a.action === "status") {
          const entries = mine();
          const ports = existsSync(MISSION_ROOT) ? readdirSync(MISSION_ROOT).filter((d) => /^\d+$/.test(d)) : [];
          const rows = ports.map((port) => {
            const log = resolveLogFile({ dir: join(MISSION_ROOT, port, "server"), file: "console" });
            const game = log && GAME_STATE.test(readFileSync(log, "utf-8")) ? "GAME reached" : "no GAME line";
            const live = entries.filter((e) => e.file && isUnder(e.file, join(MISSION_ROOT, port)));
            return `- port ${port}: ${live.length} process(es) running, ${game}${log ? `, log ${log}` : ""}`;
          });
          return text(`**mission_server**\n${rows.length ? rows.join("\n") : "No runs yet."}${entries.length ? `\n\n${instanceTable(entries)}` : ""}`);
        }

        // stop: clients first, then servers; only this tool's own (or adopted orphan) processes.
        const { stop } = planStop(mine(a.port ? portDir(a.port) : MISSION_ROOT), { adoptOrphans: a.adoptOrphans, roots: [MISSION_ROOT] });
        if (!stop.length) return text("No mission_server process of this MCP session is running.");
        const order = [...stop.filter((e) => e.inst?.kind === "client"), ...stop.filter((e) => e.inst?.kind !== "client")];
        for (const e of order) killPids([e.proc.pid], true, true);
        for (let i = 0; i < 20 && order.some((e) => isAlive(e.proc.pid)); i++) await sleep(500);
        const still = order.filter((e) => isAlive(e.proc.pid));
        for (const e of order) if (!isAlive(e.proc.pid)) rmSync(e.file!, { force: true });
        return text(
          `**Stopped ${order.length - still.length} of ${order.length}**: ${order.map((e) => `${e.inst?.name} (PID ${e.proc.pid})`).join(", ")}` +
            (still.length ? `\nStill running: ${still.map((e) => e.proc.pid).join(", ")}` : ""),
          still.length > 0
        );
      } catch (e) {
        return text(`mission_server failed: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
  );
}
