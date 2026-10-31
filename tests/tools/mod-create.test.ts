import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import type { SearchEngine } from "../../src/index/search-engine.js";
import type { PatternLibrary } from "../../src/patterns/loader.js";
import { registerMod } from "../../src/tools/mod.js";

type Result = { content: { text: string }[]; isError?: boolean };
const root = mkdtempSync(join(tmpdir(), "emcp-mc-"));
const projects = join(root, "projects");
mkdirSync(join(projects, "Taken"), { recursive: true });
const config = { projectPath: projects, gamePath: join(root, "game"), workbenchPath: join(root, "tools") } as Config;
// Two scripts that become the same file once {PREFIX} is replaced
const clash = {
  scripts: [
    { className: "{PREFIX}_Thing", scriptType: "basic", parentClass: "", methods: [], description: "" },
    { className: "{PREFIX}_Thing", scriptType: "basic", parentClass: "", methods: [], description: "" },
  ],
  configs: [],
  prefabs: [],
};
const patterns = { get: (n: string) => (n === "clash" ? clash : undefined), list: () => ["clash"] } as unknown as PatternLibrary;

let mod!: (args: Record<string, unknown>) => Promise<Result>;
registerMod({ registerTool: (_n: string, _d: unknown, h: typeof mod) => { mod = h; } } as unknown as McpServer, config, {} as SearchEngine, patterns);

describe("mod create refusals", () => {
  it("returns isError and writes nothing for an unknown pattern or a pattern collision", async () => {
    for (const pattern of ["nope", "clash"]) {
      const r = await mod({ action: "create", name: `New_${pattern}`, pattern });
      expect(r.isError).toBe(true);
      expect(existsSync(join(projects, `New_${pattern}`))).toBe(false);
    }
  });

  it("returns isError for an existing folder", async () => {
    const r = await mod({ action: "create", name: "Taken" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/already exists/);
  });

  it("refuses a parent folder inside a forbidden root and creates nothing", async () => {
    const r = await mod({ action: "create", name: "InGame", projectPath: join(root, "game", "addons") });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^Refused: .* is inside/);
    expect(existsSync(join(root, "game"))).toBe(false);
  });
});
