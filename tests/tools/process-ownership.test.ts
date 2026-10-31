import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProcInfo } from "../../src/utils/process.js";

// No real process is listed, signalled or killed: the process helpers are replaced.
const procs = vi.hoisted(() => ({ servers: [] as ProcInfo[], clients: [] as ProcInfo[], alive: new Set<number>(), ignorePolite: false }));
vi.mock("../../src/utils/process.js", async (orig) => ({
  ...(await orig<typeof import("../../src/utils/process.js")>()),
  serverProcesses: () => procs.servers,
  clientProcesses: () => procs.clients,
  processInfo: (pid: number) => [...procs.servers, ...procs.clients].find((p) => p.pid === pid),
  isAlive: (pid: number) => procs.alive.has(pid),
  killPids: vi.fn((pids: number[], force?: boolean) => {
    if (force || !procs.ignorePolite) pids.forEach((p) => procs.alive.delete(p));
  }),
  sleep: () => Promise.resolve(),
}));

const { killPids } = await import("../../src/utils/process.js");
const { INSTANCE_FILE, OWNER, clientInstanceFile, writeInstance } = await import("../../src/utils/instances.js");
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
const own = { ownerPid: OWNER.pid, ownerStartedAt: OWNER.startedAt, startedAt: now, name: "default", exe: "x.exe" };

beforeEach(() => {
  vi.mocked(killPids).mockClear();
  procs.alive = new Set();
  procs.ignorePolite = false;
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
    expect(vi.mocked(killPids).mock.calls).toEqual([[[100]], [[100], true]]);
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
    writeInstance(clientInstanceFile(config.clientProfilesRoot, 300), { kind: "client", pid: 300, ...own });
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
