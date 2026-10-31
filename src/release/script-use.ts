import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PakVirtualFS } from "../pak/vfs.js";
import { vfsOf, type AddonInfo } from "../pak/stack.js";
import { addonFiles } from "./refs.js";

/**
 * Heuristic script use of a dependency: the class, enum and method names its scripts declare
 * that a target's scripts mention as whole words. It can miss typename strings and over-match
 * common names, so it only ever clears a "no use found" note, never raises a blocker.
 */

// Strings and comments go first so their braces and words do not count
const strip = (src: string) => src.replace(/"(?:[^"\\\n]|\\.)*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => (m.startsWith('"') ? '""' : m.replace(/[^\n]/g, " ")));

const NOT_NAMES = new Set(["if", "else", "while", "for", "foreach", "switch", "return", "new", "delete", "case", "super", "this", "thread"]);

/** Names declared by these sources: classes and enums (not `modded class`, which declares nothing new) and methods in class bodies. */
export function declaredNames(sources: string[]): Set<string> {
  const out = new Set<string>();
  for (const src of sources) {
    let depth = 0;
    for (const line of strip(src).split("\n")) {
      if (depth === 0) {
        const t = line.match(/^\s*(?:(modded)\s+)?(?:sealed\s+)?(class|enum)\s+(\w+)/);
        if (t && !t[1]) out.add(t[3]);
      } else if (depth === 1) {
        const m = line.match(/^\s*(?:[\w<>,]+\s+)+(\w+)\s*\(/);
        if (m && !NOT_NAMES.has(m[1])) out.add(m[1]);
      }
      for (const c of line) depth += c === "{" ? 1 : c === "}" ? -1 : 0;
      if (depth < 0) depth = 0;
    }
  }
  return out;
}

/** Names from `names` that the target's sources use as whole words, minus those the base game also declares. */
export function usedNames(targetSources: string[], names: Iterable<string>, baseNames: Set<string> = new Set()): string[] {
  const words = new Set(targetSources.flatMap((s) => strip(s).match(/\w+/g) ?? []));
  return [...names].filter((n) => words.has(n) && !baseNames.has(n)).sort();
}

export interface Scripts { sources: string[]; unreadable: number }

/** Script sources of an addon: loose `.c` files on disk, or `scripts/` entries of its paks. */
export function addonScripts(a: Pick<AddonInfo, "dir" | "source">): Scripts {
  const out: Scripts = { sources: [], unreadable: 0 };
  if (a.source === "loose") {
    for (const f of addonFiles(a.dir).filter((f) => /^scripts\/.*\.c$/i.test(f))) out.sources.push(readFileSync(join(a.dir, f), "utf-8"));
    return out;
  }
  const vfs = vfsOf(a.dir);
  for (const f of vfs?.allFilePaths().filter((f) => /^scripts\/.*\.c$/i.test(f)) ?? []) {
    try {
      out.sources.push(vfs!.readTextFile(f));
    } catch {
      out.unreadable++; // encrypted or damaged entry
    }
  }
  return out;
}

let base: { gamePath: string; names: Set<string> } | null = null;

/** Names the base game's scripts declare, read once per game path. */
export function baseGameNames(gamePath: string): Set<string> {
  if (base?.gamePath === gamePath) return base.names;
  const vfs = PakVirtualFS.get(gamePath);
  const sources: string[] = [];
  for (const f of vfs?.allFilePaths().filter((f) => /^scripts\/.*\.c$/i.test(f)) ?? []) {
    try {
      sources.push(vfs!.readTextFile(f));
    } catch { /* an unreadable base script only weakens the filter */ }
  }
  base = { gamePath, names: declaredNames(sources) };
  return base.names;
}
