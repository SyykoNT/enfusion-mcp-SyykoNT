import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

/** Relative path (forward slashes) to [mtimeMs, size]. */
export type Snapshot = Record<string, [number, number]>;

/**
 * File times and sizes under root: its own files plus up to maxDepth levels of subfolders, at most maxFiles files.
 * shortcut: past maxFiles the rest is not seen, so a write there is not reported; raise the cap if a world folder gets that big.
 */
export async function snapshotDir(root: string, maxDepth = 3, maxFiles = 5000): Promise<Snapshot> {
  const out: Snapshot = {};
  let count = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (count >= maxFiles) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) await walk(p, depth + 1);
      } else if (e.isFile()) {
        try {
          const s = await stat(p);
          out[relative(root, p).replace(/\\/g, "/")] = [s.mtimeMs, s.size];
          count++;
        } catch {
          // removed while scanning
        }
      }
    }
  };
  await walk(root, 0);
  return out;
}

export function diffSnapshots(a: Snapshot, b: Snapshot): { changed: string[]; added: string[]; removed: string[] } {
  const keys = (s: Snapshot) => Object.keys(s).sort();
  return {
    changed: keys(b).filter((k) => a[k] && (a[k][0] !== b[k][0] || a[k][1] !== b[k][1])),
    added: keys(b).filter((k) => !a[k]),
    removed: keys(a).filter((k) => !b[k]),
  };
}
