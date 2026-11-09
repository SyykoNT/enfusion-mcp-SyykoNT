import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";
import { myGamesDir } from "../../src/utils/game-paths.js";
import { writeRefusal } from "../../src/tuning-server/write-guard.js";

const root = mkdtempSync(join(tmpdir(), "emcp-tuneguard-"));
// A fake home, so the "Workshop cache" case is a temp folder: an unguarded build must not reach the real cache.
const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, PROFILE: process.env.ENFUSION_WORKBENCH_PROFILE, FORBIDDEN: process.env.ENFUSION_FORBIDDEN_DIRS };
process.env.USERPROFILE = process.env.HOME = join(root, "home");
delete process.env.ENFUSION_WORKBENCH_PROFILE;
delete process.env.ENFUSION_FORBIDDEN_DIRS;
afterAll(() => {
  for (const [k, v] of Object.entries({ USERPROFILE: saved.USERPROFILE, HOME: saved.HOME, ENFUSION_WORKBENCH_PROFILE: saved.PROFILE, ENFUSION_FORBIDDEN_DIRS: saved.FORBIDDEN })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const projects = join(root, "projects");
const addon = (dir: string, guid: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "addon.gproj"), `GameProject {\n ID "Test"\n GUID "${guid}"\n}\n`);
  return dir;
};
const config = {
  projectPath: projects,
  gamePath: join(root, "game"),
  workbenchPath: join(root, "tools"),
  protectedAddons: ["5EB3564A02CE294F"],
} as Config;

describe("tuning server write guard", () => {
  it("refuses an addon inside the game folder", () => {
    expect(writeRefusal(config, addon(join(root, "game", "addons", "Mod"), "1111111111111111"))).toMatch(/^Refused: .* is inside .*game/);
  });

  it("refuses an addon inside a Workshop cache", () => {
    const cached = addon(join(myGamesDir(), "ArmaReforgerWorkbench", "addons", "SomeMod"), "2222222222222222");
    expect(cached.startsWith(join(root, "home"))).toBe(true);
    expect(writeRefusal(config, cached)).toMatch(/^Refused: .* is inside/);
  });

  it("refuses a protected addon", () => {
    expect(writeRefusal(config, addon(join(projects, "Coalition-Reforger-Framework"), "5EB3564A02CE294F"))).toMatch(/is protected \(ENFUSION_PROTECTED_ADDONS\)/);
  });

  it("allows a test addon in the projects folder", () => {
    expect(writeRefusal(config, addon(join(projects, "RoadForger"), "3333333333333333"))).toBeNull();
  });

  // index.ts runs on import, so the start-up refusal is checked in a child process; an unguarded start stays up and hits the timeout (status null).
  it("the server does not start on a protected addon: it exits 1 with the reason", () => {
    const repo = join(__dirname, "..", "..");
    const refused =
      spawnSync(process.execPath, ["--import", "tsx", join(repo, "src", "tuning-server", "index.ts")], {
        cwd: repo,
        encoding: "utf-8",
        timeout: 20000,
        env: {
          ...process.env,
          USERPROFILE: join(root, "home"),
          HOME: join(root, "home"),
          ENFUSION_PROJECT_PATH: projects,
          ENFUSION_GAME_PATH: join(root, "game"),
          ENFUSION_WORKBENCH_PATH: join(root, "tools"),
          ENFUSION_PROTECTED_ADDONS: "5EB3564A02CE294F",
          ENFUSION_TUNING_ADDON: "Coalition-Reforger-Framework",
          ENFUSION_TUNING_PORT: "0",
        },
      });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("is protected (ENFUSION_PROTECTED_ADDONS)");
    expect(refused.stderr).toContain("ENFUSION_TUNING_READONLY=1");
  }, 30000);
});
