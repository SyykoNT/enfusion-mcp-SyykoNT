import { describe, it, expect, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";

// No Workbench counts as running; the temp Tools folder has no exe, so nothing is ever spawned.
vi.mock("../../src/utils/process.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/utils/process.js")>()),
  findPids: vi.fn(() => []),
}));
const { WorkbenchClient, excludeHandlersFromGit } = await import("../../src/workbench/client.js");

const LINE = "Scripts/WorkbenchGame/EnfusionMCP/";
const g = (dir: string, ...a: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=", ...a], { encoding: "utf-8" });

function setup(opts: { git?: boolean; protect?: boolean; sub?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "emcp-gx-"));
  const projects = join(root, "projects");
  const repo = join(projects, "MyMission");
  const addon = opts.sub ? join(repo, opts.sub) : repo;
  mkdirSync(addon, { recursive: true });
  writeFileSync(join(addon, "addon.gproj"), `GameProject {\n ID "MyMission"\n GUID "2222222222222222"\n}\n`);
  if (opts.git !== false) {
    g(repo, "init", "-q");
    g(repo, "add", "-A");
    g(repo, "commit", "-q", "--no-verify", "-m", "init");
  }
  const config = {
    projectPath: projects,
    workbenchPath: join(root, "tools"),
    protectedAddons: opts.protect ? ["2222222222222222"] : [],
  } as Config;
  const handlerDir = join(addon, "Scripts", "WorkbenchGame", "EnfusionMCP");
  const handlers = () => (existsSync(handlerDir) ? readdirSync(handlerDir).filter((f) => f.startsWith("EMCP_")) : []);
  const excludeFile = () => join(repo, ".git", "info", "exclude");
  const lines = () => (existsSync(excludeFile()) ? readFileSync(excludeFile(), "utf-8").split(/\r?\n/).filter((l) => l.endsWith(LINE)) : []);
  return { repo, addon, config, handlers, lines, excludeFile, client: new WorkbenchClient("127.0.0.1", 1, config) };
}
const launch = (s: ReturnType<typeof setup>) => s.client.ensureRunning(join(s.addon, "addon.gproj"));

describe("wb_launch keeps the handlers out of a git addon's commits", () => {
  it("adds the folder to .git/info/exclude once, and git status shows no handler files", async () => {
    const s = setup();
    await expect(launch(s)).rejects.toThrow(/Cannot find/); // handlers copied, then no exe
    expect(s.handlers().length).toBeGreaterThan(20);
    expect(s.lines()).toEqual([LINE]);
    expect(g(s.repo, "status", "--short")).toBe("");
    await expect(launch(s)).rejects.toThrow(/Cannot find/);
    expect(s.lines()).toEqual([LINE]);
    expect(excludeHandlersFromGit(s.addon)).toBeUndefined(); // already ignored: no note
  });

  it("reports what it did", () => {
    const s = setup();
    expect(excludeHandlersFromGit(s.addon)).toMatch(/^Added Scripts\/WorkbenchGame\/EnfusionMCP\/ to .*exclude \(local, not committed\)/);
  });

  it("an addon in a subfolder of the repo gets a line relative to the repo root", async () => {
    const s = setup({ sub: "Addons/Mine" });
    await expect(launch(s)).rejects.toThrow(/Cannot find/);
    expect(s.lines()).toEqual([`Addons/Mine/${LINE}`]);
    expect(g(s.repo, "status", "--short")).toBe("");
  });

  it("a git worktree writes to the common info/exclude", () => {
    const s = setup();
    const wt = join(s.repo, "..", "MyMission-wt");
    g(s.repo, "worktree", "add", "-q", "-b", "wt", wt);
    expect(excludeHandlersFromGit(wt)).toMatch(/Added/);
    expect(s.lines()).toEqual([LINE]);
    mkdirSync(join(wt, LINE), { recursive: true });
    writeFileSync(join(wt, LINE, "EMCP_WB_Ping.c"), "");
    expect(g(wt, "status", "--short")).toBe("");
  });

  it("refuses when handler files are committed, and copies nothing", async () => {
    const s = setup();
    mkdirSync(join(s.addon, LINE), { recursive: true });
    writeFileSync(join(s.addon, LINE, "EMCP_WB_Ping.c"), "");
    g(s.repo, "add", "-A");
    g(s.repo, "commit", "-q", "--no-verify", "-m", "oops");
    await expect(launch(s)).rejects.toThrow(/committed in this repo.*git rm -r --cached/);
    expect(s.handlers()).toEqual(["EMCP_WB_Ping.c"]);
    expect(s.lines()).toEqual([]);
  });

  it("refuses when the exclude file cannot be written, and copies nothing", async () => {
    const s = setup();
    rmSync(s.excludeFile(), { force: true });
    mkdirSync(s.excludeFile(), { recursive: true }); // a folder where the file should be
    await expect(launch(s)).rejects.toThrow(/could not write .*by hand/);
    expect(s.handlers()).toEqual([]);
  });

  it("leaves a non-git addon as before", async () => {
    const s = setup({ git: false });
    expect(excludeHandlersFromGit(s.addon)).toBeUndefined();
    await expect(launch(s)).rejects.toThrow(/Cannot find/);
    expect(s.handlers().length).toBeGreaterThan(20);
    expect(existsSync(join(s.repo, ".git"))).toBe(false);
  });

  it("leaves a protected addon untouched (no exclude line, nothing copied)", async () => {
    const s = setup({ protect: true });
    mkdirSync(join(s.addon, LINE), { recursive: true });
    writeFileSync(join(s.addon, LINE, "EMCP_WB_Ping.c"), "// by hand\n");
    const before = existsSync(s.excludeFile()) ? readFileSync(s.excludeFile(), "utf-8") : null;
    await expect(launch(s)).rejects.toThrow(/Cannot find/);
    expect(existsSync(s.excludeFile()) ? readFileSync(s.excludeFile(), "utf-8") : null).toBe(before);
    expect(s.handlers()).toEqual(["EMCP_WB_Ping.c"]);
  });
});

describe("wb_launch reply", () => {
  it("passes on the exclude note", async () => {
    const { registerWbLaunch } = await import("../../src/tools/wb-launch.js");
    const s = setup();
    vi.spyOn(s.client, "ping").mockResolvedValue(false);
    vi.spyOn(s.client, "ensureRunning").mockResolvedValue("Added Scripts/WorkbenchGame/EnfusionMCP/ to x/.git/info/exclude (local, not committed)"); // never starts a real Workbench
    const tools: Record<string, (a: Record<string, unknown>) => Promise<{ content: { text: string }[] }>> = {};
    registerWbLaunch({ registerTool: (n: string, _d: unknown, h: (typeof tools)[string]) => { tools[n] = h; } } as never, s.config, s.client);
    const r = await tools.wb_launch({ gprojPath: join(s.addon, "addon.gproj") });
    expect(r.content[0].text).toMatch(/Added Scripts\/WorkbenchGame\/EnfusionMCP\/ to .*local, not committed/);
  });
});

describe.skipIf(spawnSync("git", ["--version"]).status !== 0)("wb_handlers on a protected git worktree (mission root)", { timeout: 30_000 }, () => {
  type Result = { content: { text: string }[]; isError?: boolean };
  const tree = (dir: string) => readdirSync(dir, { recursive: true }).map(String).filter((f) => !/^\.git([\\/]|$)/.test(f)).sort();
  // The clone commits the owner's own script in the handler folder (as CRF does), then a worktree of it sits in a mission-roots folder.
  async function mission(ignore?: "exclude" | "gitignore") {
    const { registerWbLaunch } = await import("../../src/tools/wb-launch.js");
    const s = setup({ protect: true });
    mkdirSync(join(s.repo, LINE), { recursive: true });
    writeFileSync(join(s.repo, LINE, "SYK_Own.c"), "// owner\n");
    if (ignore === "gitignore") writeFileSync(join(s.repo, ".gitignore"), `${LINE}EMCP_*\n`);
    g(s.repo, "add", "-A");
    g(s.repo, "commit", "-q", "--no-verify", "-m", "owner script");
    if (ignore === "exclude") writeFileSync(s.excludeFile(), `${readFileSync(s.excludeFile(), "utf-8")}${LINE}\n`);
    const dir = join(s.repo, "..", "..", "mission-roots", "M1");
    mkdirSync(dir, { recursive: true });
    const wt = join(dir, "MyMission");
    g(s.repo, "worktree", "add", "-q", "-b", "mission/M1", wt);
    const tools: Record<string, (a: Record<string, unknown>) => Promise<Result>> = {};
    registerWbLaunch({ registerTool: (n: string, _d: unknown, h: (typeof tools)[string]) => { tools[n] = h; } } as never, s.config, s.client);
    return { s, wt, gprojPath: join(wt, "addon.gproj"), handlers: (a: string) => tools.wb_handlers({ action: a, gprojPath: join(wt, "addon.gproj") }) };
  }

  it("install writes only EMCP_* files, puts the exclude line in the main clone's shared info/exclude, and leaves both work trees clean", async () => {
    const m = await mission();
    const wtBefore = tree(m.wt);
    const mainBefore = tree(m.s.repo);
    const own = readFileSync(join(m.wt, LINE, "SYK_Own.c"), "utf-8");
    const r = await m.handlers("install");
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/Handlers installed\*\* in .*\(protected\)[\s\S]*Added .*\(local, not committed\)/);
    const after = tree(m.wt);
    const added = after.filter((f) => !wtBefore.includes(f));
    expect(added.length).toBeGreaterThan(20);
    expect(added.every((f) => /^Scripts[\\/]WorkbenchGame[\\/]EnfusionMCP[\\/]EMCP_[^\\/]+\.c$/.test(f))).toBe(true);
    expect(wtBefore.filter((f) => !after.includes(f))).toEqual([]);
    expect(readFileSync(join(m.wt, LINE, "SYK_Own.c"), "utf-8")).toBe(own);
    expect(tree(m.s.repo)).toEqual(mainBefore);
    expect(statSync(join(m.wt, ".git")).isFile()).toBe(true); // a worktree: its own .git is a pointer file
    expect(m.s.lines()).toEqual([LINE]);
    expect(g(m.wt, "status", "--porcelain")).toBe("");
    expect(g(m.s.repo, "status", "--porcelain")).toBe("");
  });

  it.each(["exclude", "gitignore"] as const)("adds no line when the main clone already ignores the handlers (%s)", async (how) => {
    const m = await mission(how);
    const r = await m.handlers("install");
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/Git: ignored by git: yes; tracked handler files: none/);
    expect(m.s.lines()).toEqual(how === "exclude" ? [LINE] : []);
    expect(g(m.wt, "status", "--porcelain")).toBe("");
    expect(g(m.s.repo, "status", "--porcelain")).toBe("");
  });

  it("refuses when a handler file is tracked on the worktree's branch, and copies nothing", async () => {
    const m = await mission();
    writeFileSync(join(m.wt, LINE, "EMCP_WB_Ping.c"), "");
    g(m.wt, "add", "-A");
    g(m.wt, "commit", "-q", "--no-verify", "-m", "oops");
    const r = await m.handlers("install");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/committed in this repo.*git rm -r --cached/);
    expect(readdirSync(join(m.wt, LINE)).sort()).toEqual(["EMCP_WB_Ping.c", "SYK_Own.c"]);
    expect(m.s.lines()).toEqual([]);
  });

  it("status works on it and writes nothing", async () => {
    const m = await mission();
    const before = tree(m.wt);
    const r = await m.handlers("status");
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/Handler status\*\* for .*\(protected\)/);
    expect(r.content[0].text).toMatch(/- git: ignored by git: no; tracked handler files: none/);
    expect(tree(m.wt)).toEqual(before);
    expect(m.s.lines()).toEqual([]);
  });
});
