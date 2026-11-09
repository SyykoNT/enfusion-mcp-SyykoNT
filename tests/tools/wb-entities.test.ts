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

describe("wb_entity_inspect components and list rows", () => {
  it("1.9 payload (empty object before each row) and 1.8 payload give the same component count", async () => {
    const rows = [{ className: "RigidBody", index: 0 }, { className: "Hierarchy", index: 1 }];
    const v19 = (await tool("wb_entity_inspect", { status: "ok", name: "E", components: rows.flatMap((r) => [{}, r]) }).run({ name: "E" })).content[0].text;
    const v18 = (await tool("wb_entity_inspect", { status: "ok", name: "E", components: rows }).run({ name: "E" })).content[0].text;
    expect(v19).toContain("### Components (2)\n0. RigidBody\n1. Hierarchy");
    expect(v19).not.toContain("Unknown");
    expect(v18).toContain("### Components (2)\n0. RigidBody\n1. Hierarchy");
  });

  it("wb_entity_list drops the empty rows, counts and numbers the real ones, and keeps an unnamed entity that has a class", async () => {
    const ents = [{ name: "A", className: "GenericEntity", position: "1 2 3" }, { name: "", className: "Tree", position: "4 5 6" }];
    const v19 = (await tool("wb_entity_list", { status: "ok", totalCount: 2, offset: 0, entities: ents.flatMap((e) => [{}, e]) }).run({ offset: 0, limit: 50 })).content[0].text;
    const v18 = (await tool("wb_entity_list", { status: "ok", totalCount: 2, offset: 0, entities: ents }).run({ offset: 0, limit: 50 })).content[0].text;
    expect(v19).toContain("(showing 2 of 2, offset 0)");
    expect(v19).toContain("1. **A** at 1 2 3\n2. **(unnamed)** at 4 5 6");
    expect(v19).not.toContain("3. ");
    expect(v18).toBe(v19);
  });

  it("wb_entity_list shows the handler's totalCount and the pagination line when the list was capped", async () => {
    const ents = [{ name: "A", className: "GenericEntity", position: "1 2 3" }, { name: "B", className: "GenericEntity", position: "4 5 6" }];
    const text = (await tool("wb_entity_list", { status: "ok", totalCount: 10, offset: 0, entities: ents }).run({ offset: 0, limit: 2 })).content[0].text;
    expect(text).toContain("(showing 2 of 10, offset 0)");
    expect(text).toContain("*8 more entities not shown. Use offset/limit to paginate.*");
  });
});

describe("wb_entity_inspect values", () => {
  it("lists rows with a value first and folds the empty-value rows into one line", async () => {
    const names = ["EOnTouch", "_WB_CanDelete", "OnA", "OnB", "OnC", "OnD"];
    const props = [...names.map((name) => ({ name, value: "" })), { name: "Mass", value: "77" }, { name: "Off", value: "0" }];
    const text = (await tool("wb_entity_inspect", { status: "ok", name: "E", varCount: 8, properties: props.flatMap((p) => [{}, p]) }).run({ name: "E" })).content[0].text;
    expect(text).toContain("### Properties (8)\n| Property | Value |\n|---|---|\n| Mass | 77 |\n| Off | 0 |\n\n*6 more with no value: EOnTouch, _WB_CanDelete, OnA, OnB, OnC, ...*");
    expect(text).not.toContain("| EOnTouch |");
  });

  it("prints no table header when every property row is empty", async () => {
    const props = [{ name: "OnA", value: "" }, { name: "OnB", value: "" }];
    const text = (await tool("wb_entity_inspect", { status: "ok", name: "E", varCount: 2, properties: props }).run({ name: "E" })).content[0].text;
    expect(text).toContain("### Properties (2)\n*2 with no value: OnA, OnB*");
    expect(text).not.toContain("| Property |");
  });

  it("prints the properties the handler read, marks the capped count, and drops the empty rows", async () => {
    const t = tool("wb_entity_inspect", { status: "ok", name: "E", varCount: 60, properties: [{}, { name: "ShapeType", value: "Box" }, {}, { name: "m_Arr", value: "(not read: ARRAY)" }] });
    const text = (await t.run({ name: "E" })).content[0].text;
    expect(text).toContain(["### Properties (2 of 60)", "| Property | Value |", "|---|---|", "| ShapeType | Box |", "| m_Arr | (not read: ARRAY) |"].join("\n"));
  });
});
