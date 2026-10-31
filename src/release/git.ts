import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** Run git in dir without taking optional locks (safe beside GitHub Desktop and other sessions). */
export function git(dir: string, args: string[]): string {
  return execFileSync("git", ["--no-optional-locks", "-C", dir, ...args], {
    encoding: "utf-8",
    windowsHide: true,
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** git, or null when it exits non-zero (missing config key, no origin, not a repo). A missing git binary still throws. */
export function gitOrNull(dir: string, args: string[]): string | null {
  try {
    return git(dir, args).trim();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error("git not found on PATH");
    return null;
  }
}

/** Paths added, copied, modified or renamed in the index (deletions pass so a cleanup commit can remove a handler). */
export function stagedPaths(dir: string): string[] {
  return git(dir, ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]).split("\0").filter(Boolean);
}

export function stagedStartsWithBom(dir: string, path: string): boolean {
  const blob = execFileSync("git", ["--no-optional-locks", "-C", dir, "show", `:${path}`], {
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return blob[0] === 0xef && blob[1] === 0xbb && blob[2] === 0xbf;
}

/** The folder git runs hooks from (honours worktrees and core.hooksPath). */
export function hooksDir(dir: string): string {
  return resolve(dir, git(dir, ["rev-parse", "--git-path", "hooks"]).trim());
}

export function originUrl(dir: string): string | null {
  return gitOrNull(dir, ["remote", "get-url", "origin"]) || null;
}
