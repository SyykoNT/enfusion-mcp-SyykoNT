import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";
import { myGamesDir } from "../../src/utils/game-paths.js";
import { forbiddenRoot } from "../../src/utils/safe-path.js";

// Its own file and temp home, set before the first myGamesDir() call: myGamesDir caches the Windows Documents folder, and where the
// registry holds it as %USERPROFILE%\Documents the cached value keeps the home of that first call (a hosted Windows runner does).
const root = mkdtempSync(join(tmpdir(), "emcp-dprl-"));
process.env.USERPROFILE = process.env.HOME = join(root, "home");

describe("Workbench addons folder linked to the game's Workshop cache", () => {
  it("stays forbidden as the project root", () => {
    const cache = join(myGamesDir(), "ArmaReforger", "addons");
    const download = join(cache, "Game_4444444444444444");
    mkdirSync(download, { recursive: true });
    writeFileSync(join(download, "addon.gproj"), 'GameProject {\n ID "X"\n GUID "1111111111111111"\n}\n');
    writeFileSync(join(download, "ServerData.json"), "{}");
    mkdirSync(join(myGamesDir(), "ArmaReforgerWorkbench"), { recursive: true });
    const link = join(myGamesDir(), "ArmaReforgerWorkbench", "addons");
    symlinkSync(cache, link, "junction");
    const cfg = { projectPath: link, gamePath: join(root, "game"), workbenchPath: join(root, "tools") } as Config;
    expect(forbiddenRoot(cfg, join(link, "NewMod"))).toBe(cache);
  });
});
