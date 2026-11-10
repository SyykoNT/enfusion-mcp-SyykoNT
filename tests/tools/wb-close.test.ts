import { afterAll, describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
const dir = mkdtempSync(join(tmpdir(), "emcp-close-"));
const WORLD = join(dir, "W.ent");
writeFileSync(WORLD, "x");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let closeDescription = "";
// wb_close may check for unsaved changes: a client without a stubbed probe would run netstat for real.
const stubbed = (c: InstanceType<typeof WorkbenchClient>) => {
  c.worldProbe = { netstat: async () => "", titles: async () => ({ unavailable: "not reached" }) };
  return c;
};
function wbClose(client = stubbed(new WorkbenchClient("127.0.0.1", 1))): (a: Record<string, unknown>) => Promise<Result> {
  const tools: Record<string, (a: Record<string, unknown>) => Promise<Result>> = {};
  const fake = { registerTool: (name: string, d: { description: string }, h: (a: Record<string, unknown>) => Promise<Result>) => { tools[name] = h; if (name === "wb_close") closeDescription = d.description; } };
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

// Live check on 1.9.0.37: a close that saves cannot raise a prompt, Exit(0) with unsaved edits raises none, a window close does.
// So save=false closes unchecked, the default close first asks whether wb_save would refuse (the handler would save into a packed or game folder)
// and then refuses an unsaved world it cannot save, and only a window close for another Workbench is checked for a prompt.
// No test here runs netstat or reads a window: worldProbe and call are stubbed.
describe.runIf(process.platform === "win32")("wb_close and unsaved changes", () => {
  const LISTENING = "  TCP    0.0.0.0:1    0.0.0.0:0    LISTENING    500\r\n";
  const DIRTY = { cls: "Qt683QWindowIcon", text: "World Editor - MCPParity/Worlds/MCPParity.ent*" };
  const CLEAN = { cls: "Qt683QWindowIcon", text: "World Editor - MCPParity/Worlds/MCPParity.ent" };
  const LAYER_NOTE = "A layer this MCP created is not saved yet and is dropped unless wb_save runs first.";
  const SAVABLE = { worldPath: "$T:W.ent", absPath: WORLD };
  const windowTail =
    "Closing Workbench now would show Workbench's \"World editor - closing\" prompt, which blocks every MCP call until a person answers it. " +
    "Run wb_save first, or save or discard the changes in Workbench, then try again.";
  const lostTail = (why: string) =>
    `${why} Closing now would lose the unsaved changes. Do what that says if it names a step, or save the world by hand in Workbench (File > Save World As, in your own addon), then close again; force=true closes and discards them.`;
  const refused = (why: string) =>
    `Refused: the world open in Workbench (MCPParity/Worlds/MCPParity.ent) has unsaved changes (its World Editor title ends in *). ${lostTail(why)}`;

  const UNNAMED = "No world file: the open world is unnamed. Saving would open Workbench's \"Save world as\" dialog and block every MCP call. Save it once in Workbench (File > Save World As) or open a world from a file.";
  const PLAY = "Play mode: stop it with wb_stop before saving.";
  const PREFAB = "Prefab edit mode: wb_save saves worlds. Use wb_prefabs save for the prefab, or leave prefab edit mode to work on the world.";
  const PACKED = "World $T:P.ent has no file on disk that Workbench could resolve (packed addon?). Save a copy in your own addon by hand (File > Save World As) and work on that.";
  // [state, worldInfo, why]
  const CANNOT_SAVE: [string, Record<string, unknown>, string][] = [
    ["unnamed", { worldPath: "" }, UNNAMED],
    ["play mode", { ...SAVABLE, gameMode: true }, PLAY],
    ["prefab edit mode", { ...SAVABLE, prefabEditMode: true }, PREFAB],
    ["packed (no file on disk)", { worldPath: "$T:P.ent", absPath: "" }, PACKED],
  ];

  // The unnamed row has its own test: worldInfo gives the same empty path with no world open, so its note is the old one.
  const NAMED_CANNOT_SAVE = CANNOT_SAVE.filter(([n]) => n !== "unnamed");

  function setup(netstat: () => Promise<string>, wins: { cls: string; text: string }[], world: Record<string, unknown> | Error = SAVABLE) {
    const client = new WorkbenchClient("127.0.0.1", 1);
    const net = vi.fn(netstat);
    const titles = vi.fn(async () => ({ wins }));
    client.worldProbe = { netstat: net, titles };
    const call = vi.spyOn(client, "call").mockImplementation((async (_f: string, p?: Record<string, unknown>) => {
      if (p?.action === "worldInfo") {
        if (world instanceof Error) throw world;
        return { status: "ok", ...world };
      }
      return { status: "ok" };
    }) as never);
    sys.alive = new Set([500]);
    const exits = () => call.mock.calls.filter((c) => c[0] === "EMCP_WB_Exit").map((c) => c[1]);
    return { client, net, titles, call, exits, close: wbClose(client) };
  }

  describe("save=false is the user's discard: no check, no refusal", () => {
    it("an unsaved title closes with Exit save:false and reads no window", async () => {
      const s = setup(async () => LISTENING, [CLEAN, DIRTY]);
      const r = await s.close({ save: false, force: false });
      expect(r.isError).toBeUndefined();
      expect(r.content[0].text).toContain("**Workbench closed.** Closed without saving.");
      expect(r.content[0].text).not.toContain("unsaved");
      expect(s.call).toHaveBeenCalledWith("EMCP_WB_Exit", { save: false }, { timeout: 20_000 });
      expect(s.call).toHaveBeenCalledTimes(1); // no worldInfo read either
      expect(s.titles).not.toHaveBeenCalled();
    });

    it("a layer this MCP created closes with one line that it is dropped", async () => {
      const s = setup(async () => LISTENING, [CLEAN]);
      await s.client.markLayerCreated();
      const r = await s.close({ save: false, force: false });
      expect(r.isError).toBeUndefined();
      expect(r.content[0].text.split(LAYER_NOTE).length).toBe(2);
      expect(s.exits()).toEqual([{ save: false }]);
      expect(s.titles).not.toHaveBeenCalled();
    });

    it("force is not needed and changes nothing", async () => {
      const s = setup(async () => LISTENING, [DIRTY]);
      const r = await s.close({ save: false, force: true });
      expect(r.isError).toBeUndefined();
      expect(s.exits()).toEqual([{ save: false }]);
    });
  });

  describe("the default close", () => {
    it("on a world wb_save can write sends save:true after reading the world, and reads no window", async () => {
      const s = setup(async () => LISTENING, [DIRTY]);
      await s.client.markLayerCreated();
      s.net.mockClear();
      const r = await s.close({ save: true, force: false });
      expect(r.isError).toBeUndefined();
      expect(s.call.mock.calls.map((c) => [c[0], (c[1] as { action?: string }).action])).toEqual([["EMCP_WB_EditorControl", "worldInfo"], ["EMCP_WB_Exit", undefined]]);
      expect(s.exits()).toEqual([{ save: true }]);
      expect(s.net).not.toHaveBeenCalled(); // the save writes the layer, so there is nothing to warn about
      expect(s.titles).not.toHaveBeenCalled();
      expect(r.content[0].text).not.toContain(LAYER_NOTE);
    });

    describe("after a refused open has left the world stale (B-181), the default save cannot happen", () => {
      const STALE = "A refused open left the world in this Workbench unstable, so saving it could crash Workbench.";
      // The real client sets the mark from a refused open and refuses the pre-save world read itself; only rawCall is stubbed.
      async function stale(wins: { cls: string; text: string }[]) {
        const client = new WorkbenchClient("127.0.0.1", 1);
        client.worldProbe = { netstat: async () => LISTENING, titles: async () => ({ wins }) };
        const sent: [string, Record<string, unknown>][] = [];
        vi.spyOn(client as unknown as { rawCall: (f: string, p: Record<string, unknown>) => Promise<unknown> }, "rawCall").mockImplementation(async (f, p) => {
          sent.push([f, p]);
          if (p.action === "openResource") return { status: "error", message: `Workbench could not open: ${p.path}` };
          return { status: "ok" };
        });
        await expect(client.call("EMCP_WB_EditorControl", { action: "openResource", path: "Prefabs/NoSuch.et" })).rejects.toThrow("Workbench could not open");
        sent.length = 0;
        sys.alive = new Set([500]);
        return { sent, close: wbClose(client) };
      }

      it("refuses a world with unsaved changes and sends nothing", async () => {
        const s = await stale([DIRTY]);
        const r = await s.close({ save: true, force: false });
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toBe(refused(STALE));
        expect(s.sent).toEqual([]);
        expect(sys.alive.has(500)).toBe(true);
      });

      it("force=true closes the unsaved world with save:false and says why", async () => {
        const s = await stale([DIRTY]);
        const r = await s.close({ save: true, force: true });
        expect(r.isError).toBeUndefined();
        expect(s.sent).toEqual([["EMCP_WB_Exit", { save: false }]]);
        expect(r.content[0].text).toContain(`Nothing was saved: ${STALE}`);
      });

      it("a clean world closes with save:false and says why", async () => {
        const s = await stale([CLEAN]);
        const r = await s.close({ save: true, force: false });
        expect(r.isError).toBeUndefined();
        expect(s.sent).toEqual([["EMCP_WB_Exit", { save: false }]]);
        expect(r.content[0].text).toBe(`**Workbench closed.** Nothing was saved: ${STALE}`);
      });
    });

    it("on a world inside a forbidden root sends save:false, never save:true, and says why", async () => {
      vi.stubEnv("ENFUSION_FORBIDDEN_DIRS", dir);
      try {
        const s = setup(async () => LISTENING, [CLEAN]);
        const r = await s.close({ save: true, force: false });
        expect(r.isError).toBeUndefined();
        expect(s.exits()).toEqual([{ save: false }]);
        expect(r.content[0].text).toContain(`Nothing was saved: World $T:W.ent is inside ${dir} (game or Tools install, Workshop cache, or ENFUSION_FORBIDDEN_DIRS): a save would write there.`);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("on a world inside a forbidden root with unsaved changes is refused with the way out, and nothing is sent or killed", async () => {
      vi.stubEnv("ENFUSION_FORBIDDEN_DIRS", dir);
      try {
        const s = setup(async () => LISTENING, [DIRTY]);
        const r = await s.close({ save: true, force: false });
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toContain(`is inside ${dir}`);
        expect(r.content[0].text).toContain("save the world by hand in Workbench (File > Save World As, in your own addon)");
        expect(r.content[0].text).toContain("force=true closes and discards them.");
        expect(s.exits()).toEqual([]);
        expect(sys.taskkill).toEqual([]);
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it.each(CANNOT_SAVE)("%s, unsaved: refused with the reason and the way out, nothing is sent or killed", async (_n, world, why) => {
      const s = setup(async () => LISTENING, [CLEAN, DIRTY], world);
      const r = await s.close({ save: true, force: false });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe(refused(why));
      expect(s.exits()).toEqual([]);
      expect(sys.taskkill).toEqual([]);
      expect(sys.alive.has(500)).toBe(true);
    });

    it.each(NAMED_CANNOT_SAVE)("%s, clean: closes with save:false and says nothing was saved and why", async (_n, world, why) => {
      const s = setup(async () => LISTENING, [CLEAN], world);
      const r = await s.close({ save: true, force: false });
      expect(r.isError).toBeUndefined();
      expect(s.exits()).toEqual([{ save: false }]);
      expect(r.content[0].text).toContain(`Nothing was saved: ${why}`);
    });

    it.each(NAMED_CANNOT_SAVE)("%s, unsaved, force=true: closes with save:false and reads no window", async (_n, world, why) => {
      const s = setup(async () => LISTENING, [DIRTY], world);
      const r = await s.close({ save: true, force: true });
      expect(r.isError).toBeUndefined();
      expect(s.exits()).toEqual([{ save: false }]);
      expect(s.titles).not.toHaveBeenCalled();
      expect(r.content[0].text).toContain(`Nothing was saved: ${why}`);
    });

    it("an empty world path (no world open) closes with save:false and keeps the old line, not the unnamed-world advice", async () => {
      const s = setup(async () => LISTENING, [CLEAN], { worldPath: "" });
      const r = await s.close({ save: true, force: false });
      expect(r.isError).toBeUndefined();
      expect(s.exits()).toEqual([{ save: false }]);
      expect(r.content[0].text).toContain("Nothing saved (no world open or save refused).");
      expect(r.content[0].text).not.toContain("unnamed");
    });

    it("play mode does not count as clean: the title keeps * during play", async () => {
      const s = setup(async () => LISTENING, [DIRTY], { ...SAVABLE, gameMode: true });
      const r = await s.close({ save: true, force: false });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("Play mode: stop it with wb_stop before saving.");
      expect(s.exits()).toEqual([]);
    });

    it("cannot tell on a world it cannot save: closes with save:false and adds one line that unsaved edits are lost", async () => {
      const s = setup(async () => "", [DIRTY], { worldPath: "" });
      const r = await s.close({ save: true, force: false });
      expect(r.isError).toBeUndefined();
      expect(s.exits()).toEqual([{ save: false }]);
      expect(r.content[0].text.split("Could not check for unsaved changes").length).toBe(2);
      expect(r.content[0].text).toContain("Could not check for unsaved changes (the netstat query failed); if the current world has unsaved edits, closing now loses them.");
    });

    it("a layer this MCP created on a world it cannot save closes with save:false and says the layer is dropped", async () => {
      const s = setup(async () => LISTENING, [CLEAN], { worldPath: "" });
      await s.client.markLayerCreated();
      const r = await s.close({ save: true, force: false });
      expect(r.isError).toBeUndefined();
      expect(s.exits()).toEqual([{ save: false }]);
      expect(r.content[0].text.split(LAYER_NOTE).length).toBe(2);
    });

    it.each([
      ["no world open", new Error("WorldEditor module not available")],
      ["an old handler", new Error("Unknown action: worldInfo. Valid: play, stop, save, saveAs, undo, redo, openResource")],
      ["a dialog (timeout)", new Error("No answer from Workbench in 10 s")],
    ])("a world read that fails (%s) changes nothing: the close goes ahead with save:true as asked", async (_n, err) => {
      const s = setup(async () => LISTENING, [DIRTY], err);
      const r = await s.close({ save: true, force: false });
      expect(r.isError).toBeUndefined();
      expect(s.exits()).toEqual([{ save: true }]);
      expect(s.titles).not.toHaveBeenCalled();
    });
  });

  describe("with another Workbench running (the close is by window)", () => {
    const withOther = (netstat: () => Promise<string>, wins: { cls: string; text: string }[]) => {
      const s = setup(netstat, wins);
      sys.alive = new Set([500, 600]); // 600 is the user's own Workbench
      return s;
    };

    it("an unsaved world owned by our Workbench is refused even with the default save, names the closing prompt, and nothing is killed", async () => {
      const s = withOther(async () => LISTENING, [DIRTY]); // port owner 500 is ours
      const r = await s.close({ save: true, force: false });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe(
        `Refused: the world open in Workbench (MCPParity/Worlds/MCPParity.ent) has unsaved changes (its World Editor title ends in *). ${windowTail}`
      );
      expect(s.call).not.toHaveBeenCalled();
      expect(sys.taskkill).toEqual([]);
    });

    it("force=true closes it without the check", async () => {
      const s = withOther(async () => LISTENING, [DIRTY]);
      const r = await s.close({ save: true, force: true });
      expect(r.isError).toBeUndefined();
      expect(s.titles).not.toHaveBeenCalled();
      expect(killed()).toEqual([500]);
    });

    it("a clean world owned by our Workbench closes by window close, with no warning and no world read", async () => {
      const s = withOther(async () => LISTENING, [CLEAN]);
      const r = await s.close({ save: true, force: false });
      expect(r.isError).toBeUndefined();
      expect(r.content[0].text).not.toContain("Could not check");
      expect(s.call).not.toHaveBeenCalled();
      expect(killed()).toEqual([500]);
    });

    it("a layer this MCP created on a clean title closes with the dropped line", async () => {
      const s = withOther(async () => LISTENING, [CLEAN]);
      await s.client.markLayerCreated();
      const r = await s.close({ save: true, force: false });
      expect(r.isError).toBeUndefined();
      expect(r.content[0].text.split(LAYER_NOTE).length).toBe(2);
      expect(killed()).toEqual([500]);
    });

    it("a port owner that is not ours is not judged: it closes and adds one cannot-tell line", async () => {
      const s = withOther(async () => LISTENING.replace("500", "600"), [DIRTY]);
      const r = await s.close({ save: false, force: false });
      expect(r.isError).toBeUndefined();
      expect(s.titles).not.toHaveBeenCalled();
      expect(r.content[0].text.split("Could not check for unsaved changes").length).toBe(2);
      expect(r.content[0].text).toContain("(another Workbench runs and may own the NET API port)");
      expect(r.content[0].text).toContain('Workbench will show a blocking "World editor - closing" prompt.');
      expect(killed()).toEqual([500]);
    });
  });

  it("a Workbench this MCP did not start is refused before any check or read", async () => {
    const s = setup(async () => LISTENING, [DIRTY]);
    sys.alive = new Set([600]);
    const r = await s.close({ save: true, force: false });
    expect(r.content[0].text).toContain("**Not closed.**");
    expect(s.net).not.toHaveBeenCalled();
    expect(s.call).not.toHaveBeenCalled();
  });

  it("the description says what the close does now and no longer claims the refusal for save=false", () => {
    expect(closeDescription).toContain("save=false closes without saving and without a check: Workbench asks nothing, and the unsaved edits are lost.");
    expect(closeDescription).toContain("it closes without saving instead, and unless force=true it first refuses, without closing, a world with unsaved changes");
    expect(closeDescription).toContain('Workbench asks "World editor - closing"');
    expect(closeDescription).not.toContain("a close that does not save first (save=false");
  });
});
