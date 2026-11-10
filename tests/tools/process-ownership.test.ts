import { afterAll, afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProcInfo } from "../../src/utils/process.js";

// A fake home before any module loads: the watcher state folder and the instance registry are temp folders.
const home = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "emcp-own-home-"));
  process.env.USERPROFILE = process.env.HOME = h;
  return h;
});
afterAll(() => rmSync(home, { recursive: true, force: true }));

// No real process is listed, signalled, started or killed: the process helpers are replaced.
const procs = vi.hoisted(() => ({ servers: [] as ProcInfo[], clients: [] as ProcInfo[], alive: new Set<number>(), ignorePolite: false, cimFails: false, running: [] as number[] }));
// The real startProcWatcher runs, but its spawn is recorded here and the platform is set per test: no watcher process starts.
const watch = vi.hoisted(() => ({ spawns: [] as { args: string[]; instanceThere: boolean }[], platform: "win32" }));
vi.mock("../../src/watchdog/proc-watch.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/watchdog/proc-watch.js")>();
  const fs = await import("node:fs");
  return {
    ...actual,
    startProcWatcher: (w: Parameters<typeof actual.startProcWatcher>[0], spawn?: Parameters<typeof actual.startProcWatcher>[1], platform?: string) =>
      actual.startProcWatcher(w, spawn ?? ((_exe, args) => (watch.spawns.push({ args, instanceThere: fs.existsSync(w.instance) }), 7777)), platform ?? watch.platform),
  };
});
vi.mock("../../src/utils/process.js", async (orig) => ({
  ...(await orig<typeof import("../../src/utils/process.js")>()),
  serverProcesses: () => procs.servers,
  clientProcesses: () => procs.clients,
  processInfo: (pid: number) => (procs.cimFails ? undefined : [...procs.servers, ...procs.clients].find((p) => p.pid === pid)),
  isAlive: (pid: number) => procs.alive.has(pid),
  findPids: () => procs.running,
  spawnDetached: vi.fn(() => 424242),
  killPids: vi.fn((pids: number[], force?: boolean) => {
    if (force || !procs.ignorePolite) pids.forEach((p) => procs.alive.delete(p));
  }),
  sleep: () => Promise.resolve(),
}));

// The shared client logs root lives under this folder; tests set it.
const games = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../src/utils/game-paths.js", async (orig) => ({ ...(await orig<typeof import("../../src/utils/game-paths.js")>()), myGamesDir: () => games.dir }));

const { killPids, spawnDetached } = await import("../../src/utils/process.js");
const { INSTANCE_FILE, OWNER, pidInstanceFile, writeInstance } = await import("../../src/utils/instances.js");
const { PROC_WATCH_DIR } = await import("../../src/watchdog/proc-watch.js");
const { MISSION_ROOT } = await import("../../src/tools/mission-server.js");
const { crashLogsDir } = await import("../../src/workbench/cli.js");
const { registerServer } = await import("../../src/tools/server.js");
const { registerGame } = await import("../../src/tools/game.js");
const { loadConfig } = await import("../../src/config.js");

type Result = { content: { text: string }[]; isError?: boolean };
function tool(register: (s: McpServer, c: ReturnType<typeof loadConfig>) => void, config: ReturnType<typeof loadConfig>) {
  let handler!: (a: Record<string, unknown>) => Promise<Result>;
  register({ registerTool: (_n: string, _d: unknown, h: typeof handler) => { handler = h; } } as unknown as McpServer, config);
  return handler;
}

const now = Date.now();
// Lines 337-347 of a real ConflictGen19 server console.log, then a second block in the server form (no blank lines, the stack ends at the next timestamped line).
const VME_LOG = [
  "Log C:/x/logs_2026-11-09_12-14-01/console.log started at 2026-11-09 12:14:01 (2026-11-09 17:14:01 UTC)",
  "12:14:03.000 DEFAULT      : Entered online game state.",
  "12:14:18.032 SCRIPT    (E): Virtual Machine Exception",
  "",
  "Reason: NULL pointer to instance",
  "",
  "Class:      'SCR_CampaignMilitaryBaseComponent'",
  "Function: 'OnAllBasesInitialized'",
  "Stack trace:",
  "Scripts/Game/Components/Locations/SCR_CampaignMilitaryBaseComponent.c:2357 Function OnAllBasesInitialized",
  "Scripts/Game/Campaign/SCR_CampaignMilitaryBaseManager.c:274 Function OnAllBasesInitialized",
  "Scripts/Game/GameMode/SCR_GameModeCampaign.c:610 Function Start",
  "Scripts/Game/GameMode/SCR_GameModeCampaign.c:946 Function OnGameStart",
  "12:14:19.000 ENGINE       : after the first block",
  "12:14:40.500 SCRIPT    (E): Virtual Machine Exception",
  "Reason: Division by zero",
  "Class:      'SCR_Other'",
  "Function: 'Tick'",
  "Stack trace:",
  "Scripts/Game/SCR_Other.c:12 Function Tick",
  "12:14:41.000 ENGINE       : after the second block",
].join("\r\n");
const CRASH_LOG = Array.from({ length: 60 }, (_, i) => (i === 4 ? "Reason: Access violation" : `crash-line-${i + 1}`)).join("\n");
const expectReport = (t: string) => {
  expect(t).toContain("**Script exceptions in this run: 2**");
  expect(t).toContain("Reason: NULL pointer to instance\nClass: SCR_CampaignMilitaryBaseComponent\nFunction: OnAllBasesInitialized\nScripts/Game/Components/Locations/SCR_CampaignMilitaryBaseComponent.c:2357 Function OnAllBasesInitialized");
  expect(t).toMatch(/\*\*crash\.log\*\* [^\n]*crash\.log\n```\n(?:[^\n]*\n)*Reason: Access violation\n/);
  expect(t).toContain("crash-line-40\n");
  expect(t).not.toContain("crash-line-41");
};
const expectClean = (t: string) => {
  expect(t).not.toContain("Script exceptions in this run");
  expect(t).not.toContain("**crash.log**");
};
const own = { ownerPid: OWNER.pid, ownerStartedAt: OWNER.startedAt, startedAt: now, name: "default", exe: "x.exe" };

beforeEach(() => {
  vi.mocked(killPids).mockClear();
  procs.alive = new Set();
  procs.ignorePolite = false;
  procs.cimFails = false;
  procs.running = [];
  watch.spawns = [];
  watch.platform = "win32";
  vi.mocked(spawnDetached).mockClear();
});
afterEach(() => rmSync(PROC_WATCH_DIR, { recursive: true, force: true }));

describe("server stop", () => {
  it("stops only the server this MCP started", async () => {
    const config = { ...loadConfig(), serverProfilePath: mkdtempSync(join(tmpdir(), "emcp-srv-")) };
    writeInstance(join(config.serverProfilePath, INSTANCE_FILE), { kind: "server", pid: 100, ...own });
    procs.servers = [
      { pid: 100, ppid: 1, cmd: `ArmaReforgerServerDiag.exe -profile "${config.serverProfilePath}"`, created: now },
      { pid: 200, ppid: 1, cmd: "ArmaReforgerServerDiag.exe -profile C:\\other-session", created: now },
    ];
    procs.alive = new Set([100, 200]);
    const result = await tool(registerServer, config)({ action: "stop", graceSec: 0 });
    expect(result.isError).toBeUndefined();
    expect(vi.mocked(killPids).mock.calls.flatMap(([pids]) => pids)).toEqual([100]);
    expect(result.content[0].text).toContain("Not touched: 1 server(s)");
    expect(procs.alive.has(200)).toBe(true);
    expect(existsSync(join(config.serverProfilePath, INSTANCE_FILE))).toBe(false);
  });

  it("force-kills its own server after the grace time when the close request is ignored", async () => {
    const config = { ...loadConfig(), serverProfilePath: mkdtempSync(join(tmpdir(), "emcp-srv-")) };
    writeInstance(join(config.serverProfilePath, INSTANCE_FILE), { kind: "server", pid: 100, ...own });
    procs.servers = [{ pid: 100, ppid: 1, cmd: `ArmaReforgerServerDiag.exe -profile "${config.serverProfilePath}"`, created: now }];
    procs.alive = new Set([100]);
    procs.ignorePolite = true;
    const result = await tool(registerServer, config)({ action: "stop", graceSec: 0 });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain("forced after 0 s grace");
    expect(vi.mocked(killPids).mock.calls).toEqual([[[100], false, true], [[100], true, true]]);
  });

  it("keeps its instance file and kills nothing when the process query fails during stop", async () => {
    const config = { ...loadConfig(), serverProfilePath: mkdtempSync(join(tmpdir(), "emcp-srv-")) };
    writeInstance(join(config.serverProfilePath, INSTANCE_FILE), { kind: "server", pid: 100, ...own });
    procs.servers = [{ pid: 100, ppid: 1, cmd: `ArmaReforgerServerDiag.exe -profile "${config.serverProfilePath}"`, created: now }];
    procs.alive = new Set([100]);
    procs.ignorePolite = true;
    procs.cimFails = true;
    const result = await tool(registerServer, config)({ action: "stop", graceSec: 0 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("still running");
    expect(vi.mocked(killPids).mock.calls).toEqual([[[100], false, true]]);
    expect(existsSync(join(config.serverProfilePath, INSTANCE_FILE))).toBe(true);
  });

  it("with only foreign servers running, kills nothing even with force", async () => {
    const config = { ...loadConfig(), serverProfilePath: mkdtempSync(join(tmpdir(), "emcp-srv-")) };
    procs.servers = [{ pid: 200, ppid: 1, cmd: "ArmaReforgerServerDiag.exe -profile C:\\other-session", created: now }];
    procs.alive = new Set([200]);
    const result = await tool(registerServer, config)({ action: "stop", force: true, graceSec: 10 });
    expect(result.content[0].text).toContain("No server started by this MCP is running");
    expect(killPids).not.toHaveBeenCalled();
  });
});

describe("game stop", () => {
  it("closes the MCP's client and leaves the user's own game alone", async () => {
    const config = { ...loadConfig(), clientProfilesRoot: mkdtempSync(join(tmpdir(), "emcp-cli-")) };
    writeInstance(pidInstanceFile(config.clientProfilesRoot, 300), { kind: "client", pid: 300, ...own });
    procs.clients = [
      { pid: 300, ppid: 1, cmd: "ArmaReforgerSteamDiag.exe -client 127.0.0.1", created: now },
      { pid: 400, ppid: 1, cmd: "ArmaReforgerSteam.exe", created: now },
    ];
    procs.alive = new Set([300, 400]);
    const result = await tool(registerGame, config)({ action: "stop", force: true });
    expect(result.isError).toBeUndefined();
    expect(vi.mocked(killPids).mock.calls.flatMap(([pids]) => pids)).toEqual([300]);
    expect(procs.alive.has(400)).toBe(true);
    expect(result.content[0].text).toContain("Not touched: 1 game client(s)");
  });
});


describe("game status script error report", () => {
  const stamp = (ms: number) => {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, "0");
    return `logs_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  };
  /** The shared logs root holds an older client's folder and a later one; the MCP's own client started at `now`, its folder 2 s after. */
  const status = async (vme: boolean) => {
    const gamesDir = mkdtempSync(join(tmpdir(), "emcp-games-"));
    games.dir = gamesDir;
    const logs = join(gamesDir, "ArmaReforger", "logs");
    const put = (ms: number, log: string, crash?: string) => {
      mkdirSync(join(logs, stamp(ms)), { recursive: true });
      writeFileSync(join(logs, stamp(ms), "console.log"), log);
      if (crash) writeFileSync(join(logs, stamp(ms), "crash.log"), crash);
    };
    put(now - 3600_000, VME_LOG, "OLD-CLIENT-CRASH\n");
    put(now + 2000, vme ? VME_LOG : "12:00:00.000 DEFAULT      : ok\r\n", vme ? CRASH_LOG : undefined);
    put(now + 60_000, VME_LOG, "LATER-CLIENT-CRASH\n");
    const config = { ...loadConfig(), clientProfilesRoot: mkdtempSync(join(tmpdir(), "emcp-cli-")) };
    writeInstance(pidInstanceFile(config.clientProfilesRoot, 300), { kind: "client", pid: 300, ...own });
    procs.clients = [{ pid: 300, ppid: 1, cmd: "ArmaReforgerSteamDiag.exe -client 127.0.0.1", created: now }];
    return (await tool(registerGame, config)({ action: "status" })).content[0].text;
  };

  it("prints the report of the log folder named within 10 s after the client's start, not an older or later client's", async () => {
    const t = await status(true);
    expectReport(t);
    expect(t).toContain("**Client pid 300**");
    expect(t).not.toContain("OLD-CLIENT-CRASH");
    expect(t).not.toContain("LATER-CLIENT-CRASH");
  });

  it("prints nothing new for a clean client log", async () => {
    expectClean(await status(false));
  });
});


/** A watcher state file as the watcher writes it, into the watch folder the tools read. */
let stateSeq = 0;
function putState(instance: string, over: Record<string, unknown> = {}) {
  const s = {
    pid: 31820, kind: "client", instance, ownerPid: 99999, watcherPid: 4242, state: "ended_vme", since: Date.now(), samples: 3, updated: Date.now(),
    dialog: { title: "Virtual machine exception", text: "NULL pointer to instance" }, saved: "C:\\crash\\client_x", ...over,
  };
  mkdirSync(PROC_WATCH_DIR, { recursive: true });
  writeFileSync(join(PROC_WATCH_DIR, `${s.pid}_${stateSeq++}.json`), JSON.stringify(s));
}
const HOUR = 3600_000;
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

describe("game launch: the process watcher", () => {
  /** A game folder holding both exes, a clients root, and a shared logs root under the fake My Games folder. */
  function rig(name: string) {
    const base = mkdtempSync(join(tmpdir(), `emcp-gw-${name}-`));
    games.dir = join(base, "mygames");
    const config = { ...loadConfig(), gamePath: join(base, "game"), clientProfilesRoot: join(base, "clients"), packedPath: join(base, "packed") };
    mkdirSync(config.gamePath, { recursive: true });
    writeFileSync(join(config.gamePath, "ArmaReforgerSteam.exe"), "");
    writeFileSync(join(config.gamePath, "ArmaReforgerSteamDiag.exe"), "");
    return { config, base, launch: tool(registerGame, config) };
  }

  it("starts one watcher per launch, for both exes: the PID, its instance file (already written), this MCP, the logs root and the kind", async () => {
    const { config, launch } = rig("a");
    for (const extra of [{}, { connect: "127.0.0.1:2001" }]) {
      watch.spawns = [];
      const r = await launch({ action: "launch", lines: 80, ...extra });
      expect(r.isError).toBeUndefined();
      expect(watch.spawns).toHaveLength(1);
      const { args, instanceThere } = watch.spawns[0];
      expect(instanceThere).toBe(true);
      expect([flag(args, "--pid"), flag(args, "--kind"), flag(args, "--instance"), flag(args, "--owner-pid"), flag(args, "--owner-started"), flag(args, "--logs-root"), flag(args, "--state-dir")])
        .toEqual(["424242", "client", pidInstanceFile(config.clientProfilesRoot, 424242), String(OWNER.pid), String(OWNER.startedAt), join(games.dir, "ArmaReforger", "logs"), PROC_WATCH_DIR]);
      expect(args.includes("--crash-dir") ? flag(args, "--crash-dir") : undefined).toBe(crashLogsDir(config));
    }
  });

  it("a {GUID}path .conf mission header goes as -server with -noThrow; a .ent world still goes as -world", async () => {
    const { launch } = rig("hdr");
    const argv = () => vi.mocked(spawnDetached).mock.calls.at(-1)![1] as string[];
    const header = "{0123456789ABCDEF}Missions/Test.conf";
    expect((await launch({ action: "launch", lines: 80, world: header })).isError).toBeUndefined();
    expect(flag(argv(), "-server")).toBe(header);
    expect(argv()).toContain("-noThrow");
    expect(argv()).not.toContain("-world");
    expect((await launch({ action: "launch", lines: 80, world: "worlds/MP/MPTest.ent" })).isError).toBeUndefined();
    expect(flag(argv(), "-world")).toBe("worlds/MP/MPTest.ent");
    expect(argv()).toContain("-noThrow");
    expect(argv()).not.toContain("-server");
  });

  it("refuses a path-only mission header, or one with .., before anything is spawned, and says why", async () => {
    const { launch } = rig("hdr2");
    for (const world of ["Missions/Test.conf", "{0123456789ABCDEF}Missions/../Test.conf"]) {
      const r = await launch({ action: "launch", lines: 80, world });
      expect(r.isError, world).toBe(true);
      expect(r.content[0].text).toContain("path-only resource name crashes or is ignored");
    }
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(watch.spawns).toEqual([]);
  });

  it("starts none for a launch that is refused or fails before the instance file is written", async () => {
    const { config, launch } = rig("b");
    const noExe = tool(registerGame, { ...config, gamePath: join(config.gamePath, "nowhere") });
    const refused: [string, () => Promise<Result>][] = [
      ["extraArgs", () => launch({ action: "launch", lines: 80, extraArgs: ["-profile", "x"] })],
      ["connect", () => launch({ action: "launch", lines: 80, connect: "-createDB" })],
      ["world", () => launch({ action: "launch", lines: 80, world: "../x.ent" })],
      ["addon not packed", () => launch({ action: "launch", lines: 80, addons: ["Missing"] })],
      ["no exe", () => noExe({ action: "launch", lines: 80 })],
    ];
    for (const [why, run] of refused) expect((await run()).isError, why).toBe(true);
    procs.running = [5]; // the game is already running
    const busy = await launch({ action: "launch", lines: 80 });
    expect(busy.content[0].text).toContain("already running");
    expect(spawnDetached).not.toHaveBeenCalled();
    expect(watch.spawns).toEqual([]);
  });

  it("starts none when the instance file cannot be written, although the client was spawned", async () => {
    const { config, launch } = rig("c");
    writeFileSync(config.clientProfilesRoot, "a file where the clients folder goes");
    const r = await launch({ action: "launch", lines: 80 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("game launch failed");
    expect(spawnDetached).toHaveBeenCalledTimes(1);
    expect(watch.spawns).toEqual([]);
  });

  it("on a platform other than Windows starts no watcher and the launch reply is the same", async () => {
    const { launch } = rig("d");
    const onWindows = (await launch({ action: "launch", lines: 80 })).content[0].text;
    expect(watch.spawns).toHaveLength(1);
    watch.spawns = [];
    watch.platform = "linux";
    expect((await launch({ action: "launch", lines: 80 })).content[0].text).toBe(onWindows);
    expect(watch.spawns).toEqual([]);
  });

  it("a watcher that cannot start does not fail the launch", async () => {
    const { config, launch } = rig("e");
    mkdirSync(join(PROC_WATCH_DIR, ".."), { recursive: true });
    writeFileSync(PROC_WATCH_DIR, "a file where the state folder goes");
    const r = await launch({ action: "launch", lines: 80 });
    rmSync(PROC_WATCH_DIR);
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("**Game launched** (pid 424242)");
    expect(existsSync(pidInstanceFile(config.clientProfilesRoot, 424242))).toBe(true);
    // B-176: the reply says why, in one line, as mission_server does.
    expect(r.content[0].text.match(/^No process watcher: .+$/gm)).toHaveLength(1);
    expect(r.content[0].text).toMatch(/\nNo process watcher: [^\n]*mkdir/);
  });

  it("a launch whose watcher starts has no watcher line (B-176)", async () => {
    const { launch } = rig("f");
    const r = await launch({ action: "launch", lines: 80 });
    expect(watch.spawns).toHaveLength(1);
    expect(r.content[0].text).not.toContain("No process watcher");
  });
});

describe("game status: the process watcher states", () => {
  it("shows the last 24 h of blocked_dialog, ending_vme, ended_vme and end_failed states under the clients folder, and nothing else", async () => {
    const config = { ...loadConfig(), clientProfilesRoot: mkdtempSync(join(tmpdir(), "emcp-gs-")) };
    games.dir = mkdtempSync(join(tmpdir(), "emcp-gs-games-"));
    procs.clients = [];
    procs.alive = new Set([4242]);
    const mine = (pid: number) => pidInstanceFile(config.clientProfilesRoot, pid);
    const now = Date.now();
    // Shown: live blocked and ending states, final states with a dead watcher, one written by an earlier MCP process (another owner), one 23 h old.
    putState(mine(1001), { pid: 1001, state: "blocked_dialog", dialog: { title: "Script Authorization Required", text: "x" }, why: "not ended: it was not started by this MCP session", saved: undefined });
    putState(mine(1002), { pid: 1002, state: "ending_vme" });
    putState(mine(1003), { pid: 1003, watcherPid: 4343, ownerPid: 12345 });
    putState(mine(1004), { pid: 1004, watcherPid: 4343, state: "end_failed", saved: undefined });
    putState(mine(1005), { pid: 1005, watcherPid: 4343, updated: now - 23 * HOUR });
    // Not shown: 25 h old; another tool's root (a mission_server run, the server profile, a sibling folder with the same name start); a non-final state whose watcher is dead; watching and exited; damaged fields.
    putState(mine(2001), { pid: 2001, watcherPid: 4343, updated: now - 25 * HOUR });
    putState(join(MISSION_ROOT, "2521", "peer1", INSTANCE_FILE), { pid: 2002 });
    putState(join(home, ".enfusion-mcp", "server-profile", INSTANCE_FILE), { pid: 2003, kind: "server" });
    putState(join(`${config.clientProfilesRoot}-other`, `2004.${INSTANCE_FILE}`), { pid: 2004 });
    putState(mine(2005), { pid: 2005, watcherPid: 4343, state: "blocked_dialog" });
    putState(mine(2006), { pid: 2006, watcherPid: 4343, state: "ending_vme" });
    putState(mine(2007), { pid: 2007, state: "watching" });
    putState(mine(2008), { pid: 2008, state: "exited" });
    putState(mine(2009), { pid: 2009, updated: null });
    putState("relative\\2010.emcp-instance.json", { pid: 2010 });
    const t = (await tool(registerGame, config)({ action: "status" })).content[0].text;
    for (const pid of [1001, 1002, 1003, 1004, 1005]) expect(t, String(pid)).toContain(`client PID ${pid},`);
    for (const pid of [2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009, 2010]) expect(t, String(pid)).not.toContain(`PID ${pid},`);
    expect(t).toContain('blocked by a dialog "Script Authorization Required", not ended: it was not started by this MCP session');
    expect(t).toContain('ended after a VM exception window "Virtual machine exception" stayed open; logs saved to C:\\crash\\client_x');
  });

  it("the description says a VM exception window on a client it launched ends that client and its logs are saved", () => {
    let def!: { description: string };
    registerGame({ registerTool: (_n: string, d: typeof def) => { def = d; } } as unknown as McpServer, loadConfig());
    expect(def.description).toMatch(/VM exception window stays open on it, that process \(and only that one\) is ended and its logs are saved/);
  });
});
