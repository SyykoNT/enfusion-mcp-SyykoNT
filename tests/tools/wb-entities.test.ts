import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";
import { registerWbEntityTools } from "../../src/tools/wb-entities.js";

type Result = { content: { text: string }[]; isError?: boolean };

// Stub client in edit mode answering EMCP_WB_CreateEntity with `answer` (an Error is thrown, as the client does for a handler status "error").
function create(answer: Record<string, unknown> | Error) {
  const call = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
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

  it("an unknown layer from the handler is an error result", async () => {
    const r = await create(new Error("Layer not found: NoSuchLayer. Layers: default, PROPS")).run({ prefab: "{0123456789ABCDEF}Prefabs/X.et", layerPath: "NoSuchLayer" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Layer not found: NoSuchLayer");
  });
});

// Stub client in edit mode answering any call with `answer` (an Error is thrown, as the client does for a handler status "error").
function tool(name: string, answer: Record<string, unknown> | Error) {
  const call = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const client = { state: { connected: true, mode: "edit" }, probeMode: vi.fn(async () => "edit"), call };
  const tools: Record<string, (a: Record<string, unknown>) => Promise<Result>> = {};
  registerWbEntityTools({ registerTool: (n: string, _d: unknown, h: (a: Record<string, unknown>) => Promise<Result>) => (tools[n] = h) } as unknown as McpServer, client as unknown as WorkbenchClient);
  return { call, run: (a: Record<string, unknown>) => tools[name](a) };
}

describe("wb_entity_modify enum and listProperties", () => {
  it("an unknown enum name comes back as an error with the valid list", async () => {
    const msg = "'ZzzBogus' is not a value of enum property 'ResponseIndex'. Valid: Debris, Character. Nothing was changed.";
    const r = await tool("wb_entity_modify", new Error(msg)).run({ name: "E", action: "setProperty", propertyPath: "RigidBody", propertyKey: "ResponseIndex", value: "ZzzBogus" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(msg);
  });

  it("listProperties prints each property once, without the empty rows 1.9 packs, with the value the handler read", async () => {
    const t = tool("wb_entity_modify", { status: "ok", properties: [{}, { name: "Mass", value: "77" }, {}, { name: "LODFactors", value: "(not read: SCALAR_ARRAY)" }] });
    const text = (await t.run({ name: "E", action: "listProperties", propertyPath: "RigidBody" })).content[0].text;
    expect(text).toContain("**Properties of RigidBody** (2)");
    expect(text).toContain(["| Mass | 77 |", "| LODFactors | (not read: SCALAR_ARRAY) |"].join("\n"));
    expect(text).not.toContain("(unnamed)");
  });
});

describe("wb_entity_inspect values", () => {
  it("prints the properties the handler read, marks the capped count, and drops the empty rows", async () => {
    const t = tool("wb_entity_inspect", { status: "ok", name: "E", varCount: 60, properties: [{}, { name: "ShapeType", value: "Box" }, {}, { name: "m_Arr", value: "(not read: ARRAY)" }] });
    const text = (await t.run({ name: "E" })).content[0].text;
    expect(text).toContain(["### Properties (2 of 60)", "| Property | Value |", "|---|---|", "| ShapeType | Box |", "| m_Arr | (not read: ARRAY) |"].join("\n"));
  });
});
