import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";

// A fake home first, so MISSION_ROOT is a temp folder; processes, kills and spawns are stubs.
const home = mkdtempSync(join(tmpdir(), "emcp-ms-home-"));
process.env.USERPROFILE = process.env.HOME = home;

const sys = vi.hoisted(() => ({
  servers: [] as { pid: number; ppid: number; cmd: string; created: number }[],
  clients: [] as { pid: number; ppid: number; cmd: string; created: number }[],
  killed: [] as number[],
  spawned: [] as string[][],
}));
vi.mock("../../src/utils/process.js", async (orig) => ({
  ...(await orig<typeof import("../../src/utils/process.js")>()),
  serverProcesses: () => sys.servers,
  clientProcesses: () => sys.clients,
  killPids: (pids: number[]) => sys.killed.push(...pids),
  isAlive: (pid: number) => !sys.killed.includes(pid),
  spawnDetached: (_exe: string, args: string[]) => (sys.spawned.push(args), 99999),
  sleep: async () => {},
}));

const { planRun, serverArgs, peerArgs, checkExtra, registerMissionServer, MISSION_ROOT } = await import("../../src/tools/mission-server.js");
const { INSTANCE_FILE, OWNER } = await import("../../src/utils/instances.js");

type Result = { content: { text: string }[]; isError?: boolean };

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
      "-addonsDir", t.root, "-addons", "TestMission", "-addr", "127.0.0.1:2521", "-profile", profile, "-nothrow", "-maxFPS", "60", "-jobsysShortWorkerCount", "2",
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

  it("status reads online from the log and says when nothing of a run is still running", async () => {
    const log = join(MISSION_ROOT, "2523", "server", "logs", "logs_2026-11-02_00-19-27");
    mkdirSync(log, { recursive: true });
    writeFileSync(join(log, "console.log"), "00:19:53.459 DEFAULT      : Entered online game state.\r\n");
    const r = await tool(config(home))({ action: "status" });
    expect(r.content[0].text).toContain("- port 2523: nothing running; last run was online (no GAME state: a lobby game mode waits for players)");
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
