import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";

// A fake home before any module loads, so MISSION_ROOT and the watcher state folder are temp folders (MCP-0095); processes, kills and spawns are stubs.
const home = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "emcp-ms-home-"));
  process.env.USERPROFILE = process.env.HOME = h;
  return h;
});

const sys = vi.hoisted(() => ({
  servers: [] as { pid: number; ppid: number; cmd: string; created: number }[],
  clients: [] as { pid: number; ppid: number; cmd: string; created: number }[],
  killed: [] as number[],
  spawned: [] as string[][],
  onSpawn: undefined as undefined | ((args: string[], pid: number) => void),
  pids: [] as number[],
  limited: [] as [number, number][],
  failPins: new Set<number>(),
  freeBytes: 64 * 2 ** 30,
  cores: 16,
  /** Every sleep(500) is one poll of the wait after an exit; onPoll runs inside it with the poll's number. */
  polls: 0,
  onPoll: undefined as undefined | ((n: number) => void),
  /** Every other sleep (the settle, the pause between peers): recorded, and onSleep runs inside it with its length. */
  sleeps: [] as number[],
  onSleep: undefined as undefined | ((ms: number) => void),
  // The real startProcWatcher runs with this spawn: it records the watcher's argv and starts nothing.
  watcherSpawns: [] as { args: string[]; instanceThere: boolean }[],
  /** When set, the watcher's spawn throws this (spawnDetached throws when the child has no PID). */
  watcherThrows: undefined as undefined | string,
  platform: "win32",
}));
vi.mock("../../src/watchdog/proc-watch.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/watchdog/proc-watch.js")>();
  const fs = await import("node:fs");
  return {
    ...actual,
    startProcWatcher: (w: Parameters<typeof actual.startProcWatcher>[0], spawn?: Parameters<typeof actual.startProcWatcher>[1], platform?: string) =>
      actual.startProcWatcher(w, spawn ?? ((_exe, args) => {
        if (sys.watcherThrows) throw new Error(sys.watcherThrows);
        sys.watcherSpawns.push({ args, instanceThere: fs.existsSync(w.instance) });
        return 7777;
      }), platform ?? sys.platform),
  };
});
// Free RAM is a stub; the rest of node:os (tmpdir, homedir) is real.
vi.mock("node:os", async (orig) => {
  const actual = await orig<typeof import("node:os")>();
  const stubs = { freemem: () => sys.freeBytes, availableParallelism: () => sys.cores, platform: () => sys.platform };
  return { ...actual, ...stubs, default: { ...actual, ...stubs } };
});
vi.mock("../../src/utils/process.js", async (orig) => ({
  ...(await orig<typeof import("../../src/utils/process.js")>()),
  serverProcesses: () => sys.servers,
  clientProcesses: () => sys.clients,
  killPids: (pids: number[]) => sys.killed.push(...pids),
  isAlive: (pid: number) => !sys.killed.includes(pid),
  findPids: () => [],
  spawnDetached: (_exe: string, args: string[]) => {
    const pid = sys.pids.shift() ?? 99999;
    sys.spawned.push(args);
    sys.onSpawn?.(args, pid);
    return pid;
  },
  limitProcess: (pid: number, mask: number) => (sys.limited.push([pid, mask]), !sys.failPins.has(pid)),
  sleep: async (ms: number) => {
    if (ms === 500) {
      sys.polls++;
      sys.onPoll?.(sys.polls);
    } else {
      sys.sleeps.push(ms);
      sys.onSleep?.(ms);
    }
  },
}));

const { planRun, serverArgs, peerArgs, checkExtra, cpuMasks, peerProblems, playersConnected, registerMissionServer, MISSION_ROOT, SETTLE_MS } = await import("../../src/tools/mission-server.js");
const { SERVER_DOWNLOAD_DIR } = await import("../../src/config.js");
const { PROC_WATCH_DIR } = await import("../../src/watchdog/proc-watch.js");
const { INSTANCE_FILE, OWNER } = await import("../../src/utils/instances.js");
const { registerServer } = await import("../../src/tools/server.js");
const { registerGame } = await import("../../src/tools/game.js");
const { logRoots } = await import("../../src/tools/log-watch.js");

type Result = { content: { text: string }[]; isError?: boolean };
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

/** A temp unpacked addon "Test Mission" (space in the path) with a world and its header. */
function addon() {
  const root = mkdtempSync(join(tmpdir(), "emcp-ms-"));
  const dir = join(root, "Test Mission");
  mkdirSync(join(dir, "Worlds", "Map"), { recursive: true });
  mkdirSync(join(dir, "Missions", "Map"), { recursive: true });
  writeFileSync(join(dir, "addon.gproj"), 'GameProject {\n ID "TestMission"\n GUID "1111111111111111"\n}\n');
  const world = join(dir, "Worlds", "Map", "Me_TVT_Test.ent");
  writeFileSync(world, "");
  writeFileSync(join(dir, "Missions", "Map", "Me_1102_TVT1_Test.conf"), 'SCR_MissionHeader {\n World "{AA800BA35E7062AE}Worlds/Map/Me_TVT_Test.ent"\n}');
  writeFileSync(join(dir, "Missions", "Map", "Me_1102_TVT1_Test.conf.meta"), 'MetaFileClass {\n Name "{1234567890ABCDEF}Missions/Map/Me_1102_TVT1_Test.conf"\n}');
  return { root, dir, world };
}
const config = (projectPath: string) => ({ projectPath, serverPath: home, gamePath: home }) as unknown as Config;

beforeEach(() => {
  sys.servers = [];
  sys.clients = [];
  sys.killed = [];
  sys.spawned = [];
  sys.onSpawn = undefined;
  sys.pids = [];
  sys.limited = [];
  sys.failPins = new Set();
  sys.freeBytes = 64 * 2 ** 30;
  sys.cores = 16;
  sys.polls = 0;
  sys.onPoll = undefined;
  sys.sleeps = [];
  sys.onSleep = undefined;
  sys.watcherSpawns = [];
  sys.watcherThrows = undefined;
  sys.platform = "win32";
});
afterEach(() => {
  expect(PROC_WATCH_DIR.startsWith(home), "the delete below must never reach the real home").toBe(true);
  rmSync(PROC_WATCH_DIR, { recursive: true, force: true });
});

describe("mission_server run plan and command lines", () => {
  it("builds the server and peer command lines: header as -server {GUID}path, our port, absolute profiles", () => {
    const t = addon();
    const run = planRun({ world: t.world, port: 2521 }, config(join(t.root, "elsewhere")), () => join(t.root, "Docs", "My Games"));
    if (typeof run === "string") throw new Error(run);
    expect(run).toMatchObject({ world: "Worlds/Map/Me_TVT_Test.ent", header: "{1234567890ABCDEF}Missions/Map/Me_1102_TVT1_Test.conf", addons: ["TestMission"], gproj: join(t.dir, "addon.gproj") });
    // Neither default folder exists here, so the world's own parent folder is added: the addon must be found.
    expect(run.addonsDirs).toEqual([t.root]);
    const profile = join(MISSION_ROOT, "2521", "server");
    expect(serverArgs(run, profile, ["-jobsysShortWorkerCount", "2"])).toEqual([
      "-gproj", join(t.dir, "addon.gproj"), "-server", "{1234567890ABCDEF}Missions/Map/Me_1102_TVT1_Test.conf",
      "-addonsDir", t.root, "-addons", "TestMission", "-addr", "127.0.0.1:2521", "-profile", profile, "-noThrow", "-maxFPS", "60", "-disableCrashReporter", "-addonDownloadDir", SERVER_DOWNLOAD_DIR, "-jobsysShortWorkerCount", "2",
    ]);
    const peer = peerArgs(run, join(MISSION_ROOT, "2521", "peer1"));
    expect(peer.slice(peer.indexOf("-client"), peer.indexOf("-client") + 2)).toEqual(["-client", "127.0.0.1:2521"]);
    expect(peer).toEqual(expect.arrayContaining(["-window", "-forceupdate", "-nofocus", "-rpl-reconnect", "-rpl-timeout-disable"]));
  });

  it("defaults -addonsDir to ENFUSION_ADDONS_DIR when it is set, adding the world's own folder only when missing", () => {
    const t = addon();
    const extra = mkdtempSync(join(tmpdir(), "emcp-ms-mods-"));
    const run = planRun({ world: t.world, port: 2521 }, { projectPath: join(t.root, "elsewhere"), addonsDir: `${t.root}, ${extra}` });
    expect(typeof run !== "string" && run.addonsDirs).toEqual([t.root, extra]);
    expect(planRun({ world: t.world, port: 2521 }, { projectPath: t.root, addonsDir: `${t.root},${join(t.root, "No Such Folder")}` })).toMatch(/existing absolute folders/);
  });

  it("refuses inputs that would break or escape the command line", () => {
    const t = addon();
    const c = config(t.root);
    expect(planRun({ world: "Worlds/Map/Me_TVT_Test.ent", port: 2521 }, c)).toMatch(/existing absolute \.ent/);
    expect(planRun({ world: t.world, port: 2521, addons: ["Test;Evil"] }, c)).toMatch(/addon IDs/);
    expect(planRun({ world: t.world, port: 2521, addonsDirs: ["D:\\My,Mods"] }, c)).toMatch(/without quotes or commas/);
    expect(planRun({ world: t.world, port: 2521, missionHeader: "{1234567890ABCDEF}Missions/../../x.conf" }, c)).toMatch(/must be a \{GUID\}path/);
    // A path-only header is not applied by a dedicated server, so it is refused rather than passed on.
    expect(planRun({ world: t.world, port: 2521, missionHeader: "Missions/Other.conf" }, c)).toMatch(/must be a \{GUID\}path/);
    expect(planRun({ world: t.world, port: 2521, missionHeader: "{1234567890ABCDEF}Missions/Other.conf" }, c)).toMatchObject({ header: "{1234567890ABCDEF}Missions/Other.conf" });
    expect(checkExtra(["-jobsysShortWorkerCount", "2"])).toBeUndefined();
    expect(checkExtra(["-PROFILE", "x"])).toMatch(/may not contain -PROFILE/);
    expect(checkExtra(['-x "y'])).toMatch(/may not contain/);
  });
});

describe("mission_server never points a server at the Workshop cache (B-046)", () => {
  it("refuses -config, -addonsDir, -addonsRepair and -addonsVerify in extraArgs, in any spelling", () => {
    for (const bad of ["-config", "-addonsDir", "-addonsRepair", "-addonsVerify", "-ADDONSREPAIR", "--addonsVerify", "/addonsRepair", "-addonsVerify=1", "–addonsRepair"]) {
      expect(checkExtra([bad])).toMatch(/may not contain/);
    }
    expect(checkExtra(["-addonsRepair"])).toContain("-addonsRepair or -addonsVerify");
  });

  it("serverArgs passes -addonDownloadDir with the MCP's downloads folder; peerArgs does not", () => {
    const run = { port: 2521, gproj: "g.gproj", world: "w.ent", addonsDirs: ["a"], addons: ["x"] };
    const server = serverArgs(run, "p");
    expect(server[server.indexOf("-addonDownloadDir") + 1]).toBe(SERVER_DOWNLOAD_DIR);
    expect(peerArgs(run, "p")).not.toContain("-addonDownloadDir");
  });
});

describe("mission_server start and stop", () => {
  const tool = (c: Config) => {
    let h: (a: Record<string, unknown>) => Promise<Result> = async () => ({ content: [] });
    registerMissionServer({ registerTool: (_n: string, _d: unknown, fn: typeof h) => (h = fn) } as unknown as McpServer, c);
    return h;
  };

  it("refuses a port another server already uses and starts nothing", async () => {
    const t = addon();
    writeFileSync(join(home, "ArmaReforgerServerDiag.exe"), "");
    sys.servers = [{ pid: 4242, ppid: 1, cmd: "ArmaReforgerServerDiag.exe -addr 127.0.0.1:2521 -profile C:\\other", created: 0 }];
    const r = await tool(config(t.root))({ action: "start", world: t.world, port: 2521, peers: 0, timeoutSec: 10 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("already used by server PID 4242");
    expect(sys.spawned).toEqual([]);
  });

  it("join starts one more peer and waits for the server's player count to go up (client half)", async () => {
    // Lines as the 2026-11-02 JailKitTest run logged them.
    expect(playersConnected("01:08:48.165   NETWORK      : Players connected: 1 / 1\r\n01:11:35.079   NETWORK      : Players connected: 2 / 2\r\n")).toBe(2);
    expect(playersConnected("no players yet")).toBe(0);
    const t = addon();
    const port = 2525;
    const serverDir = join(MISSION_ROOT, String(port), "server");
    const log = join(serverDir, "logs", "logs_2026-11-02_01-08-26", "console.log");
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, "01:08:36.211 DEFAULT      : Entered online game state.\r\n01:08:48.165   NETWORK      : Players connected: 1 / 1\r\n");
    writeFileSync(join(serverDir, INSTANCE_FILE), JSON.stringify({ kind: "server", name: `mission-${port}`, pid: 701, ownerPid: OWNER.pid, ownerStartedAt: OWNER.startedAt, startedAt: 1000, exe: "x" }));
    writeFileSync(join(MISSION_ROOT, String(port), "run.json"), JSON.stringify({ port, gproj: join(t.dir, "addon.gproj"), world: "Worlds/Map/Me_TVT_Test.ent", addonsDirs: [t.root], addons: ["TestMission"] }));
    mkdirSync(join(MISSION_ROOT, String(port), "peer1"), { recursive: true });
    writeFileSync(join(home, "ArmaReforgerSteamDiag.exe"), "");
    sys.servers = [{ pid: 701, ppid: 1, cmd: `x.exe -profile "${serverDir}"`, created: 1000 }];
    // The new client "joins": the server logs the engine's count line.
    sys.onSpawn = () => appendFileSync(log, "01:11:35.079   NETWORK      : Players connected: 2 / 2\r\n");
    const r = await tool(config(home))({ action: "join", port });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("**Peer 2 joined** (PID 99999): players connected 2.");
    expect(sys.spawned[0]).toEqual(expect.arrayContaining(["-client", `127.0.0.1:${port}`, "-profile", join(MISSION_ROOT, String(port), "peer2")]));
    const s = await tool(config(home))({ action: "status" });
    expect(s.content[0].text).toContain(`- port ${port}: 1 process(es) running, online, no GAME state yet, players connected 2`);
    expect(s.content[0].text).not.toContain("lobby");
  });

  it("status reads online from the log and says when nothing of a run is still running", async () => {
    const log = join(MISSION_ROOT, "2523", "server", "logs", "logs_2026-11-02_00-19-27");
    mkdirSync(log, { recursive: true });
    writeFileSync(join(log, "console.log"), "00:19:53.459 DEFAULT      : Entered online game state.\r\n");
    const r = await tool(config(home))({ action: "status" });
    expect(r.content[0].text).toContain("- port 2523: nothing running; last run was online, no GAME state yet, players connected 0");
    expect(r.content[0].text).not.toContain("lobby");
  });

  it("stops only its own processes, clients before the server", async () => {
    const own = (pid: number, kind: "server" | "client", dir: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, INSTANCE_FILE), JSON.stringify({ kind, name: `${kind}-${pid}`, pid, ownerPid: OWNER.pid, ownerStartedAt: OWNER.startedAt, startedAt: 1000, exe: "x" }));
      return { pid, ppid: 1, cmd: `x.exe -profile "${dir}"`, created: 1000 };
    };
    const srv = own(501, "server", join(MISSION_ROOT, "2522", "server"));
    const peer = own(502, "client", join(MISSION_ROOT, "2522", "peer1"));
    // Started by this MCP but outside mission_server's folder (a `server start` run): never touched here.
    const other = own(503, "server", join(home, ".enfusion-mcp", "server-profile"));
    // Someone else's client: no instance file.
    const foreign = { pid: 504, ppid: 1, cmd: 'ArmaReforgerSteamDiag.exe -profile "C:\\Users\\x\\Documents\\My Games\\ArmaReforger"', created: 1000 };
    sys.servers = [srv, other];
    sys.clients = [peer, foreign];
    const r = await tool(config(home))({ action: "stop" });
    expect(r.content[0].text).toContain("Stopped 2 of 2");
    expect(sys.killed).toEqual([502, 501]);
    expect(existsSync(join(MISSION_ROOT, "2522", "server", INSTANCE_FILE))).toBe(false);
    expect(existsSync(join(home, ".enfusion-mcp", "server-profile", INSTANCE_FILE))).toBe(true);
  });
});

describe("write-path flags and the other server tools (review MM-SERVER-3)", () => {
  const handler = (register: (s: McpServer, c: Config) => void, c: Config) => {
    let h: (a: Record<string, unknown>) => Promise<Result> = async () => ({ content: [] });
    register({ registerTool: (_n: string, _d: unknown, fn: typeof h) => (h = fn) } as unknown as McpServer, c);
    return h;
  };
  const CRF = "C:\\Arma Reforger Modding\\projects\\Coalition-Reforger-Framework";

  it("mission_server, server start and game launch refuse flags that point writes elsewhere (B1)", async () => {
    for (const bad of [["-logsDir", CRF], ["-ADDONDOWNLOADDIR", "C:\\Arma Reforger\\addons"], ["-addonTempDir=C:\\x"], ["-cfg", "C:\\x.conf"], ["-saveDir", "C:\\x"]]) {
      expect(checkExtra(bad)).toMatch(/may not contain/);
    }
    const c = { ...config(home), serverPath: join(home, "srv"), serverProfilePath: join(home, "prof"), clientProfilesRoot: join(home, "cli") } as Config;
    const srv = await handler(registerServer, c)({ action: "start", extraArgs: ["-logsDir", CRF] });
    expect(srv.isError).toBe(true);
    expect(srv.content[0].text).toContain("extraArgs may not contain -logsDir");
    const game = await handler(registerGame, c)({ action: "launch", extraArgs: ["-profile", CRF], lines: 80 });
    expect(game.isError).toBe(true);
    expect(game.content[0].text).toContain("extraArgs may not contain -profile");
    expect(sys.spawned).toEqual([]);
  });

  it("refusedArg names the flag in every spelling the engine could read (recheck N10)", async () => {
    const { refusedArg } = await import("../../src/utils/process.js");
    const forms = [" -logsDir", "--logsDir", "/logsDir", "-logsDir C:\\x", "-LOGSDIR=C:\\x", "-diagMenu",
      // Recheck 2 N13: more dashes or slashes, a colon value, Unicode dashes, zero-width characters, single quotes.
      "---logsDir", "//logsDir", "-logsDir:C:\\x", "\u2013logsDir", "\u2212profile", "\u200B-logsDir", "-\u200BlogsDir", "'-logsDir'", "\u2018-profile\u2019",
      // Recheck 3 N15: a leading backslash or plus, a comma value, soft hyphen, combining grapheme joiner, Mongolian vowel separator.
      "\\logsDir", "+logsDir", "-logsDir,C:\\x", "\u00AD-logsDir", "-\u034FlogsDir", "\u180E-logsDir",
      // Recheck 4 N2: left-to-right mark, right-to-left override, variation selector 16 inside the name, two-em dash.
      "\u200E-logsDir", "\u202E-logsDir", "-logs\uFE0FDir", "\u2E3AlogsDir"];
    for (const form of forms) expect(refusedArg([form])).toBe(form);
    // Plain values are not flags, even when they spell a flag's name.
    expect(refusedArg(["-maxFPS", "60", "-jobsysShortWorkerCount", "2", "profile", "logsDir"])).toBeUndefined();
  });

  it("game launch checks connect and world before they reach the argv (recheck N12)", async () => {
    const c = { ...config(home), clientProfilesRoot: join(home, "cli") } as Config;
    const game = handler(registerGame, c);
    expect((await game({ action: "launch", connect: '127.0.0.1" -profile "C:\\x', lines: 80 })).content[0].text).toMatch(/^connect must be host or host:port/);
    expect((await game({ action: "launch", world: "worlds/../../x.ent", lines: 80 })).content[0].text).toMatch(/^world must be a \.ent resource path/);
    expect((await game({ action: "launch", world: "C:\\x\\y.ent", lines: 80 })).content[0].text).toMatch(/^world must be a \.ent resource path/);
    // Recheck 2 B2 and N14: a value that starts like a flag, a port out of range, a space, a drive-relative path.
    for (const connect of ["-scriptAuthorizeAll", "-createDB", "127.0.0.1:0", "127.0.0.1:70000"]) {
      expect((await game({ action: "launch", connect, lines: 80 })).content[0].text).toMatch(/^connect must be host or host:port/);
    }
    for (const world of ["-createDB.ent", "worlds/My World.ent", "C:x.ent", "/worlds/x.ent"]) {
      expect((await game({ action: "launch", world, lines: 80 })).content[0].text).toMatch(/^world must be a \.ent resource path/);
    }
    expect(sys.spawned).toEqual([]);
  });

  it("mission_server refuses .. and an absolute path after the GUID in a mission header (B-175)", () => {
    const t = addon();
    const c = config(t.root);
    // Literal strings: path.join would fold the `..` away before the check sees it (MCP-0139).
    const GUID = "{1234567890ABCDEF}";
    for (const h of [`${GUID}../x.conf`, `${GUID}/abs.conf`, `${GUID}Missions/../x.conf`]) {
      expect(planRun({ world: t.world, port: 2521, missionHeader: h }, c), h).toMatch(/must be a \{GUID\}path/);
    }
    expect(planRun({ world: t.world, port: 2521, missionHeader: `${GUID}Missions/Some.conf` }, c)).toMatchObject({ header: `${GUID}Missions/Some.conf` });
  });

  it("game launch refuses .. and an absolute path after the GUID in a mission header (B-175)", async () => {
    const game = handler(registerGame, { ...config(home), clientProfilesRoot: join(home, "cli") } as Config);
    const GUID = "{1234567890ABCDEF}";
    for (const h of [`${GUID}../x.conf`, `${GUID}/abs.conf`, `${GUID}Missions/../x.conf`]) {
      const r = await game({ action: "launch", world: h, lines: 80 });
      expect(r.isError, h).toBe(true);
      expect(r.content[0].text, h).toMatch(/^A mission header must be \{GUID\}path \.conf/);
    }
    expect((await game({ action: "launch", world: `${GUID}Missions/Some.conf`, lines: 80 })).content[0].text).not.toMatch(/^A mission header must be/);
  });

  it("server stop leaves a mission_server run to mission_server (N4); log_watch may read its logs folders (N1)", async () => {
    const write = (pid: number, dir: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, INSTANCE_FILE), JSON.stringify({ kind: "server", name: `s${pid}`, pid, ownerPid: OWNER.pid, ownerStartedAt: OWNER.startedAt, startedAt: 1000, exe: "x" }));
      return { pid, ppid: 1, cmd: `x.exe -profile "${dir}"`, created: 1000 };
    };
    const c = { ...config(home), serverProfilePath: join(home, "srv-profile") } as Config;
    sys.servers = [write(601, join(MISSION_ROOT, "2524", "server")), write(602, c.serverProfilePath)];
    const r = await handler(registerServer, c)({ action: "stop", graceSec: 0 });
    expect(r.content[0].text).toContain("Stopped 1 of 1");
    expect(sys.killed).toEqual([602]);
    expect(logRoots(c)).toContain(join(MISSION_ROOT, "2524", "server", "logs"));
    expect(logRoots(c)).not.toContain(MISSION_ROOT);
  });
});

describe("client gates after the 2026-11-02 freeze (join health, RAM, cores, stopping own peers)", () => {
  const handler = (c: Config) => {
    let h: (a: Record<string, unknown>) => Promise<Result> = async () => ({ content: [] });
    registerMissionServer({ registerTool: (_n: string, _d: unknown, fn: typeof h) => (h = fn) } as unknown as McpServer, c);
    return h;
  };
  const now = () => Date.now();
  const FAIL = "01:23:09.071 ENGINE    (F): Application hangs (force crash) 305 s";

  /** A running server on `port` with `counted` players in its log, and peers (own, alive) whose logs were written ageSec ago. */
  function run(port: number, counted: number, peers: { ageSec: number; log?: string }[], opts: { cpu?: { server: number; client: number }; serverLog?: string } = {}) {
    const t = addon();
    const dir = join(MISSION_ROOT, String(port));
    const serverDir = join(dir, "server");
    const log = join(serverDir, "logs", "logs_x", "console.log");
    mkdirSync(dirname(log), { recursive: true });
    writeFileSync(log, opts.serverLog ?? "00:00:01.000 DEFAULT      : Entered online game state.\r\n" + (counted ?`00:00:09.000   NETWORK      : Players connected: ${counted} / ${counted}\r\n` : ""));
    const inst = (kind: string, name: string, pid: number, profileDir: string) =>
      writeFileSync(join(profileDir, INSTANCE_FILE), JSON.stringify({ kind, name, pid, ownerPid: OWNER.pid, ownerStartedAt: OWNER.startedAt, startedAt: now(), exe: "x", profileDir }));
    inst("server", `mission-${port}`, 701, serverDir);
    writeFileSync(join(dir, "run.json"), JSON.stringify({ port, gproj: join(t.dir, "addon.gproj"), world: "Worlds/Map/Me_TVT_Test.ent", addonsDirs: [t.root], addons: ["TestMission"], cpu: opts.cpu }));
    sys.servers = [{ pid: 701, ppid: 1, cmd: `x.exe -profile "${serverDir}"`, created: now() }];
    sys.clients = [];
    peers.forEach((p, i) => {
      const pd = join(dir, `peer${i + 1}`);
      const pl = join(pd, "logs", "logs_x", "console.log");
      mkdirSync(dirname(pl), { recursive: true });
      writeFileSync(pl, "00:00:02.000 ENGINE       : loading\r\n" + (p.log ?? ""));
      utimesSync(pl, new Date(now() - p.ageSec * 1000), new Date(now() - p.ageSec * 1000));
      inst("client", `mission-${port}-peer${i + 1}`, 710 + i, pd);
      sys.clients.push({ pid: 710 + i, ppid: 1, cmd: `x.exe -profile "${pd}"`, created: now() });
    });
    writeFileSync(join(home, "ArmaReforgerSteamDiag.exe"), "");
    return { t, log };
  }

  it("cpuMasks: both or neither, hex, and no shared core", () => {
    expect(cpuMasks()).toBeUndefined();
    expect(cpuMasks("0x3000", "0x0C00")).toEqual({ server: 0x3000, client: 0xc00 });
    expect(cpuMasks("0x3000")).toMatch(/must both be given/);
    expect(cpuMasks("0x3000", "nonsense")).toMatch(/must both be given/);
    expect(cpuMasks("0x3000", "0x1000")).toMatch(/shares cores/);
  });

  it("peerProblems says which: a failed peer, or fewer counted than running, with each log's age", () => {
    expect(peerProblems(2, [{ n: 1, pid: 5, ageSec: 3 }, { n: 2, pid: 6, ageSec: 3 }])).toEqual([]);
    expect(peerProblems(2, [{ n: 1, pid: 5, ageSec: 3, failLine: FAIL }, { n: 2, pid: 6, ageSec: 3 }])[0]).toContain("peer 1 (PID 5) is hung or crashed: 01:23:09.071 ENGINE    (F): Application hangs");
    const slow = peerProblems(0, [{ n: 1, pid: 5, ageSec: 20 }, { n: 2, pid: 6, ageSec: 250 }, { n: 3, pid: 7 }]);
    expect(slow).toEqual(["the server has counted 0 of 3 earlier peer(s) (peer 1 (PID 5) still loading, log written 20 s ago, peer 2 (PID 6) looks hung, log silent for 250 s, peer 3 (PID 7) has no log)"]);
  });

  it("join refuses while the server has counted fewer players than peers run, and starts nothing (run 2)", async () => {
    run(2531, 0, [{ ageSec: 250 }, { ageSec: 250 }]);
    const r = await handler(config(home))({ action: "join", port: 2531, joinTimeoutSec: 1 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^join refused: the server has counted 0 of 2 earlier peer\(s\) \(peer 1 \(PID 710\) looks hung, log silent for 25\d s/);
    expect(r.content[0].text).toContain("No client was started");
    expect(sys.spawned).toEqual([]);
  });

  it("join refuses a peer whose log shows a hang or crash even when the server counted it", async () => {
    run(2532, 1, [{ ageSec: 5, log: FAIL + "\r\n" }]);
    const r = await handler(config(home))({ action: "join", port: 2532, joinTimeoutSec: 1 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("peer 1 (PID 710) is hung or crashed");
    expect(sys.spawned).toEqual([]);
  });

  it("join starts a client when the earlier peers are counted and healthy", async () => {
    const { log } = run(2533, 1, [{ ageSec: 5 }]);
    sys.pids = [720];
    sys.onSpawn = () => appendFileSync(log, "00:05:00.000   NETWORK      : Players connected: 2 / 2\r\n");
    const r = await handler(config(home))({ action: "join", port: 2533, joinTimeoutSec: 5 });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("**Peer 2 joined** (PID 720)");
  });

  it("no client starts below 4 GB free RAM, in join and in start", async () => {
    run(2534, 0, []);
    sys.freeBytes = 3.5 * 2 ** 30;
    const j = await handler(config(home))({ action: "join", port: 2534, joinTimeoutSec: 1 });
    expect(j.isError).toBe(true);
    expect(j.content[0].text).toBe("Not enough free RAM for another game client: 3.5 GB free, 4 GB needed (about 2 GB per Arma process).");
    expect(sys.spawned).toEqual([]);

    const t = addon();
    writeFileSync(join(home, "ArmaReforgerServerDiag.exe"), "");
    sys.pids = [801];
    sys.onSpawn = (args) => {
      const log = join(args[args.indexOf("-profile") + 1], "logs", "logs_x", "console.log");
      mkdirSync(dirname(log), { recursive: true });
      writeFileSync(log, "00:00:01.000 DEFAULT      : Entered online game state.\r\n");
    };
    const s = await handler(config(home))({ action: "start", world: t.world, port: 2535, peers: 1, addonsDirs: [t.root], timeoutSec: 10, joinTimeoutSec: 1 });
    expect(s.isError).toBe(true);
    expect(s.content[0].text).toContain("**Server online**, but a peer could not start: Not enough free RAM");
    expect(sys.spawned).toHaveLength(1);
  });

  it("start stops only the peers it started when they do not join in time, and leaves the server and others alone", async () => {
    const t = addon();
    writeFileSync(join(home, "ArmaReforgerServerDiag.exe"), "");
    writeFileSync(join(home, "ArmaReforgerSteamDiag.exe"), "");
    sys.pids = [801, 802, 803];
    const foreign = { pid: 900, ppid: 1, cmd: 'ArmaReforgerSteamDiag.exe -profile "C:\\Users\\x\\Documents\\My Games\\ArmaReforger"', created: now() };
    sys.clients = [foreign];
    sys.onSpawn = (args, pid) => {
      const profile = args[args.indexOf("-profile") + 1];
      if (args.includes("-server")) {
        const log = join(profile, "logs", "logs_x", "console.log");
        mkdirSync(dirname(log), { recursive: true });
        writeFileSync(log, "00:00:01.000 DEFAULT      : Entered online game state.\r\n");
      } else sys.clients.push({ pid, ppid: 1, cmd: `x.exe -profile "${profile}"`, created: now() });
    };
    const r = await handler(config(home))({ action: "start", world: t.world, port: 2536, peers: 2, addonsDirs: [t.root], timeoutSec: 10, joinTimeoutSec: 1 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Not all peers joined within 1 s: players connected 0 of 2.");
    expect(r.content[0].text).toContain("Stopped peer 1 (PID 802), peer 2 (PID 803). The server was left running.");
    expect(sys.killed).toEqual([802, 803]);
    expect(existsSync(join(MISSION_ROOT, "2536", "peer1", INSTANCE_FILE))).toBe(false);
    expect(existsSync(join(MISSION_ROOT, "2536", "server", INSTANCE_FILE))).toBe(true);
  });

  it("clients never share the server's cores: refused up front, applied to the server and each client otherwise", async () => {
    const t = addon();
    writeFileSync(join(home, "ArmaReforgerServerDiag.exe"), "");
    writeFileSync(join(home, "ArmaReforgerSteamDiag.exe"), "");
    const go = (extra: Record<string, unknown>) =>
      handler(config(home))({ action: "start", world: t.world, port: 2537, peers: 1, addonsDirs: [t.root], timeoutSec: 10, joinTimeoutSec: 2, ...extra });
    expect((await go({ serverCpuMask: "0x3000", clientCpuMask: "0x1000" })).content[0].text).toMatch(/shares cores/);
    expect((await go({ serverCpuMask: "0x3000" })).content[0].text).toMatch(/must both be given/);
    expect(sys.spawned).toEqual([]);

    sys.pids = [801, 802];
    let serverLog = "";
    sys.onSpawn = (args) => {
      const profile = args[args.indexOf("-profile") + 1];
      if (args.includes("-server")) {
        serverLog = join(profile, "logs", "logs_x", "console.log");
        mkdirSync(dirname(serverLog), { recursive: true });
        writeFileSync(serverLog, "00:00:01.000 DEFAULT      : Entered online game state.\r\n");
      } else appendFileSync(serverLog, "00:00:09.000   NETWORK      : Players connected: 1 / 1\r\n");
    };
    const ok = await go({ serverCpuMask: "0x3000", clientCpuMask: "0x0C00" });
    expect(ok.isError).toBeUndefined();
    expect(sys.limited).toEqual([[801, 0x3000], [802, 0xc00]]);
    expect(ok.content[0].text).toContain("CPU: server 0x3000 applied, clients 0xc00, BelowNormal");
  });

  /** Spawn stub: a server writes its log (online) and shows up as a process; a peer shows up as a process and, if `counted`, joins. */
  function fakeSpawns(counted: boolean) {
    let serverLog = "";
    sys.onSpawn = (args, pid) => {
      const profile = args[args.indexOf("-profile") + 1];
      const proc = { pid, ppid: 1, cmd: `x.exe -profile "${profile}"`, created: now() };
      if (args.includes("-server")) {
        serverLog = join(profile, "logs", "logs_x", "console.log");
        mkdirSync(dirname(serverLog), { recursive: true });
        writeFileSync(serverLog, "00:00:01.000 DEFAULT      : Entered online game state.\r\n");
        sys.servers.push(proc);
      } else {
        sys.clients.push(proc);
        if (counted) appendFileSync(serverLog, "00:00:09.000   NETWORK      : Players connected: 1 / 1\r\n");
      }
    };
  }
  const startWithMasks = (t: { world: string; root: string }, port: number, extra: Record<string, unknown> = {}) => {
    writeFileSync(join(home, "ArmaReforgerServerDiag.exe"), "");
    writeFileSync(join(home, "ArmaReforgerSteamDiag.exe"), "");
    return handler(config(home))({ action: "start", world: t.world, port, peers: 1, addonsDirs: [t.root], timeoutSec: 10, joinTimeoutSec: 2, serverCpuMask: "0x3000", clientCpuMask: "0x0C00", ...extra });
  };

  it("cpuMasks refuses a core this PC does not have (review MM-SERVER-4 B1)", async () => {
    expect(cpuMasks("0x3000", "0x0C00", 16)).toEqual({ server: 0x3000, client: 0xc00 });
    expect(cpuMasks("0x30000", "0x0C00", 16)).toBe("serverCpuMask 0x30000 names core 17, but this PC has 16 logical cores (0 to 15)");
    expect(cpuMasks("0x3000", "0x80000000", 16)).toMatch(/^clientCpuMask 0x80000000 names core 31, but this PC has 16/);
    expect(cpuMasks("0x3000", "0x0C00", 8)).toMatch(/^serverCpuMask 0x3000 names core 13, but this PC has 8 logical cores/);
    // The same through the tool: refused before anything is started.
    const t = addon();
    const r = await startWithMasks(t, 2540, { serverCpuMask: "0x30000" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("names core 17");
    expect(sys.spawned).toEqual([]);
  });

  it("on a platform other than Windows both cpu masks are refused before anything is written or spawned (B-167)", async () => {
    sys.platform = "linux";
    const t = addon();
    const r = await startWithMasks(t, 2541);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe("cpuMask (serverCpuMask, clientCpuMask) works on Windows only");
    expect(sys.spawned).toEqual([]);
    expect(existsSync(join(MISSION_ROOT, "2541"))).toBe(false);
    expect(cpuMasks("0x3000", "0x0C00", 16)).toBe("cpuMask (serverCpuMask, clientCpuMask) works on Windows only");
    expect(cpuMasks(undefined, undefined, 16)).toBeUndefined();
  });

  it("a server that cannot be pinned is ended at once and no peer is started (B1)", async () => {
    const t = addon();
    sys.pids = [801, 802];
    sys.failPins = new Set([801]);
    fakeSpawns(false);
    const r = await startWithMasks(t, 2541);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("**Server stopped**: serverCpuMask 0x3000 could not be applied to server PID 801.");
    expect(r.content[0].text).toContain("Stopped server (PID 801). No peers were started.");
    expect(sys.killed).toEqual([801]);
    expect(sys.spawned).toHaveLength(1);
    expect(existsSync(join(MISSION_ROOT, "2541", "server", INSTANCE_FILE))).toBe(false);
  });

  it("a peer that cannot be pinned is ended at once, in start and in join, and the server keeps running (B1)", async () => {
    const t = addon();
    sys.pids = [801, 802];
    sys.failPins = new Set([802]);
    fakeSpawns(true);
    const r = await startWithMasks(t, 2542);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("clientCpuMask 0xc00 could not be applied to peer 1 (PID 802).");
    expect(r.content[0].text).toContain("Stopped peer 1 (PID 802). The server was left running.");
    expect(sys.killed).toEqual([802]);
    expect(existsSync(join(MISSION_ROOT, "2542", "server", INSTANCE_FILE))).toBe(true);

    sys.killed = [];
    sys.pids = [730];
    sys.failPins = new Set([730]);
    run(2545, 0, [], { cpu: { server: 0x3000, client: 0xc00 } });
    fakeSpawns(false);
    const j = await handler(config(home))({ action: "join", port: 2545, joinTimeoutSec: 1 });
    expect(j.isError).toBe(true);
    expect(j.content[0].text).toContain("clientCpuMask 0xc00 could not be applied to the new peer 1 (PID 730).");
    expect(sys.killed).toEqual([730]);
  });

  it("join also refuses when the server itself is not online or shows a failure (review MM-SERVER-4 N1)", async () => {
    expect(peerProblems(0, [], "00:00:01.000 ENGINE       : loading")).toEqual(['the server is not online yet (no "Entered online game state" in its log)']);
    run(2543, 0, [], { serverLog: "00:00:01.000 ENGINE       : loading\r\n" });
    const a = await handler(config(home))({ action: "join", port: 2543, joinTimeoutSec: 1 });
    expect(a.isError).toBe(true);
    expect(a.content[0].text).toMatch(/^join refused: the server is not online yet/);
    run(2544, 0, [], { serverLog: "00:00:01.000 DEFAULT      : Entered online game state.\r\n" + FAIL + "\r\n" });
    const b = await handler(config(home))({ action: "join", port: 2544, joinTimeoutSec: 1 });
    expect(b.isError).toBe(true);
    expect(b.content[0].text).toContain("the server is hung or crashed: 01:23:09.071 ENGINE    (F): Application hangs");
    expect(sys.spawned).toEqual([]);
  });

  it("the Crash Reporter is switched off in every command line the tool builds", () => {
    const r = { port: 2521, gproj: "g", world: "w", addonsDirs: ["d"], addons: ["a"] };
    expect(serverArgs(r, "p")).toContain("-disableCrashReporter");
    expect(peerArgs(r, "p")).toContain("-disableCrashReporter");
  });

  it("game launch passes -disableCrashReporter too", async () => {
    writeFileSync(join(home, "ArmaReforgerSteam.exe"), "");
    const c = { ...config(home), clientProfilesRoot: join(home, "cli-crash") } as Config;
    let game: (a: Record<string, unknown>) => Promise<Result> = async () => ({ content: [] });
    registerGame({ registerTool: (_n: string, _d: unknown, fn: typeof game) => (game = fn) } as unknown as McpServer, c);
    const r = await game({ action: "launch", lines: 80 });
    expect(sys.spawned.at(-1)).toContain("-disableCrashReporter");
    expect(r.content[0].text).toContain("-disableCrashReporter");
  });
});

describe("-noThrow on every process the tools start, and the script error report in their replies", () => {
  const handler = (register: (s: McpServer, c: Config) => void, c: Config) => {
    let h: (a: Record<string, unknown>) => Promise<Result> = async () => ({ content: [] });
    register({ registerTool: (_n: string, _d: unknown, fn: typeof h) => (h = fn) } as unknown as McpServer, c);
    return h;
  };
  const once = (args: string[]) => args.filter((x) => x === "-noThrow");
  const now = () => Date.now();
  /** The part of a status reply that belongs to one port (other tests leave runs on other ports). */
  const portPart = (t: string, port: number) => t.split("\n- port ").find((x) => x.startsWith(`${port}:`)) ?? "";

  /** A spawn stub where the server writes `log` (and a crash.log) into its run folder; `exits` makes it end at once. */
  const serverWrites = (log: string, crash = true, exits = false) => {
    sys.onSpawn = (args, pid) => {
      if (!args.includes("-server")) return;
      const dir = join(args[args.indexOf("-profile") + 1], "logs", "logs_2026-11-09_12-14-01");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "console.log"), log);
      if (crash) writeFileSync(join(dir, "crash.log"), CRASH_LOG);
      if (exits) sys.killed.push(pid);
    };
  };
  const start = (t: { world: string; root: string }, port: number) => {
    writeFileSync(join(home, "ArmaReforgerServerDiag.exe"), "");
    return handler(registerMissionServer, config(home))({ action: "start", world: t.world, port, peers: 0, addonsDirs: [t.root], timeoutSec: 10 });
  };

  it("serverArgs, peerArgs and both game launch exes pass -noThrow once", async () => {
    const r = { port: 2521, gproj: "g", world: "w", addonsDirs: ["d"], addons: ["a"] };
    expect(once(serverArgs(r, "p"))).toHaveLength(1);
    expect(once(peerArgs(r, "p"))).toHaveLength(1);
    writeFileSync(join(home, "ArmaReforgerSteam.exe"), "");
    writeFileSync(join(home, "ArmaReforgerSteamDiag.exe"), "");
    const game = handler(registerGame, { ...config(home), clientProfilesRoot: join(home, "cli-nothrow") } as Config);
    for (const extra of [{}, { connect: "127.0.0.1:2001" }]) {
      await game({ action: "launch", lines: 80, ...extra });
      expect(once(sys.spawned.at(-1)!)).toHaveLength(1);
    }
  });

  it("start prints the report when the server is online, and nothing new for a clean log", async () => {
    const t = addon();
    serverWrites(VME_LOG);
    const r = await start(t, 2561);
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("**Server online**");
    expect(r.content[0].text).toContain("-noThrow");
    expectReport(r.content[0].text);
    serverWrites("12:00:00.000 DEFAULT      : Entered online game state.\r\n", false);
    const clean = await start(t, 2562);
    expect(clean.content[0].text).toContain("**Server online**");
    expectClean(clean.content[0].text);
  });

  it("start prints the report when the server cannot be pinned", async () => {
    const t = addon();
    sys.pids = [902];
    sys.failPins = new Set([902]);
    serverWrites(VME_LOG);
    writeFileSync(join(home, "ArmaReforgerServerDiag.exe"), "");
    const r = await handler(registerMissionServer, config(home))({ action: "start", world: t.world, port: 2564, peers: 0, addonsDirs: [t.root], timeoutSec: 10, serverCpuMask: "0x3000", clientCpuMask: "0x0C00" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("**Server stopped**: serverCpuMask 0x3000 could not be applied");
    expectReport(r.content[0].text);
  });

  it("start prints the report when the server is not ready", async () => {
    const t = addon();
    sys.pids = [901];
    serverWrites(VME_LOG.replace(/^.*Entered online.*\r\n/m, ""), true, true);
    const r = await start(t, 2563);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("**Server not ready** (the server exited)");
    expectReport(r.content[0].text);
  });

  it("start with no peers waits a settle after the online line: a script exception and crash.log written just after it are in the reply", async () => {
    const t = addon();
    const at = VME_LOG.indexOf("12:14:18.032");
    let dir = "";
    sys.onSpawn = (args) => {
      if (!args.includes("-server")) return;
      dir = join(args[args.indexOf("-profile") + 1], "logs", "logs_2026-11-09_12-14-01");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "console.log"), VME_LOG.slice(0, at));
    };
    // Written during the settle, like the live runs (0.12 s after the online line).
    sys.onSleep = (ms) => {
      if (ms !== SETTLE_MS) return;
      appendFileSync(join(dir, "console.log"), VME_LOG.slice(at));
      writeFileSync(join(dir, "crash.log"), CRASH_LOG);
    };
    const r = await start(t, 2566);
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("**Server online**");
    expectReport(r.content[0].text);
    expect(sys.sleeps).toEqual([SETTLE_MS]);
  });

  it("start waits no settle when the server is not online, or exited after the online line", async () => {
    const online = "12:00:00.000 DEFAULT      : Entered online game state.\r\n";
    const cases: [string, string, boolean, string][] = [
      ["failure line", "01:23:09.071 ENGINE    (F): Application hangs (force crash) 305 s\r\n", false, "**Server not ready** (stopped on:"],
      ["exited before online", "00:00:01.000 ENGINE       : loading\r\n", true, "**Server not ready** (the server exited)"],
      ["exited after online", online, true, "**Server exited**"], // B-157: was "**Server online**"
    ];
    let port = 2567;
    for (const [why, log, exits, reply] of cases) {
      sys.killed = [];
      sys.sleeps = [];
      serverWrites(log, false, exits);
      const r = await start(addon(), port++);
      expect(r.content[0].text, why).toContain(reply);
      expect(sys.sleeps, why).not.toContain(SETTLE_MS);
    }
  });

  it("start with peers keeps the join wait and the pause between peers, and adds no settle", async () => {
    const t = addon();
    writeFileSync(join(home, "ArmaReforgerServerDiag.exe"), "");
    writeFileSync(join(home, "ArmaReforgerSteamDiag.exe"), "");
    let log = "";
    sys.onSpawn = (args) => {
      const profile = args[args.indexOf("-profile") + 1];
      if (args.includes("-server")) {
        log = join(profile, "logs", "logs_x", "console.log");
        mkdirSync(dirname(log), { recursive: true });
        writeFileSync(log, "12:00:00.000 DEFAULT      : Entered online game state.\r\n");
      } else appendFileSync(log, "12:00:09.000   NETWORK      : Players connected: 1 / 1\r\n");
    };
    const r = await handler(registerMissionServer, config(home))({ action: "start", world: t.world, port: 2570, peers: 1, addonsDirs: [t.root], timeoutSec: 10, joinTimeoutSec: 2 });
    expect(r.content[0].text).toContain("All 1 peer(s) joined");
    expect(sys.sleeps).toEqual([2000]);
  });

  it("join and status print the report for the server and each peer; a clean run prints nothing new", async () => {
    const t = addon();
    writeFileSync(join(home, "ArmaReforgerSteamDiag.exe"), "");
    const setup = (port: number, vme: boolean) => {
      const dir = join(MISSION_ROOT, String(port));
      const serverDir = join(dir, "server");
      const logDir = join(serverDir, "logs", "logs_x");
      mkdirSync(logDir, { recursive: true });
      mkdirSync(join(dir, "peer1", "logs", "logs_x"), { recursive: true });
      writeFileSync(join(logDir, "console.log"), (vme ? VME_LOG : "12:00:00.000 DEFAULT      : Entered online game state.\r\n") + "12:15:00.000   NETWORK      : Players connected: 1 / 1\r\n");
      writeFileSync(join(dir, "peer1", "logs", "logs_x", "console.log"), "12:00:00.000 ENGINE       : loading\r\n");
      if (vme) {
        writeFileSync(join(logDir, "crash.log"), CRASH_LOG);
        writeFileSync(join(dir, "peer1", "logs", "logs_x", "crash.log"), "peer crashed\n");
      }
      writeFileSync(join(serverDir, INSTANCE_FILE), JSON.stringify({ kind: "server", name: `mission-${port}`, pid: 701, ownerPid: OWNER.pid, ownerStartedAt: OWNER.startedAt, startedAt: now(), exe: "x" }));
      writeFileSync(join(dir, "run.json"), JSON.stringify({ port, gproj: join(t.dir, "addon.gproj"), world: "Worlds/Map/Me_TVT_Test.ent", addonsDirs: [t.root], addons: ["TestMission"] }));
      sys.servers = [{ pid: 701, ppid: 1, cmd: `x.exe -profile "${serverDir}"`, created: now() }];
      sys.clients = [];
      sys.onSpawn = () => appendFileSync(join(logDir, "console.log"), "12:15:30.000   NETWORK      : Players connected: 2 / 2\r\n");
    };
    const tool = handler(registerMissionServer, config(home));

    setup(2564, true);
    const join1 = await tool({ action: "join", port: 2564, joinTimeoutSec: 5 });
    expect(join1.content[0].text).toContain("**Peer 2 joined**");
    expectReport(join1.content[0].text);
    expect(join1.content[0].text).toMatch(/\*\*server\*\*\n\*\*Script exceptions/);
    expect(join1.content[0].text).toContain("**peer1**\n**crash.log**");
    const status = portPart((await tool({ action: "status" })).content[0].text, 2564);
    expectReport(status);
    expect(status).toContain("**peer1**\n**crash.log**");

    setup(2565, false);
    const clean = await tool({ action: "join", port: 2565, joinTimeoutSec: 5 });
    expect(clean.content[0].text).toContain("**Peer 2 joined**");
    expectClean(clean.content[0].text);
    expectClean(portPart((await tool({ action: "status" })).content[0].text, 2565));
  });

  it("the descriptions of mission_server and game say -noThrow and the script exception report", () => {
    for (const [register, tool] of [[registerMissionServer, "mission_server"], [registerGame, "game"]] as const) {
      let def!: { description: string };
      register({ registerTool: (_n: string, d: typeof def) => { def = d; } } as unknown as McpServer, config(home));
      expect(def.description, tool).toMatch(/-noThrow.*script exceptions/);
    }
  });
});

describe("mission_server: the process watcher", () => {
  const arg = (args: string[], name: string) => args[args.indexOf(name) + 1];
  const exes = () => {
    writeFileSync(join(home, "ArmaReforgerServerDiag.exe"), "");
    writeFileSync(join(home, "ArmaReforgerSteamDiag.exe"), "");
  };
  /** The watcher the tool started for `pid`: its argv names the PID, the kind, the instance file, this MCP and the logs root. */
  const expectWatcher = async (w: { args: string[]; instanceThere: boolean }, pid: number, kind: string, instance: string, logsRoot: string) => {
    expect(w.instanceThere, "the instance file is written before the watcher starts").toBe(true);
    expect([arg(w.args, "--pid"), arg(w.args, "--kind"), arg(w.args, "--instance"), arg(w.args, "--owner-pid"), arg(w.args, "--owner-started"), arg(w.args, "--logs-root"), arg(w.args, "--state-dir")])
      .toEqual([String(pid), kind, instance, String(OWNER.pid), String(OWNER.startedAt), logsRoot, PROC_WATCH_DIR]);
    const { crashLogsDir } = await import("../../src/workbench/cli.js");
    expect(w.args.includes("--crash-dir") ? arg(w.args, "--crash-dir") : undefined).toBe(crashLogsDir(config(home)));
  };
  /** A server that writes its log (online, or `online=false`: loading only) and shows as a process; each peer shows as a process and is counted by the server. */
  function stubs(o: { online?: boolean; serverExits?: boolean; peerExits?: boolean } = {}) {
    let serverLog = "";
    let peers = 0;
    sys.onSpawn = (args, pid) => {
      const profile = args[args.indexOf("-profile") + 1];
      const proc = { pid, ppid: 1, cmd: `x.exe -profile "${profile}"`, created: Date.now() };
      if (args.includes("-server")) {
        serverLog = join(profile, "logs", "logs_x", "console.log");
        mkdirSync(dirname(serverLog), { recursive: true });
        writeFileSync(serverLog, o.online === false ? "00:00:01.000 ENGINE       : loading\r\n" : "00:00:01.000 DEFAULT      : Entered online game state.\r\n");
        sys.servers.push(proc);
        if (o.serverExits) sys.killed.push(pid);
      } else {
        sys.clients.push(proc);
        appendFileSync(serverLog, `00:00:09.000   NETWORK      : Players connected: ${++peers} / ${peers}\r\n`);
        if (o.peerExits) sys.killed.push(pid);
      }
    };
  }
  const ready = { timeoutSec: 10, joinTimeoutSec: 2 };

  it("start and join start one watcher for the server and one for each peer, with that PID, instance file, this MCP, the logs root and the kind", async () => {
    exes();
    const t = addon();
    sys.pids = [801, 802, 803];
    stubs();
    const tool = handler2(config(home));
    const r = await tool({ action: "start", world: t.world, port: 2581, peers: 1, addonsDirs: [t.root], ...ready });
    expect(r.isError).toBeUndefined();
    const dir = join(MISSION_ROOT, "2581");
    expect(sys.watcherSpawns).toHaveLength(2);
    await expectWatcher(sys.watcherSpawns[0], 801, "server", join(dir, "server", INSTANCE_FILE), join(dir, "server", "logs"));
    await expectWatcher(sys.watcherSpawns[1], 802, "client", join(dir, "peer1", INSTANCE_FILE), join(dir, "peer1", "logs"));
    const j = await tool({ action: "join", port: 2581, joinTimeoutSec: 2 });
    expect(j.content[0].text).toContain("**Peer 2 joined** (PID 803)");
    expect(sys.watcherSpawns).toHaveLength(3);
    await expectWatcher(sys.watcherSpawns[2], 803, "client", join(dir, "peer2", INSTANCE_FILE), join(dir, "peer2", "logs"));
    expect(sys.spawned).toHaveLength(3); // the watchers do not go through the process spawn the tool uses
  });

  it("starts none for a start that is refused or fails before the instance file is written", async () => {
    exes();
    const t = addon();
    const same = addon(); // a second copy of the same addon GUID
    const own = (pid: number, dir: string) => {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, INSTANCE_FILE), JSON.stringify({ kind: "server", name: "s", pid, ownerPid: OWNER.pid, ownerStartedAt: OWNER.startedAt, startedAt: Date.now(), exe: "x" }));
      return { pid, ppid: 1, cmd: `x.exe -profile "${dir}"`, created: Date.now() };
    };
    sys.servers = [{ pid: 4242, ppid: 1, cmd: "ArmaReforgerServerDiag.exe -addr 127.0.0.1:2582 -profile C:\\other", created: 0 }, own(705, join(MISSION_ROOT, "2583", "server"))];
    const go = (port: number, extra: Record<string, unknown> = {}, c = config(home)) =>
      handler2(c)({ action: "start", world: t.world, port, peers: 0, addonsDirs: [t.root], timeoutSec: 10, ...extra });
    const refused: [string, () => Promise<Result>][] = [
      ["bad world", () => handler2(config(home))({ action: "start", world: "relative.ent", port: 2584 })],
      ["extraArgs", () => go(2585, { extraArgs: ["-profile", "x"] })],
      ["one cpu mask", () => go(2586, { serverCpuMask: "0x3000" })],
      ["no exe", () => go(2587, {}, { ...config(home), serverPath: join(home, "nowhere") } as Config)],
      ["port in use", () => go(2582)],
      ["run still running", () => go(2583)],
      ["duplicate addon", () => go(2588, { addonsDirs: [t.root, same.root] })],
    ];
    for (const [why, run] of refused) expect((await run()).isError, why).toBe(true);
    expect(sys.spawned).toEqual([]);
    expect(sys.watcherSpawns).toEqual([]);
  });

  it("starts no watcher for a peer that is refused for RAM, only the server's", async () => {
    exes();
    const t = addon();
    sys.pids = [801];
    stubs();
    sys.freeBytes = 3.5 * 2 ** 30;
    const r = await handler2(config(home))({ action: "start", world: t.world, port: 2589, peers: 1, addonsDirs: [t.root], ...ready });
    expect(r.content[0].text).toContain("a peer could not start: Not enough free RAM");
    expect(sys.watcherSpawns.map((w) => arg(w.args, "--kind"))).toEqual(["server"]);
  });

  it("starts none when the server's instance file cannot be written, although it was spawned", async () => {
    exes();
    const t = addon();
    sys.pids = [801];
    mkdirSync(join(MISSION_ROOT, "2590", "server", INSTANCE_FILE), { recursive: true }); // a folder where the file goes
    const r = await handler2(config(home))({ action: "start", world: t.world, port: 2590, peers: 0, addonsDirs: [t.root], timeoutSec: 10 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("mission_server failed");
    expect(sys.spawned).toHaveLength(1);
    expect(sys.watcherSpawns).toEqual([]);
  });

  it("on a platform other than Windows starts no watcher and the start reply is the same", async () => {
    exes();
    const t = addon();
    const reply = async (port: number) => {
      sys.pids = [801];
      stubs();
      return (await handler2(config(home))({ action: "start", world: t.world, port, peers: 0, addonsDirs: [t.root], timeoutSec: 10 })).content[0].text.replaceAll(String(port), "PORT");
    };
    const onWindows = await reply(2591);
    expect(sys.watcherSpawns).toHaveLength(1);
    sys.watcherSpawns = [];
    sys.platform = "linux";
    sys.servers = [];
    expect(await reply(2592)).toBe(onWindows);
    expect(sys.watcherSpawns).toEqual([]);
  });

  it("a watcher that cannot start does not fail the start", async () => {
    exes();
    const t = addon();
    sys.pids = [801];
    stubs();
    mkdirSync(dirname(PROC_WATCH_DIR), { recursive: true });
    writeFileSync(PROC_WATCH_DIR, "a file where the state folder goes");
    const r = await handler2(config(home))({ action: "start", world: t.world, port: 2593, peers: 0, addonsDirs: [t.root], timeoutSec: 10 });
    rmSync(PROC_WATCH_DIR);
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("**Server online**");
    expect(existsSync(join(MISSION_ROOT, "2593", "server", INSTANCE_FILE))).toBe(true);
    // B-147: the reply says why, in one line.
    expect(r.content[0].text.match(/^No process watcher: .+$/gm)).toHaveLength(1);
    expect(r.content[0].text).toMatch(/\nNo process watcher: [^\n]*mkdir/);
  });

  it("a watcher whose process has no PID is named in one line for the server and one under each peer; a normal start has none (B-147)", async () => {
    exes();
    const t = addon();
    sys.pids = [801, 802, 803];
    stubs();
    const tool = handler2(config(home));
    const ok = await tool({ action: "start", world: t.world, port: 2594, peers: 0, addonsDirs: [t.root], ...ready });
    expect(ok.content[0].text).not.toContain("No process watcher");
    sys.pids = [801, 802, 803];
    sys.watcherThrows = "Failed to start node.exe";
    const r = await tool({ action: "start", world: t.world, port: 2595, peers: 1, addonsDirs: [t.root], ...ready });
    const text = r.content[0].text;
    expect(r.isError).toBeUndefined();
    expect(text).toContain("**Server online**");
    expect(existsSync(join(MISSION_ROOT, "2595", "server", INSTANCE_FILE))).toBe(true);
    expect(text.match(/^No process watcher: Failed to start node\.exe$/gm)).toHaveLength(2);
    expect(text).toMatch(/Log: [^\n]*\nNo process watcher: Failed to start node\.exe\n/);
    expect(text).toContain("Peer 1: PID 802\nNo process watcher: Failed to start node.exe");
    const j = await tool({ action: "join", port: 2595, joinTimeoutSec: 2 });
    expect(j.content[0].text).toContain("**Peer 2 joined** (PID 803)");
    expect(j.content[0].text).toMatch(/\nCommand: [^\n]*\nNo process watcher: Failed to start node\.exe/);
  });
});

/** A watcher state file as the watcher writes it, into the watch folder the tools read. */
let stateSeq = 0;
function putState(instance: string, over: Record<string, unknown> = {}) {
  const s = {
    pid: 31820, kind: "server", instance, ownerPid: 99999, watcherPid: 4242, state: "ended_vme", since: Date.now(), samples: 3, updated: Date.now(),
    dialog: { title: "Virtual machine exception", text: "NULL pointer to instance" }, saved: "C:\\crash\\server_x", ...over,
  };
  mkdirSync(PROC_WATCH_DIR, { recursive: true });
  writeFileSync(join(PROC_WATCH_DIR, `${s.pid}_${stateSeq++}.json`), JSON.stringify(s));
}
const HOUR = 3600_000;

describe("mission_server status: the process watcher states", () => {
  it("shows each port's states of the last 24 h under that port, and nothing from another root, port or time", async () => {
    const tool = handler2(config(home));
    const a = join(MISSION_ROOT, "2594", "server");
    const b = join(MISSION_ROOT, "2595", "server");
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    sys.killed.push(4343); // a dead watcher
    const now = Date.now();
    const inst = (dir: string) => join(dir, INSTANCE_FILE);
    // Shown on 2594: live blocked and ending states, final states with a dead watcher, another owner, 23 h old.
    putState(inst(a), { pid: 1001, state: "blocked_dialog", why: "not ended: it was not started by this MCP session", saved: undefined });
    putState(inst(a), { pid: 1002, state: "ending_vme" });
    putState(inst(a), { pid: 1003, watcherPid: 4343, ownerPid: 12345 });
    putState(inst(a), { pid: 1004, watcherPid: 4343, state: "end_failed", saved: undefined });
    putState(inst(join(MISSION_ROOT, "2594", "peer1")), { pid: 1005, kind: "client", watcherPid: 4343, updated: now - 23 * HOUR });
    putState(inst(b), { pid: 1006 });
    // Not shown: 25 h old; the server tool's root; a client folder; a non-final state whose watcher is dead; watching and exited states.
    putState(inst(a), { pid: 2001, watcherPid: 4343, updated: now - 25 * HOUR });
    putState(join(home, ".enfusion-mcp", "server-profile", INSTANCE_FILE), { pid: 2002 });
    putState(join(home, ".enfusion-mcp", "client-profiles", `2003.${INSTANCE_FILE}`), { pid: 2003, kind: "client" });
    putState(inst(a), { pid: 2004, watcherPid: 4343, state: "blocked_dialog" });
    putState(inst(a), { pid: 2005, watcherPid: 4343, state: "ending_vme" });
    putState(inst(a), { pid: 2006, state: "watching" });
    putState(inst(a), { pid: 2007, state: "exited" });
    // Damaged rows (B-148): a kind that is neither server nor client, and a time of 1e400 (JSON.parse gives Infinity).
    putState(inst(a), { pid: 2008, kind: "peer" });
    const infinite = JSON.stringify({ pid: 2009, kind: "server", instance: inst(a), ownerPid: 99999, watcherPid: 4242, state: "ended_vme", since: now, samples: 3, updated: 0 }).replace('"updated":0', '"updated":1e400');
    expect(infinite).toContain('"updated":1e400');
    writeFileSync(join(PROC_WATCH_DIR, "2009_1.json"), infinite);
    const t = (await tool({ action: "status" })).content[0].text;
    const part = (port: number) => t.split("\n- port ").find((x) => x.startsWith(`${port}:`)) ?? "";
    for (const pid of [1001, 1002, 1003, 1004, 1005]) expect(part(2594), String(pid)).toMatch(new RegExp(`PID ${pid},`));
    expect(part(2594)).not.toMatch(/PID 1006,/);
    expect(part(2595)).toMatch(/server PID 1006,/);
    for (const pid of [2001, 2002, 2003, 2004, 2005, 2006, 2007, 2008, 2009]) expect(t, String(pid)).not.toContain(`PID ${pid},`);
    expect(t).not.toContain("NaN");
    expect(part(2594)).toContain('ended after a VM exception window "Virtual machine exception" stayed open; logs saved to C:\\crash\\server_x');
  });

  it("the description says a VM exception window on a process it started ends that process and its logs are saved", () => {
    let def!: { description: string };
    registerMissionServer({ registerTool: (_n: string, d: typeof def) => { def = d; } } as unknown as McpServer, config(home));
    expect(def.description).toMatch(/VM exception window stays open on one of them, that process \(and only that one\) is ended and its logs are saved/);
  });
});

function handler2(c: Config) {
  let h: (a: Record<string, unknown>) => Promise<Result> = async () => ({ content: [] });
  registerMissionServer({ registerTool: (_n: string, _d: unknown, fn: typeof h) => (h = fn) } as unknown as McpServer, c);
  return h;
}

describe("mission_server: the final state of a process that exited", () => {
  const exes = () => {
    writeFileSync(join(home, "ArmaReforgerServerDiag.exe"), "");
    writeFileSync(join(home, "ArmaReforgerSteamDiag.exe"), "");
  };
  const serverState = (port: number, over: Record<string, unknown> = {}) => putState(join(MISSION_ROOT, String(port), "server", INSTANCE_FILE), { pid: 901, ...over });
  /** A server that logs only "loading" and is gone at once. */
  const dyingServer = () => {
    sys.pids = [901];
    sys.onSpawn = (args, pid) => {
      const log = join(args[args.indexOf("-profile") + 1], "logs", "logs_x", "console.log");
      mkdirSync(dirname(log), { recursive: true });
      writeFileSync(log, "00:00:01.000 ENGINE       : loading\r\n");
      sys.killed.push(pid);
    };
  };
  const start = (port: number) => {
    exes();
    const t = addon();
    return handler2(config(home))({ action: "start", world: t.world, port, peers: 0, addonsDirs: [t.root], timeoutSec: 10 });
  };

  it("start shows the state a watcher writes 2 s after the exit, and the one written at 5 s", async () => {
    for (const [port, at] of [[2596, 4], [2597, 10]] as const) {
      dyingServer();
      sys.polls = 0;
      sys.onPoll = (n) => n === at && serverState(port);
      const r = await start(port);
      expect(r.content[0].text).toContain("**Server not ready** (the server exited)");
      expect(r.content[0].text).toContain("- Process watcher, server PID 901,");
      expect(r.content[0].text).toContain("ended after a VM exception window");
      expect(sys.polls).toBe(at);
    }
  });

  it("start gives no line and stops waiting after 5 s when no final state appears, or only a stale, live-only or other-PID one", async () => {
    const now = Date.now();
    // Every state but the first is written during the wait (poll 3), so only its own difference keeps it out.
    const cases: [string, number, (port: number) => void, boolean][] = [
      ["none", 2598, () => {}, false],
      ["written before the process started", 2599, (p) => serverState(p, { updated: now - 60_000 }), false],
      ["not final", 2600, (p) => serverState(p, { state: "ending_vme" }), true],
      ["another PID", 2601, (p) => serverState(p, { pid: 902 }), true],
      ["under another port", 2602, () => putState(join(MISSION_ROOT, "2999", "server", INSTANCE_FILE), { pid: 901 }), true],
    ];
    for (const [why, port, put, during] of cases) {
      dyingServer();
      sys.polls = 0;
      if (during) sys.onPoll = (n) => n === 3 && put(port);
      else put(port);
      const r = await start(port);
      expect(r.content[0].text, why).toContain("**Server not ready** (the server exited)");
      expect(r.content[0].text, why).not.toContain("Process watcher");
      expect(sys.polls, why).toBe(10);
    }
  });

  it("start with no peers reports a server that is gone after the settle as exited, with its final state and crash.log, as an error (B-157)", async () => {
    sys.pids = [905];
    let dir = "";
    sys.onSpawn = (args) => {
      dir = join(args[args.indexOf("-profile") + 1], "logs", "logs_x");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "console.log"), "00:00:01.000 DEFAULT      : Entered online game state.\r\n");
    };
    // The server dies during the settle, like the live runs (crash.log 0.13 s after the online line).
    sys.onSleep = (ms) => {
      if (ms !== SETTLE_MS) return;
      writeFileSync(join(dir, "crash.log"), CRASH_LOG);
      sys.killed.push(905);
      serverState(2801, { pid: 905 });
    };
    const r = await start(2801);
    const t = r.content[0].text;
    expect(r.isError).toBe(true);
    expect(t).toContain("**Server exited**");
    expect(t).not.toContain("**Server online**");
    expect(t).toContain("Server PID 905 on 127.0.0.1:2801");
    expect(t).toContain("- Process watcher, server PID 905,");
    expect(t).toContain("Reason: Access violation");
    expect(sys.sleeps).toEqual([SETTLE_MS]);
  });

  it("start does not wait when the process is still running", async () => {
    sys.pids = [903];
    sys.onSpawn = (args) => {
      const log = join(args[args.indexOf("-profile") + 1], "logs", "logs_x", "console.log");
      mkdirSync(dirname(log), { recursive: true });
      writeFileSync(log, "01:23:09.071 ENGINE    (F): Application hangs (force crash) 305 s\r\n");
    };
    const r = await start(2603);
    expect(r.content[0].text).toContain("**Server not ready** (stopped on:");
    expect(sys.polls).toBe(0);
  });

  it("start does not wait when the wait ended on a failure line, even if the process is gone by then", async () => {
    sys.pids = [904];
    sys.onSpawn = (args, pid) => {
      const log = join(args[args.indexOf("-profile") + 1], "logs", "logs_x", "console.log");
      mkdirSync(dirname(log), { recursive: true });
      writeFileSync(log, "01:23:09.071 ENGINE    (F): Application hangs (force crash) 305 s\r\n");
      sys.killed.push(pid);
    };
    const r = await start(2606);
    expect(r.content[0].text).toContain("**Server not ready** (stopped on:");
    expect(r.content[0].text).not.toContain("Process watcher");
    expect(sys.polls).toBe(0);
  });

  it("start with peers that did not join includes a peer's final state", async () => {
    exes();
    const t = addon();
    sys.pids = [801, 802];
    let serverLog = "";
    sys.onSpawn = (args, pid) => {
      const profile = args[args.indexOf("-profile") + 1];
      const proc = { pid, ppid: 1, cmd: `x.exe -profile "${profile}"`, created: Date.now() };
      if (args.includes("-server")) {
        serverLog = join(profile, "logs", "logs_x", "console.log");
        mkdirSync(dirname(serverLog), { recursive: true });
        writeFileSync(serverLog, "00:00:01.000 DEFAULT      : Entered online game state.\r\n");
        sys.servers.push(proc);
      } else {
        sys.clients.push(proc);
        sys.killed.push(pid); // the peer is gone: the watcher ended it
      }
    };
    sys.onPoll = (n) => n === 4 && putState(join(MISSION_ROOT, "2604", "peer1", INSTANCE_FILE), { pid: 802, kind: "client" });
    const r = await handler2(config(home))({ action: "start", world: t.world, port: 2604, peers: 1, addonsDirs: [t.root], timeoutSec: 10, joinTimeoutSec: 0 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Not all peers joined");
    expect(r.content[0].text).toContain("- Process watcher, client PID 802,");
  });

  it("start with peers that did not join waits for nothing and shows no state when every process is still alive (B-148)", async () => {
    exes();
    const t = addon();
    sys.pids = [801, 802];
    sys.onSpawn = (args, pid) => {
      const profile = args[args.indexOf("-profile") + 1];
      const proc = { pid, ppid: 1, cmd: `x.exe -profile "${profile}"`, created: Date.now() };
      if (args.includes("-server")) {
        const log = join(profile, "logs", "logs_x", "console.log");
        mkdirSync(dirname(log), { recursive: true });
        writeFileSync(log, "00:00:01.000 DEFAULT      : Entered online game state.\r\n");
        sys.servers.push(proc);
      } else {
        sys.clients.push(proc);
        // A final state for a PID that is still alive: only the `gone` filter keeps it out of the reply.
        putState(join(MISSION_ROOT, "2607", "peer1", INSTANCE_FILE), { pid, kind: "client" });
      }
    };
    const r = await handler2(config(home))({ action: "start", world: t.world, port: 2607, peers: 1, addonsDirs: [t.root], timeoutSec: 10, joinTimeoutSec: 0 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Not all peers joined");
    expect(r.content[0].text).not.toContain("Process watcher");
    expect(sys.polls).toBe(0);
  });

  it("join shows the state of the server that exited while it waited, and none after 5 s", async () => {
    exes();
    const t = addon();
    const port = 2605;
    const serverDir = join(MISSION_ROOT, String(port), "server");
    const log = join(serverDir, "logs", "logs_x", "console.log");
    mkdirSync(dirname(log), { recursive: true });
    mkdirSync(join(MISSION_ROOT, String(port), "peer1"), { recursive: true });
    writeFileSync(log, "00:00:01.000 DEFAULT      : Entered online game state.\r\n00:00:09.000   NETWORK      : Players connected: 1 / 1\r\n");
    writeFileSync(join(serverDir, INSTANCE_FILE), JSON.stringify({ kind: "server", name: `mission-${port}`, pid: 701, ownerPid: OWNER.pid, ownerStartedAt: OWNER.startedAt, startedAt: Date.now(), exe: "x" }));
    writeFileSync(join(MISSION_ROOT, String(port), "run.json"), JSON.stringify({ port, gproj: join(t.dir, "addon.gproj"), world: "Worlds/Map/Me_TVT_Test.ent", addonsDirs: [t.root], addons: ["TestMission"] }));
    // The peer starts and the server is gone.
    for (const at of [4, undefined]) {
      sys.killed = [];
      sys.servers = [{ pid: 701, ppid: 1, cmd: `x.exe -profile "${serverDir}"`, created: Date.now() }];
      sys.pids = [720];
      sys.onSpawn = (_args, pid) => (sys.clients.push({ pid, ppid: 1, cmd: "x.exe", created: Date.now() }), sys.killed.push(701));
      sys.polls = 0;
      sys.onPoll = (n) => n === at && putState(join(serverDir, INSTANCE_FILE), { pid: 701 });
      const j = await handler2(config(home))({ action: "join", port, joinTimeoutSec: 0 });
      expect(j.isError).toBe(true);
      if (at) expect(j.content[0].text).toContain("- Process watcher, server PID 701,");
      else expect(j.content[0].text).not.toContain("Process watcher");
      expect(sys.polls).toBe(at ?? 10);
      rmSync(PROC_WATCH_DIR, { recursive: true, force: true });
    }
  });
});

describe("mission_server: log text is data, and join reports the run (MS-1)", () => {
  const tool = () => handler2(config(home));
  const exes = () => {
    writeFileSync(join(home, "ArmaReforgerServerDiag.exe"), "");
    writeFileSync(join(home, "ArmaReforgerSteamDiag.exe"), "");
  };
  const serverLogs = (consoleText: string) => {
    sys.onSpawn = (args) => {
      const dir = join(args[args.indexOf("-profile") + 1], "logs", "logs_x");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "console.log"), consoleText);
    };
  };
  const start = (port: number) => {
    exes();
    const t = addon();
    return tool()({ action: "start", world: t.world, port, peers: 0, addonsDirs: [t.root], timeoutSec: 10 });
  };

  it("the line the start stopped on stays inside one code block, even with a closing fence in it", async () => {
    serverLogs("01:23:09.071 ENGINE    (F): Application hangs ``` **bold** [link](x)\r\n");
    const r = await start(2701);
    const t = r.content[0].text;
    expect(t).toContain("**Server not ready** (stopped on: the log line below).");
    expect(t).toContain("```\n01:23:09.071 ENGINE    (F): Application hangs ''' **bold** [link](x)\n```");
    expect(t.match(/```/g)).toHaveLength(2);
  });

  it("the matched online line stays inside one code block, even with a closing fence in it", async () => {
    serverLogs("12:00:00.000 DEFAULT      : Entered online game state. ``` **bold** [link](x)\r\n");
    const r = await start(2702);
    const t = r.content[0].text;
    expect(t).toContain("**Server online** after");
    expect(t).toContain("```\n12:00:00.000 DEFAULT      : Entered online game state. ''' **bold** [link](x)\n```");
    expect(t.match(/```/g)).toHaveLength(2);
  });

  /** A running server of port with a script exception and a crash.log in its log folder, as the join tests need it. */
  const runningServer = (port: number, cpu?: { server: number; client: number }) => {
    exes();
    const t = addon();
    const dir = join(MISSION_ROOT, String(port));
    const serverDir = join(dir, "server");
    const logDir = join(serverDir, "logs", "logs_x");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(join(logDir, "console.log"), VME_LOG + "\r\n12:15:00.000   NETWORK      : Players connected: 1 / 1\r\n");
    writeFileSync(join(logDir, "crash.log"), CRASH_LOG);
    writeFileSync(join(serverDir, INSTANCE_FILE), JSON.stringify({ kind: "server", name: `mission-${port}`, pid: 701, ownerPid: OWNER.pid, ownerStartedAt: OWNER.startedAt, startedAt: Date.now(), exe: "x" }));
    writeFileSync(join(dir, "run.json"), JSON.stringify({ port, gproj: join(t.dir, "addon.gproj"), world: "Worlds/Map/Me_TVT_Test.ent", addonsDirs: [t.root], addons: ["TestMission"], cpu }));
    sys.servers = [{ pid: 701, ppid: 1, cmd: `x.exe -profile "${serverDir}"`, created: Date.now() }];
    sys.clients = [];
  };

  it("join includes the run report when the new client cannot start", async () => {
    runningServer(2703);
    sys.freeBytes = 1 * 2 ** 30;
    const r = await tool()({ action: "join", port: 2703, joinTimeoutSec: 1 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Not enough free RAM for another game client");
    expect(sys.spawned).toEqual([]);
    expectReport(r.content[0].text);
  });

  it("join includes the run report when the client CPU mask cannot be applied", async () => {
    runningServer(2704, { server: 0x3000, client: 0xc00 });
    sys.pids = [730];
    sys.failPins = new Set([730]);
    const r = await tool()({ action: "join", port: 2704, joinTimeoutSec: 1 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("clientCpuMask 0xc00 could not be applied to the new peer 1 (PID 730).");
    expectReport(r.content[0].text);
  });

  it("start with addonsDirs [] lists only the folder that holds the world's addon, sibling addons included (B-165)", async () => {
    exes();
    const t = addon();
    mkdirSync(join(t.root, "Sibling Addon"));
    serverLogs("12:00:00.000 DEFAULT      : Entered online game state.\r\n");
    const r = await tool()({ action: "start", world: t.world, port: 2705, peers: 0, addonsDirs: [], timeoutSec: 10 });
    expect(r.isError).toBeUndefined();
    expect(sys.spawned).toHaveLength(1);
    const argv = sys.spawned[0];
    expect(argv.filter((x) => x === "-addonsDir")).toHaveLength(1);
    expect(argv[argv.indexOf("-addonsDir") + 1]).toBe(t.root);
  });
});
