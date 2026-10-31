import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import { registerScriptCreate } from "../../src/tools/script-create.js";

type Result = { content: { text: string }[]; isError?: boolean };
const root = mkdtempSync(join(tmpdir(), "emcp-sc-"));
const addonDir = join(root, "TestAddon");
mkdirSync(addonDir);
writeFileSync(join(addonDir, "addon.gproj"), `GameProject {\n ID "TestAddon"\n}\n`);
const config = { projectPath: join(root, "projects"), gamePath: join(root, "game"), workbenchPath: join(root, "tools") } as Config;
let create!: (args: Record<string, unknown>) => Promise<Result>;
registerScriptCreate({ registerTool: (_n: string, _d: unknown, h: typeof create) => { create = h; } } as unknown as McpServer, config);

describe("script_create", () => {
  it("refuses without a target, returns the code and writes nothing", async () => {
    const r = await create({ className: "SDI2_Test", scriptType: "component" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^No target addon[\s\S]*Generated code \(not written\)[\s\S]*class SDI2_Test : ScriptComponent/);
    expect(readdirSync(root)).toEqual(["TestAddon"]);
  });

  it("refuses a folder without .gproj", async () => {
    const r = await create({ className: "SDI2_Test", scriptType: "component", projectPath: root });
    expect(r.content[0].text).toMatch(/^Not an addon/);
  });

  it("writes into the addon's Scripts/Game without a BOM and never overwrites", async () => {
    const r = await create({ className: "SDI2_Test", scriptType: "component", projectPath: addonDir });
    expect(r.isError).toBeUndefined();
    const file = join(addonDir, "Scripts", "Game", "SDI2_Test.c");
    const bytes = readFileSync(file);
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.toString("utf-8")).toContain("SetEventMask(owner, EntityEvent.INIT);");

    writeFileSync(file, "keep");
    const again = await create({ className: "SDI2_Test", scriptType: "component", projectPath: addonDir });
    expect(again.content[0].text).toMatch(/^File already exists/);
    expect(readFileSync(file, "utf-8")).toBe("keep");
  });

  it("rejects an attribute with a bad type", async () => {
    const r = await create({ className: "SDI2_A", scriptType: "component", projectPath: addonDir, attributes: [{ type: "float; int", name: "m_f" }] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Invalid attribute type/);
  });
});
