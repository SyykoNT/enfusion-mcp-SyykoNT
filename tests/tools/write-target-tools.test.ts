import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import { myGamesDir } from "../../src/utils/game-paths.js";
import { registerConfigOverride } from "../../src/tools/config-override.js";
import { registerEconomy } from "../../src/tools/economy.js";
import { registerGameDuplicate } from "../../src/tools/game-duplicate.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";

const root = mkdtempSync(join(tmpdir(), "emcp-wtt-"));
const projects = join(root, "projects");
const addon = (name: string, guid: string) => {
  mkdirSync(join(projects, name), { recursive: true });
  writeFileSync(join(projects, name, "addon.gproj"), `GameProject {\n ID "${name.replace(/-/g, "")}"\n GUID "${guid}"\n}\n`);
};
addon("Coalition-Reforger-Framework", "5EB3564A02CE294F");
addon("COALITION-Lobby", "69EA43E490A50DBE");
mkdirSync(join(root, "game", "addons", "data", "Prefabs"), { recursive: true });
writeFileSync(join(root, "game", "addons", "data", "Prefabs", "Src.conf"), "SCR_Foo {\n}\n");
const config = {
  projectPath: projects,
  gamePath: join(root, "game"),
  workbenchPath: join(root, "tools"),
  defaultMod: "Coalition-Reforger-Framework",
  protectedAddons: ["5EB3564A02CE294F", "69EA43E490A50DBE"],
} as Config;

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const tools: Record<string, Handler> = {};
const server = { registerTool: (name: string, _def: unknown, h: Handler) => { tools[name] = h; } } as unknown as McpServer;
registerConfigOverride(server, config);
registerEconomy(server, config);
registerGameDuplicate(server, config, {} as WorkbenchClient);

const listing = () => readdirSync(projects, { recursive: true }).map(String).sort();
const before = listing();
const workshop = join(myGamesDir(), "ArmaReforgerWorkbench", "addons", "SomeMod");

const calls: [string, Record<string, unknown>][] = [
  ["config_override", { action: "set", path: "Configs/Campaign/XPRewards.conf", edits: [{ property: "m_iRewardXP", value: "1" }] }],
  ["economy", { action: "set", category: "xp", multiplier: 2 }],
  ["game_duplicate", { sourcePath: "Prefabs/Src.conf", destPath: "Configs/Copy.conf", register: false }],
];

describe.each(calls)("%s", (tool, args) => {
  it("refuses without a target even though ENFUSION_DEFAULT_MOD is set", async () => {
    const r = await tools[tool](args);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^No target addon/);
  });

  it("refuses CRF and Lobby when protected", async () => {
    for (const modName of ["Coalition-Reforger-Framework", "COALITION-Lobby"]) {
      const r = await tools[tool]({ ...args, modName });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/is protected \(ENFUSION_PROTECTED_ADDONS\)/);
    }
  });

  it("refuses a folder in the Workbench Workshop cache", async () => {
    const r = await tools[tool]({ ...args, projectPath: workshop });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^Refused: .* is inside/);
  });

  it("wrote nothing", () => {
    expect(listing()).toEqual(before);
  });
});
