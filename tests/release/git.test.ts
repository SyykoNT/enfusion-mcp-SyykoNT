import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hooksDir, originUrl, stagedPaths, stagedStartsWithBom } from "../../src/release/git.js";

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
