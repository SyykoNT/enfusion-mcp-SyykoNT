import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
