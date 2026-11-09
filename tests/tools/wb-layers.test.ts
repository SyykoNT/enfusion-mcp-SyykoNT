import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";
import { registerWbLayers } from "../../src/tools/wb-layers.js";

type Result = { content: { text: string }[]; isError?: boolean };

// Stub client in edit mode: EMCP_WB_Layers answers with `answer`, or throws it when it is an Error.
function layers(answer: Record<string, unknown> | Error) {
  const call = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const mark = vi.fn(async () => {});
  const client = { state: { connected: true, mode: "edit" }, probeMode: vi.fn(async () => "edit"), call, markLayerCreated: mark };
  let tool!: (a: Record<string, unknown>) => Promise<Result>;
  registerWbLayers({ registerTool: (_n: string, _d: unknown, h: typeof tool) => (tool = h) } as unknown as McpServer, client as unknown as WorkbenchClient);
  return { call, mark, run: async (a: Record<string, unknown>) => (await tool(a)) };
}

describe("wb_layers", () => {
  it("create refuses a nested request instead of making a top-level layer, without calling Workbench", async () => {
    const t = layers({ status: "ok", layerPath: "OBJECTIVES" });
    const r = await t.run({ action: "create", name: "OBJECTIVES", parentPath: "MISSION" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Nested layers are not offered");
    expect(t.call).not.toHaveBeenCalled();
  });

  it("create refuses a name that is not letters, digits or '_' (it becomes a file name), without calling Workbench", async () => {
    for (const name of ["..\\x", "a/b", "A B", "", "x".repeat(65)]) {
      const t = layers({ status: "ok", layerPath: name });
      const r = await t.run({ action: "create", name });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("Layer name must be 1 to 64 letters, digits or '_'");
      expect(t.call).not.toHaveBeenCalled();
    }
  });

  it("create sends the name, no sub-scene unless given, and prints the path the handler made", async () => {
    const t = layers({ status: "ok", layerPath: "_INIT", activeLayer: "default", currentSubScene: 2 });
    const r = await t.run({ action: "create", name: "_INIT" });
    expect(t.call).toHaveBeenCalledWith("EMCP_WB_Layers", { action: "create", name: "_INIT" });
    expect(r.content[0].text).toContain("- **Layer:** _INIT\n");
    expect(r.content[0].text).toContain("Written to disk on the next wb_save.");
  });

  it("a layer create marks the world unsaved; a failed create, setActive and list do not", async () => {
    const ok = layers({ status: "ok", layerPath: "_INIT", activeLayer: "default", layers: [] });
    await ok.run({ action: "create", name: "_INIT" });
    expect(ok.mark).toHaveBeenCalledTimes(1);
    await ok.run({ action: "setActive", layerPath: "_INIT" });
    await ok.run({ action: "list" });
    expect(ok.mark).toHaveBeenCalledTimes(1);
    const failed = layers(new Error("no sub-scene"));
    await failed.run({ action: "create", name: "_INIT" });
    expect(failed.mark).not.toHaveBeenCalled();
  });

  it("setActive prints the layer the handler read back", async () => {
    const t = layers({ status: "ok", activeLayer: "MISSION", layerPath: "MISSION", currentSubScene: 2 });
    const r = await t.run({ action: "setActive", layerPath: "MISSION", subScene: 2 });
    expect(t.call).toHaveBeenCalledWith("EMCP_WB_Layers", { action: "setActive", layerPath: "MISSION", subScene: 2 });
    expect(r.content[0].text).toContain("- **Active layer:** MISSION\n");
  });

  it("a setActive that did not take is an error with the handler's read-back", async () => {
    const r = await layers(new Error("Active layer did not change to X: it is default")).run({ action: "setActive", layerPath: "X" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Active layer did not change to X: it is default");
  });

  it("getActive prints the sub-scene and its active layer, and says when an old handler reports no layer", async () => {
    expect((await layers({ status: "ok", currentSubScene: 2, activeLayer: "MISSION" }).run({ action: "getActive" })).content[0].text)
      .toContain("- **Sub-scene:** 2\n- **Active layer:** MISSION");
    expect((await layers({ status: "ok", currentSubScene: 2 }).run({ action: "getActive" })).content[0].text)
      .toContain("(not reported: handler out of date)");
  });

  it("an old handler's Unknown action for create or setActive says to refresh the handlers", async () => {
    const r = await layers(new Error("Unknown action: create. Valid: list, getActive, getEntityLayer, isVisible, getInfo, toggleLock")).run({ action: "create", name: "A" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("EMCP_WB_Layers is out of date (it has no create); refresh the handlers");
  });

  it("list prints each layer's name, empty layers, the active flag and what the counts cover, and drops the empty rows 1.9 packs", async () => {
    const message = "Found 2 layers in sub-scene 2. Entity counts cover the 5 entities of that sub-scene only (the editor holds 99 across all sub-scenes)";
    const t = layers({
      status: "ok", currentSubScene: 2, activeLayer: "default", message,
      layers: [{}, { layerID: 0, path: "default", entityCount: 5 }, {}, { layerID: 1, path: "OPS_A", entityCount: 0 }, {}, { layerID: 7, path: "", entityCount: 3 }],
    });
    const text = (await t.run({ action: "list" })).content[0].text;
    expect(text).toContain("- default [ACTIVE] (5 entities)\n- OPS_A (0 entities)\n- (layer id 7) (3 entities)");
    expect(text).not.toContain("(unnamed)");
    expect(text).toContain(message);
  });

  it("list keeps a real layer whose entityCount is missing or not a number and shows no count for it", async () => {
    const t = layers({ status: "ok", layers: [{}, { layerID: 0, path: "default", entityCount: "5" }, {}, { layerID: 1, path: "OPS_A" }] });
    const text = (await t.run({ action: "list" })).content[0].text;
    expect(text).toContain("- default\n- OPS_A");
    expect(text).not.toContain("entities)");
  });
});
