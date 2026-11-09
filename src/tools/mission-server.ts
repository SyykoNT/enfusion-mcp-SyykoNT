import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, freemem } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { MCP_HOME, SERVER_DOWNLOAD_DIR, type Config } from "../config.js";
import { findGproj, myGamesDir } from "../utils/game-paths.js";
import { addonsDirsError, crashLogsDir, readGproj } from "../workbench/cli.js";
import { procWatchLines, startProcWatcher, type StartProcWatcher } from "../watchdog/proc-watch.js";
import { duplicateAddonError } from "../pak/stack.js";
import { DISABLE_CRASH_REPORTER, NO_THROW, argValue, clientProcesses, isAlive, killPids, limitProcess, newestDir, refusedArg, serverProcesses, sleep, spawnDetached } from "../utils/process.js";
import { INSTANCE_FILE, OWNER, instanceTable, isUnder, planStop, scan, writeInstance, type Entry } from "../utils/instances.js";
import { DEFAULT_FAIL_PATTERNS, fenced, resolveLogFile, runErrors, waitFor } from "../utils/logwatch.js";
import { findMissionHeader } from "./server-params.js";

/** Everything this tool starts lives here, one folder per port: server/, peer<n>/, run.json. */
export const MISSION_ROOT = join(MCP_HOME, "mission-server");
// The server accepts clients from here on; GAME comes later and only from some game modes (COALITION's lobby waits for players).
const ONLINE = /Entered online game state/;
const GAME_STATE = /OnGameStateChanged = GAME\b/;
// The engine logs this on every join and leave (seen 2026-11-02: "NETWORK : Players connected: 2 / 2").
const PLAYERS = /Players connected: (\d+) \//g;
/**
 * Free RAM needed before each game client starts: what one client needs. The 2026-11-02 runs used about 2 GB per Arma process
 * (32.1 to 28.3 GB free for a server and one client), so 4 GB is that process plus the same again as margin. Plans with several
 * peers are the user's call. Run 2 froze the PC with 18 GB still free, so this gate alone would not have prevented it.
 */
export const MIN_FREE_GB_CLIENT = 4;
/** A peer whose log has not been written for this long, and is not counted yet, looks hung (run 2: silent from 01:18:04 on). */
const STALL_SEC = 60;
const DEFAULT_JOIN_SEC = 120;
/** With no peers there is no join wait, so the reply waits this long after "online": live runs logged the script exception 0.12 s and crash.log 0.13 s after that line. */
export const SETTLE_MS = 3000;

/** The last "Players connected" count in a server log, 0 when there is none yet. */
export function playersConnected(log: string): number {
  const all = [...log.matchAll(PLAYERS)];
  return all.length ? Number(all[all.length - 1][1]) : 0;
}

/** Wait for "Players connected: <count>" in lines written after `offset`; false on timeout or when the server exits. */
async function waitPlayers(logFile: string, offset: number, count: number, serverPid: number, seconds: number): Promise<boolean> {
  const w = await waitFor({ log: () => logFile, patterns: [{ name: "joined", regex: new RegExp(`Players connected: ${count} /`) }], failPatterns: [], from: offset, pid: serverPid, timeoutMs: seconds * 1000 });
  return w.status === "matched";
}

export interface PeerState {
  n: number;
  pid: number;
  /** Seconds since the peer's console log was last written; undefined when it has no log. */
  ageSec?: number;
  /** First engine failure line in the peer's log ("Application hangs", "(F):", ...). */
  failLine?: string;
}

/** The first engine failure line ("Application hangs", "(F):", ...) in a log's text. */
export const firstFailure = (text: string) => text.split(/\r?\n/).find((l) => DEFAULT_FAIL_PATTERNS.some((re) => re.test(l)));

/**
 * Why another client must not start now: the server is not online or shows a failure, a peer failed, or fewer players are counted
 * by the server than peers running. Empty when healthy. `serverLog` is the server's console log text.
 */
export function peerProblems(counted: number, peers: PeerState[], serverLog = "Entered online game state"): string[] {
  const serverFail = firstFailure(serverLog);
  const out = serverFail
    ? [`the server is hung or crashed: ${serverFail.trim()}`]
    : ONLINE.test(serverLog) ? [] : ["the server is not online yet (no \"Entered online game state\" in its log)"];
  out.push(...peers.filter((p) => p.failLine).map((p) => `peer ${p.n} (PID ${p.pid}) is hung or crashed: ${p.failLine!.trim()}`));
  if (counted < peers.length) {
    const detail = peers
      .map((p) => `peer ${p.n} (PID ${p.pid}) ${p.ageSec === undefined ? "has no log" : p.ageSec > STALL_SEC ? `looks hung, log silent for ${p.ageSec} s` : `still loading, log written ${p.ageSec} s ago`}`)
      .join(", ");
    out.push(`the server has counted ${counted} of ${peers.length} earlier peer(s) (${detail})`);
  }
  return out;
}
// Flags the tool sets itself; extraArgs may not override them.
const OWN_FLAGS = /^-(profile|addr|addonsdir|addons|server|client|gproj|config|missionheader|bindport|addonsrepair|addonsverify)$/i;

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });

export interface Run {
  port: number;
  gproj: string;
  world: string;
  header?: string;
  addonsDirs: string[];
  addons: string[];
  /** Hex-parsed CPU masks, set when the caller gave them: BelowNormal priority and these cores for the server and for every client. */
  cpu?: { server: number; client: number };
}

/**
 * serverCpuMask and clientCpuMask as hex ("0x3000"): both or neither, and no shared core. Game clients on the server's cores
 * starved each other in the 2026-11-02 Boat Patrol run. shortcut: 32-bit masks only, so no cores above 31.
 */
export function cpuMasks(server?: string, client?: string, cores = availableParallelism()): Run["cpu"] | string {
  if (server === undefined && client === undefined) return undefined;
  const parse = (v?: string) => (v && /^(0x)?[0-9a-f]{1,8}$/i.test(v) ? parseInt(v.replace(/^0x/i, ""), 16) : 0);
  const s = parse(server);
  const c = parse(client);
  if (!s || !c) return "serverCpuMask and clientCpuMask must both be given as hex masks, for example 0x3000 and 0x0C00";
  // A bit for a core this PC lacks makes the pin fail (0x30000 on 16 cores), which would leave the clients on the server's cores.
  for (const [name, m] of [["serverCpuMask", s], ["clientCpuMask", c]] as const) {
    if (31 - Math.clz32(m) >= cores) return `${name} 0x${m.toString(16)} names core ${31 - Math.clz32(m)}, but this PC has ${cores} logical cores (0 to ${cores - 1})`;
  }
  if (s & c) return `clientCpuMask 0x${c.toString(16)} shares cores with serverCpuMask 0x${s.toString(16)}: game clients must run on other cores`;
  return { server: s, client: c };
}

/**
 * The server command line: the Dedicated Server Tool's flags (SCR_DedicatedServerPlugin.c) with our own port and an absolute profile.
 * The header goes as `-server {GUID}path`: the tool's `-server <world> -MissionHeader <path>` form left the header unapplied on the
 * dedicated server (probe 2026-11-02: no "Starting new playthrough" line, CRF_LoggingManager NULL m_sAuthor).
 */
export function serverArgs(r: Run, profile: string, extra: string[] = []): string[] {
  return [
    "-gproj", r.gproj, "-server", r.header ?? r.world,
    "-addonsDir", r.addonsDirs.join(","), "-addons", r.addons.join(","),
    "-addr", `127.0.0.1:${r.port}`, "-profile", profile, NO_THROW, "-maxFPS", "60", DISABLE_CRASH_REPORTER, "-addonDownloadDir", SERVER_DOWNLOAD_DIR, ...extra,
  ];
}

/** A peer's command line: the plugin's PeerConfig defaults, plus the server address (the plugin passes a bare -client). */
export function peerArgs(r: Run, profile: string): string[] {
  return [
    "-gproj", r.gproj, "-addonsDir", r.addonsDirs.join(","), "-addons", r.addons.join(","),
    "-window", "-forceupdate", "-nofocus", "-client", `127.0.0.1:${r.port}`, "-rpl-reconnect", "-rpl-timeout-disable", "-profile", profile, NO_THROW, DISABLE_CRASH_REPORTER,
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
export function planRun(a: StartArgs, config: Pick<Config, "projectPath" | "addonsDir">, myGames = myGamesDir): Run | string {
  if (!isAbsolute(a.world) || !/\.ent$/i.test(a.world) || !existsSync(a.world)) return `world must be an existing absolute .ent path: ${a.world}`;
  const found = findMissionHeader(a.world);
  if (!found.addon) return `No .gproj above ${a.world}: the world must be inside an unpacked addon.`;
  const gproj = findGproj(found.addon)!;
  const world = relative(found.addon, a.world).replace(/\\/g, "/");
  if (/[",]/.test(world)) return `World path has a quote or comma: ${world}`;
  // A path-only resource name crashes or is ignored by a dedicated server, so the header must carry its {GUID}.
  const guidConf = (h?: string) => !!h && /^\{[0-9A-Fa-f]{16}\}[\w ./-]+\.conf$/i.test(h) && !h.split("/").includes("..");
  if (a.missionHeader !== undefined && !guidConf(a.missionHeader)) return `missionHeader must be a {GUID}path .conf: ${a.missionHeader}`;
  const header = a.missionHeader ?? (guidConf(found.header) ? found.header : undefined);
  const addons = a.addons ?? [readGproj(gproj).id];
  if (!addons.length || addons.some((id) => !/^[\w.-]+$/.test(id))) return `addons must be addon IDs (letters, digits, . _ -): ${addons.join(", ")}`;
  // Default as wb_launch: ENFUSION_ADDONS_DIR when set, else the guide's Params (projects plus the Workbench addons folder).
  const dirs = a.addonsDirs ??
    (config.addonsDir
      ? config.addonsDir.split(",").map((d) => d.trim()).filter(Boolean)
      : [config.projectPath, join(myGames(), "ArmaReforgerWorkbench", "addons")].filter((d) => existsSync(d)));
  // The world's own addon must be found: add its parent folder when no listed folder holds it.
  if (!dirs.some((d) => isUnder(found.addon!, d))) dirs.push(dirname(found.addon));
  const bad = addonsDirsError(dirs);
  if (bad) return bad;
  return { port: a.port, gproj, world, header, addonsDirs: dirs, addons };
}

/** extraArgs that are plain tokens, leave the tool's own flags alone and point no writes anywhere. */
export function checkExtra(extra: string[]): string | undefined {
  const bad = refusedArg(extra, OWN_FLAGS);
  return bad
    ? `extraArgs may not contain ${bad} (the tool sets -profile, -addr, -addonsDir, -addons, -server, -client, -gproj itself; no -addonsRepair or -addonsVerify; no write-path flags such as -logsDir, -addonDownloadDir, -addonTempDir, -saveDir, -cfg; no quotes)`
    : undefined;
}

const portDir = (port: number) => join(MISSION_ROOT, String(port));

/** The logs folder of every server and peer profile this tool has made (for log_watch's allowed roots). */
export function missionLogRoots(): string[] {
  const list = (d: string) => (existsSync(d) ? readdirSync(d) : []);
  return list(MISSION_ROOT)
    .filter((port) => /^\d+$/.test(port))
    .flatMap((port) => list(join(MISSION_ROOT, port)).filter((p) => /^(server|peer\d+)$/.test(p)).map((p) => join(MISSION_ROOT, port, p, "logs")));
}
const readRun = (port: number): Run | undefined => {
  try {
    return JSON.parse(readFileSync(join(portDir(port), "run.json"), "utf-8")) as Run;
  } catch {
    return undefined;
  }
};
/**
 * Script exceptions and crash.log of the newest run on one port, for the server and every peer that logged since it started
 * (run.json is written right after the server starts). "" when there are none, else text that begins with a blank line.
 */
function runReport(port: number): string {
  const dir = portDir(port);
  if (!existsSync(dir)) return "";
  let since = 0;
  try {
    since = statSync(join(dir, "run.json")).mtimeMs - 5000;
  } catch {
    // no run.json: the newest logs
  }
  const names = ["server", ...readdirSync(dir).filter((d) => /^peer\d+$/.test(d)).sort()];
  const parts = names.flatMap((n) => {
    const log = newestDir(join(dir, n, "logs"), since);
    const r = log ? runErrors(log) : "";
    return r ? [`**${n}**\n${r}`] : [];
  });
  return parts.length ? `\n\n${parts.join("\n\n")}` : "";
}
/**
 * Start the process watcher for a server or client whose instance file was just written. The process is already running, so a watcher
 * that cannot start (no state folder, no spawn) must not turn the start into a failure.
 */
export function watchStarted(w: Pick<StartProcWatcher, "pid" | "kind" | "instance" | "logsRoot">, config: Config): void {
  try {
    startProcWatcher({ ...w, ownerPid: OWNER.pid, ownerStarted: OWNER.startedAt, crashDir: crashLogsDir(config) });
  } catch {
    // shortcut: no note in the reply, -noThrow is the first defence; surface a watcher that did not start if a user needs it
  }
}

/** After a wait that ended with a process gone: its watcher may still be writing the final state of an end it made, so look for up to 5 s. */
async function exitedStates(root: string, pids: number[], since: number): Promise<string> {
  const gone = pids.filter((p) => !isAlive(p));
  if (!gone.length) return "";
  for (let i = 0; ; i++) {
    const lines = procWatchLines({ root, pids: gone, since, final: true });
    if (lines.length) return `\n${lines.join("\n")}`;
    if (i >= 10) return "";
    await sleep(500);
  }
}

/** This tool's processes (instance file under MISSION_ROOT, or under one port's folder). */
const mine = (root = MISSION_ROOT): Entry[] => [...scan(serverProcesses()), ...scan(clientProcesses())].filter((e) => e.file && isUnder(e.file, root));

/** The peers of one run that are still running and ours, with how their logs look. */
function peerStates(port: number): PeerState[] {
  return mine(portDir(port))
    .filter((e) => e.cls === "own" && e.inst?.kind === "client")
    .map((e) => {
      const log = resolveLogFile({ dir: e.inst!.profileDir ?? "", file: "console" });
      const text = log ? readFileSync(log, "utf-8") : "";
      return {
        n: Number(/peer(\d+)$/.exec(e.inst!.name)?.[1] ?? 0),
        pid: e.proc.pid,
        ageSec: log ? Math.round((Date.now() - statSync(log).mtimeMs) / 1000) : undefined,
        failLine: firstFailure(text),
      };
    })
    .sort((a, b) => a.n - b.n);
}

/**
 * End the given processes (peers, or the server), which this call just started: only PIDs that still carry this tool's instance
 * file for this run and a matching start time. `peersOnly` adds the note that the server was left running.
 */
async function stopOwn(port: number, started: { pid: number }[], peersOnly = true): Promise<string> {
  if (!started.length) return "";
  const own = mine(portDir(port)).filter((e) => e.cls === "own" && started.some((s) => s.pid === e.proc.pid));
  killPids(own.map((e) => e.proc.pid), true, true);
  for (let i = 0; i < 20 && own.some((e) => isAlive(e.proc.pid)); i++) await sleep(500);
  const gone = own.filter((e) => !isAlive(e.proc.pid));
  for (const e of gone) rmSync(e.file!, { force: true });
  const label = (e: Entry) => (e.inst!.kind === "server" ? "server" : `peer ${/peer(\d+)$/.exec(e.inst!.name)?.[1]}`) + ` (PID ${e.proc.pid})`;
  const left = own.filter((e) => isAlive(e.proc.pid));
  return (
    `\nStopped ${gone.length ? gone.map(label).join(", ") : "nothing"}` +
    (started.length > own.length ? `; ${started.length - own.length} had already ended` : "") +
    (left.length ? `; still running: ${left.map(label).join(", ")}` : "") +
    (peersOnly ? ". The server was left running." : ".")
  );
}

function startPeer(r: Run, config: Config): { n: number; pid: number; args: string[]; pinned?: boolean } | string {
  const free = freemem() / 2 ** 30;
  if (free < MIN_FREE_GB_CLIENT) {
    return `Not enough free RAM for another game client: ${free.toFixed(1)} GB free, ${MIN_FREE_GB_CLIENT} GB needed (about 2 GB per Arma process).`;
  }
  const exe = join(config.gamePath, "ArmaReforgerSteamDiag.exe");
  if (!existsSync(exe)) return `Not found: ${exe} (set ENFUSION_GAME_PATH)`;
  const used = existsSync(portDir(r.port)) ? readdirSync(portDir(r.port)).map((f) => /^peer(\d+)$/.exec(f)?.[1]).filter(Boolean).map(Number) : [];
  const n = Math.max(0, ...used) + 1;
  const profile = join(portDir(r.port), `peer${n}`);
  mkdirSync(profile, { recursive: true });
  const args = peerArgs(r, profile);
  const started = Date.now();
  const pid = spawnDetached(exe, args, config.gamePath);
  const instance = join(profile, INSTANCE_FILE);
  writeInstance(instance, {
    kind: "client", name: `mission-${r.port}-peer${n}`, pid, ownerPid: OWNER.pid, ownerStartedAt: OWNER.startedAt, startedAt: started, exe, port: r.port, profileDir: profile,
  });
  watchStarted({ pid, kind: "client", instance, logsRoot: join(profile, "logs") }, config);
  return { n, pid, args, pinned: r.cpu ? limitProcess(pid, r.cpu.client) : undefined };
}

export function registerMissionServer(server: McpServer, config: Config): void {
  server.registerTool(
    "mission_server",
    {
      description:
        "Run a mission the way Workbench's Dedicated Server Tool does, without Workbench: an ArmaReforgerServerDiag server on the mission world and " +
        "its Mission Header, with unpacked addons from -addonsDir, on its own loopback port and profile, plus Diag game clients that join it. " +
        "start (server, waits until it accepts clients, then peers), join (one more client, the guide's Start only clients), status, stop (only its own processes). " +
        "Starts processes on this PC, so ask the user before start or join; port picks the loopback port, and serverCpuMask and clientCpuMask choose the cores. " +
        "A start is refused, before anything is spawned, when the world's addon, an addon in addons or one of their dependencies exists as two copies with the same GUID in the listed folders. " +
        "Every client needs at least 4 GB free RAM; join refuses while an earlier peer is hung or not counted by the server; start stops its own peers " +
        "that do not join in time. serverCpuMask and clientCpuMask (hex, both or neither, no shared core) pin the server and the clients at BelowNormal priority. " +
        "The Crash Reporter is switched off for everything it starts (-disableCrashReporter), and every server and client it starts runs with -noThrow (no error dialogs). " +
        "The start, join and status replies report the run's script exceptions (VM exceptions) and crash.log, for the server and each peer. " +
        "On Windows a watcher is started for every server and client it starts: if a VM exception window stays open on one of them, that process (and only that one) is ended and its logs are saved; the status reply shows what the watcher did.",
      inputSchema: {
        action: z.enum(["start", "join", "status", "stop"]),
        world: z.string().optional().describe("(start) Absolute path of the mission .ent inside an unpacked addon"),
        missionHeader: z.string().optional().describe("(start) Header .conf as {GUID}path; default the one in the world's addon whose World is this .ent. Without one the world starts bare"),
        addons: z.array(z.string()).optional().describe("(start) Addon IDs for -addons; default the world's addon (the server resolves its dependencies)"),
        addonsDirs: z.array(z.string()).optional().describe("(start) Folders for -addonsDir (read only); default ENFUSION_ADDONS_DIR, else the project folder and the Workbench addons folder; [] is an empty list (no default), so only the world's addon folder is listed"),
        port: z.number().int().min(1024).max(65535).optional().describe("Loopback game port (-addr 127.0.0.1:<port>), one run per port; start and join default to 2521, stop without it stops every run of this tool"),
        peers: z.number().int().min(0).max(4).default(0).describe("(start) Game clients to start once the server is online"),
        extraArgs: z.array(z.string()).optional().describe("(start) Extra server args, e.g. ['-jobsysShortWorkerCount','2']"),
        timeoutSec: z.number().int().min(10).max(600).default(180).describe("(start) How long to wait for the server to come online"),
        joinTimeoutSec: z.number().int().min(1).max(600).default(DEFAULT_JOIN_SEC).describe("(start, join) How long to wait for clients to be counted by the server; start stops the peers it started when they are not"),
        serverCpuMask: z.string().optional().describe("(start) Hex CPU mask for the server, e.g. 0x3000; needs clientCpuMask"),
        clientCpuMask: z.string().optional().describe("(start) Hex CPU mask for every game client, e.g. 0x0C00; must not share a core with serverCpuMask"),
        adoptOrphans: z.boolean().optional().describe("(stop) Also stop processes this tool started from an MCP session that has ended"),
      },
    },
    async (a) => {
      try {
        const port = a.port ?? 2521;
        if (a.action === "start") {
          if (!a.world) return text("start needs world", true);
          const planned = planRun({ world: a.world, missionHeader: a.missionHeader, addons: a.addons, addonsDirs: a.addonsDirs, port }, config);
          if (typeof planned === "string") return text(planned, true);
          const dup = duplicateAddonError([planned.gproj], planned.addonsDirs, { ids: planned.addons, via: "addonsDirs" });
          if (dup) return text(dup, true);
          const cpu = cpuMasks(a.serverCpuMask, a.clientCpuMask);
          if (typeof cpu === "string") return text(cpu, true);
          const run: Run = { ...planned, cpu };
          const extraErr = checkExtra(a.extraArgs ?? []);
          if (extraErr) return text(extraErr, true);
          const exe = join(config.serverPath, "ArmaReforgerServerDiag.exe");
          if (!existsSync(exe)) return text(`Not found: ${exe} (set ENFUSION_SERVER_PATH)`, true);
          const taken = serverProcesses().find((p) => argValue(p.cmd, "-addr")?.endsWith(`:${port}`));
          if (taken) return text(`Port ${port} is already used by server PID ${taken.pid}. Pick another port or stop that run (only this tool's own runs are stopped by mission_server stop).`, true);
          if (mine(portDir(port)).length) return text(`A mission_server run on port ${port} is still running: stop it first.`, true);

          const profile = join(portDir(port), "server");
          mkdirSync(profile, { recursive: true });
          mkdirSync(SERVER_DOWNLOAD_DIR, { recursive: true });
          const args = serverArgs(run, profile, a.extraArgs);
          const started = Date.now();
          const pid = spawnDetached(exe, args, config.serverPath);
          const instance = join(profile, INSTANCE_FILE);
          writeInstance(instance, {
            kind: "server", name: `mission-${port}`, pid, ownerPid: OWNER.pid, ownerStartedAt: OWNER.startedAt, startedAt: started, exe, port, profileDir: profile,
          });
          watchStarted({ pid, kind: "server", instance, logsRoot: join(profile, "logs") }, config);
          writeFileSync(join(portDir(port), "run.json"), JSON.stringify(run, null, 2));
          const serverPinned = run.cpu ? limitProcess(pid, run.cpu.server) : undefined;
          if (run.cpu && !serverPinned) {
            // An unpinned server would let the clients share its cores (run 2): end it and start nothing else.
            const stopped = await stopOwn(port, [{ pid }], false);
            return text(`**Server stopped**: serverCpuMask 0x${run.cpu.server.toString(16)} could not be applied to server PID ${pid}.${stopped} No peers were started.${runReport(port)}`, true);
          }
          const w = await waitFor({
            log: () => resolveLogFile({ dir: profile, file: "console", newerThan: started - 5000 }),
            patterns: [{ name: "online", regex: ONLINE }],
            failPatterns: DEFAULT_FAIL_PATTERNS,
            from: "start",
            pid,
            timeoutMs: a.timeoutSec * 1000,
          });
          const cpuNote = run.cpu
            ? `\nCPU: server 0x${run.cpu.server.toString(16)} ${serverPinned ? "applied" : "NOT applied"}, clients 0x${run.cpu.client.toString(16)}, BelowNormal`
            : "";
          const head = `Server PID ${pid} on 127.0.0.1:${port}\nCommand: ${basename(exe)} ${args.join(" ")}\nLog: ${w.file ?? "(none yet)"}${cpuNote}`;
          if (w.status !== "matched") {
            const why = w.status === "failed" ? "stopped on: the log line below" : w.status === "exited" ? "the server exited" : `not online within ${a.timeoutSec} s`;
            const failLine = w.status === "failed" ? `\n\n${fenced(w.fatal[0].line.trim())}` : "";
            const ended = w.status === "exited" ? await exitedStates(portDir(port), [pid], started) : "";
            return text(`**Server not ready** (${why}). No peers started.${isAlive(pid) ? " It is still running: mission_server stop." : ""}${failLine}\n\n${head}${ended}${runReport(port)}`, true);
          }
          const peers: string[] = [];
          const startedPeers: { n: number; pid: number }[] = [];
          const offset = statSync(w.file!).size;
          for (let i = 0; i < a.peers; i++) {
            const p = startPeer(run, config);
            if (typeof p === "string") {
              const stopped = await stopOwn(port, startedPeers);
              return text(`**Server online**, but a peer could not start: ${p}${stopped}\n\n${head}\n${peers.join("\n")}${runReport(port)}`, true);
            }
            startedPeers.push(p);
            if (p.pinned === false) {
              const stopped = await stopOwn(port, startedPeers);
              return text(`**Server online**, but clientCpuMask 0x${run.cpu!.client.toString(16)} could not be applied to peer ${p.n} (PID ${p.pid}).${stopped}\n\n${head}\n${peers.join("\n")}${runReport(port)}`, true);
            }
            peers.push(`Peer ${p.n}: PID ${p.pid}${p.pinned === undefined ? "" : " (pinned)"}`);
            await sleep(2000);
          }
          if (a.peers === 0 && isAlive(pid)) await sleep(SETTLE_MS);
          const joined = a.peers > 0 && (await waitPlayers(w.file!, offset, a.peers, pid, a.joinTimeoutSec));
          // Before stopOwn: the peers it ends itself are not "exited" waits.
          const ended = a.peers > 0 && !joined ? await exitedStates(portDir(port), [pid, ...startedPeers.map((p) => p.pid)], started) : "";
          const stopped = a.peers > 0 && !joined ? await stopOwn(port, startedPeers) : "";
          const joinLine = a.peers === 0 ? "" : joined
            ? `\nAll ${a.peers} peer(s) joined (Players connected: ${a.peers}).`
            : `\nNot all peers joined within ${a.joinTimeoutSec} s: players connected ${playersConnected(readFileSync(w.file!, "utf-8"))} of ${a.peers}.${stopped}`;
          return text(
            `**Server online** after ${w.elapsedSec.toFixed(0)} s, matched log line:\n${fenced(w.matched[0].line.trim())}${run.header ? "" : "\nNo Mission Header: the world started without one."}${joinLine}\n\n${head}` +
              (peers.length ? `\n\n${peers.join("\n")}\nPeer command: ArmaReforgerSteamDiag.exe ${peerArgs(run, "<peer profile>").join(" ")}` : "") + ended + runReport(port),
            a.peers > 0 && !joined
          );
        }

        if (a.action === "join") {
          const run = readRun(port);
          const srv = mine(portDir(port)).find((e) => e.inst?.kind === "server" && e.cls === "own");
          if (!run || !srv) return text(`No mission_server run of this MCP session on port ${port}.`, true);
          const log = resolveLogFile({ dir: join(portDir(port), "server"), file: "console" });
          if (!log) return text(`No server log for port ${port} yet.`, true);
          const serverText = readFileSync(log, "utf-8");
          const before = playersConnected(serverText);
          // A hung server, or an earlier peer that is hung or not counted, would only add load to a stuck run (2026-11-02 run 2).
          const problems = peerProblems(before, peerStates(port), serverText);
          if (problems.length) return text(`join refused: ${problems.join("; ")}. No client was started; mission_server stop ends this run.`, true);
          const offset = statSync(log).size;
          const since = Date.now();
          const p = startPeer(run, config);
          if (typeof p === "string") return text(`${p}${runReport(port)}`, true);
          if (p.pinned === false) {
            const stopped = await stopOwn(port, [p]);
            return text(`clientCpuMask 0x${run.cpu!.client.toString(16)} could not be applied to the new peer ${p.n} (PID ${p.pid}).${stopped}${runReport(port)}`, true);
          }
          const joined = await waitPlayers(log, offset, before + 1, srv.proc.pid, a.joinTimeoutSec);
          const ended = joined ? "" : await exitedStates(portDir(port), [p.pid, srv.proc.pid], since);
          const stopped = joined ? "" : await stopOwn(port, [p]);
          return text(
            (joined
              ? `**Peer ${p.n} joined** (PID ${p.pid}): players connected ${before + 1}.`
              : `**Peer ${p.n} did not join** within ${a.joinTimeoutSec} s (PID ${p.pid}): players connected ${playersConnected(readFileSync(log, "utf-8"))}.${stopped}`) +
              `\nCommand: ArmaReforgerSteamDiag.exe ${p.args.join(" ")}` + ended + runReport(port),
            !joined
          );
        }

        if (a.action === "status") {
          const entries = mine();
          const ports = existsSync(MISSION_ROOT) ? readdirSync(MISSION_ROOT).filter((d) => /^\d+$/.test(d)) : [];
          const rows = ports.map((port) => {
            const log = resolveLogFile({ dir: join(MISSION_ROOT, port, "server"), file: "console" });
            const t = log ? readFileSync(log, "utf-8") : "";
            const players = `, players connected ${playersConnected(t)}`;
            const game = GAME_STATE.test(t) ? `online, GAME reached${players}` : ONLINE.test(t) ? `online (no GAME state: a lobby game mode waits for players)${players}` : "not online";
            const live = entries.filter((e) => e.file && isUnder(e.file, join(MISSION_ROOT, port)));
            return (live.length
              ? `- port ${port}: ${live.length} process(es) running, ${game}${log ? `, log ${log}` : ""}`
              : `- port ${port}: nothing running; last run was ${game}${log ? `, log ${log}` : ""}`) + procWatchLines({ root: join(MISSION_ROOT, port) }).map((l) => `\n${l}`).join("") + runReport(Number(port));
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
