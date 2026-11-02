import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";
import { myGamesDir } from "../../src/utils/game-paths.js";
import { registerWbEntityDuplicate } from "../../src/tools/wb-entity-duplicate.js";

const root = mkdtempSync(join(tmpdir(), "emcp-wbdup-"));
// A fake home, so the "Workshop cache" case is a temp folder: an unguarded build must not reach the real cache.
process.env.USERPROFILE = process.env.HOME = join(root, "home");
const projects = join(root, "projects");
const addon = (dir: string, guid: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "addon.gproj"), `GameProject {\n GUID "${guid}"\n}\n`);
};
addon(join(projects, "Coalition-Reforger-Framework"), "5EB3564A02CE294F");
addon(join(projects, "COALITION-Lobby"), "69EA43E490A50DBE");
const testAddon = join(root, "test-addons", "MCPParity");
addon(testAddon, "1111222233334444");
mkdirSync(join(root, "game", "addons", "data", "Prefabs"), { recursive: true });
writeFileSync(join(root, "game", "addons", "data", "Prefabs", "Src.et"), "GenericEntity {\n}\n");

const config = {
  projectPath: projects,
  gamePath: join(root, "game"),
  workbenchPath: join(root, "tools"),
  defaultMod: "Coalition-Reforger-Framework",
  protectedAddons: ["5EB3564A02CE294F", "69EA43E490A50DBE"],
} as Config;

type Result = { content: { text: string }[]; isError?: boolean };
const client = {
  state: { connected: true, mode: "edit" },
  probeMode: vi.fn(async () => "edit"),
  call: vi.fn(async (method: string) =>
    method === "EMCP_WB_Prefabs" ? { status: "ok", ancestorPath: "{0123456789ABCDEF}Prefabs/Src.et" } : { status: "ok" }
  ),
};
let handler: (a: Record<string, unknown>) => Promise<Result> = async () => ({ content: [] });
registerWbEntityDuplicate(
  { registerTool: (_n: string, _d: unknown, h: typeof handler) => (handler = h) } as unknown as McpServer,
  config,
  client as unknown as WorkbenchClient
);
const run = (args: Record<string, unknown>) => handler({ entityName: "Barrel_01", destPath: "Prefabs/Copy.et", replaceInScene: false, ...args });
const listing = () => readdirSync(root, { recursive: true }).map(String).sort();
const before = listing();

describe("wb_entity_duplicate write target", () => {
  it("refuses without a target even though ENFUSION_DEFAULT_MOD is set", async () => {
    const r = await run({});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^No target addon/);
  });

  it("refuses CRF and Lobby when protected", async () => {
    for (const modName of ["Coalition-Reforger-Framework", "COALITION-Lobby"]) {
      const r = await run({ modName });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/is protected \(ENFUSION_PROTECTED_ADDONS\)/);
    }
  });

  it("refuses a folder in the Workbench Workshop cache", async () => {
    const workshop = join(myGamesDir(), "ArmaReforgerWorkbench", "addons", "SomeMod");
    expect(workshop.startsWith(join(root, "home"))).toBe(true);
    addon(workshop, "5555666677778888");
    const r = await run({ projectPath: workshop });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/^Refused: .* is inside/);
    expect(readdirSync(workshop)).toEqual(["addon.gproj"]);
  });

  it("wrote nothing and made no Workbench call for the refusals", () => {
    expect(listing().filter((p) => !p.startsWith("home"))).toEqual(before); // home holds only the Workshop case's own fake addon
    expect(client.probeMode).not.toHaveBeenCalled();
    expect(client.call).not.toHaveBeenCalled();
  });

  it("writes into an explicit test addon", async () => {
    const r = await run({ projectPath: testAddon });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("**Prefab saved successfully**");
    expect(readFileSync(join(testAddon, "Prefabs", "Copy.et"), "utf-8")).toBe("GenericEntity {\n}\n");
    expect(client.call.mock.calls.map((c) => c[0])).toEqual(["EMCP_WB_Prefabs", "EMCP_WB_Resources"]);
  });
});
