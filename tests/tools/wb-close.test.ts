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
// wb_close may check for unsaved changes: a client without a stubbed probe would run netstat for real.
const stubbed = (c: InstanceType<typeof WorkbenchClient>) => {
  c.worldProbe = { netstat: async () => "", titles: async () => ({ unavailable: "not reached" }) };
  return c;
};
function wbClose(client = stubbed(new WorkbenchClient("127.0.0.1", 1))): (a: Record<string, unknown>) => Promise<Result> {
  const tools: Record<string, (a: Record<string, unknown>) => Promise<Result>> = {};
  const fake = { registerTool: (name: string, _d: unknown, h: (a: Record<string, unknown>) => Promise<Result>) => { tools[name] = h; } };
  registerWbLaunch(fake as unknown as McpServer, loadConfig(), client);
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

// Closing without saving can raise Workbench's save prompt; the default close saves first and cannot. No test here runs netstat or reads a window.
describe.runIf(process.platform === "win32")("wb_close without saving checks for unsaved changes", () => {
  const LISTENING = "  TCP    0.0.0.0:1    0.0.0.0:0    LISTENING    500\r\n";
  const DIRTY = { cls: "Qt683QWindowIcon", text: "World Editor - MCPParity/Worlds/MCPParity.ent*" };
  const CLEAN = { cls: "Qt683QWindowIcon", text: "World Editor - MCPParity/Worlds/MCPParity.ent" };
  const tail =
    "Closing Workbench now would show Workbench's save-changes prompt, which blocks every MCP call until a person answers it. " +
    "Run wb_save first, or save or discard the changes in Workbench, then try again.";
  const markTail =
    "Closing Workbench now would show Workbench's save-changes prompt, which blocks every MCP call until a person answers it. " +
    "Run wb_save, even if you already saved the world in Workbench, then try again.";

  function setup(netstat: () => Promise<string>, wins: { cls: string; text: string }[]) {
    const client = new WorkbenchClient("127.0.0.1", 1);
    const net = vi.fn(netstat);
    const titles = vi.fn(async () => ({ wins }));
    client.worldProbe = { netstat: net, titles };
    const call = vi.spyOn(client, "call").mockResolvedValue({ status: "ok" });
    sys.alive = new Set([500]);
    return { client, net, titles, call, close: wbClose(client) };
  }

  it("refuses an unsaved title with the world named, and sends and kills nothing", async () => {
    const s = setup(async () => LISTENING, [CLEAN, DIRTY]);
    const r = await s.close({ save: false, force: false });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(
      `Refused: the world open in Workbench (MCPParity/Worlds/MCPParity.ent) has unsaved changes (its World Editor title ends in *). ${tail}`
    );
    expect(s.call).not.toHaveBeenCalled();
    expect(sys.taskkill).toEqual([]);
    expect(sys.alive.has(500)).toBe(true);
  });

  it("refuses when only the layer mark is set, without reading a window", async () => {
    const s = setup(async () => LISTENING, [CLEAN]);
    await s.client.markLayerCreated();
    const r = await s.close({ save: false, force: false });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(
      `Refused: this MCP created a layer in the world open in Workbench since the last wb_save, so the world may have unsaved changes. ${markTail}`
    );
    expect(s.call).not.toHaveBeenCalled();
    expect(s.titles).not.toHaveBeenCalled();
    expect(sys.taskkill).toEqual([]);
  });

  it("a clean world closes as before, with no extra line", async () => {
    const s = setup(async () => LISTENING, [CLEAN]);
    const r = await s.close({ save: false, force: false });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("**Workbench closed.**");
    expect(r.content[0].text).not.toContain("Could not check");
    expect(s.call).toHaveBeenCalledWith("EMCP_WB_Exit", { save: false }, { timeout: 20_000 });
  });

  it("cannot tell: it closes and adds one warning line", async () => {
    const s = setup(async () => "", [DIRTY]);
    const r = await s.close({ save: false, force: false });
    expect(r.isError).toBeUndefined();
    expect(s.call).toHaveBeenCalledTimes(1);
    expect(r.content[0].text.split("Could not check for unsaved changes").length).toBe(2);
    expect(r.content[0].text).toContain(
      'Could not check for unsaved changes (the netstat query failed); if the current world has unsaved edits, Workbench will show a blocking save-changes prompt.'
    );
  });

  it("the default close saves first, so it does not run the check", async () => {
    const s = setup(async () => LISTENING, [DIRTY]);
    await s.client.markLayerCreated();
    s.net.mockClear();
    const r = await s.close({ save: true, force: false });
    expect(r.isError).toBeUndefined();
    expect(s.net).not.toHaveBeenCalled();
    expect(s.call).toHaveBeenCalledWith("EMCP_WB_Exit", { save: true }, { timeout: 20_000 });
  });

  it("a Workbench this MCP did not start is refused before any check", async () => {
    const s = setup(async () => LISTENING, [DIRTY]);
    sys.alive = new Set([600]);
    const r = await s.close({ save: false, force: false });
    expect(r.content[0].text).toContain("**Not closed.**");
    expect(s.net).not.toHaveBeenCalled();
  });

  it("save=false with force=true is not refused: force documents that unsaved work is lost", async () => {
    const s = setup(async () => LISTENING, [DIRTY]);
    await s.client.markLayerCreated();
    s.net.mockClear();
    const r = await s.close({ save: false, force: true });
    expect(r.isError).toBeUndefined();
    expect(s.net).not.toHaveBeenCalled();
    expect(s.call).toHaveBeenCalledWith("EMCP_WB_Exit", { save: false }, { timeout: 20_000 });
  });

  describe("with another Workbench running", () => {
    const withOther = (netstat: () => Promise<string>, wins: { cls: string; text: string }[]) => {
      const s = setup(netstat, wins);
      sys.alive = new Set([500, 600]); // 600 is the user's own Workbench
      return s;
    };

    it("an unsaved world owned by our Workbench is refused even with the default save, and nothing is killed", async () => {
      const s = withOther(async () => LISTENING, [DIRTY]); // port owner 500 is ours
      const r = await s.close({ save: true, force: false });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("has unsaved changes");
      expect(s.call).not.toHaveBeenCalled();
      expect(sys.taskkill).toEqual([]);
    });

    it("a clean world owned by our Workbench closes by window close, with no warning", async () => {
      const s = withOther(async () => LISTENING, [CLEAN]);
      const r = await s.close({ save: true, force: false });
      expect(r.isError).toBeUndefined();
      expect(r.content[0].text).not.toContain("Could not check");
      expect(killed()).toEqual([500]);
    });

    it("a port owner that is not ours is not judged: it closes and adds one cannot-tell line", async () => {
      const s = withOther(async () => LISTENING.replace("500", "600"), [DIRTY]);
      const r = await s.close({ save: false, force: false });
      expect(r.isError).toBeUndefined();
      expect(s.titles).not.toHaveBeenCalled();
      expect(r.content[0].text.split("Could not check for unsaved changes").length).toBe(2);
      expect(r.content[0].text).toContain("(another Workbench runs and may own the NET API port)");
      expect(killed()).toEqual([500]);
    });
  });
});
