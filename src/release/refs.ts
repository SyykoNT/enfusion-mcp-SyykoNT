import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A `{GUID}path` reference and the addon file it is in (relative, forward slashes). */
export interface Ref { guid: string; path: string; file: string }

export type RefKind = "own" | "closure" | "undeclared" | "dangling";
export interface ClassifiedRef { ref: Ref; kind: RefKind; owner?: string }

const REF_EXT = /\.(et|ent|layer|conf|ct|emat|layout|c|st)$/i;
const REF = /\{([0-9A-Fa-f]{16})\}([^"\s{}]+\.\w+)/g;

/** Every file of an addon (relative, forward slashes), skipping dot folders such as .git. */
export function addonFiles(addonDir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(addonDir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!e.name.startsWith(".")) walk(r); }
      else if (e.isFile()) out.push(r);
    }
  };
  walk("");
  return out;
}

/** Keep the files equal to, or under, one of `only` (relative paths or folder prefixes, either slash). */
export function filterFiles(files: string[], only?: string[]): string[] {
  if (!only?.length) return files;
  const want = only.map((w) => w.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").toLowerCase());
  return files.filter((f) => { const l = f.toLowerCase(); return want.some((w) => l === w || l.startsWith(`${w}/`)); });
}

/** Distinct (GUID, path, file) references in the addon's resource and script files. */
export function collectRefs(addonDir: string, files?: string[]): Ref[] {
  const out = new Map<string, Ref>();
  for (const file of filterFiles(addonFiles(addonDir), files).filter((f) => REF_EXT.test(f))) {
    for (const m of readFileSync(join(addonDir, file), "utf-8").matchAll(REF)) {
      const ref = { guid: m[1].toUpperCase(), path: m[2], file };
      out.set(`${ref.guid}|${ref.path}|${file}`, ref);
    }
  }
  return [...out.values()];
}

/** GUIDs an unpacked addon declares in its .meta files (`Name "{GUID}path"`). */
export function metaGuids(addonDir: string): Set<string> {
  const out = new Set<string>();
  for (const f of addonFiles(addonDir).filter((f) => /\.meta$/i.test(f))) {
    const g = readFileSync(join(addonDir, f), "utf-8").match(/Name\s+"\{([0-9A-Fa-f]{16})\}/)?.[1];
    if (g) out.add(g.toUpperCase());
  }
  return out;
}

/** Owner maps go from resource GUID to addon GUID; the first map that knows a GUID decides its kind. */
export function classifyRefs(refs: Ref[], ownGuids: Set<string>, closureOwners: Map<string, string>, installedOwners: Map<string, string>): ClassifiedRef[] {
  return refs.map((ref) => {
    if (ownGuids.has(ref.guid)) return { ref, kind: "own" };
    const c = closureOwners.get(ref.guid);
    if (c) return { ref, kind: "closure", owner: c };
    const i = installedOwners.get(ref.guid);
    return i ? { ref, kind: "undeclared", owner: i } : { ref, kind: "dangling" };
  });
}
