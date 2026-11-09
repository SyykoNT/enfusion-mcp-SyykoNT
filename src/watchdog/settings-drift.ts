/**
 * Settings drift: a run without the mods that wrote a settings block drops that block from the settings files. The watcher keeps the
 * depth-1 class names of every `*.conf` in the game and Workbench profiles and reports the ones that vanish. Read only: the one file
 * written is the snapshot in the watch dir. Values are never read into the report.
 */

import { readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../config.js";
import { myGamesDir } from "../utils/game-paths.js";
import { workbenchProfileDir } from "../workbench/cli.js";

/** Real path of a settings file -> its depth-1 class names, sorted (a name can repeat). */
export type SettingsSnapshot = Record<string, string[]>;

/** The profile folders whose settings a run can change: the game's (next to the Workshop cache) and Workbench's. */
export const profileRoots = (config: Config): string[] => [
  config.workshopPath ? dirname(config.workshopPath) : join(myGamesDir(), "ArmaReforger"),
  workbenchProfileDir(config),
];

const readNames = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

/** Every `*.conf` in `<root>\profile\.save\settings` and `<root>\profile\.save\<app>\settings`, by real path so a junction is read once. */
export function settingsFiles(roots: string[]): string[] {
  const files = new Set<string>();
  for (const root of roots) {
    const save = join(root, "profile", ".save");
    for (const name of readNames(save)) {
      const dir = name.toLowerCase() === "settings" ? join(save, name) : join(save, name, "settings");
      for (const f of readNames(dir).filter((n) => /\.conf$/i.test(n))) {
        try {
          files.add(realpathSync.native(join(dir, f)));
        } catch {
          // gone between the listing and now
        }
      }
    }
  }
  return [...files];
}

/** The class names of the direct children of the root block: ` SCR_VideoSettings SCR_VideoSettings "{GUID}" {` at depth 1. */
export function depth1Names(text: string): string[] {
  const names: string[] = [];
  let depth = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "}") depth--;
    else if (line.endsWith("{")) {
      if (depth === 1) names.push(line.split(/\s+/)[0]);
      depth++;
    }
  }
  return names.sort();
}

/** shortcut: a file that cannot be read is left out, so its blocks are not compared this time; upgrade if a locked file proves common. */
export function takeSnapshot(roots: string[]): SettingsSnapshot {
  const snap: SettingsSnapshot = {};
  for (const f of settingsFiles(roots)) {
    try {
      snap[f] = depth1Names(readFileSync(f, "utf-8"));
    } catch {
      // unreadable now
    }
  }
  return snap;
}

/** Per file present in both, the names in `before` that `after` no longer holds (a name that repeats is counted). A file that is gone is not reported. */
export function lostBlocks(before: SettingsSnapshot, after: SettingsSnapshot): { file: string; names: string[] }[] {
  const out: { file: string; names: string[] }[] = [];
  for (const [file, was] of Object.entries(before)) {
    const now = after[file];
    if (!Array.isArray(was) || !now) continue;
    const left = [...now];
    const names = was.filter((n) => {
      const i = left.indexOf(n);
      if (i >= 0) left.splice(i, 1);
      return i < 0;
    });
    if (names.length) out.push({ file, names });
  }
  return out;
}

export const driftLine = (time: string, file: string, names: string[]) =>
  `SETTINGS ${time} ${file}: blocks gone: ${names.join(", ")} (a run without those mods drops their settings; restore from your own backup)`;

const snapshotFile = (dir: string) => join(dir, "settings.json");

export function loadSnapshot(dir: string): SettingsSnapshot | undefined {
  try {
    const j = JSON.parse(readFileSync(snapshotFile(dir), "utf-8"));
    return j && typeof j === "object" && !Array.isArray(j) ? (j as SettingsSnapshot) : undefined;
  } catch {
    return undefined;
  }
}

/** Merged over the saved one, so a profile that cannot be read for one run does not erase the baseline of its files. */
export function saveSnapshot(dir: string, snap: SettingsSnapshot): void {
  const file = snapshotFile(dir);
  writeFileSync(file + ".tmp", JSON.stringify({ ...loadSnapshot(dir), ...snap }));
  renameSync(file + ".tmp", file);
}
