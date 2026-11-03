/**
 * The parts of the Script Authorization and crash handling that read or write the disk or other processes
 * (F2.8-AUTH). The decisions themselves are pure and live in signals.ts. Nothing here restores, stages or deletes a file.
 */

import { appendFileSync, constants, copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Config } from "../config.js";
import { buildStack } from "../pak/stack.js";
import { gitOrNull } from "../release/git.js";
import { realPathOf } from "../utils/safe-path.js";
import { argValue, type ProcInfo } from "../utils/process.js";
import { PROGRAM_METHODS, crashFiles, programCommand, type AuthDialog, type AuthLog, type CrashLog } from "./signals.js";

/** The addons a Workbench loaded, as far as a Script Authorization dialog needs them. */
export interface LoadSet {
  /** The top layer holding the addon-relative script path: the copy Workbench runs. */
  find(path: string): { addon: string; source(): string | undefined } | undefined;
  /** CRF and COALITION-Lobby clones among the loaded addons. */
  clones: { name: string; root: string }[];
  /** Folders of the loose (project) addons, where a texture rebuild would show. */
  looseRoots: string[];
}

/** The addons of the Workbench with this command line: its -gproj and dependencies, resolved as the tools do, plus its own -addonsDir. Undefined when they cannot be read. */
export function loadSetOf(config: Config, cmd: string): LoadSet | undefined {
  const gproj = argValue(cmd, "-gproj");
  if (!gproj) return undefined;
  try {
    const addonsDir = [config.addonsDir, argValue(cmd, "-addonsDir")].filter(Boolean).join(",");
    const { layers } = buildStack({ ...config, addonsDir }, gproj);
    const top = [...layers].reverse();
    return {
      find(path) {
        const p = path.replace(/\\/g, "/");
        const l = top.find((x) => x.exists(p));
        return l && { addon: l.id || l.title || basename(l.root), source: () => l.read(p)?.toString("utf-8") };
      },
      clones: layers
        .filter((l) => l.kind === "loose" && (l.exists("Tools/Validation/validate_mission.py") || basename(l.root).toLowerCase() === "coalition-lobby"))
        .map((l) => ({ name: basename(l.root), root: l.root })),
      looseRoots: layers.filter((l) => l.kind === "loose").map((l) => l.root),
    };
  } catch {
    return undefined;
  }
}

const GEAR_LIST = "Configs/Gearscripts/GearScriptsConfigList.json";

/** Read-only `git status` and the diff stat of the gear list in each CRF or Lobby clone, as one short text. */
export function gitReport(clones: { name: string; root: string }[]): string {
  return clones
    .map(({ name, root }) => {
      const top = gitOrNull(root, ["rev-parse", "--show-toplevel"]);
      if (!top || realPathOf(top) !== realPathOf(root)) return `${name}: not a git clone of its own`;
      const changed = (gitOrNull(root, ["status", "--porcelain"]) ?? "").split("\n").filter(Boolean).length;
      const stat = (gitOrNull(root, ["diff", "--stat", "--", GEAR_LIST]) ?? "").trim().split("\n").pop()?.trim();
      return `${name}: ${changed} changed files, GearScriptsConfigList.json ${stat || "unchanged"}`;
    })
    .join("; ");
}

/** How many .edds files under these folders changed in the last `windowMs` (a texture rebuild may be what repaints Workbench into a crash). */
export function eddsChanged(roots: string[], now: number, windowMs = 300_000): number {
  let n = 0;
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== ".git") walk(p);
      } else if (/\.edds$/i.test(e.name)) {
        try {
          if (now - statSync(p).mtimeMs <= windowMs) n++;
        } catch {
          // gone between listing and stat
        }
      }
    }
  };
  roots.forEach(walk);
  return n;
}

/** What an auth log line adds to the dialog text: the addon the script is in, the command of a program run, and, after an answer, the git report and the .edds count. */
export function authDetails(set: LoadSet | undefined, parsed: AuthDialog | undefined, answered: boolean, now: number): Pick<AuthLog, "addon" | "command" | "git" | "edds"> {
  const found = parsed && set?.find(parsed.script);
  return {
    addon: found?.addon,
    command: parsed && PROGRAM_METHODS.includes(parsed.method) ? programCommand(found?.source() ?? "", parsed.line, parsed.method) : undefined,
    git: answered && set?.clones.length ? gitReport(set.clones) : undefined,
    edds: answered && set ? eddsChanged(set.looseRoots, now) : undefined,
  };
}

/** Append one line to the Workbench lock file with a shared-write open. Returns why it could not, or undefined. */
export function appendLockLine(lock: string | undefined, line: string): string | undefined {
  if (!lock) return undefined;
  try {
    appendFileSync(lock, `${line}\r\n`);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Copy (never move) a crashed run's log files to `<destRoot>/<stamp>_<pid>/`. A missing file is reported, an existing copy is kept. */
export function copyCrashFiles(logDir: string | undefined, destRoot: string, stamp: string, pid: number): Pick<CrashLog, "dir" | "copied" | "missing"> {
  if (!logDir) return { copied: [], missing: ["the log folder of this run was not found"] };
  const dir = join(destRoot, `${stamp}_${pid}`);
  let names: string[];
  try {
    names = readdirSync(logDir);
  } catch (e) {
    return { dir, copied: [], missing: [`the log folder cannot be read (${e instanceof Error ? e.message : String(e)})`] };
  }
  const { copy, missing } = crashFiles(names);
  const copied: { name: string; size: number }[] = [];
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    return { dir, copied, missing: [`the crash folder cannot be made (${e instanceof Error ? e.message : String(e)})`] };
  }
  for (const name of copy) {
    try {
      copyFileSync(join(logDir, name), join(dir, name), constants.COPYFILE_EXCL); // a copy already there is kept
      copied.push({ name, size: statSync(join(dir, name)).size });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") copied.push({ name, size: statSync(join(dir, name)).size });
      else missing.push(`${name} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  return { dir, copied, missing };
}

/**
 * End the CrashReporter processes whose parent is the crashed Workbench `pid` (started after that Workbench), without sending a report.
 * Another CrashReporter, and the Workbench itself, are never touched.
 */
export function endCrashReporters(
  pid: number,
  startTime: number | undefined,
  reporters: ProcInfo[],
  kill: (pid: number) => void,
  alive: (pid: number) => boolean
): CrashLog["reporters"] {
  return reporters
    .filter((r) => r.ppid === pid && r.pid !== pid && (startTime === undefined || r.created >= startTime - 10_000))
    .map((r) => {
      kill(r.pid);
      return alive(r.pid) ? { pid: r.pid, ended: false, why: "still running after the end request" } : { pid: r.pid, ended: true };
    });
}
