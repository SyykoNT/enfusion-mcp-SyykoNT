import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// execFileSync is stubbed: tasklist reports fake Workbench PIDs, taskkill is only recorded. Nothing real is listed or killed.
const sys = vi.hoisted(() => ({ alive: new Set<number>(), taskkill: [] as string[][], ignorePolite: false }));
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  execFileSync: vi.fn((cmd: string, args: string[]) => {
    if (cmd === "tasklist") return [...sys.alive].map((p) => `"ArmaReforgerWorkbenchSteamDiag.exe","${p}","Console","1","1 K"`).join("\n");
    if (cmd === "taskkill") {
      sys.taskkill.push(args);
      if (args.includes("/F") || !sys.ignorePolite) sys.alive.delete(Number(args[args.indexOf("/PID") + 1]));
      return "";
    }
    throw new Error(`unexpected ${cmd}`);
  }),
}));
vi.mock("../../src/utils/process.js", async (orig) => ({
  ...(await orig<typeof import("../../src/utils/process.js")>()),
  sleep: () => Promise.resolve(),
}));
vi.mock("../../src/utils/instances.js", async (orig) => ({
  ...(await orig<typeof import("../../src/utils/instances.js")>()),
  isOwned: (pid: number) => pid === 500, // 500 was spawned by this MCP, 600 is the user's own Workbench
}));

const { registerWbLaunch } = await import("../../src/tools/wb-launch.js");
const { killPids } = await import("../../src/utils/process.js");
const { WorkbenchClient } = await import("../../src/workbench/client.js");
const { loadConfig } = await import("../../src/config.js");

type Result = { content: { text: string }[]; isError?: boolean };
function wbClose(): (a: Record<string, unknown>) => Promise<Result> {
  const tools: Record<string, (a: Record<string, unknown>) => Promise<Result>> = {};
  const fake = { registerTool: (name: string, _d: unknown, h: (a: Record<string, unknown>) => Promise<Result>) => { tools[name] = h; } };
  registerWbLaunch(fake as unknown as McpServer, loadConfig(), new WorkbenchClient("127.0.0.1", 1));
  return tools.wb_close;
}
const killed = () => sys.taskkill.map((a) => Number(a[a.indexOf("/PID") + 1]));

beforeEach(() => {
  sys.taskkill = [];
  sys.ignorePolite = false;
});

describe.runIf(process.platform === "win32")("wb_close ownership", () => {
  it("refuses a Workbench this MCP did not start and never calls taskkill", async () => {
    sys.alive = new Set([600]);
    const result = await wbClose()({ save: true, force: true });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not started by this MCP session");
    expect(sys.taskkill).toEqual([]);
    expect(sys.alive.has(600)).toBe(true);
  });

  it("closes only the owned Workbench, without /T, and leaves the other running", async () => {
    sys.alive = new Set([500, 600]);
    const result = await wbClose()({ save: true, force: false });
    expect(result.isError).toBeUndefined();
    expect(killed()).toEqual([500]);
    expect(sys.taskkill.flat()).not.toContain("/T");
    expect(sys.alive.has(600)).toBe(true);
    expect(result.content[0].text).toContain("Not touched: Workbench pid 600");
  });

  it("force-kills only the owned Workbench when it ignores the close request", async () => {
    sys.alive = new Set([500, 600]);
    sys.ignorePolite = true;
    const result = await wbClose()({ save: true, force: true });
    expect(result.isError).toBeUndefined();
    expect(killed().every((p) => p === 500)).toBe(true);
    expect(sys.taskkill.at(-1)).toEqual(["/PID", "500", "/F"]);
    expect(sys.alive.has(600)).toBe(true);
  });

  it("killPids adds /T only when asked for the tree", () => {
    sys.alive = new Set([7, 8]);
    killPids([7], true);
    killPids([8], true, true);
    expect(sys.taskkill).toEqual([["/PID", "7", "/F"], ["/PID", "8", "/T", "/F"]]);
  });
});
