import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../../src/config.js";
import { parse, getProperty } from "../../src/formats/enfusion-text.js";
import { entityTemplateMeta } from "../../src/formats/config-override.js";
import { registerPrefab } from "../../src/tools/prefab.js";

type Result = { content: { text: string }[]; isError?: boolean };
const root = mkdtempSync(join(tmpdir(), "emcp-pc-"));
const addonDir = join(root, "TestAddon");
mkdirSync(addonDir);
writeFileSync(join(addonDir, "addon.gproj"), `GameProject {\n ID "TestAddon"\n GUID "1234567890ABCDEF"\n}\n`);
const config = { ...loadConfig(), projectPath: join(root, "projects"), addonsDir: undefined, protectedAddons: [] };
let create!: (args: Record<string, unknown>) => Promise<Result>;
registerPrefab({ registerTool: (_n: string, _d: unknown, h: typeof create) => { create = (a) => h({ action: "create", includeAncestry: true, ...a }); } } as unknown as McpServer, config);

describe("prefab create", () => {
  it("writes nothing without a target and returns the content", async () => {
    const r = await create({ name: "PCT_None", prefabType: "generic" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^No target addon[\s\S]*Generated prefab \(not written\)[\s\S]*GenericEntity/);
    expect(readdirSync(root)).toEqual(["TestAddon"]);
  });

  it("refuses a folder without .gproj", async () => {
    const r = await create({ name: "PCT_X", prefabType: "generic", projectPath: root });
    expect(r.content[0].text).toMatch(/^Not an addon/);
  });

  it("writes the .et and a full .meta into the addon", async () => {
    const r = await create({ name: "PCT_Generic", prefabType: "generic", projectPath: addonDir });
    expect(r.isError).toBeUndefined();
    const guid = /Reference it as: \{([0-9A-F]{16})\}Prefabs\/PCT_Generic\.et/.exec(r.content[0].text)?.[1];
    expect(guid).toBeDefined();
    expect(readFileSync(join(addonDir, "Prefabs", "PCT_Generic.et.meta"), "utf-8")).toContain(`Name "{${guid}}Prefabs/PCT_Generic.et"`);
  });

  it.skipIf(!existsSync(join(config.gamePath, "addons")))("writes a true child of the real Rifle_Base.et", async () => {
    const r = await create({ name: "PCT_TestRifle", prefabType: "firearm", variant: "rifle", projectPath: addonDir });
    expect(r.isError).toBeUndefined();
    const node = parse(readFileSync(join(addonDir, "Prefabs", "Weapons", "Rifles", "PCT_TestRifle.et"), "utf-8"));
    expect(node.inheritance).toBe("{911D6C8DC7BA2D63}Prefabs/Weapons/Core/Rifle_Base.et");
    expect(node.type).toBe("GenericEntity");
    expect(node.children.find((c) => c.type === "components")).toBeUndefined();
    expect(existsSync(join(addonDir, "Prefabs", "Weapons", "Rifles", "PCT_TestRifle.et.meta"))).toBe(true);
  });
});

describe("entityTemplateMeta", () => {
  it("parses and has the Name and one block per platform", () => {
    const text = entityTemplateMeta("0123456789ABCDEF", "Prefabs/X.et");
    const node = parse(text);
    expect(node.type).toBe("MetaFileClass");
    expect(getProperty(node, "Name")).toBe("{0123456789ABCDEF}Prefabs/X.et");
    expect(node.children.find((c) => c.type === "Configurations")!.children).toHaveLength(7);
    // the current parser reads "X : PC {" blocks by their parent name, so count the class in the text
    expect(text.match(/^ {2}EntityTemplateResourceClass \w+( : PC)? \{$/gm)).toHaveLength(7);
  });
});
