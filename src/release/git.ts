import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { realPathOf } from "../utils/safe-path.js";
import { aiIdentity, aiLineHits } from "./ai-attribution.js";

/** Run git in dir without taking optional locks (safe beside GitHub Desktop and other sessions). */
export function git(dir: string, args: string[]): string {
  return execFileSync("git", ["--no-optional-locks", "-C", dir, ...args], {
    encoding: "utf-8",
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 256 * 1024 * 1024, // the default 1 MiB made a long git log throw ENOBUFS, which gitOrNull read as "nothing"
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Why a git call failed: git's first stderr line, else the first line of Node's message. */
export function gitFailure(e: unknown): string {
  const err = e as { stderr?: string | Buffer; message?: string };
  return String(err.stderr ?? "").trim().split("\n")[0] || String(err.message ?? e).split("\n")[0];
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

export interface GitState {
  /** False when there is no repo of the addon's own (note says why) */
  repo: boolean;
  note?: string;
  /** No commit yet */
  unborn: boolean;
  branch: string;
  upstream: string | null;
  /** Commits in the scanned range (base..HEAD, or those on no remote branch without an upstream) */
  ahead: number;
  /** `git status --porcelain=v1` lines ("XY path") */
  porcelain: string[];
  /** Tracked or staged handler files, their folder meta, or resourceDatabase.rdb */
  trackedForbidden: string[];
  ignoresHandlers: boolean;
  hasCommitMsgHook: boolean;
  /** "<hash> <subject>: <why>" of scanned commits with an AI attribution line in the message or an AI author or committer */
  aiMessages: string[];
  /** Why the unpushed commit messages could not be read; G5 then blocks instead of reporting nothing */
  scanError?: string;
}

/** One G5 entry for a git log record ("%h %s\0%an\0%ae\0%cn\0%ce\0%B"), or none. */
function aiReason(record: string): string[] {
  const [head, an = "", ae = "", cn = "", ce = "", body = ""] = record.split("\0");
  const line = aiLineHits(body)[0];
  const author = aiIdentity(an, ae);
  const committer = aiIdentity(cn, ce);
  const why = line ? `matched "${line.trim()}"` : author ? `author ${author}` : committer ? `committer ${committer}` : undefined;
  return why ? [`${head}: ${why}`] : [];
}

/** Read-only repo state for release_audit. base defaults to the upstream; without one, commits on no remote branch count as unpushed. */
export function gitState(dir: string, base?: string): GitState {
  const none = (note: string): GitState => ({ repo: false, note, unborn: false, branch: "", upstream: null, ahead: 0, porcelain: [], trackedForbidden: [], ignoresHandlers: false, hasCommitMsgHook: false, aiMessages: [] });
  let top: string | null;
  try {
    top = git(dir, ["rev-parse", "--show-toplevel"]).trim() || null;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return none("git not found on PATH, git checks skipped");
    // A .git that git cannot read (broken HEAD, "dubious ownership") must not read as "no repo": that would skip every git check.
    if (existsSync(join(dir, ".git"))) throw new Error(`git cannot read the repo in ${dir}: ${gitFailure(e)}`);
    top = null;
  }
  if (!top) return none("Not a git repository: git checks skipped");
  if (realPathOf(top) !== realPathOf(dir)) return none(`Inside the git repo ${top}, not a repo of its own: git checks skipped`);

  const unborn = gitOrNull(dir, ["rev-parse", "--verify", "-q", "HEAD"]) === null;
  const upstream = unborn ? null : gitOrNull(dir, ["rev-parse", "--abbrev-ref", "@{u}"]);
  // base comes from the caller: a leading "-" would be read as an option (--output writes a file), so only a commit it resolves to reaches git log
  const baseSha = base && !base.startsWith("-") && !unborn ? gitOrNull(dir, ["rev-parse", "--verify", "-q", "--end-of-options", `${base}^{commit}`]) : null;
  // Without an upstream, "unpushed" means on no remote-tracking branch
  const from = base ? baseSha : upstream;
  const range = unborn || (base && !baseSha) ? null : from ? [`${from}..HEAD`] : ["HEAD", "--not", "--remotes"];
  let log = "";
  let scanError: string | undefined;
  if (range) {
    try {
      log = git(dir, ["log", ...range, "--format=%h %s%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x00%x1e"]).trim();
    } catch (e) {
      scanError = gitFailure(e);
    }
  }
  const commits = log.split("\0\x1e").map((c) => c.trim()).filter(Boolean);

  const porcelain: string[] = [];
  const entries = git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).split("\0");
  for (let i = 0; i < entries.length; i++) {
    if (!entries[i]) continue;
    porcelain.push(entries[i]);
    if (/^[RC]/.test(entries[i])) i++; // a rename or copy is followed by its source path
  }
  const forbidden = ["resourceDatabase.rdb", "Scripts/WorkbenchGame/EnfusionMCP", "Scripts/WorkbenchGame/EnfusionMCP.meta"];
  return {
    repo: true,
    note: base && !unborn && !baseSha ? `gitBase ${JSON.stringify(base)} is not a commit in this repo: commit messages not scanned` : undefined,
    unborn,
    branch: gitOrNull(dir, ["branch", "--show-current"]) || "(detached)",
    upstream,
    ahead: commits.length,
    porcelain,
    trackedForbidden: (gitOrNull(dir, ["ls-files", "-z", "--", ...forbidden]) ?? "").split("\0").filter(Boolean),
    ignoresHandlers: gitOrNull(dir, ["check-ignore", "-q", "Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Ping.c"]) !== null,
    hasCommitMsgHook: existsSync(join(hooksDir(dir), "commit-msg")),
    aiMessages: commits.flatMap(aiReason),
    scanError,
  };
}
