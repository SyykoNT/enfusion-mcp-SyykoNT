import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Socket } from "node:net";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WorkbenchClient } from "../../src/workbench/client.js";
import { registerWbEditorTools } from "../../src/tools/wb-editor.js";
import type { Config } from "../../src/config.js";
import { decodeInt32LE, decodePascalString, encodePascalString } from "../../src/workbench/protocol.js";

type Result = { content: { text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

/** Fake Workbench NET API (copy of the one in wb-gate.test.ts): answers with handler(apiFunc, params); undefined means never answer. */
function mockWorkbench(handler: (apiFunc: string, params: Record<string, unknown>) => unknown) {
  // allowHalfOpen: an unanswered request keeps its socket open, as a Workbench stuck behind a dialog does.
  const open = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    const chunks: Buffer[] = [];
    socket.on("data", (c) => chunks.push(c));
    socket.on("end", () => {
      const buf = Buffer.concat(chunks);
      let offset = decodeInt32LE(buf, 0).bytesRead;
      offset += decodePascalString(buf, offset).bytesRead;
      offset += decodePascalString(buf, offset).bytesRead;
      const { APIFunc, ...params } = JSON.parse(decodePascalString(buf, offset).value);
      const answer = handler(APIFunc, params);
      if (answer !== undefined) socket.end(Buffer.concat([encodePascalString("Ok"), encodePascalString(JSON.stringify(answer))]));
    });
  });
  server.listen(0);
  const addr = server.address();
  return {
    port: addr && typeof addr !== "string" ? addr.port : 0,
    close: () => new Promise<void>((res) => {
      server.close(() => res());
      for (const s of open) s.destroy();
    }),
  };
}

let mock: ReturnType<typeof mockWorkbench> | undefined;
afterEach(async () => {
  vi.unstubAllEnvs();
  await mock?.close();
  mock = undefined;
});

/** A temp world folder, a mock answering GetState (edit), worldInfo and save, and the wb_save and wb_play handlers. */
function setup(info: Record<string, unknown>, onSave: (folder: string) => unknown) {
  const folder = mkdtempSync(join(tmpdir(), "emcp-save-"));
  mkdirSync(join(folder, "W_Layers"));
  for (const f of ["W.ent", "W.ent.meta", "W_Layers/default.layer", "Other.ent"]) writeFileSync(join(folder, f), "x");
  const actions: string[] = [];
  mock = mockWorkbench((f, p) => {
    if (f === "EMCP_WB_GetState") return { status: "ok", mode: "edit" };
    actions.push(String(p.action));
    if (p.action === "worldInfo") return { status: "ok", worldPath: "$Test:Worlds/W.ent", absPath: join(folder, "W.ent"), ...info };
    return onSave(folder);
  });
  const client = new WorkbenchClient("127.0.0.1", mock.port);
  // Stubbed so that no test runs netstat or reads windows (wb_play reads netstat only when a layer of ours is marked).
  client.worldProbe = { netstat: async () => "Active Connections\r\n", titles: async () => ({ unavailable: "not reached" }) };
  client.crashProbe = { reporters: async () => [], logs: () => undefined }; // the timeout test would otherwise start PowerShell
  const tools: Record<string, Handler> = {};
  const descriptions: Record<string, string> = {};
  registerWbEditorTools(
    { registerTool: (n: string, d: { description: string }, h: Handler) => ((tools[n] = h), (descriptions[n] = d.description)) } as unknown as McpServer,
    client,
    {} as Config
  );
  return { folder, actions, client, descriptions, save: (args: Record<string, unknown> = {}) => tools.wb_save(args), play: () => tools.wb_play({}) };
}
const later = (folder: string, f: string) => writeFileSync(join(folder, f), "changed by the save");

describe("wb_save", () => {
  it("refuses Save As without calling Workbench", async () => {
    const t = setup({}, () => ({ status: "ok", saved: true }));
    const r = await t.save({ path: "Worlds/Copy.ent" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Save As is not reachable from the 1.8 script API: GameWorldEditor (which has SaveWorldAs) is not a Workbench module");
    expect(t.actions).toEqual([]);
  });

  it.each([
    [{ worldPath: "" }, "No world file: the open world is unnamed"],
    [{ prefabEditMode: true }, "Prefab edit mode: wb_save saves worlds. Use wb_prefabs save"],
    [{ absPath: "" }, "has no file on disk"],
    [{ gameMode: true }, "Play mode: stop it with wb_stop before saving"],
  ])("refuses %j without a save call", async (info, text) => {
    const t = setup(info, () => ({ status: "ok", saved: true }));
    const r = await t.save();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(text);
    expect(t.actions).toEqual(["worldInfo"]);
  });

  it("refuses a world inside a forbidden root without a save call", async () => {
    const t = setup({}, () => ({ status: "ok", saved: true }));
    vi.stubEnv("ENFUSION_FORBIDDEN_DIRS", t.folder);
    const r = await t.save();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(`is inside ${t.folder}`);
    expect(r.content[0].text).toContain("Nothing was saved");
    expect(t.actions).toEqual(["worldInfo"]);
  });

  it.each(["wb_save", "wb_play"])("an old handler (no worldInfo) is refused by %s and never asked to act", async (tool) => {
    const t = setup({}, () => ({ status: "ok", saved: true }));
    mock!.close();
    mock = mockWorkbench((f, p) => {
      if (f === "EMCP_WB_GetState") return { status: "ok", mode: "edit" };
      t.actions.push(String(p.action));
      return { status: "error", message: `Unknown action: ${p.action}. Valid: play, stop, save, saveAs, undo, redo, openResource` };
    });
    const client = new WorkbenchClient("127.0.0.1", mock.port);
    const tools: Record<string, Handler> = {};
    registerWbEditorTools({ registerTool: (n: string, _d: unknown, h: Handler) => (tools[n] = h) } as unknown as McpServer, client, {} as Config);
    const r = await tools[tool]({});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("EMCP_WB_EditorControl is out of date");
    expect(t.actions).toEqual(["worldInfo"]);
  });

  it("lists the files the save wrote", async () => {
    const t = setup({}, (folder) => {
      later(folder, "W.ent");
      later(folder, "W_Layers/default.layer");
      return { status: "ok", saved: true };
    });
    const r = await t.save();
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("**World saved**\nWorld: $Test:Worlds/W.ent\n");
    expect(r.content[0].text).toContain(`Written (2) under ${t.folder}: W.ent, W_Layers/default.layer\nNot changed: 2 other files\nSave() returned true`);
    expect(t.actions).toEqual(["worldInfo", "save"]);
  });

  it("files written but Save() false still leads with World saved, and Save() is a secondary line", async () => {
    const t = setup({}, (folder) => {
      later(folder, "W.ent");
      return { status: "ok", saved: false };
    });
    const r = await t.save();
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text.startsWith("**World saved**\n")).toBe(true);
    expect(r.content[0].text).toContain("Written (1) under");
    expect(r.content[0].text).toContain("\nSave() returned false; on 1.9.0.37 it also returns false when files are written");
  });

  it("false with no change is not an error; true with no change is", async () => {
    let r = await setup({}, () => ({ status: "ok", saved: false })).save();
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("Save() returned false and no file changed");
    await mock!.close();
    r = await setup({}, () => ({ status: "ok", saved: true })).save();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Save() returned true but no file under");
  });

  it("a timeout says a dialog probably blocks every call, and lists what changed so far", async () => {
    const t = setup({}, (folder) => {
      later(folder, "W.ent");
      return undefined;
    });
    // Shorten the tool's 30 s save timeout for the test.
    const call = t.client.call.bind(t.client);
    vi.spyOn(t.client, "call").mockImplementation((f, p, o) => call(f, p, o?.timeout ? { ...o, timeout: 300 } : o));
    const r = await t.save();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("No answer from Workbench in 30 s. A dialog is probably open and blocks every MCP call until it is answered (B-007). Files changed so far: W.ent.");
  });
});

describe("wb_play", () => {
  const ok = () => ({ status: "ok", message: "playing" });

  it.each([
    ["no file on disk", { absPath: "" }],
    ["a world in a forbidden root", {}],
  ])("refuses %s before the play call and says to play a sub-scene in a test addon", async (_n, info) => {
    const t = setup(info, ok);
    if (!("absPath" in info)) vi.stubEnv("ENFUSION_FORBIDDEN_DIRS", t.folder);
    const r = await t.play();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Play is refused on a world without a writable file");
    expect(r.content[0].text).toContain("sub-scene of it in your own test addon");
    expect(t.actions).toEqual(["worldInfo"]);
  });

  it("an unnamed world gets the unnamed-world text, no play call", async () => {
    const t = setup({ worldPath: "" }, ok);
    const r = await t.play();
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("No world file: the open world is unnamed");
    expect(t.actions).toEqual(["worldInfo"]);
  });

  it("plays a world whose file is in a test folder", async () => {
    const t = setup({}, ok);
    const r = await t.play();
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("**Play Mode Started**");
    expect(t.actions).toEqual(["worldInfo", "play"]);
  });

  it("the description states the refusal", () => {
    const d = setup({}, ok).descriptions.wb_play;
    expect(d).toContain("Refuses, without playing,");
    expect(d).toContain("Play a sub-scene of it in your own test addon");
  });
});
