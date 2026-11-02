import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import { guardCheck, guardInstall, registerAddonGitGuard } from "../../src/tools/addon-git-guard.js";
import { COMMIT_MSG, HOOK_VERSION, STRIPPER_COMMIT_MSG, PRE_COMMIT } from "../../src/release/hooks.js";

const hasGit = spawnSync("git", ["--version"]).status === 0;
const hasSh = spawnSync("sh", ["-c", "exit 0"]).status === 0;

const root = mkdtempSync(join(tmpdir(), "emcp-guard-"));
const projects = join(root, "projects");
const g = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "pipe" });
const addon = (base: string, name: string, guid: string, opts: { git?: boolean; origin?: string } = {}) => {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "addon.gproj"), `GameProject {\n ID "${name.replace(/-/g, "")}"\n GUID "${guid}"\n}\n`);
  if (opts.git !== false && hasGit) {
    g(dir, "init", "-q");
    if (opts.origin) g(dir, "remote", "add", "origin", opts.origin);
  }
  return dir;
};
// gamePath inside the projects folder, so the forbidden-root refusal is reachable with a temp repo.
const config = { projectPath: projects, gamePath: join(projects, "GameInstall"), protectedAddons: ["5EB3564A02CE294F", "69EA43E490A50DBE"], githubOwners: ["syykont"] } as Config;

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
let call: Handler = async () => ({ content: [] });
const server = { registerTool: (_n: string, _d: unknown, h: Handler) => { call = h; } } as unknown as McpServer;
registerAddonGitGuard(server, config);

const hook = (dir: string, name: string) => join(dir, ".git", "hooks", name);

describe.skipIf(!hasGit)("addon_git_guard", { timeout: 30_000 }, () => {
  const syk = addon(projects, "SYK-Test", "1111111111111111", { origin: "https://github.com/SyykoNT/SYK-Test.git" });
  const crf = addon(projects, "Coalition-Reforger-Framework", "5EB3564A02CE294F", { origin: "https://github.com/CoalitionArma/Coalition-Reforger-Framework.git" });
  const lobby = addon(projects, "COALITION-Lobby", "69EA43E490A50DBE", { origin: "https://github.com/CoalitionArma/COALITION-Lobby.git" });
  const shared = addon(projects, "Shared", "2222222222222222", { origin: "https://github.com/CoalitionArma/x.git" });
  addon(projects, "NoGit", "3333333333333333", { git: false });
  const outside = addon(join(root, "outside"), "Addon", "4444444444444444");

  it("refuses check and install without a named addon (no default-mod fallback)", async () => {
    for (const action of ["check", "install"]) {
      const r = await call({ action });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/never falls back/);
    }
  });

  it("refuses CRF and Lobby (protected) and writes nothing", async () => {
    for (const [name, dir] of [["Coalition-Reforger-Framework", crf], ["COALITION-Lobby", lobby]]) {
      const r = await call({ action: "install", addonName: name, sharedRepoOk: true });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/protected/);
      expect(existsSync(hook(dir, "pre-commit")) || existsSync(hook(dir, "commit-msg"))).toBe(false);
    }
  });

  it("refuses repos outside the projects folder, by gprojPath or by a traversing addonName", async () => {
    for (const args of [{ gprojPath: join(outside, "addon.gproj") }, { addonName: "../outside/Addon" }]) {
      for (const action of ["check", "install"]) {
        const r = await call({ action, ...args });
        expect(r.isError).toBe(true);
        expect(r.content[0].text).toMatch(/outside the projects folder/);
      }
    }
    expect(existsSync(hook(outside, "pre-commit"))).toBe(false);
  });

  it("refuses an addon inside a forbidden root (install or Workshop cache) and writes nothing", async () => {
    const d = addon(projects, "GameInstall", "BBBBBBBBBBBBBBBB");
    for (const action of ["check", "install"]) {
      const r = await call({ action, addonName: "GameInstall" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/is inside .*GameInstall/);
    }
    expect(existsSync(hook(d, "pre-commit"))).toBe(false);
  });

  it("refuses an addon that is not its own git repo", async () => {
    const r = await call({ action: "install", addonName: "NoGit" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/not a git repository/);
  });

  it("refuses an origin whose owner is not in ENFUSION_GITHUB_OWNERS without sharedRepoOk, then installs with it", async () => {
    const r = await call({ action: "install", addonName: "Shared" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/shared repo.*Ask the user before installing.*Nothing written/s);
    expect(existsSync(hook(shared, "pre-commit"))).toBe(false);
    expect((await call({ action: "install", addonName: "Shared", sharedRepoOk: true })).isError).toBeFalsy();
    expect(readFileSync(hook(shared, "pre-commit"), "utf-8")).toBe(PRE_COMMIT);
  });

  it("treats an owner in githubOwners as own, over https and ssh, ignoring case; an unset list makes every origin shared", () => {
    const https = addon(projects, "OwnHttps", "AAAA000000000001", { origin: "https://github.com/SyykoNT/x.git" });
    const ssh = addon(projects, "OwnSsh", "AAAA000000000002", { origin: "git@github.com:syykont/x.git" });
    const owners = { githubOwners: ["SyykoNT"], hooks: ["pre-commit" as const] };
    expect(guardInstall(https, owners).ok).toBe(true);
    expect(guardInstall(ssh, owners).ok).toBe(true);

    const unset = addon(projects, "OwnUnset", "AAAA000000000003", { origin: "https://github.com/SyykoNT/x.git" });
    const r = guardInstall(unset, { hooks: ["pre-commit"] });
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toMatch(/shared repo/);
    expect(existsSync(hook(unset, "pre-commit"))).toBe(false);
    expect(guardInstall(unset, { hooks: ["pre-commit"], sharedRepoOk: true }).ok).toBe(true);
  });

  it("installs in a repo with no origin when githubOwners is unset", () => {
    const d = addon(projects, "NoOrigin", "AAAA000000000004");
    expect(guardInstall(d, { hooks: ["pre-commit"] }).ok).toBe(true);
  });

  it("refuses when core.hooksPath is set and writes nothing", () => {
    const d = addon(projects, "HooksPath", "5555555555555555");
    g(d, "config", "core.hooksPath", "elsewhere");
    expect(guardInstall(d).ok).toBe(false);
    expect(existsSync(hook(d, "pre-commit"))).toBe(false);
  });

  it("installs both hooks, LF and without a BOM, and a second install changes nothing", async () => {
    const first = await call({ action: "install", addonName: "SYK-Test" });
    expect(first.content[0].text).toMatch(/wrote .*pre-commit[\s\S]*wrote .*commit-msg/);
    const pre = readFileSync(hook(syk, "pre-commit"));
    expect(pre.toString("utf-8")).toBe(PRE_COMMIT);
    expect(pre[0]).toBe(0x23); // "#", no BOM
    expect(pre.includes(0x0d)).toBe(false);
    expect(readFileSync(hook(syk, "commit-msg"), "utf-8")).toBe(COMMIT_MSG);
    const second = await call({ action: "install", addonName: "SYK-Test" });
    expect(second.content[0].text).toBe(`pre-commit already v${HOOK_VERSION}\ncommit-msg already v${HOOK_VERSION}`);
  });

  it("leaves a foreign pre-commit alone and keeps the user's own commit-msg", () => {
    const d = addon(projects, "Foreign", "6666666666666666");
    writeFileSync(hook(d, "pre-commit"), "#!/bin/sh\necho lfs\n");
    const r = guardInstall(d);
    expect(r.ok).toBe(false);
    expect(r.lines[0]).toMatch(/foreign pre-commit.*Nothing written/);
    expect(readFileSync(hook(d, "pre-commit"), "utf-8")).toBe("#!/bin/sh\necho lfs\n");
    expect(existsSync(hook(d, "commit-msg"))).toBe(false);

    const d2 = addon(projects, "StripperHook", "7777777777777777");
    writeFileSync(hook(d2, "commit-msg"), STRIPPER_COMMIT_MSG);
    expect(guardInstall(d2).lines).toContain("kept commit-msg (attribution stripper); not ours, left alone");
    expect(readFileSync(hook(d2, "commit-msg"), "utf-8")).toBe(STRIPPER_COMMIT_MSG);
  });

  it("recognises a stripper hook written before the v3 comment wording", () => {
    const d = addon(projects, "OldStripper", "AAAA000000000005");
    const old = STRIPPER_COMMIT_MSG.replace(/^# Local hook.*$/m, "# Local hook (not tracked): strip Claude/Anthropic attribution so commits read as X only.");
    expect(old).not.toBe(STRIPPER_COMMIT_MSG);
    writeFileSync(hook(d, "commit-msg"), old);
    expect(guardInstall(d, { hooks: ["commit-msg"] }).lines).toContain("kept commit-msg (attribution stripper); not ours, left alone");
  });

  it("replaces an older version of our hook", () => {
    const d = addon(projects, "Upgrade", "8888888888888888");
    writeFileSync(hook(d, "pre-commit"), "#!/bin/sh\n# enfusion-mcp-syykont commit guard v0 (local hook, not tracked)\n");
    expect(guardInstall(d, { hooks: ["pre-commit"] }).lines[0]).toMatch(/replaced v0/);
    expect(readFileSync(hook(d, "pre-commit"), "utf-8")).toBe(PRE_COMMIT);
  });

  it("check reports staged handlers (G2) and BOM scripts (T1) without writing", () => {
    const d = addon(projects, "Check", "9999999999999999");
    mkdirSync(join(d, "Scripts", "WorkbenchGame", "EnfusionMCP"), { recursive: true });
    writeFileSync(join(d, "Scripts", "WorkbenchGame", "EnfusionMCP", "EMCP_WB_Ping.c"), "class X {}\n");
    writeFileSync(join(d, "Bom.c"), "﻿class B {}\n");
    g(d, "add", "-f", ".");
    expect(guardCheck(d).map((f) => `${f.id} ${f.path}`).sort()).toEqual(["G2 Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Ping.c", "T1 Bom.c"]);
  });

  it("status lists each repo with its hooks, ignore rule and handler count", async () => {
    const r = await call({ action: "status" });
    const text = r.content[0].text;
    expect(text).toMatch(/^SYK-Test: pre-commit ours v3; commit-msg ours v3; handlers ignored no; handler files on disk 0$/m);
    expect(text).toMatch(/^Foreign: pre-commit foreign \(#!\/bin\/sh\); commit-msg none;/m);
    expect(text).toMatch(/^StripperHook: pre-commit ours v3; commit-msg attribution stripper;/m);
    expect(text).not.toMatch(/^NoGit/m);
  });
});

describe.skipIf(!hasGit || !hasSh)("generated hooks in a real git commit", { timeout: 30_000 }, () => {
  const d = addon(projects, "Commit", "AAAAAAAAAAAAAAAA");
  guardInstall(d);
  const commit = (...a: string[]) => spawnSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", ...a], { encoding: "utf-8" });

  it("refuses a staged handler file and names the fix", () => {
    mkdirSync(join(d, "Scripts", "WorkbenchGame", "EnfusionMCP"), { recursive: true });
    writeFileSync(join(d, "Scripts", "WorkbenchGame", "EnfusionMCP", "EMCP_WB_Ping.c"), "class X {}\n");
    g(d, "add", "-f", "Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Ping.c");
    const r = commit("-m", "handler");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Ping.c");
    expect(r.stderr).toContain("commit guard: MCP handler files");
  });

  it("refuses a handler staged with a different path case, in check and in the hook", () => {
    const lc = addon(projects, "LowerCase", "CCCCCCCCCCCCCCCC");
    guardInstall(lc);
    mkdirSync(join(lc, "scripts", "workbenchgame", "enfusionmcp"), { recursive: true });
    writeFileSync(join(lc, "scripts", "workbenchgame", "enfusionmcp", "EMCP_WB_Ping.c"), "class X {}\n");
    g(lc, "add", "-f", "scripts/workbenchgame/enfusionmcp/EMCP_WB_Ping.c");
    expect(guardCheck(lc).map((f) => f.id)).toEqual(["G2"]);
    const r = spawnSync("git", ["-C", lc, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "lc"], { encoding: "utf-8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("scripts/workbenchgame/enfusionmcp/EMCP_WB_Ping.c");
  });

  it("lets --no-verify through (the documented bypass)", () => {
    expect(commit("--no-verify", "-m", "bypass").status).toBe(0);
  });

  it("refuses a BOM .c with a space in its path", () => {
    mkdirSync(join(d, "Scripts", "Game"), { recursive: true });
    writeFileSync(join(d, "Scripts", "Game", "My File.c"), "﻿class B {}\n");
    g(d, "add", "Scripts/Game/My File.c");
    const r = commit("-m", "bom");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("Scripts/Game/My File.c starts with a UTF-8 BOM");
    g(d, "restore", "--staged", "Scripts/Game/My File.c");
  });

  it("commits clean files and strips attribution lines", () => {
    writeFileSync(join(d, "Clean.c"), "class C {}\n");
    g(d, "add", "Clean.c");
    const r = commit("-m", "clean\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n");
    expect(r.status).toBe(0);
    expect(execFileSync("git", ["-C", d, "log", "-1", "--format=%B"], { encoding: "utf-8" }).trim()).toBe("clean");
  });
});
