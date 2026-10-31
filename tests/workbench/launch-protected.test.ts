import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";

// No Workbench counts as running; the temp Tools folder has no exe, so nothing is ever spawned.
vi.mock("../../src/utils/process.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/utils/process.js")>()),
  findPids: vi.fn(() => []),
}));
const { WorkbenchClient } = await import("../../src/workbench/client.js");

// A fake home: the "Workshop cache" below is a temp folder, never the real one.
const home = mkdtempSync(join(tmpdir(), "emcp-lp-home-"));
process.env.USERPROFILE = process.env.HOME = home;
const cache = join(home, "Documents", "My Games", "ArmaReforgerWorkbench", "addons");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "emcp-lp-"));
  const projects = join(root, "projects");
  const addon = (name: string, guid: string) => {
    mkdirSync(join(projects, name), { recursive: true });
    writeFileSync(join(projects, name, "addon.gproj"), `GameProject {\n ID "${name}"\n GUID "${guid}"\n}\n`);
    return join(projects, name);
  };
  const crf = addon("Coalition-Reforger-Framework", "5EB3564A02CE294F");
  const config = {
    projectPath: projects,
    workbenchPath: join(root, "tools"),
    defaultMod: "Coalition-Reforger-Framework",
    protectedAddons: ["5EB3564A02CE294F"],
  } as Config;
  const handlers = (dir: string) => existsSync(join(dir, "Scripts", "WorkbenchGame", "EnfusionMCP"));
  return { projects, addon, crf, config, handlers, client: new WorkbenchClient("127.0.0.1", 1, config) };
}

describe("launchWorkbench and protected addons", () => {
  it("refuses an explicit protected gprojPath before copying anything", async () => {
    const { crf, client, handlers } = setup();
    await expect(client.ensureRunning(join(crf, "addon.gproj"))).rejects.toThrow(/protected addon/);
    expect(handlers(crf)).toBe(false);
  });

  it("without gprojPath skips a protected default mod and uses the next addon", async () => {
    const { crf, addon, client, handlers } = setup();
    const test = addon("TestAddon", "1111111111111111");
    await expect(client.ensureRunning()).rejects.toThrow(/Cannot find/);
    expect(handlers(crf)).toBe(false);
    expect(handlers(test)).toBe(true);
  });

  it("with only protected addons falls back to the standalone handler addon", async () => {
    const { crf, projects, client, handlers } = setup();
    await expect(client.ensureRunning()).rejects.toThrow(/Cannot find/);
    expect(handlers(crf)).toBe(false);
    expect(handlers(join(projects, "EnfusionMCP"))).toBe(true);
  });

  it("refuses an addon in the Workshop cache, explicit or as the fallback", async () => {
    const cacheMod = join(cache, "CacheMod");
    mkdirSync(cacheMod, { recursive: true });
    writeFileSync(join(cacheMod, "addon.gproj"), "GameProject {\n ID \"CacheMod\"\n}\n");
    writeFileSync(join(cacheMod, "ServerData.json"), "{}");
    const { config, handlers } = setup();
    await expect(new WorkbenchClient("127.0.0.1", 1, config).ensureRunning(join(cacheMod, "addon.gproj"))).rejects.toThrow(/is inside .*copy handler scripts/);
    // projectPath = the game's Workshop cache: no cache addon, no standalone addon there
    const gameCache = join(home, "Documents", "My Games", "ArmaReforger", "addons");
    const gameMod = join(gameCache, "GameMod");
    mkdirSync(gameMod, { recursive: true });
    writeFileSync(join(gameMod, "addon.gproj"), "GameProject {\n ID \"GameMod\"\n}\n");
    const inCache = { ...config, projectPath: gameCache, defaultMod: "GameMod" } as Config;
    await expect(new WorkbenchClient("127.0.0.1", 1, inCache).ensureRunning()).rejects.toThrow(/is inside/);
    expect(handlers(gameMod)).toBe(false);
    expect(existsSync(join(gameCache, "EnfusionMCP"))).toBe(false);
    // projectPath = the Workbench addons folder (the default when ENFUSION_PROJECT_PATH is unset): its Workshop downloads are skipped
    const inWb = { ...config, projectPath: cache, defaultMod: "CacheMod" } as Config;
    await expect(new WorkbenchClient("127.0.0.1", 1, inWb).ensureRunning()).rejects.toThrow(/Cannot find/);
    expect(handlers(cacheMod)).toBe(false);
  });

  it("names a missing gprojPath plainly and creates nothing", async () => {
    const { projects, client } = setup();
    const missing = join(projects, "Nope", "addon.gproj");
    await expect(client.ensureRunning(missing)).rejects.toThrow(/^Not found: .*addon\.gproj/);
    expect(existsSync(join(projects, "Nope"))).toBe(false);
  });
});
