import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";

// No Workbench counts as running; the temp Tools folder has no exe, so nothing is ever spawned.
vi.mock("../../src/utils/process.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/utils/process.js")>()),
  findPids: vi.fn(() => []),
}));
// The guide's Documents\My Games folder is a temp folder, never the real one.
const myGames = mkdtempSync(join(tmpdir(), "emcp-mrp-mygames-"));
vi.mock("../../src/utils/game-paths.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/utils/game-paths.js")>()),
  myGamesDir: () => myGames,
}));
const { isProtectedAddon, protectedAddonOf, resolveWriteAddon } = await import("../../src/utils/game-paths.js");
const { forbiddenRoot } = await import("../../src/utils/safe-path.js");
const { WorkbenchClient } = await import("../../src/workbench/client.js");
const { registerWbLaunch } = await import("../../src/tools/wb-launch.js");

const hasGit = spawnSync("git", ["--version"]).status === 0;
const git = (dir: string, ...a: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=", ...a], { encoding: "utf-8" });

const BASE_GUID = "AAAAAAAAAAAAAAAA";
const DEP_GUID = "BBBBBBBBBBBBBBBB";
const gproj = (id: string, guid: string) => `GameProject {\n ID "${id}"\n GUID "${guid}"\n}\n`;
const H = join("Scripts", "WorkbenchGame", "EnfusionMCP");
const bundled = fileURLToPath(new URL("../../mod/Scripts/WorkbenchGame/EnfusionMCP", import.meta.url));
const snap = (dir: string) => readdirSync(dir).sort().map((f) => `${f}:${readFileSync(join(dir, f)).toString("base64")}`).join("|");
const status = (dir: string) => git(dir, "--no-optional-locks", "status", "--porcelain", "--untracked-files=all");
type Result = { content: { text: string }[]; isError?: boolean };

const made: string[] = [myGames];
afterEach(() => { for (const d of made.splice(1)) rmSync(d, { recursive: true, force: true }); });

/**
 * A mission root: a protected clone, a git worktree of it, and a junction to a second protected addon.
 *   projects/BaseAddon (git clone, GUID BASE)    mission-roots/M1/BaseAddon (worktree)
 *   projects/DepAddon (GUID DEP)                 mission-roots/M1/DepAddon (junction to it)
 */
function setup(protectedAddons = [BASE_GUID, DEP_GUID]) {
  const root = mkdtempSync(join(tmpdir(), "emcp-mrp-"));
  made.push(root);
  const projects = join(root, "projects");
  const base = join(projects, "BaseAddon");
  const dep = join(projects, "DepAddon");
  const mission = join(root, "mission-roots", "M1");
  mkdirSync(base, { recursive: true });
  mkdirSync(dep, { recursive: true });
  mkdirSync(mission, { recursive: true });
  writeFileSync(join(base, "addon.gproj"), gproj("BaseAddon", BASE_GUID));
  writeFileSync(join(dep, "addon.gproj"), gproj("DepAddon", DEP_GUID));
  git(base, "init", "-q");
  git(base, "add", "-A");
  git(base, "commit", "-q", "--no-verify", "-m", "init");
  const worktree = join(mission, "BaseAddon");
  git(base, "worktree", "add", "-q", "-b", "mission/M1", worktree);
  const junction = join(mission, "DepAddon");
  symlinkSync(dep, junction, "junction");
  const config = { projectPath: projects, workbenchPath: join(root, "tools"), protectedAddons } as Config;
  const client = new WorkbenchClient("127.0.0.1", 1, config);
  client.worldProbe.netstat = async () => ""; // no real netstat
  const tools: Record<string, (a: Record<string, unknown>) => Promise<Result>> = {};
  registerWbLaunch({ registerTool: (n: string, _d: unknown, h: (a: Record<string, unknown>) => Promise<Result>) => { tools[n] = h; } } as unknown as McpServer, config, client);
  return { root, projects, base, dep, mission, worktree, junction, config, client, tools };
}

describe.skipIf(!hasGit)("protection holds for a git worktree and a junction (mission root)", { timeout: 30_000 }, () => {
  it("isProtectedAddon: the worktree's .gproj and the one reached through the junction are protected by GUID", () => {
    const s = setup();
    expect(isProtectedAddon(s.config, join(s.worktree, "addon.gproj"))).toBe(true);
    expect(isProtectedAddon(s.config, join(s.junction, "addon.gproj"))).toBe(true);
    const unlisted = setup([]);
    expect(isProtectedAddon(unlisted.config, join(unlisted.worktree, "addon.gproj"))).toBe(false);
    expect(isProtectedAddon(unlisted.config, join(unlisted.junction, "addon.gproj"))).toBe(false);
  });

  it("protectedAddonOf: the worktree folder for a file inside it, the junction folder (not its target) through the junction", () => {
    const s = setup();
    expect(protectedAddonOf(s.config, join(s.worktree, "Scripts", "Game", "New.c"))).toBe(resolve(s.worktree));
    expect(protectedAddonOf(s.config, join(s.junction, "Prefabs", "New.et"))).toBe(resolve(s.junction));
    expect(protectedAddonOf(setup([]).config, join(s.worktree, "Scripts", "Game", "New.c"))).toBeNull();
  });

  it("resolveWriteAddon refuses projectPath = the worktree, and = the junction (GUID read through it)", () => {
    const s = setup();
    const wt = resolveWriteAddon(s.config, { projectPath: s.worktree });
    expect(wt).toMatchObject({ error: expect.stringContaining(`GUID ${BASE_GUID}) is protected`) });
    const jn = resolveWriteAddon(s.config, { projectPath: s.junction });
    expect(jn).toMatchObject({ error: expect.stringContaining(`GUID ${DEP_GUID}) is protected`) });
    const open = setup([]); // the same folders with nothing listed resolve, so the refusal above is the protection
    expect(resolveWriteAddon(open.config, { projectPath: open.worktree })).toMatchObject({ dir: resolve(open.worktree) });
    expect(resolveWriteAddon(open.config, { projectPath: open.junction })).toMatchObject({ dir: resolve(open.junction) });
  });

  it("wb_launch on the worktree .gproj without handlers is refused and writes nothing", async () => {
    const s = setup();
    vi.spyOn(s.client, "ping").mockResolvedValue(false);
    const r = await s.tools.wb_launch({ gprojPath: join(s.worktree, "addon.gproj") });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/protected addon .*without the MCP handler scripts, and wb_launch never writes into it/);
    expect(existsSync(join(s.worktree, "Scripts"))).toBe(false);
    expect(existsSync(join(s.projects, "EnfusionMCP"))).toBe(false);
    expect(status(s.worktree)).toBe("");
    expect(status(s.base)).toBe("");
  });

  it("wb_cleanup refuses the worktree and keeps its handlers and the owner's scripts", async () => {
    const s = setup();
    const dir = join(s.worktree, H);
    cpSync(bundled, dir, { recursive: true });
    writeFileSync(join(dir, "SYK_Own.c"), "// owner\n");
    const before = snap(dir);
    const r = await s.tools.wb_cleanup({ modDir: s.worktree });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/protected addon .*kept/);
    expect(snap(dir)).toBe(before);
    expect(() => s.client.cleanupHandlerScripts(s.worktree)).toThrow(/protected/);
    expect(snap(dir)).toBe(before);
  });

  it("a junction in a mission root whose target is in a forbidden root (Workshop cache) is refused by forbiddenRoot, resolveWriteAddon and wb_handlers install", async () => {
    const s = setup();
    const workshop = join(s.root, "workshop");
    const target = join(workshop, "5AB1C2D3E4F50617", "Cached");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "addon.gproj"), gproj("Cached", "CCCCCCCCCCCCCCCC"));
    const link = join(s.mission, "Cached");
    symlinkSync(target, link, "junction");
    s.config.workshopPath = workshop;
    expect(forbiddenRoot(s.config, link)).toBe(workshop);
    expect(forbiddenRoot(s.config, join(link, "addon.gproj"))).toBe(workshop);
    expect(forbiddenRoot(s.config, s.worktree)).toBeNull(); // protected, but not a forbidden root
    expect(resolveWriteAddon(s.config, { projectPath: link })).toMatchObject({ error: expect.stringContaining("is inside") });
    const r = await s.tools.wb_handlers({ action: "install", gprojPath: join(link, "addon.gproj") });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Refused: .* is inside .*workshop/);
    expect(existsSync(join(target, "Scripts"))).toBe(false);
  });
});
