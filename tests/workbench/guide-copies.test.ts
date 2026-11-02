import { describe, it, expect, vi, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";

// The guide's junction fails when Documents is on OneDrive, so users copy their mods by hand:
// Documents\My Games\ArmaReforgerWorkbench\addons is then a real folder of Workshop copies. Temp home here.
vi.mock("../../src/utils/process.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/utils/process.js")>()),
  findPids: vi.fn(() => []),
}));

const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
const home = mkdtempSync(join(tmpdir(), "emcp-gc-home-"));
process.env.USERPROFILE = process.env.HOME = home;
const myGames = join(home, "Documents", "My Games");
const cache = join(myGames, "ArmaReforger", "addons");
const wbAddons = join(myGames, "ArmaReforgerWorkbench", "addons");
const LOBBY = "COALITIONLobby_69EA43E490A50DBE";
const download = (dir: string, name: string, version: string) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "addon.gproj"), `GameProject {\n ID "${name}"\n}\n`);
  writeFileSync(join(dir, name, "ServerData.json"), `{"revision":{"version":"${version}"}}`);
};
download(cache, LOBBY, "2.0.10");
download(wbAddons, LOBBY, "copied");
download(wbAddons, "SomeMod_1111111111111111", "copied");
const crf = join(myGames, "ArmaReforgerWorkbench", "Projects", "Coalition-Reforger-Framework");
mkdirSync(join(crf, "Tools", "Validation"), { recursive: true });
writeFileSync(join(crf, "Tools", "Validation", "validate_mission.py"), "");

const { forbiddenRoot } = await import("../../src/utils/safe-path.js");
const { resolveCoalitionRoots } = await import("../../src/utils/coalition-paths.js");
const { WorkbenchClient } = await import("../../src/workbench/client.js");

afterAll(() => {
  Object.assign(process.env, saved);
  rmSync(home, { recursive: true, force: true });
});

// The fork's defaults when ENFUSION_PROJECT_PATH is unset
const config = { projectPath: wbAddons, workshopPath: cache, workbenchPath: join(home, "tools") } as Config;

describe("the guide's setup with hand-copied mods (Documents on OneDrive)", () => {
  it("refuses writes into a copied mod in the Workbench addons folder", () => {
    for (const mod of [LOBBY, "SomeMod_1111111111111111"]) {
      expect(forbiddenRoot(config, join(wbAddons, mod, "Scripts", "Game", "x.c"))).not.toBeNull();
    }
  });

  it("reads the Lobby from the game's Workshop folder, not from the copy", () => {
    const r = resolveCoalitionRoots(config);
    expect([r.crf.kind, r.crf.root, r.lobby.kind, r.lobby.root]).toEqual(["loose", crf, "workshop", join(cache, LOBBY)]);
    expect(r.lobby.label).toBe(`Workshop 2.0.10 (${join(cache, LOBBY)})`);
  });

  it("wb_launch without gprojPath skips the copies and writes nothing into them", async () => {
    const before = (dir: string) => readdirSync(dir, { recursive: true });
    const copies = [LOBBY, "SomeMod_1111111111111111"].map((m) => [m, before(join(wbAddons, m))] as const);
    const err = await new WorkbenchClient("127.0.0.1", 1, config).ensureRunning().catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    // Recorded for the README (DOCS-COAL)
    console.log(`wb_launch reply: ${(err as Error).message}`);
    for (const [m, list] of copies) expect(before(join(wbAddons, m))).toEqual(list);
    expect(existsSync(join(cache, "EnfusionMCP"))).toBe(false);
    // As for any user on the default project folder: the standalone handler addon goes in its root, beside the copies
    expect(existsSync(join(wbAddons, "EnfusionMCP"))).toBe(true);
    expect((err as Error).message).toMatch(/^Cannot find ArmaReforgerWorkbenchSteamDiag\.exe/);
  });
});
