import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitState, hooksDir, originUrl, stagedPaths, stagedStartsWithBom } from "../../src/release/git.js";
import { checkGit } from "../../src/release/checks.js";

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit)("release git helpers (temp repo)", () => {
  const dir = mkdtempSync(join(tmpdir(), "emcp-relgit-"));
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: "ignore" });
  g("init", "-q");
  writeFileSync(join(dir, ".gitignore"), "Scripts/WorkbenchGame/EnfusionMCP/\n");
  mkdirSync(join(dir, "Scripts", "WorkbenchGame", "EnfusionMCP"), { recursive: true });
  mkdirSync(join(dir, "Scripts", "Game"), { recursive: true });
  writeFileSync(join(dir, "Scripts", "WorkbenchGame", "EnfusionMCP", "EMCP_WB_Ping.c"), "class X {}\n");
  writeFileSync(join(dir, "Scripts", "Game", "Bom File.c"), "﻿class B {}\n");
  writeFileSync(join(dir, "Scripts", "Game", "Clean.c"), "class C {}\n");
  g("add", "-f", "Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Ping.c");
  g("add", "Scripts/Game");

  it("lists staged paths, force-added and with spaces", () => {
    expect(stagedPaths(dir).sort()).toEqual(["Scripts/Game/Bom File.c", "Scripts/Game/Clean.c", "Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Ping.c"]);
  });

  it("reads the staged blob's first bytes", () => {
    expect(stagedStartsWithBom(dir, "Scripts/Game/Bom File.c")).toBe(true);
    expect(stagedStartsWithBom(dir, "Scripts/Game/Clean.c")).toBe(false);
  });

  it("finds the hooks folder and origin", () => {
    expect(hooksDir(dir).replace(/\\/g, "/")).toMatch(/\.git\/hooks$/);
    expect(originUrl(dir)).toBeNull();
    g("remote", "add", "origin", "https://github.com/SyykoNT/x.git");
    expect(originUrl(dir)).toBe("https://github.com/SyykoNT/x.git");
  });
});

describe.skipIf(!hasGit)("gitState and checkGit (temp repos)", () => {
  const repo = () => {
    const d = mkdtempSync(join(tmpdir(), "emcp-gitstate-"));
    execFileSync("git", ["-C", d, "init", "-q"], { stdio: "ignore" });
    return d;
  };
  const g = (d: string, ...a: string[]) => execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "ignore" });

  it("G1 modified and untracked resources, G2 tracked handler and rdb, G3, G4, G5 and G6", () => {
    const d = repo();
    mkdirSync(join(d, "Scripts", "WorkbenchGame", "EnfusionMCP"), { recursive: true });
    writeFileSync(join(d, "Scripts", "WorkbenchGame", "EnfusionMCP", "EMCP_WB_Ping.c"), "class X {}\n");
    writeFileSync(join(d, "resourceDatabase.rdb"), "rdb");
    writeFileSync(join(d, "A.et"), "GenericEntity {\n}\n");
    g(d, "add", ".");
    g(d, "commit", "-q", "--no-verify", "-m", "first\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
    writeFileSync(join(d, "A.et"), "GenericEntity {\n m_x 1\n}\n");
    writeFileSync(join(d, "New.conf"), "X {\n}\n");
    writeFileSync(join(d, "notes.txt"), "not a resource");
    const s = gitState(d);
    expect(s).toMatchObject({ repo: true, unborn: false, upstream: null, ahead: 1, ignoresHandlers: false, hasCommitMsgHook: false });
    expect(s.trackedForbidden.sort()).toEqual(["Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Ping.c", "resourceDatabase.rdb"]);
    const f = checkGit(s);
    expect(f.map((x) => `${x.id} ${x.level}`)).toEqual(["G1 blocker", "G1 blocker", "G2 blocker", "G3 warning", "G4 warning", "G5 blocker", "G6 info"]);
    expect(f[0].message).toBe("1 staged or modified tracked files: A.et");
    expect(f[1].message).toBe("1 untracked resource files: New.conf");
    expect(f[6].message).toMatch(/no upstream; 1 commits on no remote branch/);
  });

  it("a clean repo with ignore rule and hook gives only G6; an unborn repo says no commit yet", () => {
    const d = repo();
    writeFileSync(join(d, ".gitignore"), "Scripts/WorkbenchGame/EnfusionMCP/\n");
    writeFileSync(join(hooksDir(d), "commit-msg"), "#!/bin/sh\n");
    expect(checkGit(gitState(d)).map((x) => x.message)).toEqual(["No commit yet"]);
    g(d, "add", ".");
    g(d, "commit", "-q", "-m", "clean");
    expect(checkGit(gitState(d)).map((x) => x.id)).toEqual(["G6"]);
  });

  it("gitBase: an option-like value writes nothing and is reported as unknown; a real ref sets the range", () => {
    const d = repo();
    writeFileSync(join(d, "A.et"), "GenericEntity {\n}\n");
    g(d, "add", ".");
    g(d, "commit", "-q", "--no-verify", "-m", "one");
    g(d, "commit", "-q", "--no-verify", "--allow-empty", "-m", "two\n\nCo-Authored-By: Claude <noreply@anthropic.com>");
    const out = mkdtempSync(join(tmpdir(), "emcp-gitbase-"));
    for (const base of [`--output=${join(out, "PWNED")}`, "-p", "nope"]) {
      const s = gitState(d, base);
      expect(readdirSync(out)).toEqual([]);
      expect(s.aiMessages).toEqual([]);
      expect(checkGit(s).filter((x) => x.id === "G6").map((x) => x.message)).toEqual([`gitBase ${JSON.stringify(base)} is not a commit in this repo: commit messages not scanned`, `Branch ${s.branch}`]);
    }
    expect(gitState(d, "HEAD~1")).toMatchObject({ ahead: 1, note: undefined });
    expect(gitState(d, "HEAD~1").aiMessages).toHaveLength(1);
  }, 20_000); // many git runs: 2.4 to 4.9 s, too close to vitest's 5 s default

  it("G6 only, git checks skipped, outside a repo or inside a parent repo", () => {
    const plain = mkdtempSync(join(tmpdir(), "emcp-nogit-"));
    expect(checkGit(gitState(plain))[0].message).toMatch(/Not a git repository/);
    const d = repo();
    mkdirSync(join(d, "Sub"));
    expect(checkGit(gitState(join(d, "Sub")))[0].message).toMatch(/not a repo of its own/);
  });
});
