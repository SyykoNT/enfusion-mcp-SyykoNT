import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProcInfo } from "../../src/utils/process.js";

// No real process is listed, signalled or killed: the process helpers are replaced.
const procs = vi.hoisted(() => ({ servers: [] as ProcInfo[], clients: [] as ProcInfo[], alive: new Set<number>(), ignorePolite: false, cimFails: false }));
vi.mock("../../src/utils/process.js", async (orig) => ({
  ...(await orig<typeof import("../../src/utils/process.js")>()),
  serverProcesses: () => procs.servers,
  clientProcesses: () => procs.clients,
  processInfo: (pid: number) => (procs.cimFails ? undefined : [...procs.servers, ...procs.clients].find((p) => p.pid === pid)),
  isAlive: (pid: number) => procs.alive.has(pid),
  killPids: vi.fn((pids: number[], force?: boolean) => {
    if (force || !procs.ignorePolite) pids.forEach((p) => procs.alive.delete(p));
  }),
  sleep: () => Promise.resolve(),
}));

// The shared client logs root lives under this folder; tests set it.
const games = vi.hoisted(() => ({ dir: "" }));
vi.mock("../../src/utils/game-paths.js", async (orig) => ({ ...(await orig<typeof import("../../src/utils/game-paths.js")>()), myGamesDir: () => games.dir }));

const { killPids } = await import("../../src/utils/process.js");
const { INSTANCE_FILE, OWNER, pidInstanceFile, writeInstance } = await import("../../src/utils/instances.js");
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
  expect(t).toMatch(/\*\*crash\.log\*\* .*crash\.log \(Reason: Access violation\)/);
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
});

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
