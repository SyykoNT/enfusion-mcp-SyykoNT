import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";
import { registerWbEntityTools } from "../../src/tools/wb-entities.js";

type Result = { content: { text: string }[]; isError?: boolean };

// Stub client in edit mode answering EMCP_WB_CreateEntity with `answer`.
function create(answer: Record<string, unknown>) {
  const call = vi.fn(async () => answer);
  const client = { state: { connected: true, mode: "edit" }, probeMode: vi.fn(async () => "edit"), call };
  const tools: Record<string, (a: Record<string, unknown>) => Promise<Result>> = {};
  registerWbEntityTools({ registerTool: (n: string, _d: unknown, h: (a: Record<string, unknown>) => Promise<Result>) => (tools[n] = h) } as unknown as McpServer, client as unknown as WorkbenchClient);
  return { call, run: (a: Record<string, unknown>) => tools.wb_entity_create(a) };
}

describe("wb_entity_create layer", () => {
  it("sends layerPath and prints the layer the handler read back", async () => {
    const t = create({ status: "ok", entityName: "X", layerPath: "MISSION/OBJECTIVES" });
    const r = await t.run({ prefab: "{0123456789ABCDEF}Prefabs/X.et", layerPath: "MISSION/OBJECTIVES" });
    expect(t.call).toHaveBeenCalledWith("EMCP_WB_CreateEntity", expect.objectContaining({ layerPath: "MISSION/OBJECTIVES" }));
    expect(r.content[0].text).toContain("- **Layer:** MISSION/OBJECTIVES\n");
  });

  it("an old handler that reports no layer is not presented as having used the requested one", async () => {
    const r = await create({ status: "ok", entityName: "X" }).run({ prefab: "{0123456789ABCDEF}Prefabs/X.et", layerPath: "MISSION" });
    expect(r.content[0].text).toContain("- **Layer:** MISSION requested, not confirmed");
  });
});
