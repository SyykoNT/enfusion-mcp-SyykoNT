import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crashLogsDir, crashLogsFolder, parseScriptIssues, readGproj, workbenchProfileDir } from "../../src/workbench/cli.js";
import type { Config } from "../../src/config.js";

// Lines copied from a real `-wbSilent` run on Arma Reforger Tools 1.8 with a broken addon script
const LOG = [
  `19:57:04.925    SCRIPT    (E): @"Scripts/Game/MCT_Broken.c,5": Unknown type 'UnknownType'`,
  `19:57:04.925    SCRIPT    (E): @"Scripts/Game/MCT_Broken.c,5": Unknown type 'UnknownType'`,
  `19:57:04.943    SCRIPT    (E): @"Scripts/Game/ScenarioFramework/Actions/SCR_X.c,10": Can't find class SCR_ScenarioFrameworkParam`,
  `19:56:48.624    SCRIPT    (W): @"Scripts/Game/MCT_Broken.c,3": 'Foo' is obsolete`,
  `19:57:05.013    SCRIPT    (E): Can't compile "Game" script module!`,
].join("\n");

describe("parseScriptIssues", () => {
  const addon = mkdtempSync(join(tmpdir(), "emcp-"));
  mkdirSync(join(addon, "Scripts", "Game"), { recursive: true });
  writeFileSync(join(addon, "Scripts", "Game", "MCT_Broken.c"), "");

  it("dedupes errors and flags the ones in the addon", () => {
    const errs = parseScriptIssues(LOG, addon, "E");
    expect(errs).toEqual([
      { file: "Scripts/Game/MCT_Broken.c", line: 5, message: "Unknown type 'UnknownType'", inAddon: true },
      { file: "Scripts/Game/ScenarioFramework/Actions/SCR_X.c", line: 10, message: "Can't find class SCR_ScenarioFrameworkParam", inAddon: false },
    ]);
  });

  it("reads warnings separately", () => {
    expect(parseScriptIssues(LOG, addon, "W").map((w) => w.line)).toEqual([3]);
  });
});

describe("readGproj", () => {
  it("reads quoted and bare ID/GUID/TITLE", () => {
    const d = mkdtempSync(join(tmpdir(), "emcp-"));
    const f = join(d, "a.gproj");
    writeFileSync(f, `GameProject {\n ID "My Mod"\n GUID B83297F2C2B9C62B\n TITLE "My Mod Title"\n}`);
    expect(readGproj(f)).toEqual({ id: "My Mod", guid: "B83297F2C2B9C62B", title: "My Mod Title" });
  });
});

describe("workbenchProfileDir", () => {
  it("uses ENFUSION_WORKBENCH_PROFILE when it has logs/, else falls back to the project path parent", () => {
    const root = mkdtempSync(join(tmpdir(), "emcp-"));
    const profile = join(root, "Workbench");
    mkdirSync(join(profile, "logs"), { recursive: true });
    const config = { projectPath: join(root, "projects") } as Config;
    const saved = process.env.ENFUSION_WORKBENCH_PROFILE;
    try {
      process.env.ENFUSION_WORKBENCH_PROFILE = profile;
      expect(workbenchProfileDir(config)).toBe(profile);
      process.env.ENFUSION_WORKBENCH_PROFILE = join(root, "missing");
      mkdirSync(join(root, "logs"));
      expect(workbenchProfileDir(config)).toBe(root);
    } finally {
      if (saved === undefined) delete process.env.ENFUSION_WORKBENCH_PROFILE;
      else process.env.ENFUSION_WORKBENCH_PROFILE = saved;
    }
  });
});

describe("crashLogsFolder", () => {
  const saved = process.env.ENFUSION_WORKBENCH_PROFILE;
  afterEach(() => {
    if (saved === undefined) delete process.env.ENFUSION_WORKBENCH_PROFILE;
    else process.env.ENFUSION_WORKBENCH_PROFILE = saved;
  });

  function setup(profileUnder?: "game") {
    const root = mkdtempSync(join(tmpdir(), "emcp-crash-"));
    const game = join(root, "game");
    const workshop = join(root, "workshop");
    mkdirSync(join(workshop, "Mod"), { recursive: true });
    mkdirSync(game);
    const profile = join(profileUnder === "game" ? game : root, "Workbench");
    mkdirSync(join(profile, "logs"), { recursive: true });
    process.env.ENFUSION_WORKBENCH_PROFILE = profile;
    const config = { gamePath: game, workbenchPath: join(root, "tools"), workshopPath: workshop, projectPath: join(root, "projects") } as Config;
    return { root, game, workshop, config, fallback: join(profileUnder === "game" ? game : root, "Workbench Crash Logs") };
  }

  it("keeps an allowed setting, also when it does not exist yet (checked through its nearest existing parent)", () => {
    const { root, config } = setup();
    const want = join(root, "out", "a", "b");
    expect(crashLogsFolder({ ...config, crashLogsDir: want })).toEqual({ dir: want });
    mkdirSync(join(root, "out"));
    expect(crashLogsDir({ ...config, crashLogsDir: want })).toBe(want);
  });

  it("refuses a setting inside the game folder, even a folder that does not exist yet, and uses the default beside the profile", () => {
    const { game, config, fallback } = setup();
    const bad = join(game, "Crashes", "new");
    expect(crashLogsFolder({ ...config, crashLogsDir: bad })).toEqual({ dir: fallback, refused: { setting: bad, root: game } });
    expect(crashLogsDir({ ...config, crashLogsDir: bad })).toBe(fallback);
  });

  it("refuses a setting inside a Workshop cache", () => {
    const { workshop, config, fallback } = setup();
    const bad = join(workshop, "Mod", "crash");
    expect(crashLogsFolder({ ...config, crashLogsDir: bad })).toEqual({ dir: fallback, refused: { setting: bad, root: workshop } });
  });

  it("returns no folder when the default is refused too", () => {
    const { game, config } = setup("game");
    const bad = join(game, "Crashes");
    expect(crashLogsFolder({ ...config, crashLogsDir: bad })).toEqual({ dir: undefined, refused: { setting: bad, root: game } });
    expect(crashLogsDir(config)).toBeUndefined();
  });
});
