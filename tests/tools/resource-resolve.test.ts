import { describe, it, expect, afterAll } from "vitest";
import { rmSync, existsSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { buildStack } from "../../src/pak/stack.js";
import { resolve, providers, flat, diffFlat, registerResourceResolve } from "../../src/tools/resource-resolve.js";
import type { Config } from "../../src/config.js";
import { makeFakeStack, G } from "../pak/fake-stack.js";

const { root, config } = makeFakeStack();
afterAll(() => rmSync(root, { recursive: true, force: true }));
const layers = buildStack(config, "AddonA").layers;
const byLabel = (path: string) => {
  const eff = resolve(layers, path)!;
  return { eff, props: Object.fromEntries(flat(eff.root, eff.origins).map((p) => [p.label, p])) };
};

type Handler = (a: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
let tool!: Handler;
registerResourceResolve({ registerTool: (_n: string, _d: unknown, h: Handler) => { tool = h; } } as unknown as McpServer, { ...config, defaultMod: "AddonA" });

describe("resource_resolve", () => {
  it("warns on an {ID} whose class changed and keeps every origin through the chain", () => {
    const { eff, props } = byLabel("Prefabs/Guerilla_Pants.et");
    expect(eff.chain).toEqual(["ArmaReforger:Prefabs/Pants_Base.et", "ArmaReforger:Prefabs/Pants_BDU.et", "ModB:Prefabs/Guerilla_Pants.et"]);
    expect(eff.warnings).toEqual([
      "type change: components/{5222CB01D5B9A306} was SCR_UniversalInventoryStorageComponent, is InventoryItemComponent in ModB:Prefabs/Guerilla_Pants.et; properties of the old class may not apply (engine behavior unverified)",
    ]);
    const c = "components/InventoryItemComponent{5222CB01D5B9A306}";
    expect(props[`${c}/Attributes{CCCC000000000001}/ItemVolume`]).toMatchObject({ value: "2000", origin: "ModB:Prefabs/Guerilla_Pants.et" });
    expect(props[`${c}/MaxWeight`].origin).toBe("ArmaReforger:Prefabs/Pants_BDU.et");
    expect(props["components/MeshObject{AAAA000000000001}/Object"].origin).toBe("ArmaReforger:Prefabs/Pants_Base.et");
  });

  it("tells overrides (same GUID) from shadows (another GUID)", () => {
    expect(providers(layers, "Prefabs/Character_Base.et").map((p) => [p.layer.id, p.role])).toEqual([
      ["ArmaReforger", "defines"], ["ModB", "overrides"], ["AddonA", "overrides"],
    ]);
    expect(providers(layers, "Prefabs/Pants_Base.et").map((p) => [p.layer.id, p.role, p.guid])).toEqual([
      ["ArmaReforger", "defines", G.pantsBase], ["AddonA", "shadows", G.shadow],
    ]);
    expect(byLabel("Prefabs/Pants_Base.et").props["m_Other"]).toBeUndefined();
  });

  it("applies overrides in load order, appends `+ {` lists, and stops at upTo", () => {
    const { props } = byLabel("Prefabs/Character_Base.et");
    expect(props["m_Value"]).toMatchObject({ value: "3", origin: "AddonA:Prefabs/Character_Base.et" });
    expect(props["Tags"].value).toBe('["a", "b"]');
    const vanilla = resolve(layers.slice(0, 1), "Prefabs/Character_Base.et")!;
    expect(flat(vanilla.root, vanilla.origins).find((p) => p.label === "m_Value")?.value).toBe("1");
  });

  it("puts the '#' warning in the error when the only file does not parse", () => {
    expect(() => resolve(layers, "Prefabs/Hash.et")).toThrow(/line 2: '#' comment, Workbench drops this prefab's components/);
  });

  it("diffs two effective views with both origins", () => {
    const a = resolve(layers.slice(0, 1), "Prefabs/Character_Base.et")!, b = resolve(layers, "Prefabs/Character_Base.et")!;
    expect(diffFlat(flat(a.root, a.origins), flat(b.root, b.origins))).toEqual([
      "~ m_Value: 1  <- ArmaReforger:Prefabs/Character_Base.et  ->  3  <- AddonA:Prefabs/Character_Base.et",
      '~ Tags: ["a"]  ->  ["a", "b"]',
    ]);
    const c = resolve(layers, "Prefabs/Pants_BDU.et")!, d = resolve(layers, "Prefabs/Guerilla_Pants.et")!;
    expect(diffFlat(flat(c.root, c.origins), flat(d.root, d.origins))).toContain(
      "+ components/InventoryItemComponent{5222CB01D5B9A306}/Attributes{CCCC000000000001}/ItemVolume = 2000  <- ModB:Prefabs/Guerilla_Pants.et");
  });

  it("tool: stack, providers, diff, paging, bare GUID and errors", async () => {
    const stack = await tool({ action: "stack" });
    expect(stack.content[0].text).toMatch(/0 ArmaReforger .*vanilla[\s\S]*3 AddonA[\s\S]*MISSING dependency DDDDDDDDDDDDDDDD/);
    const prov = await tool({ action: "providers", path: `{${G.character}}` });
    expect(prov.content[0].text).toContain("ModB (workshop: ModB_BBBBBBBBBBBBBBBB)  overrides (same GUID)");
    const diff = await tool({ action: "diff", path: "Prefabs/Character_Base.et", upTo: "ArmaReforger", againstStack: "AddonA" });
    expect(diff.content[0].text).toContain("~ m_Value: 1");
    const page = await tool({ action: "effective", path: "Prefabs/Guerilla_Pants.et", limit: 2 });
    expect(page.content[0].text).toMatch(/-- lines 1-2 of \d+; continue with offset=2$/);
    expect((await tool({ action: "effective", path: "Prefabs/Guerilla_Pants.et", filter: "itemvolume" })).content[0].text).not.toContain("MaxWeight");
    for (const bad of [{ action: "effective" }, { action: "stack", stack: "Nope" }, { action: "effective", path: "Prefabs/None.et" }, { action: "effective", path: "x", upTo: "Zzz" }]) {
      expect((await tool(bad)).isError).toBe(true);
    }
  });
});

const GAME = "C:/Program Files (x86)/Steam/steamapps/common/Arma Reforger";
describe.skipIf(!existsSync(`${GAME}/addons/data/data.pak`))("installed game", () => {
  it("resolves Vehicle_Base.et in the vanilla stack", () => {
    const vanilla = buildStack({ gamePath: GAME, projectPath: "", workshopPath: "" } as Config, "vanilla").layers;
    expect(vanilla.map((l) => l.id)).toEqual(["core", "ArmaReforger"]);
    const eff = resolve(vanilla, "Prefabs/Vehicles/Core/Vehicle_Base.et")!;
    expect(eff.chain.at(-1)).toBe("ArmaReforger:Prefabs/Vehicles/Core/Vehicle_Base.et");
    expect(flat(eff.root, eff.origins).length).toBeGreaterThan(50);
  });
});
