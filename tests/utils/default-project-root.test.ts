import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";
import { resolveWriteAddon, myGamesDir } from "../../src/utils/game-paths.js";
import { forbiddenRoot } from "../../src/utils/safe-path.js";

// A temp home, so My Games (and both Workshop caches) are temp folders, never the real ones.
const root = mkdtempSync(join(tmpdir(), "emcp-dpr-"));
process.env.USERPROFILE = process.env.HOME = join(root, "home");
const wbAddons = join(myGamesDir(), "ArmaReforgerWorkbench", "addons");
const gameCache = join(myGamesDir(), "ArmaReforger", "addons");
const addon = (dir: string, download = false) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "addon.gproj"), 'GameProject {\n ID "X"\n GUID "1111111111111111"\n}\n');
  if (download) writeFileSync(join(dir, "ServerData.json"), "{}");
  return dir;
};
addon(join(wbAddons, "MyMod"));
addon(join(wbAddons, "Cached_3333333333333333"), true);
addon(join(gameCache, "Game_4444444444444444"), true);
const cfg = (projectPath: string) => ({ projectPath, gamePath: join(root, "game"), workbenchPath: join(root, "tools") }) as Config;
const err = (r: ReturnType<typeof resolveWriteAddon>) => ("error" in r ? r.error : "");

describe("default project path (Workbench addons folder)", () => {
  it("is inside the temp home", () => {
    expect(wbAddons.startsWith(root)).toBe(true);
  });

  it("as the project root: own addons and new folders are writable, Workshop downloads are not", () => {
    expect(resolveWriteAddon(cfg(wbAddons), { modName: "MyMod" })).toHaveProperty("dir", join(wbAddons, "MyMod"));
    expect(forbiddenRoot(cfg(wbAddons), join(wbAddons, "NewMod", "Scripts"))).toBeNull();
    expect(err(resolveWriteAddon(cfg(wbAddons), { modName: "Cached_3333333333333333" }))).toMatch(/^Refused: .* is inside .*cached_3333333333333333/i);
  });

  it("stays forbidden when the project root is elsewhere", () => {
    expect(forbiddenRoot(cfg(join(root, "projects")), join(wbAddons, "MyMod"))).toBe(wbAddons);
  });

  it("the game's Workshop cache stays forbidden, also as the project root", () => {
    expect(forbiddenRoot(cfg(gameCache), join(gameCache, "Game_4444444444444444"))).toBe(gameCache);
  });
});

describe("Workbench addons folder linked to the game's Workshop cache", () => {
  it("stays forbidden as the project root", () => {
    const home = join(root, "home2");
    process.env.USERPROFILE = process.env.HOME = home;
    try {
      const cache = join(myGamesDir(), "ArmaReforger", "addons");
      addon(join(cache, "Game_4444444444444444"), true);
      mkdirSync(join(myGamesDir(), "ArmaReforgerWorkbench"), { recursive: true });
      const link = join(myGamesDir(), "ArmaReforgerWorkbench", "addons");
      symlinkSync(cache, link, "junction");
      expect(forbiddenRoot(cfg(link), join(link, "NewMod"))).toBe(cache);
    } finally {
      process.env.USERPROFILE = process.env.HOME = join(root, "home");
    }
  });
});
