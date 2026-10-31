import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import type { Config } from "../config.js";
import { parse, getProperty } from "../formats/enfusion-text.js";
import { stripGuid } from "../formats/config-override.js";
import { readGproj } from "../workbench/cli.js";
import { findGproj } from "../utils/game-paths.js";
import { validateProjectPath, isContained, realPathOf } from "../utils/safe-path.js";
import { PakVirtualFS } from "./vfs.js";
import { parseResourceDatabase, type RdbEntry } from "./rdb.js";

/**
 * The addon stack a .gproj loads: its dependency closure from loose projects, the Workshop
 * cache and the base game, one layer per addon, dependencies before their dependents.
 * Read only: nothing here writes, so Workshop and install folders stay untouched (D-024).
 */

export type LayerKind = "vanilla" | "workshop" | "loose";

export interface Layer {
  index: number;
  id: string;
  guid: string;
  title: string;
  kind: LayerKind;
  /** Addon folder */
  root: string;
  /** File or directory */
  exists(path: string): boolean;
  /** File bytes, or null for a missing file or a directory */
  read(path: string): Buffer | null;
  guidOf(path: string): string | undefined;
}

export interface Stack {
  layers: Layer[];
  /** Dependency GUIDs found in no loose project, Workshop folder or base game addon */
  missing: string[];
  warnings: string[];
}

interface Addon { kind: LayerKind; root: string; gproj: string; guid?: string }
interface Info { id: string; guid: string; title: string; deps: string[]; warning?: string }

export const VANILLA_GUID = "58D0FB3206B6F859";

const subdirs = (dir: string) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
};

/** Loose dirs in the order Workbench resolves them: -addonsDir entries, then the project path. */
export const looseDirs = (config: Config) =>
  [...(config.addonsDir ?? "").split(","), config.projectPath].map((d) => d?.trim()).filter((d): d is string => !!d);

function catalog(config: Config): Addon[] {
  const out: Addon[] = [];
  const add = (kind: LayerKind, dirs: string[]) => {
    for (const root of dirs) {
      const gproj = findGproj(root);
      // Workshop folders end in _<GUID>; reading 500+ .gproj files up front is not needed
      if (gproj) out.push({ kind, root, gproj, guid: kind === "workshop" ? basename(root).split("_").pop()!.toUpperCase() : readGproj(gproj).guid.toUpperCase() });
    }
  };
  // Loose first: Workbench runs with -addonsDir, so a local clone wins over its Workshop copy
  add("loose", looseDirs(config).flatMap(subdirs));
  if (config.workshopPath) add("workshop", subdirs(config.workshopPath));
  add("vanilla", subdirs(join(config.gamePath, "addons")));
  return out;
}

function readInfo(gproj: string): Info {
  try {
    const node = parse(readFileSync(gproj, "utf-8"));
    const str = (k: string) => { const v = getProperty(node, k); return typeof v === "string" ? v : ""; };
    // The real CRF closure has one "" entry
    const deps = (node.children.find((c) => c.type === "Dependencies")?.values ?? []).filter(Boolean).map((d) => d.toUpperCase());
    return { id: str("ID"), guid: str("GUID").toUpperCase(), title: str("TITLE"), deps };
  } catch (e) {
    const r = readGproj(gproj);
    return { ...r, guid: r.guid.toUpperCase(), deps: [], warning: `${gproj}: ${(e as Error).message}; its dependencies were not read` };
  }
}

const inside = (root: string | undefined, p: string) => {
  try {
    return !!root && isContained(realPathOf(root), realPathOf(p));
  } catch {
    return false;
  }
};

/** Find an addon by folder name, GUID or ID ("vanilla" = the base game). Throws with the known names. */
function findAddon(config: Config, cat: Addon[], target: string): Addon {
  if (/\.gproj$/i.test(target)) {
    const gproj = resolve(target);
    if (!existsSync(gproj)) throw new Error(`No such .gproj: ${gproj}`);
    const kind: LayerKind = inside(config.workshopPath, gproj) ? "workshop" : inside(config.gamePath, gproj) ? "vanilla" : "loose";
    return { kind, root: dirname(gproj), gproj };
  }
  const key = target.toLowerCase() === "vanilla" ? VANILLA_GUID : target;
  const hit = cat.find((a) => basename(a.root).toLowerCase() === key.toLowerCase())
    ?? byGuid(cat, key.toUpperCase())
    ?? cat.find((a) => readGproj(a.gproj).id.toLowerCase() === key.toLowerCase());
  if (hit) return hit;
  const known = cat.filter((a) => a.kind === "loose").map((a) => basename(a.root));
  throw new Error(
    `No addon "${target}" under ${[...looseDirs(config), config.workshopPath ?? "(no Workshop path)"].join(", ")}; ` +
      `known projects: ${known.join(", ") || "none"} (or a Workshop folder name, a GUID, an ID, a .gproj path, or "vanilla")`
  );
}

/** First addon with this GUID: loose before Workshop before base game (the catalog's order). */
const byGuid = (cat: Addon[], guid: string) => cat.find((a) => a.guid === guid);

const norm = (p: string) => stripGuid(p).replace(/\\/g, "/").replace(/^\/+/, "").toLowerCase();

const rdbs = new Map<string, Map<string, RdbEntry>>();
function rdbOf(root: string): Map<string, RdbEntry> {
  const f = join(root, "resourceDatabase.rdb");
  if (!existsSync(f)) return new Map();
  const key = `${f}|${statSync(f).mtimeMs}`;
  let m = rdbs.get(key);
  if (!m) rdbs.set(key, (m = parseResourceDatabase(readFileSync(f))));
  return m;
}

// Pak indexes load on first use, so building a 140-layer stack reads no pak
const paks = new Map<string, { sig: string; vfs: PakVirtualFS | null }>();
function vfsOf(root: string): PakVirtualFS | null {
  const files = readdirSync(root).filter((n) => /\.pak$/i.test(n)).sort().map((n) => join(root, n));
  const sig = files.map((f) => { const s = statSync(f); return `${f}|${s.size}|${s.mtimeMs}`; }).join(";");
  let e = paks.get(root);
  if (e?.sig !== sig) paks.set(root, (e = { sig, vfs: files.length ? PakVirtualFS.forPaks(files) : null }));
  return e.vfs;
}

/** Path of a resource GUID, from the topmost layer's rdb down. shortcut: loose layers' .meta files are not scanned. */
export function pathOfGuid(layers: Layer[], guid: string): string | undefined {
  for (const l of [...layers].reverse()) for (const e of rdbOf(l.root).values()) if (e.guid === guid) return e.path;
  return undefined;
}

function makeLayer(a: Addon, info: Info, index: number): Layer {
  const base = { index, id: info.id, guid: info.guid, title: info.title, kind: a.kind, root: a.root };
  if (a.kind !== "loose") {
    return {
      ...base,
      exists: (p) => vfsOf(a.root)?.exists(stripGuid(p)) ?? false,
      read: (p) => { const v = vfsOf(a.root); return v && v.fileSize(stripGuid(p)) >= 0 ? v.readFile(stripGuid(p)) : null; },
      guidOf: (p) => rdbOf(a.root).get(norm(p))?.guid,
    };
  }
  const file = (p: string) => {
    try {
      return validateProjectPath(a.root, stripGuid(p));
    } catch {
      return null;
    }
  };
  return {
    ...base,
    exists: (p) => { const f = file(p); return !!f && existsSync(f); },
    read: (p) => { const f = file(p); return f && existsSync(f) && statSync(f).isFile() ? readFileSync(f) : null; },
    guidOf: (p) => {
      const f = file(p);
      const meta = f && existsSync(`${f}.meta`) ? readFileSync(`${f}.meta`, "utf-8").match(/Name\s+"\{([0-9A-Fa-f]{16})\}/)?.[1] : undefined;
      return meta?.toUpperCase() ?? rdbOf(a.root).get(norm(p))?.guid;
    },
  };
}

/**
 * The stack `target` loads (folder name, GUID, ID, .gproj path or "vanilla"). Each dependency
 * resolves to the first loose project, then Workshop folder, then base game addon with its GUID.
 */
export function buildStack(config: Config, target: string): Stack {
  const cat = catalog(config);
  const layers: Layer[] = [], missing: string[] = [], warnings: string[] = [];
  const seen = new Set<string>();
  // Depth-first post-order: a dependency before its dependents, siblings in Dependencies order
  // (the engine's order among siblings is unverified)
  const visit = (a: Addon) => {
    const info = readInfo(a.gproj);
    const key = info.guid || a.root;
    if (seen.has(key)) return;
    seen.add(key); // before the dependencies, so a cycle stops here
    if (info.warning) warnings.push(info.warning);
    for (const d of info.deps) {
      if (seen.has(d)) continue;
      const dep = byGuid(cat, d);
      if (dep) visit(dep);
      else if (!missing.includes(d)) missing.push(d);
    }
    layers.push(makeLayer(a, info, layers.length));
  };
  visit(findAddon(config, cat, target));
  return { layers, missing, warnings };
}
