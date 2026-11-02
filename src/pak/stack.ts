import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, basename, dirname, relative } from "node:path";
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
  /** Every file under a folder ("" = all), as paths from the addon root with forward slashes */
  list(dir: string): string[];
}

export interface Stack {
  layers: Layer[];
  /** Dependency GUIDs found in no loose project, Workshop folder or base game addon */
  missing: string[];
  warnings: string[];
}

interface Addon { kind: LayerKind; root: string; gproj: string; guid?: string }
interface Info { id: string; guid: string; title: string; deps: string[]; warning?: string }

/** One installed addon, as RL-N1, RL-I2 and RL-I3 read it. */
export interface AddonInfo extends Info {
  dir: string;
  gproj: string;
  source: LayerKind;
  /** Workshop name from ServerData.json, else the TITLE */
  name: string;
  /** Installed Workshop version ("" for projects and the base game) */
  version: string;
  /** Game version the installed Workshop version was built for ("" when the mod left it empty) */
  gameVersion: string;
  /** Dependency names from the Workshop meta, so a missing dependency can still be named */
  depNames: Record<string, string>;
  /** Other folders with this GUID, which lose to this one */
  shadowed: string[];
}

export interface Closure {
  /** Dependencies before their dependents, the target last */
  order: AddonInfo[];
  missing: string[];
  /** GUID paths that lead back to themselves, e.g. [A, B, A] */
  cycles: string[][];
  warnings: string[];
}

export const VANILLA_GUID = "58D0FB3206B6F859";

const subdirs = (dir: string) => {
  try {
    // An addon may be a junction or symlink to its folder (findGproj skips one that is not a folder)
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
};

/** Loose dirs in the order Workbench resolves them: -addonsDir entries, then the project path. */
export const looseDirs = (config: Config) =>
  [...(config.addonsDir ?? "").split(","), config.projectPath].map((d) => d?.trim()).filter((d): d is string => !!d);

/**
 * A Workshop download is packed even when found in a loose dir: the default project path is the
 * Workbench addons folder, a link to the Workshop cache, and hand copies keep ServerData.json too.
 */
const kindOf = (root: string, kind: LayerKind): LayerKind =>
  kind === "loose" && existsSync(join(root, "ServerData.json")) ? "workshop" : kind;

function catalog(config: Config): Addon[] {
  const out: Addon[] = [];
  const add = (found: LayerKind, dirs: string[]) => {
    for (const root of dirs) {
      const gproj = findGproj(root);
      if (!gproj) continue;
      const kind = kindOf(root, found);
      // Workshop folders end in _<GUID>; reading 500+ .gproj files up front is not needed
      const suffix = kind === "workshop" ? /_([0-9A-Fa-f]{16})$/.exec(basename(root))?.[1] : undefined;
      out.push({ kind, root, gproj, guid: (suffix ?? readGproj(gproj).guid).toUpperCase() });
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

// Both Workshop files start with a UTF-8 BOM
const json = (f: string): any => {
  try {
    return JSON.parse(readFileSync(f, "utf-8").replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
};

const described = new Map<string, Omit<AddonInfo, "shadowed">>();
function describe(a: Addon, cat: Addon[]): AddonInfo {
  const key = `${a.gproj}|${statSync(a.gproj).mtimeMs}|${statSync(a.root).mtimeMs}`;
  let d = described.get(key);
  if (!d) {
    const info = readInfo(a.gproj);
    const sd = json(join(a.root, "ServerData.json"));
    const version: string = sd?.revision?.version ?? "";
    const versions: any[] = json(join(a.root, "meta"))?.meta?.versions ?? [];
    const v = versions.find((x) => x.version === version) ?? versions[0];
    const depNames = Object.fromEntries((v?.dependencies ?? []).map((x: any) => [String(x.assetId).toUpperCase(), String(x.assetName)]));
    d = { ...info, dir: a.root, gproj: a.gproj, source: a.kind, name: sd?.name || info.title, version, gameVersion: v?.gameVersion ?? "", depNames };
    described.set(key, d);
  }
  const guid = d.guid;
  return { ...d, shadowed: cat.filter((o) => o.root !== a.root && o.guid === guid && realPathOf(o.root) !== realPathOf(a.root)).map((o) => o.root) };
}

/** Every installed addon by GUID, the copy Workbench would load (loose before Workshop before base game). */
export function installedAddons(config: Config): Map<string, AddonInfo> {
  const cat = catalog(config), out = new Map<string, AddonInfo>();
  for (const a of cat) if (a.guid && !out.has(a.guid)) out.set(a.guid, describe(a, cat));
  return out;
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
    return { kind: kindOf(dirname(gproj), kind), root: dirname(gproj), gproj };
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
export function rdbOf(root: string): Map<string, RdbEntry> {
  const f = join(root, "resourceDatabase.rdb");
  if (!existsSync(f)) return new Map();
  const key = `${f}|${statSync(f).mtimeMs}`;
  let m = rdbs.get(key);
  if (!m) rdbs.set(key, (m = parseResourceDatabase(readFileSync(f))));
  return m;
}

// Pak indexes load on first use, so building a 140-layer stack reads no pak
const paks = new Map<string, { sig: string; vfs: PakVirtualFS | null }>();
export function vfsOf(root: string): PakVirtualFS | null {
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

/** A layer over one addon folder: loose files, or the paks of a Workshop or base game download. */
export function makeLayer(a: Pick<AddonInfo, "id" | "guid" | "title" | "source" | "dir">, index: number): Layer {
  const base = { index, id: a.id, guid: a.guid, title: a.title, kind: a.source, root: a.dir };
  if (a.source !== "loose") {
    return {
      ...base,
      exists: (p) => vfsOf(a.dir)?.exists(stripGuid(p)) ?? false,
      read: (p) => { const v = vfsOf(a.dir); return v && v.fileSize(stripGuid(p)) >= 0 ? v.readFile(stripGuid(p)) : null; },
      guidOf: (p) => rdbOf(a.dir).get(norm(p))?.guid,
      list: (dir) => {
        const pre = dir ? `${norm(dir).replace(/\/+$/, "")}/` : "";
        return vfsOf(a.dir)?.allFilePaths().filter((f) => f.toLowerCase().startsWith(pre)) ?? [];
      },
    };
  }
  const file = (p: string) => {
    try {
      return validateProjectPath(a.dir, stripGuid(p));
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
      return meta?.toUpperCase() ?? rdbOf(a.dir).get(norm(p))?.guid;
    },
    list: (dir) => {
      const d = file(dir);
      if (!d || !existsSync(d)) return [];
      return readdirSync(d, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => relative(a.dir, join(e.parentPath, e.name)).replace(/\\/g, "/"));
    },
  };
}

/**
 * The dependency closure of `target` (folder name, GUID, ID, .gproj path or "vanilla"). Each dependency
 * resolves to the first loose project, then Workshop folder, then base game addon with its GUID.
 */
export function closure(config: Config, target: string): Closure {
  const cat = catalog(config);
  const order: AddonInfo[] = [], missing: string[] = [], cycles: string[][] = [], warnings: string[] = [];
  const seen = new Set<string>(), path: string[] = [];
  // Depth-first post-order: a dependency before its dependents, siblings in Dependencies order
  // (the engine's order among siblings is unverified)
  const visit = (a: Addon) => {
    const info = describe(a, cat);
    const key = info.guid || a.root;
    if (seen.has(key)) return;
    seen.add(key); // before the dependencies, so a cycle stops here
    path.push(key);
    if (info.warning) warnings.push(info.warning);
    for (const d of info.deps) {
      const at = path.indexOf(d);
      if (at >= 0) cycles.push([...path.slice(at), d]);
      else if (seen.has(d)) continue;
      else {
        const dep = byGuid(cat, d);
        if (dep) visit(dep);
        else if (!missing.includes(d)) missing.push(d);
      }
    }
    path.pop();
    order.push(info);
  };
  visit(findAddon(config, cat, target));
  return { order, missing, cycles, warnings };
}

/** The stack `target` loads: its closure, one layer per addon. */
export function buildStack(config: Config, target: string): Stack {
  const { order, missing, warnings } = closure(config, target);
  return { layers: order.map(makeLayer), missing, warnings };
}
