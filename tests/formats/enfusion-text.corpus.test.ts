import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { parseAll, serializeAll, type EnfusionNode } from "../../src/formats/enfusion-text.js";
import { buildDelta, mergeOverride } from "../../src/formats/config-override.js";
import { PakVirtualFS } from "../../src/pak/vfs.js";

// Read-only round trip over real files. Runs only when ENFUSION_CORPUS_DIRS lists addon folders
// (";"-separated); the vanilla paks are added when the game is installed. Nothing is written.
const DIRS = (process.env.ENFUSION_CORPUS_DIRS ?? "").split(";").filter(Boolean);
const GAME = "C:/Program Files (x86)/Steam/steamapps/common/Arma Reforger";
const EXTS = new Set([".et", ".conf", ".ct", ".layer", ".ent", ".gproj", ".meta", ".acp", ".layout", ".agf", ".agr", ".ast", ".asi", ".aw"]);
// Known malformed files may throw: a stray brace, the legacy graph format, unescaped quotes
const MAY_THROW = [
  "Prefabs/Structures/Rush/CRF_Rush_MCOM_NoNet.et",
  "Assets/Weapons/Handguns/workspaces/pistol_graphs.agr",
  "UI/layouts/HUD/QuickMenu/QuickMenu.layout",
  "UI/layouts/Test/PreviewRichText_AsianFontTesting.layout",
];

const norm = (s: string) => s.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\s+$/, "");
// Independent of the module's tokenizer: strings (only \" escaped), braces and colons, bare words
const tokens = (s: string) => JSON.stringify(s.match(/"(?:\\"|[^"])*"|[{}:]|[^\s"{}:]+/g) ?? []);

function* walk(dir: string, root = dir): Generator<[string, string]> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, root);
    else if (EXTS.has(extname(e.name).toLowerCase())) yield [p.slice(root.length + 1).replace(/\\/g, "/"), readFileSync(p, "utf-8")];
  }
}

function* paks(): Generator<[string, string]> {
  const vfs = PakVirtualFS.get(GAME)!;
  for (const p of vfs.allFilePaths()) if (EXTS.has(extname(p).toLowerCase())) yield [p, vfs.readTextFile(p)];
}

function roundTrip(label: string, files: Iterable<[string, string]>) {
  const byExt: Record<string, number> = {};
  const r = { files: 0, binary: 0, identical: 0, tokenEqual: [] as string[], changed: [] as string[], threw: [] as string[], mergeChanged: [] as string[] };
  for (const [path, text] of files) {
    if (text.includes("\0")) { r.binary++; continue; }
    r.files++;
    const ext = extname(path).toLowerCase();
    byExt[ext] = (byExt[ext] ?? 0) + 1;
    let nodes: EnfusionNode[];
    try {
      nodes = parseAll(text);
    } catch (e) {
      (MAY_THROW.some((m) => path.endsWith(m)) ? r.threw : r.changed).push(`${path}: ${(e as Error).message}`);
      continue;
    }
    const out = serializeAll(nodes);
    if (norm(out) === norm(text)) {
      r.identical++;
      // An override merge with nothing to change must give the file back byte for byte
      if (nodes.length === 1 && (ext === ".conf" || ext === ".et") && mergeOverride(text, buildDelta(nodes[0], []).delta) !== text) r.mergeChanged.push(path);
    } else if (tokens(out) === tokens(text)) r.tokenEqual.push(path);
    else r.changed.push(path);
  }
  console.log(`${label}: ${r.files} text files (${r.binary} binary skipped), ${r.identical} identical, ${r.tokenEqual.length} token-equal only, ` +
    `${r.changed.length} changed, ${r.threw.length} known malformed threw, ${r.mergeChanged.length} changed by an empty merge; ${JSON.stringify(byExt)}`);
  for (const [name, list] of Object.entries({ changed: r.changed, threw: r.threw, "token-equal only": r.tokenEqual, "empty merge changed": r.mergeChanged })) {
    for (const f of list.slice(0, 20)) console.log(`  ${name}: ${f}`);
  }
  expect(r.changed).toEqual([]);
  expect(r.mergeChanged).toEqual([]);
}

describe.skipIf(!DIRS.length)("enfusion-text corpus round trip", () => {
  it.skipIf(!existsSync(`${GAME}/addons/data`))("vanilla paks", () => roundTrip("vanilla", paks()), 600_000);
  for (const dir of DIRS) it(dir, () => roundTrip(dir, walk(dir)), 600_000);
});
