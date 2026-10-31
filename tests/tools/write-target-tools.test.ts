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
import { registerConfigCreate } from "../../src/tools/config-create.js";
import { registerLayoutCreate } from "../../src/tools/layout-create.js";
import { registerLayoutRecipe } from "../../src/tools/layout-recipe.js";
import { registerMenuCreate } from "../../src/tools/menu-create.js";
import { registerPrefab } from "../../src/tools/prefab.js";
import { registerScriptCreate } from "../../src/tools/script-create.js";
import { registerGamemodeScaffold } from "../../src/tools/gamemode-scaffold.js";
import { registerBuildingSetup } from "../../src/tools/building-setup.js";
import { registerServerConfig } from "../../src/tools/server-config.js";

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
registerConfigCreate(server, config);
registerLayoutCreate(server, config);
registerLayoutRecipe(server, config);
registerMenuCreate(server, config);
registerPrefab(server, config);
registerScriptCreate(server, config);
registerGamemodeScaffold(server, config);
registerBuildingSetup(server, config);
registerServerConfig(server, config);

const listing = () => readdirSync(projects, { recursive: true }).map(String).sort();
const before = listing();
const workshop = join(myGamesDir(), "ArmaReforgerWorkbench", "addons", "SomeMod");

const manifest = join(root, "building_manifest.json");
writeFileSync(manifest, JSON.stringify({ building_name: "WTT_House", export_root: "", structure: { fbx: "h.fbx", sockets: [] }, parts: [] }));

const calls: [string, Record<string, unknown>][] = [
  ["config_override", { action: "set", path: "Configs/Campaign/XPRewards.conf", edits: [{ property: "m_iRewardXP", value: "1" }] }],
  ["economy", { action: "set", category: "xp", multiplier: 2 }],
  ["game_duplicate", { sourcePath: "Prefabs/Src.conf", destPath: "Configs/Copy.conf", register: false }],
  ["config_create", { configType: "faction", name: "WTT_Faction" }],
  ["layout_create", { name: "WTT_Hud", layoutType: "hud" }],
  ["layout_recipe", { action: "create", recipe: "info_panel", name: "WTT_Info" }],
  ["menu_create", { action: "create", className: "WTT_Menu" }],
  ["prefab", { action: "create", name: "WTT_Prefab", prefabType: "generic", includeAncestry: true }],
  ["script_create", { className: "WTT_Script", scriptType: "component" }],
  ["gamemode_scaffold", { action: "create", features: ["battle_prep"] }],
  ["building_setup", { manifestPath: manifest }],
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

describe("create tools", () => {
  it("return the generated content with the refusal", async () => {
    const r = await tools.layout_create({ name: "WTT_Hud", layoutType: "hud" });
    expect(r.content[0].text).toMatch(/Generated layout \(not written\)[\s\S]*FrameWidgetClass/);
  });

  it("write into an explicit addon", async () => {
    const dir = join(root, "elsewhere", "MyAddon");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "addon.gproj"), "GameProject {\n ID \"MyAddon\"\n}\n");
    const r = await tools.config_create({ configType: "faction", name: "WTT_Faction", projectPath: dir });
    expect(r.isError).toBeUndefined();
    expect(readdirSync(dir, { recursive: true }).map(String)).toContain(join("Configs", "Factions", "WTT_Faction.conf"));
  });
});

describe("server_config (modName there is the addon ID to load, so only projectPath picks the target)", () => {
  it("refuses without projectPath, and for a protected or Workshop folder", async () => {
    expect((await tools.server_config({ name: "T" })).content[0].text).toMatch(/^No target addon/);
    expect((await tools.server_config({ name: "T", projectPath: join(projects, "Coalition-Reforger-Framework") })).content[0].text).toMatch(/is protected/);
    expect((await tools.server_config({ name: "T", projectPath: workshop })).content[0].text).toMatch(/^Refused: .* is inside/);
    expect(listing()).toEqual(before);
  });
});

describe("guarded writers write into an explicit addon", () => {
  const dir = join(root, "elsewhere", "Writers");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "addon.gproj"), "GameProject {\n ID \"Writers\"\n}\n");

  it("gamemode_scaffold, building_setup and server_config", async () => {
    expect((await tools.gamemode_scaffold({ action: "create", features: ["battle_prep"], projectPath: dir })).isError).toBeUndefined();
    expect((await tools.building_setup({ manifestPath: manifest, projectPath: dir })).isError).toBeUndefined();
    expect((await tools.server_config({ name: "T", projectPath: dir })).isError).toBeUndefined();
    const files = readdirSync(dir, { recursive: true }).map(String);
    expect(files).toContain(join("scripts", "Game", "GameMode", "SCR_GameModeCampaign_modded.c"));
    expect(files).toContain(join("Prefabs", "Structures", "WTT_House", "WTT_House.et"));
    expect(files).toContain("server.json");
  });

  it("building_setup refuses an outputDir outside the addon", async () => {
    const r = await tools.building_setup({ manifestPath: manifest, projectPath: dir, outputDir: join(root, "outside") });
    expect(r.content[0].text).toMatch(/outside the target addon/);
  });
});
