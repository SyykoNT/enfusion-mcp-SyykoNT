/**
 * Save the log folders of earlier Workbench runs that crashed or hung (B-044, PRD F14.1). A new Workbench start prunes older
 * log folders, so a crash nobody watched is gone by the next start. Copy only: nothing in the logs folder is moved or deleted.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { copyCrashFiles } from "./auth.js";
import { LEAK_TEXT, crashFiles, parseCrashLog } from "./signals.js";

export interface SweepOpts {
  /** Log folders of Workbenches that are running now: still being written, never copied. */
  skipDirs?: string[];
  /** Start of the earliest running Workbench; a folder named at or after it belongs to a running Workbench. */
  liveSince?: number;
  now?: () => number;
  /** Stop after this long; the next sweep continues (default 5 s). */
  capMs?: number;
}

export interface SweepResult {
  saved: { folder: string; dest: string }[];
  /** Files that could not be read or copied. */
  errors: string[];
  capped: boolean;
}

/** Workbench names its log folder after its process start: logs_yyyy-MM-dd_HH-mm-ss. */
const FOLDER = /^logs_(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)$/;
const startOf = (name: string): number => {
  const m = FOLDER.exec(name)!;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
};
const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const sameBytes = (a: string, b: string) => {
  try {
    return sha(a) === sha(b);
  } catch {
    return false; // unreadable: not a twin
  }
};
const norm = (p: string) => resolve(p).toLowerCase();

/** True when some entry of a crash.log has a Reason other than the leak assert (entries are split as parseCrashLog splits them). */
const hasCrashEntry = (text: string) =>
  text.split(/^-{20,}\s*$/m).some((block) => {
    const reason = parseCrashLog(block).reason; // the file header block has no Reason: it is not an entry
    return reason !== undefined && reason !== LEAK_TEXT;
  });

/** Every copy folder under the crash folder with its files (lowercase name to size). */
function savedIndex(root: string): { dir: string; files: Map<string, number> }[] {
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return []; // no crash folder yet
  }
  const index: { dir: string; files: Map<string, number> }[] = [];
  for (const d of dirs) {
    try {
      index.push({ dir: join(root, d), files: new Map(readdirSync(join(root, d)).map((f) => [f.toLowerCase(), statSync(join(root, d, f)).size])) });
    } catch {
      // an unreadable copy is not recognised: its folder is saved again
    }
  }
  return index;
}

/** Copy every finished crash or hang log folder under `logsRoot` that is not saved yet to `<destRoot>/<folder name>/`. */
export function saveCrashFolders(logsRoot: string, destRoot: string, o: SweepOpts = {}): SweepResult {
  const now = o.now ?? Date.now;
  const t0 = now();
  const res: SweepResult = { saved: [], errors: [], capped: false };
  let names: string[];
  try {
    names = readdirSync(logsRoot);
  } catch {
    return res; // no logs folder yet
  }
  const skip = new Set((o.skipDirs ?? []).map(norm));
  let index: ReturnType<typeof savedIndex> | undefined;
  // Newest first: the oldest folders are the likeliest to be pruned already.
  const folders = names.filter((n) => FOLDER.test(n)).sort().reverse();
  for (const [i, folder] of folders.entries()) {
    if (i > 0 && now() - t0 >= (o.capMs ?? 5000)) {
      res.capped = true;
      break;
    }
    const src = join(logsRoot, folder);
    if (skip.has(norm(src)) || (o.liveSince !== undefined && startOf(folder) >= o.liveSince - 3000)) continue;
    try {
      const files = readdirSync(src);
      const dumps = files.filter((f) => /\.mdmp$/i.test(f)).sort();
      const log = files.find((f) => f.toLowerCase() === "crash.log");
      if (!dumps.length && !(log && hasCrashEntry(readFileSync(join(src, log), "utf-8")))) continue;
      // Saved only when ONE copy folder holds every file a copy would take (same name and size) and the key file has the same bytes:
      // a copy that missed a dump (disk full, locked file) is copied again.
      const key = (log ?? dumps[0])!;
      const want = crashFiles(files).copy.map((f) => [f.toLowerCase(), statSync(join(src, f)).size] as const);
      const twin = (index ??= savedIndex(destRoot)).some((c) => want.every(([f, size]) => c.files.get(f) === size) && sameBytes(join(src, key), join(c.dir, key)));
      if (twin) continue;
      let name = folder;
      for (let n = 2; existsSync(join(destRoot, name)); n++) name = `${folder}_${n}`;
      const copy = copyCrashFiles(src, destRoot, "", 0, name);
      // copyCrashFiles lists a failed copy as "<file> (<reason>)" and a normal absentee (script.log) as a bare name.
      res.errors.push(...copy.missing.filter((m) => /\(.+\)$/.test(m)).map((m) => `${folder}: ${m}`));
      if (copy.copied.length) res.saved.push({ folder, dest: copy.dir! });
      else {
        try {
          rmdirSync(copy.dir!); // our own empty folder from a copy that failed; rmdir refuses a folder that holds anything
        } catch {
          // never made, or not empty
        }
      }
    } catch (e) {
      res.errors.push(`${folder}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return res;
}

/** The one line for a reply or an event, or undefined when nothing was saved. */
export function sweepLine(r: SweepResult, root: string): string | undefined {
  return r.saved.length ? `Saved ${r.saved.length} crash folder(s) to ${root}${r.capped ? " (time cap reached, the next start saves the rest)" : ""}` : undefined;
}
