import { beforeEach, describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import type { SearchEngine } from "../../src/index/search-engine.js";
import type { PatternLibrary } from "../../src/patterns/loader.js";

// A fake home first: instance files and the Workbench profile land in temp folders.
const home = mkdtempSync(join(tmpdir(), "emcp-ad-home-"));
process.env.USERPROFILE = process.env.HOME = home;

// Nothing real starts: spawn is a recorded stub that exits at once, and no Workbench counts as running.
const sys = vi.hoisted(() => ({ spawned: [] as string[][] }));
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn: vi.fn((exe: string, args: string[]) => {
    if (/ArmaReforgerWorkbenchSteamDiag.exe$/.test(exe)) sys.spawned.push(args); // not the watchdog process the launch also starts
    return { pid: 4242, unref: () => {}, kill: () => {}, on: (ev: string, cb: (code: number) => void) => { if (ev === "close") setTimeout(() => cb(0)); } };
  }),
}));
vi.mock("../../src/utils/process.js", async (orig) => ({
  ...(await orig<typeof import("../../src/utils/process.js")>()),
  findPids: () => [],
  workbenchCommandLines: () => [],
  sleep: async () => {},
}));
vi.mock("../../src/utils/game-paths.js", async (orig) => ({
  ...(await orig<typeof import("../../src/utils/game-paths.js")>()),
  findWorkbenchExe: () => join(home, "Tools", "Workbench", "ArmaReforgerWorkbenchSteamDiag.exe"),
}));
vi.mock("../../src/watchdog/crash-sweep.js", async (orig) => ({
  ...(await orig<typeof import("../../src/watchdog/crash-sweep.js")>()),
  saveCrashFolders: vi.fn(() => ({ saved: [], errors: [], capped: false })),
}));
// The dialog probe is a stub: the real one reads real windows with PowerShell.
vi.mock("../../src/watchdog/probe.js", async (orig) => ({
  ...(await orig<typeof import("../../src/watchdog/probe.js")>()),
  probeDialogs: vi.fn(async () => []),
}));

// cli first: it and the config import each other through game-paths, and the mocks above bind in this order
const { checkPackOutput, runWorkbench, compileAddon, packAddon } = await import("../../src/workbench/cli.js");
const { WorkbenchClient } = await import("../../src/workbench/client.js");
const { registerWbLaunch } = await import("../../src/tools/wb-launch.js");
const { registerMod } = await import("../../src/tools/mod.js");

type Reply = { isError?: boolean; content: { text: string }[] };
type Handler = (a: Record<string, unknown>) => Promise<Reply>;

const tmp = mkdtempSync(join(tmpdir(), "emcp-ad-"));
let n = 0;
const fresh = () => {
  const d = join(tmp, `t${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const G = "AAAAAAAAAAAAAAAA";
const OTHER = "BBBBBBBBBBBBBBBB";
function addon(parent: string, name: string, guid: string): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "addon.gproj"), `GameProject {\n ID "${name}"\n GUID "${guid}"\n}\n`);
  return dir;
}
const gprojOf = (dir: string) => join(dir, "addon.gproj");
/** The folder after "-addonsDir" in a recorded command line. */
const addonsDirArg = (args: string[]) => args[args.indexOf("-addonsDir") + 1];

/** The shape of the plan: the configured -addonsDir ("projects") holds one copy of Base, the "mission" folder holds the one to open. */
function world() {
  const base = fresh();
  const projects = join(base, "projects"), mission = join(base, "mission");
  addon(projects, "Base", G);
  const opened = addon(mission, "Base", G);
  const config = {
    projectPath: projects, addonsDir: projects, packedPath: join(base, "packed"), gamePath: join(base, "game"), workbenchPath: join(home, "Tools"),
  } as Config;
  return { base, projects, mission, opened, gproj: gprojOf(opened), config };
}

/** A client whose NET API is down until the spawn, then answers (the first `down` pings fail). */
function client(config: Config, down = 2) {
  const c = new WorkbenchClient("127.0.0.1", 1, config);
  const raw = vi.spyOn(c as unknown as { rawCall: () => Promise<unknown> }, "rawCall").mockResolvedValue({});
  for (let i = 0; i < down; i++) raw.mockRejectedValueOnce(new Error("refused"));
  return c;
}
function launchTool(config: Config, c: InstanceType<typeof WorkbenchClient>): Handler {
  let h!: Handler;
  registerWbLaunch({ registerTool: (name: string, _d: unknown, fn: Handler) => { if (name === "wb_launch") h = fn; } } as unknown as McpServer, config, c);
  return h;
}
function modTool(config: Config): Handler {
  let h!: Handler;
  registerMod({ registerTool: (_n: string, _d: unknown, fn: Handler) => { h = fn; } } as unknown as McpServer, config, {} as SearchEngine, {} as PatternLibrary);
  return h;
}

beforeEach(() => {
  sys.spawned = [];
});

describe("wb_launch addonsDirs", () => {
  it("reaches -addonsDir joined with a comma; omitted, the configured folders stay", async () => {
    const w = world();
    const extra = fresh();
    const r = await launchTool(w.config, client(w.config))({ gprojPath: w.gproj, addonsDirs: [w.mission, extra] });
    expect(r.isError).toBeUndefined();
    expect(addonsDirArg(sys.spawned[0])).toBe(`${w.mission},${extra}`);

    const lone = addon(w.projects, "Lone", OTHER);
    await launchTool(w.config, client(w.config))({ gprojPath: gprojOf(lone) });
    expect(addonsDirArg(sys.spawned[1])).toBe(w.projects);
  });

  it("reaches -addonsDir on the standalone-addon fallback too", async () => {
    const w = world();
    const config = { ...w.config, projectPath: fresh() } as Config; // no addon to open: the fallback addon is used
    const r = await launchTool(config, client(config))({ addonsDirs: [w.mission] });
    expect(r.isError).toBeUndefined();
    expect(sys.spawned[0]).toContain("-gproj");
    expect(sys.spawned[0][sys.spawned[0].indexOf("-gproj") + 1]).toMatch(/EnfusionMCP\.gproj$/);
    expect(addonsDirArg(sys.spawned[0])).toBe(w.mission);
  });

  it("the duplicate check uses the call's folders: refused with the defaults and naming addonsDirs, started with the mission folder", async () => {
    const w = world();
    const refused = await launchTool(w.config, client(w.config))({ gprojPath: w.gproj });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/Refused: addon GUID AAAAAAAAAAAAAAAA[\s\S]*pass addonsDirs with/);
    expect(sys.spawned).toEqual([]);
    const ok = await launchTool(w.config, client(w.config))({ gprojPath: w.gproj, addonsDirs: [w.mission] });
    expect(ok.isError).toBeUndefined();
    expect(sys.spawned.length).toBe(1);
  });

  it.each([["relative/dir"], ['C:\\x"y'], ["C:\\x,y"]])("refuses %j before anything starts", async (bad) => {
    const w = world();
    const r = await launchTool(w.config, client(w.config))({ gprojPath: w.gproj, addonsDirs: [bad] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toBe(`addonsDirs must be existing absolute folders without quotes or commas: ${bad}`);
    expect(sys.spawned).toEqual([]);
  });

  it("starts nothing and says addonsDirs was not applied when Workbench already answers", async () => {
    const w = world();
    const c = client(w.config, 0);
    const ensure = vi.spyOn(c, "ensureRunning");
    vi.spyOn(c, "answeringWorkbench").mockResolvedValue({ line: "Workbench PID 1 has this project open." });
    const r = await launchTool(w.config, c)({ gprojPath: w.gproj, addonsDirs: [w.mission] });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("addonsDirs was not applied");
    expect(ensure).not.toHaveBeenCalled();
    expect(sys.spawned).toEqual([]);
    const plain = await launchTool(w.config, c)({ gprojPath: w.gproj });
    expect(plain.content[0].text).not.toContain("addonsDirs was not applied");
  });

  it("says addonsDirs was not applied when the client finds Workbench up at the start of the launch", async () => {
    const w = world();
    const c = client(w.config, 0);
    vi.spyOn(c, "answeringWorkbench").mockResolvedValue({ line: "same project" });
    expect(await c.ensureRunning(w.gproj, false, undefined, [w.mission])).toContain("addonsDirs was not applied");
    expect(await c.ensureRunning(w.gproj)).toBeUndefined();
    expect(sys.spawned).toEqual([]);
  });

  it("a call that joins a launch already in flight starts nothing and says addonsDirs was not applied", async () => {
    const w = world();
    const c = client(w.config, 1);
    const first = c.ensureRunning(w.gproj, false, undefined, [w.mission]);
    const second = c.ensureRunning(w.gproj, false, undefined, [fresh()]);
    const joined = await Promise.all([first, second]);
    expect(joined[0] ?? "").not.toContain("addonsDirs was not applied");
    expect(joined[1]).toContain("addonsDirs was not applied");
    expect(sys.spawned.length).toBe(1);
    expect(addonsDirArg(sys.spawned[0])).toBe(w.mission);
  });
});

describe("mod addonsDirs", () => {
  it.each([["compile", 1], ["pack", 1], ["build", 2]])("%s runs Workbench with the call's folders in place of the configured ones", async (action, runs) => {
    const w = world();
    const outputPath = join(w.base, "out");
    const refused = await modTool(w.config)({ action, gprojPath: w.gproj, outputPath });
    expect(refused.content[0].text).toMatch(/Refused: addon GUID AAAAAAAAAAAAAAAA[\s\S]*pass addonsDirs with/);
    expect(sys.spawned).toEqual([]);

    const extra = fresh();
    await modTool(w.config)({ action, gprojPath: w.gproj, outputPath, addonsDirs: [w.mission, extra] });
    expect(sys.spawned.length).toBe(runs);
    for (const args of sys.spawned) expect(addonsDirArg(args)).toBe(`${w.mission},${extra}`);
  });

  it("runWorkbench, compileAddon and packAddon take the folders; without them the configured ones", async () => {
    const w = world();
    await runWorkbench(w.config, ["-wbSilent"], 5000, [w.mission]);
    await compileAddon(w.config, w.gproj, undefined, [w.mission]);
    await packAddon(w.config, w.gproj, join(w.base, "out"), undefined, [w.mission]);
    expect(sys.spawned.map(addonsDirArg)).toEqual([w.mission, w.mission, w.mission]);
    sys.spawned = [];
    await runWorkbench(w.config, ["-wbSilent"], 5000, []);
    await runWorkbench({ ...w.config, addonsDir: undefined } as Config, ["-wbSilent"], 5000);
    expect(sys.spawned[0]).toContain(w.projects);
    expect(sys.spawned[1]).not.toContain("-addonsDir");
  });

  it("refuses a pack output inside one of the call's folders, and a bad folder, before Workbench starts", async () => {
    const w = world();
    const outputPath = join(w.mission, "packed");
    const r = await modTool(w.config)({ action: "pack", gprojPath: w.gproj, outputPath, addonsDirs: [w.mission] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/outputPath is inside an addons dir/);
    expect(existsSync(outputPath)).toBe(false);
    const bad = await modTool(w.config)({ action: "compile", gprojPath: w.gproj, addonsDirs: ["relative/dir"] });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toBe("addonsDirs must be existing absolute folders without quotes or commas: relative/dir");
    expect(sys.spawned).toEqual([]);
  });

  it("checkPackOutput counts the call's folders next to the configured ones", () => {
    const w = world();
    const extra = fresh();
    const out = join(extra, "packed");
    expect(checkPackOutput(w.config, w.opened, G, out)).toBeNull();
    expect(checkPackOutput(w.config, w.opened, G, out, false, [extra])).toMatch(/inside an addons dir/);
    expect(checkPackOutput(w.config, w.opened, G, join(w.projects, "x"), false, [extra])).toMatch(/inside an addons dir/);
  });
});

describe("the launched .gproj and mod compile without a path", () => {
  it("refuses after a launch of a copy outside the project path, and compiles a path-less launch under it", async () => {
    const w = world();
    const config = { ...w.config } as Config;
    await launchTool(config, client(config))({ gprojPath: w.gproj, addonsDirs: [w.mission] });
    expect(config.defaultMod).toBe("Base"); // unchanged: the folder name, which is also the projects copy's
    expect(config.launchedGproj).toBe(resolve(w.gproj));
    const launches = sys.spawned.length;

    const r = await modTool(config)({ action: "compile" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(resolve(w.gproj));
    expect(r.content[0].text).toContain("Pass gprojPath");
    expect(sys.spawned.length).toBe(launches);

    // a path, or the addon name, still works
    await modTool(config)({ action: "compile", gprojPath: w.gproj, addonsDirs: [w.mission] });
    expect(sys.spawned.length).toBe(launches + 1);
  });

  it("keeps today's behaviour for an addon directly under the project path", async () => {
    const w = world();
    const lone = addon(w.projects, "Lone", OTHER);
    const config = { ...w.config, addonsDir: undefined } as Config;
    await launchTool(config, client(config))({ gprojPath: gprojOf(lone) });
    expect(config.launchedGproj).toBe(resolve(gprojOf(lone)));
    const r = await modTool(config)({ action: "compile" });
    expect(r.isError).toBeUndefined();
    expect(sys.spawned.length).toBe(2);
  });

  it("is cleared by a fresh launch without a path, kept when a running Workbench is shared", async () => {
    const config = { launchedGproj: "C:\\m\\A\\addon.gproj" } as Config;
    const c = new WorkbenchClient("127.0.0.1", 1);
    c.ping = async () => true;
    c.answeringWorkbench = async () => ({ line: "shared" });
    await launchTool(config, c)({});
    expect(config.launchedGproj).toBe("C:\\m\\A\\addon.gproj");
    c.ping = async () => false;
    c.ensureRunning = async () => undefined;
    await launchTool(config, c)({});
    expect(config.launchedGproj).toBeUndefined();
  });
});
