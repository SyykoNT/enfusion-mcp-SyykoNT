import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  countUnquotedBraces,
  findRootOpenLine,
  findChildBlock,
  findParentReference,
} from "./et-engine-block.js";

/**
 * The reading half of the tuning server, shared by the engine and chassis
 * resolvers: one reader for vanilla files, one parent walker that lists every
 * file a vehicle's values can come from (nearest first), and one group
 * resolver that fills a set of keys from those files and the `.conf` chains
 * their blocks reference.
 */

/** Where a value was found: the vehicle's own .et, a parent/conf, or the component template (.ct). */
export type ValueSource = "own" | "inherited" | "template";
export type FieldValue = number | string;
export interface ResolvedField {
  value: FieldValue | null;
  source: ValueSource | "unresolved";
  /** Addon-relative path of the file the value was read from. */
  file?: string;
}
export type ResolvedGroup = Record<string, ResolvedField>;

export interface BlockRange {
  openLine: number;
  closeLine: number;
}

function defaultReadFile(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** Strip a leading `{GUID}` from an Enfusion resource reference. */
export function stripGuid(ref: string): string {
  return ref.replace(/^\{[0-9A-Fa-f]+\}/, "");
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.error(message);
}

/** A reference comes from file content, so it must stay inside the data root it is joined to. */
function isSafeRel(rel: string): boolean {
  return !(rel.includes("..") || rel.includes("\\") || rel.includes(":") || rel.startsWith("/"));
}

export interface ReadSources {
  /** Addon root, so the mod's own files are read first. */
  addonPath?: string;
  /** Extracted vanilla data. When set it is the only base source (the paks are not asked). */
  extractedPath?: string;
  /** File reader for the two folders above; tests inject a fake. */
  readFile?: (path: string) => string | null;
  /** Base game by addon-relative path (the installed paks), used only when there is no extractedPath. */
  readBase?: (rel: string) => string | null;
}

export interface Reader {
  /** A referenced `{GUID}path`: the mod's copy, else the base-game copy. */
  ref(ref: string): string | null;
  /** Every copy of a referenced path, mod first then base game. */
  copies(ref: string): string[];
  /** The base-game copy of an addon-relative path. */
  base(rel: string): string | null;
}

/** The one read hook both resolvers use, so a vanilla file comes from the same place everywhere. */
export function makeReader(src: ReadSources): Reader {
  const read = src.readFile ?? defaultReadFile;
  const safe = (rel: string): boolean => {
    if (isSafeRel(rel)) return true;
    warnOnce(`unsafe:${rel}`, `tuning-server: ignoring unsafe reference ${JSON.stringify(rel)}`);
    return false;
  };
  const fromFolder = (root: string, rel: string) => read(join(root, ...rel.split("/")));
  const base = (rel: string): string | null => {
    if (!safe(rel)) return null;
    if (src.extractedPath) return fromFolder(src.extractedPath, rel);
    try {
      return src.readBase?.(rel) ?? null;
    } catch (e) {
      warnOnce(`pak:${rel}`, `tuning-server: pak read failed for ${JSON.stringify(rel)}:${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  };
  const mod = (rel: string) => (src.addonPath && safe(rel) ? fromFolder(src.addonPath, rel) : null);
  // One reader serves one request, so remembering a file is safe and saves re-reading a pak per key group.
  const cache = new Map<string, string | null>();
  return {
    ref: (ref) => {
      const rel = stripGuid(ref);
      if (!cache.has(rel)) cache.set(rel, mod(rel) || base(rel));
      return cache.get(rel) ?? null;
    },
    copies: (ref) => {
      const rel = stripGuid(ref);
      return [mod(rel), base(rel)].filter((t): t is string => !!t);
    },
    base,
  };
}

/** Whole-document range, so a config file's root block can be treated uniformly. */
export function rootRange(text: string): BlockRange | null {
  const lines = text.split(/\r?\n/);
  const open = findRootOpenLine(lines);
  if (open === -1) return null;
  let d = countUnquotedBraces(lines[open]);
  let close = open;
  while (d > 0 && close + 1 < lines.length) {
    close++;
    d += countUnquotedBraces(lines[close]);
  }
  return { openLine: open, closeLine: close };
}

/**
 * Walk a chain of first-token names down from the document root.
 * `["components", "VehicleWheeledSimulation", "Simulation", "TyreModel"]`
 */
export function findBlockByPath(text: string, path: string[]): BlockRange | null {
  const lines = text.split(/\r?\n/);
  let range = rootRange(text);
  if (!range) return null;
  for (const token of path) {
    const next: BlockRange | null = findChildBlock(lines, range, token);
    if (!next) return null;
    range = next;
  }
  return range;
}

/** Every direct child block of `parent`, in order, used for the axle list. */
export function findChildBlocks(text: string, parent: BlockRange, firstToken: string): BlockRange[] {
  const lines = text.split(/\r?\n/);
  const out: BlockRange[] = [];
  let depth = 0;
  for (let i = parent.openLine + 1; i < parent.closeLine; i++) {
    const line = lines[i];
    if (depth === 0) {
      const trimmed = line.trim();
      if (trimmed.split(/\s+/)[0] === firstToken && countUnquotedBraces(line) > 0) {
        let d = countUnquotedBraces(line);
        let j = i;
        while (d > 0 && j + 1 < lines.length) {
          j++;
          d += countUnquotedBraces(lines[j]);
        }
        out.push({ openLine: i, closeLine: j });
      }
    }
    depth += countUnquotedBraces(line);
  }
  return out;
}

function headerLine(text: string, range: BlockRange): string {
  return text.split(/\r?\n/)[range.openLine];
}

/** The `.conf` reference on a block's header line, if it has one. */
export function blockReference(text: string, range: BlockRange): string | undefined {
  const m = /:\s*"([^"]+)"/.exec(headerLine(text, range));
  return m ? m[1] : undefined;
}

/** The quoted `"{ID}"` of a block header (without braces), if it has one. */
export function blockId(text: string, range: BlockRange): string | null {
  const m = /"\{([0-9A-Fa-f]+)\}"/.exec(headerLine(text, range));
  return m ? m[1] : null;
}

/** Header words before the conf reference, quoted IDs removed: `Differential Differential Diff_01` gives three. */
function headerWords(text: string, range: BlockRange): string[] {
  return headerLine(text, range).replace(/"[^"]*"/g, " ").split(/[:{]/)[0].trim().split(/\s+/).filter(Boolean);
}

/** A block's name is its last header word (`Diff_C`); its class is the second word (`Pacejka2002`). */
export function blockName(text: string, range: BlockRange): string {
  const w = headerWords(text, range);
  return w[w.length - 1] ?? "";
}
export function blockClass(text: string, range: BlockRange): string {
  return headerWords(text, range)[1] ?? "";
}

// A key with a number, a quoted string or a bare word (`Type LSD`) as its value. A header such as
// `Forward +{` ends in a brace and never matches, so append arrays cannot pass for a field.
const FIELD_LINE_RE = /^\s*([A-Za-z][A-Za-z0-9_]*)\s+(?:(-?\d+(?:\.\d+)?)|"([^"]*)"|([A-Za-z][A-Za-z0-9_]*))\s*$/;

/** Read the named fields written directly at this block's top level (nested blocks and arrays are skipped). */
export function readFields(text: string, range: BlockRange, keys: readonly string[]): Record<string, FieldValue> {
  const lines = text.split(/\r?\n/);
  const found: Record<string, FieldValue> = {};
  let depth = 0;
  for (let i = range.openLine + 1; i < range.closeLine; i++) {
    const line = lines[i];
    if (depth === 0) {
      const m = FIELD_LINE_RE.exec(line);
      if (m && keys.includes(m[1])) found[m[1]] = m[2] !== undefined ? parseFloat(m[2]) : (m[3] ?? m[4]);
    }
    depth += countUnquotedBraces(line);
  }
  return found;
}

/** Each `name { ... }` or `name +{ ... }` array block inside `parent`, with its numbers. */
export function readArrays(text: string, parent: BlockRange, name: string): { append: boolean; values: number[] }[] {
  const lines = text.split(/\r?\n/);
  return findChildBlocks(text, parent, name).map((r) => {
    const body = lines.slice(r.openLine, r.closeLine + 1).join(" ");
    const inner = body.slice(body.indexOf("{") + 1, body.lastIndexOf("}"));
    return {
      append: /\+\s*\{/.test(lines[r.openLine]),
      values: (inner.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number),
    };
  });
}

const MAX_CHAIN_DEPTH = 16;

/** Visit a `.conf` and each parent conf above it, nearest first; `visit` returns true to stop. */
export function walkConfChain(
  startRef: string | undefined,
  read: (ref: string) => string | null,
  visit: (text: string, file: string) => boolean | void
): void {
  const seen = new Set<string>();
  let ref: string | undefined = startRef;
  for (let depth = 0; depth < MAX_CHAIN_DEPTH && ref; depth++) {
    const rel = stripGuid(ref);
    if (seen.has(rel)) return;
    seen.add(rel);
    const text = read(ref);
    if (!text) return;
    if (visit(text, rel)) return;
    ref = findParentReference(text) ?? undefined;
  }
}

/**
 * Follow a `.conf` reference and every parent conf above it, taking each key
 * from the nearest definition. Enfusion configs store only what differs from
 * their parent, so the whole chain has to be read to fill a set.
 */
export function collectFromConfChain(
  startRef: string | undefined,
  opts: { read: (ref: string) => string | null; subBlock?: string; keys: readonly string[] }
): Record<string, { value: FieldValue; file: string }> {
  const out: Record<string, { value: FieldValue; file: string }> = {};
  walkConfChain(startRef, opts.read, (text, file) => {
    const target = opts.subBlock ? findBlockByPath(text, [opts.subBlock]) : rootRange(text);
    if (!target) return;
    const vals = readFields(text, target, opts.keys);
    for (const k of opts.keys) if (out[k] === undefined && vals[k] !== undefined) out[k] = { value: vals[k], file };
  });
  return out;
}

/** One file a vehicle's values can come from, with the path to its Simulation block. */
export interface PrefabSource {
  kind: ValueSource;
  file: string;
  text: string;
  simPath: string[];
}

const ET_SIM_PATH = ["components", "VehicleWheeledSimulation", "Simulation"];
// A .ct template's root is the VehicleWheeledSimulation component itself.
const CT_SIM_PATH = ["Simulation"];

/**
 * Every file the vehicle's simulation values can come from, nearest first:
 * the mod .et, the same-path vanilla .et (an override sits on top of its original),
 * then the parent chain (mod copy then base-game copy at each step), then the component template
 * (`.ct`) the VehicleWheeledSimulation component references, which holds the
 * root defaults (Wheeled_Base.et points it at VehicleWheeledSimulation_Base.ct).
 * Depth-capped and cycle-guarded so a malformed graph cannot hang a request.
 */
export function collectSources(reader: Reader, modText: string, relPath: string): PrefabSource[] {
  const et = (kind: ValueSource, file: string, text: string): PrefabSource => ({ kind, file, text, simPath: ET_SIM_PATH });
  const out: PrefabSource[] = [et("own", relPath, modText)];
  const seen = new Set<string>([relPath]);

  const climb = (from: string): void => {
    let text: string | null = from;
    for (let depth = 0; depth < MAX_CHAIN_DEPTH && text; depth++) {
      const parentRef = findParentReference(text);
      if (!parentRef) return;
      const rel = stripGuid(parentRef);
      if (seen.has(rel)) return;
      seen.add(rel);
      const copies = reader.copies(parentRef);
      if (copies.length === 0) return;
      for (const c of copies) out.push(et("inherited", rel, c));
      // The mod's copy, when there is one, is the authoritative parent chain.
      text = copies[0];
    }
  };

  // A Workbench override copy holds only the addon's changes, applied on top of the original,
  // and carries the original's own parent line. So the same-path vanilla file ranks right
  // after the mod .et, before any parent; the parent chain is climbed from both afterwards.
  const vanilla = reader.base(relPath);
  if (vanilla) out.push(et("inherited", relPath, vanilla));
  climb(modText);
  if (vanilla) climb(vanilla);

  const templates: string[] = [];
  for (const s of out) {
    const comp = findBlockByPath(s.text, ["components", "VehicleWheeledSimulation"]);
    const ref = comp && blockReference(s.text, comp);
    if (ref && stripGuid(ref).endsWith(".ct") && !templates.some((t) => stripGuid(t) === stripGuid(ref))) templates.push(ref);
  }
  for (const ref of templates) {
    const text = reader.ref(ref);
    if (text) out.push({ kind: "template", file: stripGuid(ref), text, simPath: CT_SIM_PATH });
  }
  return out;
}

/** The kind a value gets when it came from a conf that a block in `s` references. */
const viaConf = (s: PrefabSource): ValueSource => (s.kind === "own" ? "inherited" : s.kind);

/**
 * Fill `keys` for one block (or one sub-block of it) from every source.
 *
 * Per key, nearest first: this source's inline value, then the conf chain its block
 * references, then the next source. A child block may switch the conf ref its parent
 * used, and whether the engine lets the parent's inline value survive that is
 * unverified, so the nearest definition is shown and its source named.
 */
export function resolveGroup(
  reader: Reader,
  sources: PrefabSource[],
  locate: (s: PrefabSource, index: number) => BlockRange | null,
  keys: readonly string[],
  subBlock?: string
): ResolvedGroup {
  const found: ResolvedGroup = {};
  const pending = () => keys.filter((k) => found[k] === undefined);
  sources.forEach((s, i) => {
    if (pending().length === 0) return;
    const range = locate(s, i);
    if (!range) return;
    const target = subBlock ? findChildBlock(s.text.split(/\r?\n/), range, subBlock) : range;
    if (target) {
      for (const [k, v] of Object.entries(readFields(s.text, target, pending()))) found[k] = { value: v, source: s.kind, file: s.file };
    }
    const chain = collectFromConfChain(blockReference(s.text, range), { read: reader.ref, subBlock, keys: pending() });
    for (const [k, f] of Object.entries(chain)) found[k] = { value: f.value, source: viaConf(s), file: f.file };
  });
  const out: ResolvedGroup = {};
  for (const k of keys) out[k] = found[k] ?? { value: null, source: "unresolved" };
  return out;
}

export interface ResolvedArray {
  value: number[] | null;
  source: ValueSource | "unresolved";
  file?: string;
  /** A nearer source adds entries with `+{ }`; they are not merged into `value`. */
  appended: boolean;
}

/**
 * A numeric array such as Gearbox `Forward`, from the nearest plain `Name { }` block
 * (inline, then conf chain). shortcut: a nearer `Name +{ }` is only flagged, not merged
 * into the base list, upgrade when the page has to edit the appended entries.
 */
export function resolveArray(
  reader: Reader,
  sources: PrefabSource[],
  locate: (s: PrefabSource) => BlockRange | null,
  name: string
): ResolvedArray {
  let appended = false;
  for (const s of sources) {
    const range = locate(s);
    if (!range) continue;
    const inline = readArrays(s.text, range, name);
    const plain = inline.find((a) => !a.append);
    if (plain) return { value: plain.values, source: s.kind, file: s.file, appended };
    if (inline.some((a) => a.append)) appended = true;
    let hit: ResolvedArray | null = null;
    walkConfChain(blockReference(s.text, range), reader.ref, (text, file) => {
      const root = rootRange(text);
      const p = root && readArrays(text, root, name).find((a) => !a.append);
      if (p) hit = { value: p.values, source: viaConf(s), file, appended };
      return !!p;
    });
    if (hit) return hit;
  }
  return { value: null, source: "unresolved", appended };
}
