import { describe, it, expect, vi, beforeEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import type { SearchEngine } from "../../src/index/search-engine.js";
import type { PatternLibrary } from "../../src/patterns/loader.js";

// A fake home first: instance files, the mission_server run folder and the Workbench profile land in temp folders.
const home = mkdtempSync(join(tmpdir(), "emcp-dup-home-"));
process.env.USERPROFILE = process.env.HOME = home;

// Nothing real starts: spawn and spawnDetached are recorded stubs, no Workbench or server counts as running, compile and pack are stubs.
const sys = vi.hoisted(() => ({ spawned: [] as string[][], detached: [] as string[][] }));
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn: vi.fn((_exe: string, args: string[]) => {
    sys.spawned.push(args);
    return { pid: 4242, unref: () => {}, on: () => {} };
  }),
}));
vi.mock("../../src/utils/process.js", async (orig) => ({
  ...(await orig<typeof import("../../src/utils/process.js")>()),
  findPids: () => [],
  workbenchCommandLines: () => [],
  serverProcesses: () => [],
  clientProcesses: () => [],
  spawnDetached: (_exe: string, args: string[]) => {
    sys.detached.push(args);
    return 777;
  },
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
vi.mock("../../src/workbench/cli.js", async (orig) => ({
  ...(await orig<typeof import("../../src/workbench/cli.js")>()),
  compileAddon: vi.fn(),
  packAddon: vi.fn(),
}));

const { duplicateAddonError } = await import("../../src/pak/stack.js");
const cli = await import("../../src/workbench/cli.js");
const { WorkbenchClient } = await import("../../src/workbench/client.js");
const { registerMod } = await import("../../src/tools/mod.js");
const { registerMissionServer, MISSION_ROOT } = await import("../../src/tools/mission-server.js");

type Result = { content: { text: string }[]; isError?: boolean };

const tmp = mkdtempSync(join(tmpdir(), "emcp-dup-"));
let n = 0;
const fresh = () => {
  const d = join(tmp, `t${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const gprojText = (id: string, guid: string, deps: string[] = []) =>
  `GameProject {\n ID "${id}"\n GUID "${guid}"\n${deps.length ? ` Dependencies {\n  ${deps.map((d) => `"${d}"`).join(" ")}\n }\n` : ""}}\n`;
/** An unpacked addon folder `<parent>/<name>`; returns the folder. */
function addon(parent: string, name: string, guid: string, deps: string[] = [], id = name): string {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "addon.gproj"), gprojText(id, guid, deps));
  return dir;
}
const gprojOf = (dir: string) => join(dir, "addon.gproj");

const G = "AAAAAAAAAAAAAAAA";
const DEP = "BBBBBBBBBBBBBBBB";
const MID = "CCCCCCCCCCCCCCCC";

describe("duplicateAddonError", () => {
  it("refuses an opened addon whose GUID is also in a listed folder, and names the GUID, both folders and the fix", () => {
    const base = fresh();
    const projects = join(base, "projects"), mission = join(base, "mission");
    const copy = addon(projects, "Base", G);
    const opened = addon(mission, "Base", G);
    const err = duplicateAddonError([gprojOf(opened)], [projects]);
    expect(err).toContain(G);
    expect(err).toContain(copy);
    expect(err).toContain(opened);
    expect(err).toMatch(/set ENFUSION_ADDONS_DIR to the folder that holds only the copy you want \(for example .*mission\)/);
    expect(duplicateAddonError([gprojOf(opened)], [projects], { via: "addonsDirs" })).toMatch(/pass addonsDirs with the folder that holds only the copy/);
  });

  it("refuses a dependency with two copies, also two levels down, but not an unrelated addon", () => {
    const base = fresh();
    const projects = join(base, "projects"), mission = join(base, "mission");
    addon(projects, "Dep", DEP);
    addon(mission, "Dep", DEP);
    addon(mission, "Mid", MID, [DEP]);
    const opened = addon(mission, "App", G, [MID]);
    expect(duplicateAddonError([gprojOf(opened)], [projects, mission])).toContain(DEP);
    const lone = addon(mission, "Lone", "DDDDDDDDDDDDDDDD");
    expect(duplicateAddonError([gprojOf(lone)], [projects, mission])).toBeNull(); // Dep's two copies are not Lone's business
  });

  it("checks every addon ID passed in ids, resolved in the folder set", () => {
    const base = fresh();
    const a = join(base, "a"), b = join(base, "b");
    addon(a, "Extra", DEP);
    addon(b, "Extra", DEP);
    const opened = addon(a, "World", G);
    expect(duplicateAddonError([gprojOf(opened)], [a, b])).toBeNull();
    expect(duplicateAddonError([gprojOf(opened)], [a, b], { ids: ["extra"] })).toContain(DEP);
    expect(duplicateAddonError([gprojOf(opened)], [a, b], { ids: ["NoSuchId"] })).toBeNull();
  });

  describe("folder identity (an opened addon and the same folder listed are one folder)", () => {
    const setup = () => {
      const projects = join(fresh(), "projects");
      const opened = addon(projects, "CRF", G);
      return { projects, gproj: gprojOf(opened) };
    };

    it("the Boat Patrol shape: projects\\CRF opened with -addonsDir projects", () => {
      const { projects, gproj } = setup();
      expect(duplicateAddonError([gproj], [projects])).toBeNull();
    });
    it("a trailing separator on the listed folder", () => {
      const { projects, gproj } = setup();
      expect(duplicateAddonError([gproj], [projects + sep])).toBeNull();
    });
    it("forward slashes in the listed folder", () => {
      const { projects, gproj } = setup();
      expect(duplicateAddonError([gproj], [projects.replace(/\\/g, "/")])).toBeNull();
    });
    it("a lower-case or upper-case drive letter", () => {
      const { projects, gproj } = setup();
      const flip = (p: string) => (/^[a-z]:/i.test(p) ? (p[0] === p[0].toLowerCase() ? p[0].toUpperCase() : p[0].toLowerCase()) + p.slice(1) : p);
      expect(duplicateAddonError([flip(gproj)], [projects])).toBeNull();
      expect(duplicateAddonError([gproj], [flip(projects)])).toBeNull();
    });
    it("an 8.3 short spelling of the listed folder", () => {
      const parent = fresh();
      const long = join(parent, "Long Projects Folder");
      const gproj = gprojOf(addon(long, "CRF", G));
      const short = join(parent, "LONGPR~1");
      // Only where the PC makes 8.3 names (Windows with the default setting): the short path then names the same folder.
      if (!existsSync(short)) return;
      expect(realpathSync.native(short).toLowerCase()).toBe(realpathSync.native(long).toLowerCase());
      expect(duplicateAddonError([gproj], [short])).toBeNull();
      expect(duplicateAddonError([gprojOf(join(short, "CRF"))], [long])).toBeNull();
    });
    it("a listed folder given twice", () => {
      const { projects, gproj } = setup();
      expect(duplicateAddonError([gproj], [projects, projects + sep])).toBeNull();
    });
  });

  it("counts a junction and its target under two listed folders as two copies (unverified Workbench behaviour, the stricter default)", () => {
    const base = fresh();
    const projects = join(base, "projects"), mission = join(base, "mission");
    const lobby = addon(projects, "Lobby", DEP);
    mkdirSync(mission, { recursive: true });
    symlinkSync(lobby, join(mission, "Lobby"), "junction");
    const opened = addon(mission, "App", G, [DEP]);
    const err = duplicateAddonError([gprojOf(opened)], [projects, mission]);
    expect(err).toContain(DEP);
    expect(err).toContain(join(mission, "Lobby"));
    expect(duplicateAddonError([gprojOf(opened)], [mission])).toBeNull(); // the intended use: the junction alone
  });

  describe("not refused", () => {
    it("an opened addon outside every listed folder with no second copy (test addons)", () => {
      const base = fresh();
      const opened = addon(join(base, "test-addons"), "T", G);
      const projects = join(base, "projects");
      addon(projects, "Other", DEP);
      expect(duplicateAddonError([gprojOf(opened)], [projects])).toBeNull();
      expect(duplicateAddonError([gprojOf(opened)], [])).toBeNull();
    });

    it("a Workshop download of the same GUID in a listed folder", () => {
      const base = fresh();
      const projects = join(base, "projects"), cache = join(base, "workshop");
      const opened = addon(projects, "Base", G);
      const dl = addon(cache, "Base_AAAAAAAAAAAAAAAA", G);
      writeFileSync(join(dl, "ServerData.json"), "{}");
      expect(duplicateAddonError([gprojOf(opened)], [projects, cache])).toBeNull();
      // A dependency too
      const dep = addon(cache, "Dep_BBBBBBBBBBBBBBBB", DEP);
      writeFileSync(join(dep, "ServerData.json"), "{}");
      addon(projects, "Dep", DEP);
      const app = addon(projects, "App", MID, [DEP]);
      expect(duplicateAddonError([gprojOf(app)], [projects, cache])).toBeNull();
    });

    it("an unrelated duplicate GUID in the listed folders", () => {
      const base = fresh();
      const projects = join(base, "projects");
      addon(projects, "Old", DEP);
      addon(projects, "Copy", DEP);
      const opened = addon(projects, "App", G);
      expect(duplicateAddonError([gprojOf(opened)], [projects])).toBeNull();
    });
  });

  it("refuses a packed build of the same GUID in a listed folder", () => {
    const base = fresh();
    const packs = join(base, "packs"), src = join(base, "src");
    const opened = addon(src, "Base", G);
    const packed = join(packs, "Base");
    mkdirSync(packed, { recursive: true });
    writeFileSync(join(packed, "Base.gproj"), gprojText("Base", G));
    writeFileSync(join(packed, "data.pak"), "");
    const err = duplicateAddonError([gprojOf(opened)], [packs]);
    expect(err).toContain(G);
    expect(err).toContain(packed);
  });
});

describe("addonsDirsError", () => {
  it("returns the message mission_server gave for a bad folder, and null for good ones", () => {
    const d = fresh();
    expect(cli.addonsDirsError([d])).toBeNull();
    for (const bad of ["relative/dir", join(d, "missing"), `${d}"x`, `${d},x`, `${d}\nx`]) {
      expect(cli.addonsDirsError([d, bad])).toBe(`addonsDirs must be existing absolute folders without quotes or commas: ${bad}`);
    }
  });
});

// One shape for every tool: the addon is opened from a "mission root"; the configured -addonsDir ("projects") holds a second copy.
function twoCopies() {
  const base = fresh();
  const projects = join(base, "projects"), mission = join(base, "mission");
  addon(projects, "Base", G);
  const opened = addon(mission, "Base", G);
  return { base, projects, mission, opened, gproj: gprojOf(opened) };
}
const handlers = (dir: string) => existsSync(join(dir, "Scripts", "WorkbenchGame", "EnfusionMCP"));

beforeEach(() => {
  sys.spawned = [];
  sys.detached = [];
  vi.mocked(cli.compileAddon).mockReset();
  vi.mocked(cli.packAddon).mockReset();
});

describe("wb_launch (launchWorkbench) refuses two copies before writing or starting anything", () => {
  it("writes no handler folder and spawns nothing", async () => {
    const t = twoCopies();
    const config = { projectPath: t.projects, addonsDir: t.projects, workbenchPath: join(home, "Tools") } as Config;
    const client = new WorkbenchClient("127.0.0.1", 1, config);
    vi.spyOn(client as unknown as { rawCall: () => Promise<unknown> }, "rawCall").mockRejectedValueOnce(new Error("refused")).mockResolvedValue({});
    await expect(client.ensureRunning(t.gproj)).rejects.toThrow(/Refused: addon GUID AAAAAAAAAAAAAAAA/);
    expect(handlers(t.opened)).toBe(false);
    expect(existsSync(join(t.mission, "EnfusionMCP"))).toBe(false);
    expect(sys.spawned).toEqual([]);
    expect(sys.detached).toEqual([]);
  });
});

describe("mod build, compile and pack refuse two copies before Workbench starts", () => {
  it.each(["build", "compile", "pack"])("%s", async (action) => {
    const t = twoCopies();
    const config = { projectPath: t.mission, addonsDir: t.projects, packedPath: join(t.base, "packed"), gamePath: join(t.base, "game"), workbenchPath: join(home, "Tools") } as Config;
    let mod!: (a: Record<string, unknown>) => Promise<Result>;
    registerMod({ registerTool: (_n: string, _d: unknown, h: typeof mod) => { mod = h; } } as unknown as McpServer, config, {} as SearchEngine, {} as PatternLibrary);
    const outputPath = join(t.base, "out");
    const r = await mod({ action, gprojPath: t.gproj, outputPath });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Refused: addon GUID AAAAAAAAAAAAAAAA/);
    expect(cli.compileAddon).not.toHaveBeenCalled();
    expect(cli.packAddon).not.toHaveBeenCalled();
    expect(sys.spawned).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });
});

describe("mission_server start refuses two copies before anything is spawned", () => {
  function start(config: Config) {
    let tool!: (a: Record<string, unknown>) => Promise<Result>;
    registerMissionServer({ registerTool: (_n: string, _d: unknown, h: typeof tool) => { tool = h; } } as unknown as McpServer, config);
    return tool;
  }
  const world = (dir: string) => {
    mkdirSync(join(dir, "Worlds"), { recursive: true });
    const w = join(dir, "Worlds", "W.ent");
    writeFileSync(w, "");
    return w;
  };
  const config = (projectPath: string, addonsDir?: string) => ({ projectPath, addonsDir, serverPath: home, gamePath: home }) as unknown as Config;

  it("the world's addon appended by planRun counts: ENFUSION_ADDONS_DIR holds the other copy", async () => {
    const t = twoCopies();
    writeFileSync(join(home, "ArmaReforgerServerDiag.exe"), ""); // so a missing check would reach the spawn
    const r = await start(config(t.projects, t.projects))({ action: "start", world: world(t.opened), port: 2571, timeoutSec: 10 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Refused: addon GUID AAAAAAAAAAAAAAAA[\s\S]*pass addonsDirs with/);
    expect(sys.detached).toEqual([]);
    expect(existsSync(join(MISSION_ROOT, "2571"))).toBe(false);
  });

  it("every addon ID in addons is checked, not only the world's addon", async () => {
    const base = fresh();
    const a = join(base, "a"), b = join(base, "b");
    addon(a, "Extra", DEP);
    addon(b, "Extra", DEP);
    const opened = addon(a, "World", G);
    writeFileSync(join(home, "ArmaReforgerServerDiag.exe"), "");
    const r = await start(config(a))({ action: "start", world: world(opened), port: 2572, addons: ["World", "Extra"], addonsDirs: [a, b], timeoutSec: 10 });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain(DEP);
    expect(sys.detached).toEqual([]);
  });
});
