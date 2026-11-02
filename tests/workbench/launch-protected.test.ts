import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, cpSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";

// No Workbench counts as running; the temp Tools folder has no exe, so nothing is ever spawned.
vi.mock("../../src/utils/process.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/utils/process.js")>()),
  findPids: vi.fn(() => []),
}));
const { WorkbenchClient } = await import("../../src/workbench/client.js");
const { registerWbLaunch } = await import("../../src/tools/wb-launch.js");

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

// The bundled handlers copied into an addon, as done by hand for CRF.
const bundled = fileURLToPath(new URL("../../mod/Scripts/WorkbenchGame/EnfusionMCP", import.meta.url));
function withHandlers(modDir: string): string {
  const dir = join(modDir, "Scripts", "WorkbenchGame", "EnfusionMCP");
  cpSync(bundled, dir, { recursive: true });
  return dir;
}
const snap = (dir: string) => readdirSync(dir).sort().map((f) => `${f}:${readFileSync(join(dir, f)).toString("base64")}`).join("|");

type Result = { content: { text: string }[]; isError?: boolean };
function wbTools(config: Config, client = new WorkbenchClient("127.0.0.1", 1, config)) {
  const tools: Record<string, (a: Record<string, unknown>) => Promise<Result>> = {};
  const fake = { registerTool: (name: string, _d: unknown, h: (a: Record<string, unknown>) => Promise<Result>) => { tools[name] = h; } };
  registerWbLaunch(fake as unknown as McpServer, config, client);
  return tools;
}
const wbCleanup = (config: Config) => wbTools(config).wb_cleanup;

describe("wb_launch worldPath", () => {
  it("passes worldPath to the launch and asks the caller to confirm with wb_state", async () => {
    const { addon, config, client } = setup();
    const gproj = join(addon("TestAddon", "1111111111111111"), "addon.gproj");
    vi.spyOn(client, "ping").mockResolvedValue(false);
    const launch = vi.spyOn(client, "ensureRunning").mockResolvedValue(undefined); // never starts a real Workbench
    const r = await wbTools(config, client).wb_launch({ gprojPath: gproj, worldPath: "worlds/Test.ent" });
    expect(launch).toHaveBeenCalledWith(gproj, undefined, "worlds/Test.ent");
    expect(r.content[0].text).toMatch(/World requested at start: worlds\/Test\.ent[\s\S]*wb_state/);
  });

  it("does not switch worlds in a running Workbench and says so", async () => {
    const { config, client } = setup();
    vi.spyOn(client, "ping").mockResolvedValue(true);
    const launch = vi.spyOn(client, "ensureRunning").mockResolvedValue(undefined);
    const r = await wbTools(config, client).wb_launch({ worldPath: "worlds/Test.ent" });
    expect(launch).not.toHaveBeenCalled();
    expect(r.content[0].text).toMatch(/Already Running[\s\S]*worldPath was not opened[\s\S]*wb_open_resource/);
  });

  it("refuses a bad worldPath before copying any handlers", async () => {
    const { addon, projects, client, handlers } = setup();
    const test = addon("TestAddon", "1111111111111111");
    await expect(client.ensureRunning(join(test, "addon.gproj"), false, "worlds/Test.layer")).rejects.toThrow(/\.ent/);
    expect(handlers(test)).toBe(false);
    expect(existsSync(join(projects, "EnfusionMCP"))).toBe(false);
    // only a protected addon: no project to open the world in, so no standalone addon is created either
    const only = setup();
    await expect(only.client.ensureRunning(undefined, false, "worlds/Test.ent")).rejects.toThrow(/needs a project/);
    expect(existsSync(join(only.projects, "EnfusionMCP"))).toBe(false);
  });
});

describe("wb_cleanup and protected addons", () => {
  it("refuses a protected modDir and keeps its handlers", async () => {
    const { crf, config, client } = setup();
    const dir = withHandlers(crf);
    writeFileSync(join(dir, "SYK_Own.c"), ""); // CRF's folder also holds the owner's scripts
    const before = snap(dir);
    const r = await wbCleanup(config)({ modDir: crf });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/protected .*kept/);
    expect(snap(dir)).toBe(before);
    expect(() => client.cleanupHandlerScripts(crf)).toThrow(/protected/);
    expect(snap(dir)).toBe(before);
  });

  it("all=true removes handlers from a test addon, keeps the protected one, and the listing marks it", async () => {
    const { crf, addon, config, handlers } = setup();
    const test = addon("TestAddon", "1111111111111111");
    const dir = withHandlers(crf);
    withHandlers(test);
    const before = snap(dir);
    const list = await wbCleanup(config)({});
    expect(list.content[0].text).toMatch(/Coalition-Reforger-Framework.*protected: kept/);
    const r = await wbCleanup(config)({ all: true });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/removed from 1 addon\b/);
    expect(r.content[0].text).toMatch(/Kept \(protected[\s\S]*Coalition-Reforger-Framework/);
    expect(handlers(test)).toBe(false);
    expect(snap(dir)).toBe(before);
  });

  it("modDir on a test addon removes the handlers and points to release_audit, not 'ready to publish'", async () => {
    const { addon, config, handlers } = setup();
    const test = addon("TestAddon", "1111111111111111");
    withHandlers(test);
    const r = await wbCleanup(config)({ modDir: test });
    expect(handlers(test)).toBe(false);
    expect(r.content[0].text).toMatch(/removed[\s\S]*release_audit/);
    expect(r.content[0].text).not.toMatch(/ready to publish/);
  });
});

describe("launchWorkbench and protected addons", () => {
  it("refuses a protected gprojPath without handlers and creates nothing", async () => {
    const { crf, projects, client, handlers } = setup();
    await expect(client.ensureRunning(join(crf, "addon.gproj"))).rejects.toThrow(/protected addon .*by hand/);
    expect(handlers(crf)).toBe(false);
    expect(existsSync(join(projects, "EnfusionMCP"))).toBe(false);
  });

  it("opens a protected gprojPath that holds the handlers without writing anything", async () => {
    const { crf, projects, client } = setup();
    const dir = withHandlers(crf);
    const before = snap(dir);
    await expect(client.ensureRunning(join(crf, "addon.gproj"))).rejects.toThrow(/Cannot find/);
    expect(snap(dir)).toBe(before);
    expect(existsSync(join(projects, "EnfusionMCP"))).toBe(false);
    expect(client.staleHandlers(crf)).toEqual([]);
  });

  it("reports missing or changed handlers in a protected addon and changes nothing", () => {
    const { crf, client } = setup();
    const dir = withHandlers(crf);
    writeFileSync(join(dir, "EMCP_WB_Clipboard.c"), "// old\n");
    rmSync(join(dir, "EMCP_WB_Components.c"));
    const before = snap(dir);
    expect(client.staleHandlers(crf).sort()).toEqual(["EMCP_WB_Clipboard.c", "EMCP_WB_Components.c"]);
    expect(snap(dir)).toBe(before);
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
    expect(handlers(join(cache, "EnfusionMCP"))).toBe(true); // the standalone fallback addon, in the project root
  });

  it("names a missing gprojPath plainly and creates nothing", async () => {
    const { projects, client } = setup();
    const missing = join(projects, "Nope", "addon.gproj");
    await expect(client.ensureRunning(missing)).rejects.toThrow(/^Not found: .*addon\.gproj/);
    expect(existsSync(join(projects, "Nope"))).toBe(false);
  });
});
