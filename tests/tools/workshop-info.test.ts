import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import { registerWorkshopInfo } from "../../src/tools/workshop-info.js";

const root = mkdtempSync(join(tmpdir(), "emcp-wsi-"));
const projects = join(root, "projects");
const addon = (base: string, name: string, guid: string, deps: string[] = []) => {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "addon.gproj"),
    `GameProject {\n ID "${name}"\n GUID "${guid}"\n TITLE "${name} Title"\n Dependencies {\n${deps.map((d) => `  "${d}"\n`).join("")} }\n}\n`
  );
  return dir;
};
addon(projects, "Alpha", "AAAA000000000001");
addon(projects, "Default", "DDDD000000000001");
addon(root, "Outside", "0000000000000099");
const config = { projectPath: projects, gamePath: join(root, "game"), workshopPath: join(root, "workshop"), defaultMod: "Default" } as Config;

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
let call: Handler = async () => ({ content: [] });
registerWorkshopInfo({ registerTool: (_n: string, _d: unknown, h: Handler) => { call = h; } } as unknown as McpServer, config);
const text = async (args: Record<string, unknown>) => (await call(args)).content[0].text;

describe("workshop_info: finding the addon", () => {
  it("projectPath = the addon folder itself (the F0.5 case)", async () => {
    expect(await text({ projectPath: join(projects, "Alpha") })).toContain("AAAA000000000001");
  });

  it("modName finds addon.gproj", async () => {
    expect(await text({ modName: "Alpha" })).toContain("AAAA000000000001");
  });

  it("no arguments use ENFUSION_DEFAULT_MOD", async () => {
    expect(await text({})).toContain("DDDD000000000001");
  });

  it("refuses traversal and reports not found as an error", async () => {
    for (const modName of ["..\\Outside", "../Outside", "Missing"]) {
      const r = await call({ modName });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/No \.gproj found/);
    }
  });

  it("prints no publishing steps, only the neutral closing line", async () => {
    const t = await text({ modName: "Alpha" });
    expect(t).not.toMatch(/Steam|Click|File > Addon Publishing/);
    expect(t).toContain("This tool does not publish.");
  });
});

describe("workshop_info: dependencies", () => {
  // Loose dep -> Workshop dep -> base game, plus one GUID found nowhere
  addon(join(root, "game", "addons"), "data", "58D0FB3206B6F859");
  addon(join(root, "workshop"), "WsDep_BBBB000000000001", "BBBB000000000001", ["58D0FB3206B6F859"]);
  addon(projects, "LocalDep", "CCCC000000000001", ["BBBB000000000001"]);
  addon(projects, "Boat", "EEEE000000000001", ["58D0FB3206B6F859", "CCCC000000000001", "FFFF000000000001"]);

  it("names direct deps with their source and counts the closure with missing ones", async () => {
    const t = await text({ modName: "Boat" });
    expect(t).toContain("- 58D0FB3206B6F859 data Title (game)");
    expect(t).toContain("- CCCC000000000001 LocalDep Title (local)");
    expect(t).toMatch(/- FFFF000000000001 \(missing: /);
    expect(t).toContain("Closure: 3 addons found, 1 missing (FFFF000000000001)");
  });
});

describe("workshop_info: Workshop text lint", () => {
  const dir = addon(projects, "Texts", "1234000000000001");
  writeFileSync(join(dir, "README.md"), "Credits: model by someone.\n");
  writeFileSync(join(root, "summary.txt"), `${"s".repeat(200)}\n`);

  it("lints the gproj TITLE by default and the fields given", async () => {
    const t = await text({ modName: "Texts", summary: "A boat — fast", changeNotes: "ok" });
    expect(t).toContain("- name: ok (11/30)");
    expect(t).toContain("- summary: en or em dash: — at 8 (measured dialog limit; BI documents 1024)");
    expect(t).toContain("- changeNotes: ok (2/30000)");
    expect(t).not.toContain("- description:");
    expect(t).toContain("- licence: license.txt absent");
    expect(t).toMatch(/- reminder: README\.md mention credits/);
  });

  it("reads text files (last newline dropped) and flags a planned name that differs from TITLE", async () => {
    const t = await text({ modName: "Texts", name: "Texts (Boat)", textFiles: { summary: join(root, "summary.txt"), description: join(root, "nope.txt") } });
    expect(t).toContain('- name: characters not allowed: ( ) (info: .gproj TITLE is "Texts Title")');
    expect(t).toContain("- summary: ok (200/200)");
    expect(t).toMatch(/- description: cannot read .*nope\.txt/);
  });

  it("201 summary characters fail", async () => {
    expect(await text({ modName: "Texts", summary: "s".repeat(201) })).toContain("- summary: 201/200 characters");
  });
});
