import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";
import { resolveWriteAddon, myGamesDir } from "../../src/utils/game-paths.js";
import { forbiddenRoot, forbiddenRoots } from "../../src/utils/safe-path.js";

const root = mkdtempSync(join(tmpdir(), "emcp-wt-"));
const addon = (dir: string, guid: string, id: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "addon.gproj"), `GameProject {\n ID "${id}"\n GUID "${guid}"\n}\n`);
  return dir;
};
const projects = join(root, "projects");
const mine = addon(join(projects, "MyAddon"), "1111111111111111", "MyAddonID");
addon(join(projects, "Protected"), "AAAAAAAAAAAAAAAA", "ProtID");
mkdirSync(join(projects, "NoGproj"));
addon(join(root, "extra", "ExtraAddon"), "2222222222222222", "ExtraID");
addon(join(root, "workshop", "Cached"), "3333333333333333", "CachedID");
mkdirSync(join(root, "game"));
mkdirSync(join(root, "tools"));
symlinkSync(join(root, "workshop"), join(root, "link"), "junction");

const cfg = (extra: Partial<Config> = {}) =>
  ({ projectPath: projects, addonsDir: join(root, "extra"), gamePath: join(root, "game"), workbenchPath: join(root, "tools"), ...extra }) as Config;
const err = (r: ReturnType<typeof resolveWriteAddon>) => ("error" in r ? r.error : "");

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = { f: process.env.ENFUSION_FORBIDDEN_DIRS, p: process.env.ENFUSION_WORKBENCH_PROFILE };
  process.env.ENFUSION_FORBIDDEN_DIRS = join(root, "workshop");
  process.env.ENFUSION_WORKBENCH_PROFILE = join(root, "profile");
});
afterEach(() => {
  for (const [k, v] of [["ENFUSION_FORBIDDEN_DIRS", saved.f], ["ENFUSION_WORKBENCH_PROFILE", saved.p]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("forbiddenRoot", () => {
  it("lists both Workshop caches and the env roots", () => {
    const roots = forbiddenRoots(cfg());
    expect(roots).toContain(join(myGamesDir(), "ArmaReforger", "addons"));
    expect(roots).toContain(join(myGamesDir(), "ArmaReforgerWorkbench", "addons"));
    expect(roots).toContain(join(root, "profile", "addons"));
    expect(roots).toContain(join(root, "workshop"));
  });

  it("finds a path under each root, missing files included", () => {
    expect(forbiddenRoot(cfg(), join(root, "game", "addons", "x.pak"))).toBe(join(root, "game"));
    expect(forbiddenRoot(cfg(), join(root, "tools", "Workbench"))).toBe(join(root, "tools"));
    expect(forbiddenRoot(cfg(), join(root, "profile", "addons", "Foo"))).toBe(join(root, "profile", "addons"));
    expect(forbiddenRoot(cfg(), join(root, "workshop", "Cached"))).toBe(join(root, "workshop"));
  });

  it("follows junctions and ignores same-prefix siblings", () => {
    expect(forbiddenRoot(cfg(), join(root, "link", "Cached"))).toBe(join(root, "workshop"));
    expect(forbiddenRoot(cfg(), join(root, "gameX", "a"))).toBeNull();
    expect(forbiddenRoot(cfg(), mine)).toBeNull();
  });

  it.skipIf(process.platform !== "win32")("ignores case on Windows", () => {
    expect(forbiddenRoot(cfg(), join(root, "GAME", "Addons").toUpperCase())).toBe(join(root, "game"));
  });
});

describe("resolveWriteAddon", () => {
  it("refuses without a target, even with a default mod", () => {
    expect(err(resolveWriteAddon(cfg({ defaultMod: "MyAddon" }), {}))).toMatch(/^No target addon/);
  });

  it("accepts projectPath, modName under the project path and under ENFUSION_ADDONS_DIR", () => {
    expect(resolveWriteAddon(cfg(), { projectPath: mine })).toEqual({ dir: mine, gproj: join(mine, "addon.gproj") });
    expect(resolveWriteAddon(cfg(), { modName: "MyAddon" })).toMatchObject({ dir: mine });
    expect(resolveWriteAddon(cfg(), { modName: "ExtraAddon" })).toMatchObject({ dir: join(root, "extra", "ExtraAddon") });
  });

  it("projectPath wins over modName", () => {
    expect(resolveWriteAddon(cfg(), { projectPath: mine, modName: "ExtraAddon" })).toMatchObject({ dir: mine });
  });

  it("refuses an unknown modName, a folder without .gproj and the projects folder", () => {
    expect(err(resolveWriteAddon(cfg(), { modName: "Nope" }))).toMatch(/modName "Nope" not found/);
    expect(err(resolveWriteAddon(cfg(), { modName: "NoGproj" }))).toMatch(/^Not an addon/);
    expect(err(resolveWriteAddon(cfg(), { projectPath: projects }))).toMatch(/is the projects folder/);
  });

  it("refuses protected addons by GUID, ID or folder name, any case", () => {
    for (const p of ["aaaaaaaaaaaaaaaa", "ProtID", "protected"]) {
      expect(err(resolveWriteAddon(cfg({ protectedAddons: [p] }), { modName: "Protected" }))).toMatch(/is protected/);
    }
    expect(resolveWriteAddon(cfg({ protectedAddons: ["ProtID"] }), { modName: "MyAddon" })).toMatchObject({ dir: mine });
  });

  it("refuses an addon inside a forbidden root reached through a junction", () => {
    expect(err(resolveWriteAddon(cfg(), { projectPath: join(root, "link", "Cached") }))).toMatch(/^Refused: .* is inside/);
  });
});
