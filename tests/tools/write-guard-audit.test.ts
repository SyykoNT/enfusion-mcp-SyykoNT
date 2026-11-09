import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import { myGamesDir } from "../../src/utils/game-paths.js";
import { registerProject } from "../../src/tools/project.js";
import { registerScenarioCreate } from "../../src/tools/scenario-create.js";
import { registerAnimationGraph } from "../../src/tools/animation-graph.js";

// The writers WG-AUDIT moved to resolveWriteAddon: project write, scenario_create_conflict, animation_graph author and setup.
const root = mkdtempSync(join(tmpdir(), "emcp-wga-"));
// A fake home, so the "Workshop cache" case is a temp folder: an unguarded build must not reach the real cache.
process.env.USERPROFILE = process.env.HOME = join(root, "home");
const projects = join(root, "projects");
const addon = (dir: string, guid: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "addon.gproj"), `GameProject {\n GUID "${guid}"\n}\n`);
};
addon(join(projects, "Coalition-Reforger-Framework"), "5EB3564A02CE294F");
addon(join(projects, "COALITION-Lobby"), "69EA43E490A50DBE");
addon(join(projects, "MyMod"), "1111222233334444");
const testAddon = join(root, "test-addons", "MCPParity");
addon(testAddon, "5555666677778888");
const workshop = join(myGamesDir(), "ArmaReforgerWorkbench", "addons", "SomeMod");
addon(workshop, "9999AAAABBBBCCCC");

const config = {
  projectPath: projects,
  gamePath: join(root, "game"),
  workbenchPath: join(root, "tools"),
  defaultMod: "Coalition-Reforger-Framework",
  protectedAddons: ["5EB3564A02CE294F", "69EA43E490A50DBE"],
} as Config;

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const tools: Record<string, Handler> = {};
const server = { registerTool: (name: string, _def: unknown, h: Handler) => void (tools[name] = h) } as unknown as McpServer;
registerProject(server, config);
registerScenarioCreate(server, config);
registerAnimationGraph(server, config);

const listing = () => readdirSync(root, { recursive: true }).map(String).sort();
const before = listing();
const files = (dir: string) => readdirSync(dir, { recursive: true }).map(String).filter((f) => f !== "addon.gproj").sort();

const scenario = { scenarioName: "WGA_Conflict", worldName: "Arland", bases: [{ name: "BaseAlpha", position: "100 0 100", faction: "US" }] };
// The handler gets raw arguments (no zod defaults), so pass the defaults the schema would fill.
const anim = {
  vehicleName: "WGA_Truck", vehicleType: "wheeled", wheelCount: 4, hasTurret: false, hasSuspensionIK: true, hasShockAbsorbers: false,
  hasSteeringLinkage: false, seatTypes: ["driver"], dialList: [], source: "mod", inspectAction: "inspect", step: "all", setupSubAction: "setup",
};

describe("refusals write nothing", () => {
  it("project write refuses a file outside any addon, a protected addon and the Workshop cache", async () => {
    const write = (args: Record<string, unknown>) => tools.project({ action: "write", content: "x", ...args });
    expect((await write({ path: "Loose.c" })).content[0].text).toMatch(/is the projects folder, not an addon/);
    expect((await write({ path: "Coalition-Reforger-Framework/Scripts/Game/X.c" })).content[0].text).toMatch(/is protected \(ENFUSION_PROTECTED_ADDONS\)/);
    expect((await write({ path: "COALITION-Lobby/X.c" })).content[0].text).toMatch(/is protected/);
    expect((await write({ path: "Scripts/X.c", projectPath: workshop })).content[0].text).toMatch(/^Refused: .* is inside/);
  });

  it("scenario_create_conflict refuses with the generated files shown, not written", async () => {
    const none = await tools.scenario_create_conflict(scenario);
    expect(none.isError).toBe(true);
    expect(none.content[0].text).toMatch(/^No target addon[\s\S]*Generated conflict scenario \(not written\)/);
    for (const modName of ["Coalition-Reforger-Framework", "COALITION-Lobby"]) {
      expect((await tools.scenario_create_conflict({ ...scenario, modName })).content[0].text).toMatch(/is protected/);
    }
    expect((await tools.scenario_create_conflict({ ...scenario, projectPath: workshop })).content[0].text).toMatch(/^Refused: .* is inside/);
  });

  it("animation_graph author and setup refuse the same targets", async () => {
    for (const action of ["author", "setup"]) {
      const run = (extra: Record<string, unknown>) => tools.animation_graph({ ...anim, action, ...extra });
      const none = (await run({})).content[0].text;
      expect(none).toMatch(/No target addon/);
      expect((await run({ modName: "Coalition-Reforger-Framework" })).content[0].text).toMatch(/is protected/);
      expect((await run({ projectPath: workshop })).content[0].text).toMatch(/Refused: .* is inside/);
      if (action === "setup") expect(none).toContain("## Step 1: AGR + AST, not written");
    }
  });

  it("nothing was written anywhere", () => {
    expect(listing()).toEqual(before);
  });
});

describe("an explicit test addon still gets the same files", () => {
  it("project write, by projectPath and by a path under the projects folder", async () => {
    expect((await tools.project({ action: "write", path: "Scripts/Game/X.c", content: "x", projectPath: testAddon })).isError).toBeUndefined();
    expect((await tools.project({ action: "write", path: "MyMod/Scripts/Game/Y.c", content: "y" })).isError).toBeUndefined();
    expect(existsSync(join(testAddon, "Scripts", "Game", "X.c"))).toBe(true);
    expect(existsSync(join(projects, "MyMod", "Scripts", "Game", "Y.c"))).toBe(true);
  });

  it("scenario_create_conflict", async () => {
    const r = await tools.scenario_create_conflict({ ...scenario, projectPath: testAddon });
    expect(r.isError).toBeUndefined();
    expect(files(testAddon).filter((f) => !f.startsWith("Scripts"))).toEqual(
      ["Missions", join("Missions", "WGA_Conflict.conf"), join("Missions", "WGA_Conflict.conf.meta"), "Worlds", join("Worlds", "WGA_Conflict.ent"), join("Worlds", "WGA_Conflict.ent.meta"), join("Worlds", "WGA_Conflict_Layers"),
        ...["Bases.layer", "Defenders.layer", "default.layer"].map((l) => join("Worlds", "WGA_Conflict_Layers", l))].sort()
    );
  });

  it("animation_graph author by modName", async () => {
    const r = await tools.animation_graph({ ...anim, action: "author", modName: "MyMod", outputPath: "Assets/Vehicles/WGA_Truck/workspaces" });
    expect(r.isError).toBeUndefined();
    const dir = join(projects, "MyMod", "Assets", "Vehicles", "WGA_Truck", "workspaces");
    expect(readdirSync(dir).sort()).toEqual(["WGA_Truck.agr", "WGA_Truck.ast"]);
  });
});
