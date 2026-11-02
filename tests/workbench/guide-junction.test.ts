import { describe, it, expect, vi, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";

// The Coalition Mission Making Guide makes Documents\My Games\ArmaReforgerWorkbench\addons a junction
// (mklink /J) to the game's Workshop cache ArmaReforger\addons. Both live in a temp home here.
vi.mock("../../src/utils/process.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/utils/process.js")>()),
  findPids: vi.fn(() => []),
}));

const win = process.platform === "win32";
const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
const home = mkdtempSync(join(tmpdir(), "emcp-gj-home-"));
process.env.USERPROFILE = process.env.HOME = home;
const myGames = join(home, "Documents", "My Games");
const cache = join(myGames, "ArmaReforger", "addons");
const wbAddons = join(myGames, "ArmaReforgerWorkbench", "addons");
mkdirSync(join(cache, "SomeMod_1111111111111111"), { recursive: true });
writeFileSync(join(cache, "SomeMod_1111111111111111", "addon.gproj"), 'GameProject {\n ID "SomeMod"\n GUID "1111111111111111"\n}\n');
writeFileSync(join(cache, "SomeMod_1111111111111111", "ServerData.json"), "{}");
mkdirSync(join(myGames, "ArmaReforgerWorkbench"), { recursive: true });
if (win) execFileSync("cmd", ["/d", "/c", "mklink", "/J", wbAddons, cache], { stdio: "ignore", windowsHide: true });

const { forbiddenRoot } = await import("../../src/utils/safe-path.js");
const { WorkbenchClient } = await import("../../src/workbench/client.js");

afterAll(() => {
  Object.assign(process.env, saved);
  if (win) execFileSync("cmd", ["/d", "/c", "rmdir", wbAddons], { stdio: "ignore", windowsHide: true }); // removes the junction only
  rmSync(home, { recursive: true, force: true });
});

// The fork's defaults when ENFUSION_PROJECT_PATH is unset: projectPath = the junction
const config = { projectPath: wbAddons, workshopPath: cache, workbenchPath: join(home, "tools") } as Config;

describe.skipIf(!win)("write guard under the guide's addons junction", () => {
  it("refuses a write target under the junction: it resolves to the Workshop cache", () => {
    expect(forbiddenRoot(config, join(wbAddons, "MyMod", "Scripts", "Game", "x.c"))).toBe(cache);
    expect(forbiddenRoot(config, join(wbAddons, "EnfusionMCP"))).toBe(cache);
  });

  it("wb_launch without gprojPath refuses and writes nothing", async () => {
    const before = readdirSync(cache, { recursive: true });
    const err = await new WorkbenchClient("127.0.0.1", 1, config).ensureRunning().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    // Recorded for the README (DOCS-COAL)
    console.log(`wb_launch reply: ${(err as Error).message}`);
    expect((err as Error).message).toMatch(/is inside/);
    expect(readdirSync(cache, { recursive: true })).toEqual(before);
    expect(existsSync(join(cache, "EnfusionMCP"))).toBe(false);
  });
});
