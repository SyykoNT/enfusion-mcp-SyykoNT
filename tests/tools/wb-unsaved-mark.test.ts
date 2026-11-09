import { afterAll, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WorkbenchClient } from "../../src/workbench/client.js";
import type { TitleProbe } from "../../src/watchdog/probe.js";
import { registerWbEditorTools } from "../../src/tools/wb-editor.js";
import { registerWbLayers } from "../../src/tools/wb-layers.js";
import type { Config } from "../../src/config.js";

// A layer the MCP creates does not put * in the World Editor title, so the client remembers it until wb_save writes files.
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
const tail = (doing: string, prompt: string) =>
  `${doing} now would show Workbench's ${prompt}, which blocks every MCP call until a person answers it. Run wb_save first, or save or discard the changes in Workbench, then try again.`;
const markRefusal = (doing: string, prompt: string) =>
  `Refused: this MCP created a layer in the world open in Workbench since the last wb_save, so the world has unsaved changes. ${tail(doing, prompt)}`;
const OPEN_MARK = markRefusal(`Opening ${OPEN_PATH}`, '"Loading world" save prompt');
const PLAY_MARK = markRefusal("Starting play", '"World needs to be saved" prompt');
const PLAY_WARN = (why: string) =>
  `Could not check for unsaved changes (${why}); if the current world has unsaved edits, Workbench will show a blocking "World needs to be saved" prompt.`;

function setup(host = "127.0.0.1") {
  const env = {
    netstat: async (): Promise<string> => listening(4242),
    wins: [CLEAN] as { cls: string; text: string }[],
    titles: undefined as undefined | (() => Promise<TitleProbe>),
    saveWrites: true,
    openFails: false,
  };
  const client = new WorkbenchClient(host, PORT);
  const netstat = vi.fn(() => env.netstat());
  const titles = vi.fn(() => (env.titles ? env.titles() : Promise.resolve({ wins: env.wins })));
  client.worldProbe = { netstat, titles };
  const sent: string[] = [];
  let n = 0;
  vi.spyOn(client as unknown as { rawCall: (f: string, p: Record<string, unknown>) => Promise<unknown> }, "rawCall").mockImplementation(async (f, p) => {
    sent.push(`${f}:${p.action}`);
    if (f === "EMCP_WB_GetState") return { status: "ok", mode: "edit" };
    if (p.action === "worldInfo") return { status: "ok", worldPath: "$T:W.ent", absPath: WORLD };
    if (p.action === "save") {
      if (env.saveWrites) writeFileSync(WORLD, `saved ${++n}`);
      return { status: "ok", saved: false }; // 1.9.0.37 returns false even when it writes
    }
    if (f === "EMCP_WB_Layers") return { status: "ok", layerPath: "L1", activeLayer: "default" };
    if (p.action === "openResource" && env.openFails) return { status: "error", message: "Workbench could not open" };
    return { status: "ok", message: "done" };
  });
  const tools: Record<string, Handler> = {};
  const server = { registerTool: (name: string, _d: unknown, h: Handler) => (tools[name] = h) } as unknown as McpServer;
  registerWbEditorTools(server, client, {} as Config);
  registerWbLayers(server, client);
  return {
    env, netstat, titles, sent,
    layer: () => tools.wb_layers({ action: "create", name: "L1" }),
    open: () => tools.wb_open_resource({ path: OPEN_PATH }),
    save: () => tools.wb_save({}),
    play: () => tools.wb_play({}),
    opens: () => sent.filter((s) => s.endsWith(":openResource")).length,
    plays: () => sent.filter((s) => s === "EMCP_WB_EditorControl:play").length,
  };
}

describe("a layer created by the MCP counts as unsaved", () => {
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

  it("a wb_save that wrote no file keeps the mark", async () => {
    const s = setup();
    await s.layer();
    s.env.saveWrites = false;
    const saved = await s.save();
    expect(saved.content[0].text).toContain("no file changed");
    const r = await s.open();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(OPEN_MARK);
    expect(s.opens()).toBe(0);
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
    expect((await s.play()).isError).toBeUndefined();
    s.env.netstat = async () => listening(4242);
    expect((await s.play()).isError).toBeUndefined();
    expect(s.plays()).toBe(2);
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

describe("wb_play checks for unsaved changes", () => {
  it("an unsaved title is refused with the world named and no play call", async () => {
    const s = setup();
    s.env.wins = [CLEAN, DIRTY];
    const r = await s.play();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(
      "Refused: the world open in Workbench (MCPParity/Worlds/MCPParity.ent) has unsaved changes (its World Editor title ends in *). " +
        tail("Starting play", '"World needs to be saved" prompt')
    );
    expect(s.plays()).toBe(0);
  });

  it("only the layer mark is refused too, and no window is read", async () => {
    const s = setup();
    await s.layer();
    const r = await s.play();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(PLAY_MARK);
    expect(s.plays()).toBe(0);
    expect(s.titles).not.toHaveBeenCalled();
  });

  it("clean plays as before, with no extra line", async () => {
    const s = setup();
    const r = await s.play();
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("**Play Mode Started**");
    expect(r.content[0].text).not.toContain("Could not check");
    expect(s.plays()).toBe(1);
  });

  it("after a wb_save that wrote files, play goes ahead", async () => {
    const s = setup();
    await s.layer();
    await s.save();
    expect((await s.play()).isError).toBeUndefined();
    expect(s.plays()).toBe(1);
  });

  const cannotTell: [string, (s: ReturnType<typeof setup>) => void, string, string?][] = [
    ["netstat failed", (s) => (s.env.netstat = async () => ""), "the netstat query failed"],
    ["netstat throws", (s) => (s.env.netstat = () => Promise.reject(new Error("only Windows can be checked"))), "only Windows can be checked"],
    ["title read failed", (s) => (s.env.titles = async () => ({ unavailable: "the title read failed or took over 8 s (exit 1)" })), "the title read failed or took over 8 s (exit 1)"],
    ["zero visible windows", (s) => (s.env.wins = []), "no window of Workbench PID 4242 is visible to this MCP, for example because it runs in another Windows session"],
    ["remote host", () => {}, "the NET API host 10.0.0.5 is not this PC", "10.0.0.5"],
  ];
  it.each(cannotTell)("cannot tell (%s): play is sent and one warning line says why", async (_n, arrange, why, host) => {
    const s = setup(host);
    arrange(s);
    const r = await s.play();
    expect(r.isError).toBeUndefined();
    expect(s.plays()).toBe(1);
    expect(r.content[0].text.split("Could not check for unsaved changes").length).toBe(2);
    expect(r.content[0].text).toContain(PLAY_WARN(why));
  });

  it("no port owner skips the check and plays", async () => {
    const s = setup();
    s.env.netstat = async () => "Active Connections\r\n";
    const r = await s.play();
    expect(s.titles).not.toHaveBeenCalled();
    expect(s.plays()).toBe(1);
    expect(r.content[0].text).not.toContain("Could not check");
  });
});
