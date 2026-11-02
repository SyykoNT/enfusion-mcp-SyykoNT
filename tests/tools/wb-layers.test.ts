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
  const client = { state: { connected: true, mode: "edit" }, probeMode: vi.fn(async () => "edit"), call };
  let tool!: (a: Record<string, unknown>) => Promise<Result>;
  registerWbLayers({ registerTool: (_n: string, _d: unknown, h: typeof tool) => (tool = h) } as unknown as McpServer, client as unknown as WorkbenchClient);
  return { call, run: async (a: Record<string, unknown>) => (await tool(a)) };
}

describe("wb_layers", () => {
  it("create sends the name, no sub-scene unless given and no parent, and prints the path the handler made", async () => {
    const t = layers({ status: "ok", layerPath: "OBJECTIVES", activeLayer: "default", currentSubScene: 2 });
    const r = await t.run({ action: "create", name: "OBJECTIVES", parentPath: "MISSION" });
    expect(t.call).toHaveBeenCalledWith("EMCP_WB_Layers", { action: "create", name: "OBJECTIVES" });
    expect(r.content[0].text).toContain("- **Layer:** OBJECTIVES\n");
    expect(r.content[0].text).toContain("Written to disk on the next wb_save.");
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
});
