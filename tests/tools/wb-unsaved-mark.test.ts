import { afterAll, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WorkbenchClient } from "../../src/workbench/client.js";
import type { TitleProbe } from "../../src/watchdog/probe.js";
import { registerWbEditorTools } from "../../src/tools/wb-editor.js";
import { registerWbLayers } from "../../src/tools/wb-layers.js";
import { registerWbResources } from "../../src/tools/wb-resources.js";
import type { Config } from "../../src/config.js";

// A layer the MCP creates does not put * in the World Editor title, so the client remembers it until a wb_save call succeeds.
// Workbench 1.9.0.37 asks "Loading world" for it on a .ent open but not on play or exit, so an open refuses and play warns.
// Nothing here runs netstat or PowerShell or reads a window: worldProbe and rawCall are stubbed on every client.

type Result = { content: { text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const PORT = 5775;
const listening = (pid: number) => `  TCP    0.0.0.0:${PORT}    0.0.0.0:0    LISTENING    ${pid}\r\n`;
const DIRTY = { cls: "Qt683QWindowIcon", text: "World Editor - MCPParity/Worlds/MCPParity.ent*" };
const CLEAN = { cls: "Qt683QWindowIcon", text: "World Editor - MCPParity/Worlds/MCPParity.ent" };
const dir = mkdtempSync(join(tmpdir(), "emcp-mark-"));
const WORLD = join(dir, "W.ent");
writeFileSync(WORLD, "x");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const OPEN_PATH = "Worlds/Other.ent";
const OPEN_MARK =
  "Refused: this MCP created a layer in the world open in Workbench since the last wb_save, so the world may have unsaved changes. " +
  `Opening ${OPEN_PATH} now would show Workbench's "Loading world" save prompt, which blocks every MCP call until a person answers it. Run wb_save, even if you already saved the world in Workbench, then try again.`;
const LAYER_NOTE = "A layer this MCP created is not saved yet and is dropped unless wb_save runs first.";
const savableWorld = { worldPath: "$T:W.ent", absPath: WORLD };

function setup(host = "127.0.0.1") {
  const env = {
    netstat: async (): Promise<string> => listening(4242),
    wins: [CLEAN] as { cls: string; text: string }[],
    titles: undefined as undefined | (() => Promise<TitleProbe>),
    world: savableWorld as Record<string, unknown>,
    mode: "edit",
    saveWrites: true,
    saveFails: false,
    openFails: false,
    resourcesOpenMessage: "done",
  };
  const client = new WorkbenchClient(host, PORT);
  const netstat = vi.fn(() => env.netstat());
  const titles = vi.fn(() => (env.titles ? env.titles() : Promise.resolve({ wins: env.wins })));
  client.worldProbe = { netstat, titles };
  const sent: string[] = [];
  let n = 0;
  vi.spyOn(client as unknown as { rawCall: (f: string, p: Record<string, unknown>) => Promise<unknown> }, "rawCall").mockImplementation(async (f, p) => {
    sent.push(`${f}:${p.action}`);
    if (f === "EMCP_WB_GetState") return { status: "ok", mode: env.mode };
    if (p.action === "worldInfo") return { status: "ok", ...env.world };
    if (p.action === "save") {
      if (env.saveFails) return { status: "error", message: "save refused by the handler" };
      if (env.saveWrites) writeFileSync(WORLD, `saved ${++n}`);
      return { status: "ok", saved: false }; // 1.9.0.37 returns false even when it writes
    }
    if (f === "EMCP_WB_Layers") return { status: "ok", layerPath: "L1", activeLayer: "default" };
    if (p.action === "openResource" && env.openFails) return { status: "error", message: "Workbench could not open" };
    if (f === "EMCP_WB_Resources") return { status: "ok", message: env.resourcesOpenMessage };
    return { status: "ok", message: "done" };
  });
  const tools: Record<string, Handler> = {};
  const descriptions: Record<string, string> = {};
  const server = {
    registerTool: (name: string, d: { description: string }, h: Handler) => ((tools[name] = h), (descriptions[name] = d.description)),
  } as unknown as McpServer;
  registerWbEditorTools(server, client, {} as Config);
  registerWbLayers(server, client, {} as Config);
  registerWbResources(server, client);
  return {
    env, client, netstat, titles, sent, descriptions,
    layer: () => tools.wb_layers({ action: "create", name: "L1" }),
    open: (path = OPEN_PATH) => tools.wb_open_resource({ path }),
    resOpen: (path = OPEN_PATH) => tools.wb_resources({ action: "open", path }),
    save: () => tools.wb_save({}),
    play: () => tools.wb_play({}),
    opens: () => sent.filter((s) => s.endsWith(":openResource")).length,
    plays: () => sent.filter((s) => s === "EMCP_WB_EditorControl:play").length,
  };
}

describe("a layer created by the MCP counts as unsaved for a world open", () => {
  it("a .ent open after a layer create is refused with the mark text and nothing is sent", async () => {
    const s = setup();
    expect((await s.layer()).isError).toBeUndefined();
    s.titles.mockClear();
    const r = await s.open();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(OPEN_MARK);
    expect(s.opens()).toBe(0);
    expect(s.titles).not.toHaveBeenCalled(); // the mark decides; no window read
  });

  it("a wb_save that wrote files clears the mark, so the open goes ahead", async () => {
    const s = setup();
    await s.layer();
    const saved = await s.save();
    expect(saved.content[0].text).toContain("**World saved**");
    const r = await s.open();
    expect(r.isError).toBeUndefined();
    expect(s.opens()).toBe(1);
  });

  it("a wb_save that wrote no file (the world was saved by hand) clears the mark too", async () => {
    const s = setup();
    await s.layer();
    s.env.saveWrites = false;
    const saved = await s.save();
    expect(saved.content[0].text).toContain("no file changed");
    const r = await s.open();
    expect(r.isError).toBeUndefined();
    expect(s.opens()).toBe(1);
  });

  it("a wb_save call that errors keeps the mark", async () => {
    const s = setup();
    await s.layer();
    s.env.saveFails = true;
    expect((await s.save()).isError).toBe(true);
    const r = await s.open();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(OPEN_MARK);
    expect(s.opens()).toBe(0);
  });

  it("a wb_resources open that answers ok but opened nothing keeps the mark", async () => {
    const s = setup();
    await s.layer();
    s.env.netstat = async () => ""; // cannot tell: the open is sent
    s.env.resourcesOpenMessage = "SetOpenedResource returned false for: Worlds/Other.ent";
    expect((await s.resOpen()).isError).toBe(true);
    s.env.netstat = async () => listening(4242);
    expect((await s.open()).content[0].text).toBe(OPEN_MARK);
    s.env.resourcesOpenMessage = "Opened";
    s.env.netstat = async () => "";
    expect((await s.resOpen()).isError).toBeUndefined();
    s.env.netstat = async () => listening(4242);
    expect((await s.open()).isError).toBeUndefined();
  });

  it("a successful .ent open clears the mark; a failed one does not", async () => {
    const s = setup();
    await s.layer();
    s.env.netstat = async () => ""; // cannot tell: the open is sent with a warning, and this one fails
    s.env.openFails = true;
    expect((await s.open()).isError).toBe(true);
    s.env.netstat = async () => listening(4242);
    expect((await s.open()).content[0].text).toBe(OPEN_MARK);
    s.env.netstat = async () => ""; // cannot tell again: the open is sent and succeeds
    s.env.openFails = false;
    expect((await s.open()).isError).toBeUndefined();
    expect(s.opens()).toBe(2);
    s.env.netstat = async () => listening(4242);
    const r = await s.open(); // the mark is gone and the title is clean
    expect(r.isError).toBeUndefined();
    expect(s.opens()).toBe(3);
  });

  it("a successful .gproj open clears the mark too: the project reload drops the world", async () => {
    const s = setup();
    await s.layer();
    s.env.netstat = async () => ""; // cannot tell: the open is sent
    expect((await s.resOpen("C:/mods/Other/addon.gproj")).isError).toBeUndefined(); // wb_open_resource refuses a .gproj; wb_resources still sends it
    s.env.netstat = async () => listening(4242);
    expect((await s.open()).isError).toBeUndefined();
  });

  it("a new PID on the port clears the mark", async () => {
    const s = setup();
    await s.layer();
    s.env.netstat = async () => listening(5151); // Workbench restarted
    const r = await s.open();
    expect(r.isError).toBeUndefined();
    expect(s.opens()).toBe(1);
    // A check that sends no open: only the PID change can have cleared the mark when the old PID answers again.
    s.env.netstat = async () => listening(4242);
    await s.layer();
    s.env.netstat = async () => listening(5151);
    expect((await s.play()).content[0].text).not.toContain(LAYER_NOTE);
    s.env.netstat = async () => listening(4242);
    expect((await s.play()).content[0].text).not.toContain(LAYER_NOTE);
  });

  it("a layer create with no readable PID marks nothing, and the title check still runs", async () => {
    const s = setup();
    s.env.netstat = async () => "";
    await s.layer();
    s.env.netstat = async () => listening(4242);
    const r = await s.open();
    expect(r.isError).toBeUndefined();
    expect(s.titles).toHaveBeenCalledWith(4242);
  });

  it("a layer create on a remote host reads no netstat", async () => {
    const s = setup("10.0.0.5");
    await s.layer();
    expect(s.netstat).not.toHaveBeenCalled();
  });
});

describe("the mark cannot block an open for good", () => {
  it.each([
    ["unnamed", { worldPath: "" }],
    ["packed (no file on disk)", { worldPath: "$T:W.ent", absPath: "" }],
  ])("a layer create in a world that is %s is refused, sets no mark, and the open is not refused", async (_n, world) => {
    const s = setup();
    s.env.world = world;
    expect((await s.layer()).isError).toBe(true);
    expect(s.sent).not.toContain("EMCP_WB_Layers:create");
    const r = await s.open();
    expect(r.isError).toBeUndefined();
    expect(s.opens()).toBe(1);
  });

  it("a wb_save that refuses because the world is not a savable file drops a stale mark, so the open can go ahead", async () => {
    const s = setup();
    await s.layer(); // marked in a savable world
    s.env.world = { worldPath: "$T:Packed.ent", absPath: "" }; // the user then opened a packed world by hand
    expect((await s.save()).isError).toBe(true);
    expect((await s.open()).isError).toBeUndefined();
  });

  it("a wb_save that refuses for play mode keeps the mark: the layer may still be waiting", async () => {
    const s = setup();
    await s.layer();
    s.env.world = { ...savableWorld, gameMode: true };
    expect((await s.save()).content[0].text).toContain("Play mode: stop it with wb_stop before saving.");
    expect((await s.open()).content[0].text).toBe(OPEN_MARK);
  });

  it("with no world open the mark is dropped: wb_save cannot run, and the open is the way to get a world", async () => {
    const s = setup();
    await s.layer();
    s.env.mode = "no_world";
    expect((await s.save()).isError).toBe(true);
    expect((await s.open()).isError).toBeUndefined();
  });
});

describe("the footer after a world open", () => {
  it("a .ent open that opened says edit mode, from any cached mode", async () => {
    const s = setup();
    s.client.setMode("no_world");
    const r = await s.open();
    expect(r.content[0].text.endsWith("`Workbench: edit mode`")).toBe(true);
    s.client.setMode("unknown");
    expect((await s.resOpen()).content[0].text.endsWith("`Workbench: edit mode`")).toBe(true);
  });

  it("a Resources open that answers SetOpenedResource returned false leaves the cached mode as it was", async () => {
    const s = setup();
    s.client.setMode("no_world");
    s.env.resourcesOpenMessage = "SetOpenedResource returned false for: Worlds/Other.ent";
    const r = await s.resOpen();
    expect(r.isError).toBe(true);
    expect(r.content[0].text.endsWith("`Workbench: no world open`")).toBe(true);
  });

  it("a .gproj open loads no world, so it does not say edit mode", async () => {
    const s = setup();
    s.client.setMode("no_world");
    const r = await s.resOpen("C:/mods/Other/addon.gproj");
    expect(r.content[0].text.endsWith("`Workbench: no world open`")).toBe(true);
  });
});

describe("wb_play and unsaved changes", () => {
  it("an unsaved title plays: no refusal, no window read, no extra line", async () => {
    const s = setup();
    s.env.wins = [CLEAN, DIRTY];
    const r = await s.play();
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("**Play Mode Started**");
    expect(r.content[0].text).not.toContain("Could not check");
    expect(r.content[0].text).not.toContain("unsaved");
    expect(s.plays()).toBe(1);
    expect(s.titles).not.toHaveBeenCalled();
  });

  it("a layer this MCP created plays with exactly one line, and no window is read", async () => {
    const s = setup();
    await s.layer();
    const r = await s.play();
    expect(r.isError).toBeUndefined();
    expect(s.plays()).toBe(1);
    expect(r.content[0].text.split(LAYER_NOTE).length).toBe(2);
    expect(r.content[0].text).toContain(`entering game mode.\ndone\n\n${LAYER_NOTE}\n\n---`);
    expect(s.titles).not.toHaveBeenCalled();
  });

  it("after a wb_save that wrote files, play carries no line", async () => {
    const s = setup();
    await s.layer();
    await s.save();
    const r = await s.play();
    expect(r.content[0].text).not.toContain(LAYER_NOTE);
    expect(s.plays()).toBe(1);
  });

  it("a netstat that fails cannot show the mark is stale, so the line is still said", async () => {
    const s = setup();
    await s.layer();
    s.env.netstat = async () => "";
    expect((await s.play()).content[0].text).toContain(LAYER_NOTE);
    s.env.netstat = () => Promise.reject(new Error("only Windows can be checked"));
    expect((await s.play()).content[0].text).toContain(LAYER_NOTE);
  });

  it("with no mark it reads no netstat at all, also off this PC", async () => {
    const s = setup("10.0.0.5");
    const r = await s.play();
    expect(s.netstat).not.toHaveBeenCalled();
    expect(r.content[0].text).not.toContain("Could not check");
    expect(s.plays()).toBe(1);
  });

  it("the description no longer claims a refusal for unsaved changes and says what it does instead", () => {
    const d = setup().descriptions.wb_play;
    expect(d).not.toContain("Also refuses, without playing, a world with unsaved changes");
    expect(d).not.toContain("World needs to be saved");
    expect(d).toContain("Plays a world with unsaved changes without asking to save");
    expect(d).toContain("the reply adds a line that wb_save has to run first or the layer is dropped");
  });
});
