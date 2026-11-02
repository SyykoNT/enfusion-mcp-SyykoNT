import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parse, getProperty } from "../formats/enfusion-text.js";
import type { RdbEntry } from "../pak/rdb.js";
import type { Layer } from "../pak/stack.js";
import { checkGproj } from "../tools/mod.js";
import { handlerFiles } from "../workbench/cli.js";
import type { GitState } from "./git.js";
import { readPngJpegSize, type AddonScan } from "./scan.js";
import { textStyleStrict, workshopNameIssues } from "./workshop-rules.js";

export type Level = "blocker" | "warning" | "info";
export type Check = "root" | "handlers" | "git" | "gproj" | "meta" | "leftovers" | "text" | "size" | "preview" | "overrides";
export interface Finding { id: string; level: Level; check: Check; message: string; path?: string; fix?: string }

const HANDLER_DIR = "Scripts/WorkbenchGame/EnfusionMCP";
const SOURCE_IMAGES = [".png", ".tga", ".tif", ".tiff", ".dds", ".jpg"];
const PLATFORMS = ["PC", "XBOX_ONE", "XBOX_SERIES", "PS4", "PS5", "HEADLESS"];
const PREVIEW_MAX = 2 * 1024 * 1024;
const RESCAN = "Headless rescan: -gproj <gproj> -addonsDir <dirs> -wbModule=ResourceManager -wbSilent -exitAfterInit";
const list = (xs: string[], n = 10) => xs.slice(0, n).join(", ") + (xs.length > n ? `, and ${xs.length - n} more` : "");
const lower = (s: string) => s.toLowerCase();

/** H1 the MCP's own handler files, H2 anything else in their folder (it ships too). */
export function checkHandlers(addonDir: string): Finding[] {
  const files = handlerFiles(addonDir).filter((f) => f !== `${HANDLER_DIR}.meta`);
  const ours = files.filter((f) => /^EMCP_/i.test(posix.basename(f)));
  const other = files.filter((f) => !ours.includes(f));
  const out: Finding[] = [];
  if (ours.length) {
    out.push({ id: "H1", level: "blocker", check: "handlers", path: HANDLER_DIR, message: `${ours.length} MCP handler files in ${HANDLER_DIR}`, fix: `wb_cleanup on this addon, then restart Workbench before more wb_* calls` });
  }
  if (other.length) {
    out.push({ id: "H2", level: "warning", check: "handlers", path: HANDLER_DIR, message: `Other files in ${HANDLER_DIR} would ship too: ${list(other)}`, fix: "wb_cleanup keeps them; move them out of the addon before a pack" });
  }
  return out;
}

/** P1 to P4: the .gproj parses with ID, GUID and base dependency; TITLE fits the Publish dialog; all platforms; one .gproj. */
export function checkGprojFindings(addonDir: string): Finding[] {
  const gprojs = readdirSync(addonDir).filter((f) => /\.gproj$/i.test(f));
  const out: Finding[] = checkGproj(addonDir)
    .filter((i) => i.level !== "info")
    .map((i) => ({ id: "P1", level: "blocker" as const, check: "gproj" as const, message: i.message }));
  if (gprojs.length > 1) out.push({ id: "P4", level: "warning", check: "gproj", message: `${gprojs.length} .gproj files: ${gprojs.join(", ")}` });
  if (!gprojs.length || out.some((f) => /Failed to parse/.test(f.message))) return out;
  const node = parse(readFileSync(join(addonDir, gprojs[0]), "utf-8"));
  const title = getProperty(node, "TITLE");
  const issues = typeof title === "string" ? workshopNameIssues(title) : [];
  if (issues.length) {
    out.push({ id: "P2", level: "warning", check: "gproj", path: gprojs[0], message: `TITLE "${title}" breaks the Publish dialog rules: ${issues.join("; ")}`, fix: "Use a Workshop Project Name of at most 30 letters, digits, spaces, dots, dashes or underscores" });
  }
  const configs = node.children.find((c) => c.type === "Configurations")?.children.map((c) => String(c.id || getProperty(c, "name") || c.type)) ?? [];
  const missing = PLATFORMS.filter((p) => !configs.includes(p));
  if (missing.length) out.push({ id: "P3", level: "info", check: "gproj", path: gprojs[0], message: `Configurations missing: ${missing.join(", ")}` });
  return out;
}

/** Owners of resource GUIDs outside this addon (base game and dependencies): GUID to path and addon name. */
export type GuidOwners = Map<string, { path: string; addon: string }>;

/** M1 to M7: meta names, rdb registration, orphans, duplicate and shared GUIDs, missing metas, mission config images. */
export function checkMeta(addonDir: string, scan: AddonScan, rdb: Map<string, RdbEntry> | null, owners?: GuidOwners): Finding[] {
  const out: Finding[] = [];
  const files = new Set(scan.files.map((f) => lower(f.rel)));
  const dirs = new Set(scan.files.flatMap((f) => f.rel.split("/").slice(0, -1).map((_, i, a) => lower(a.slice(0, i + 1).join("/")))));
  const exists = (rel: string) => files.has(lower(rel)) || dirs.has(lower(rel));
  const hasSource = (stem: string, exts: string[]) => exts.some((e) => files.has(lower(stem + e)));
  if (!rdb) out.push({ id: "M2", level: "warning", check: "meta", message: "No resourceDatabase.rdb: registration not checked", fix: RESCAN });

  const byGuid = new Map<string, string[]>();
  for (const m of scan.metas) {
    const actual = m.rel.replace(/\.meta$/i, "");
    if (m.guid) byGuid.set(m.guid, [...(byGuid.get(m.guid) ?? []), m.rel]);
    if (m.guid && m.namePath && m.namePath !== actual) {
      const caseOnly = lower(m.namePath) === lower(actual);
      out.push({ id: "M1", level: "info", check: "meta", path: m.rel, message: `Meta Name is "${m.namePath}"${caseOnly ? " (case only)" : ""}`, fix: "Resave in Workbench, or fix the path in the meta" });
    }
    if (!exists(actual)) {
      const ext = posix.extname(actual).toLowerCase();
      const stem = actual.slice(0, actual.length - ext.length);
      const known = ext === ".edds" ? SOURCE_IMAGES : ext === ".xob" ? [".fbx", ".txo"] : [];
      if (hasSource(stem, known)) continue;
      const other = scan.files.find((f) => lower(f.rel).startsWith(lower(`${stem}.`)) && !/\.meta$/i.test(f.rel));
      out.push(other
        ? { id: "M3", level: "info", check: "meta", path: m.rel, message: `No ${posix.basename(actual)}; beside it only ${posix.basename(other.rel)} (source type unknown)` }
        : { id: "M3", level: "warning", check: "meta", path: m.rel, message: `Orphan meta: no ${posix.basename(actual)}${known.length ? " and no source" : ""}`, fix: "Restore the file, or remove the meta (after the user agrees)" });
      continue;
    }
    // Scripts sit in the rdb with an all-zero GUID, which the parser drops
    if (rdb && m.guid && files.has(lower(actual)) && !/\.c$/i.test(actual)) {
      const e = rdb.get(lower(actual));
      if (!e) out.push({ id: "M2", level: "warning", check: "meta", path: actual, message: "Not in resourceDatabase.rdb", fix: `${RESCAN}, or open the addon in Workbench` });
      else if (e.guid !== m.guid) out.push({ id: "M2", level: "warning", check: "meta", path: actual, message: `rdb GUID ${e.guid} differs from the meta's ${m.guid}` });
    }
    const o = m.guid ? owners?.get(m.guid) : undefined;
    if (o) {
      out.push(lower(o.path) === lower(actual)
        ? { id: "M5", level: "info", check: "meta", path: actual, message: `Overrides ${o.addon}'s ${o.path} (same GUID and path)` }
        // Whether a same-GUID file at another path works as an override is unverified, so this cannot block
        : { id: "M5", level: "warning", check: "meta", path: actual, message: `Same GUID ${m.guid} as ${o.addon}'s ${o.path}: a deliberate override by GUID, or a copied meta`, fix: "If it is a copy, give it a new GUID" });
    }
  }
  for (const [guid, rels] of byGuid) {
    if (rels.length > 1) out.push({ id: "M4", level: "blocker", check: "meta", message: `GUID ${guid} declared by ${rels.length} metas: ${list(rels)}`, fix: "New GUID for all but one (never copy metas)" });
  }
  for (const f of scan.files) {
    if (/\.(et|conf|ent)$/i.test(f.rel) && !files.has(lower(`${f.rel}.meta`))) {
      out.push({ id: "M6", level: "warning", check: "meta", path: f.rel, message: "No .meta", fix: "Register it in Workbench, or rescan" });
    }
  }
  const eddsMetas = new Map(scan.metas.filter((m) => m.guid && /\.edds\.meta$/i.test(m.rel)).map((m) => [m.guid, m.rel.replace(/\.edds\.meta$/i, "")]));
  for (const f of scan.files.filter((x) => /\.conf$/i.test(x.rel))) {
    let text: string;
    try {
      text = readFileSync(join(addonDir, f.rel), "utf-8");
    } catch {
      continue; // listed as unreadable by the walk
    }
    // BI names mission config images; gearscripts pointing at compiled-only flag images publish fine (CRF)
    if (!/^\uFEFF?\s*\w*MissionHeader\b/.test(text)) continue;
    for (const r of text.matchAll(/\{([0-9A-Fa-f]{16})\}[^"\s{}]*\.edds/gi)) {
      const stem = eddsMetas.get(r[1].toUpperCase());
      if (stem !== undefined && !hasSource(stem, SOURCE_IMAGES)) {
        out.push({ id: "M7", level: "blocker", check: "meta", path: f.rel, message: `Points at ${stem}.edds, which has no source image beside it`, fix: 'BI: "Creating bundle failed" on publish; restore the source image' });
      }
    }
  }
  return out;
}

/** L1 leftover files and folders, L2 material assigns Workbench rewrote to its fallback emat. */
export function checkLeftovers(addonDir: string, scan: AddonScan): Finding[] {
  const out = new Map<string, Finding>();
  for (const f of scan.files) {
    const parts = f.rel.split("/");
    const at = parts.slice(0, -1).findIndex((p) => /^(temp|__pycache__)$/i.test(p));
    const name = parts[parts.length - 1];
    const path = at >= 0 ? `${parts.slice(0, at + 1).join("/")}/` : /\.(tmp|bak|orig|blend1)$|~$|^Thumbs\.db$|\$\w|%\w+%/i.test(name) ? f.rel : null;
    if (path && !out.has(path)) out.set(path, { id: "L1", level: "warning", check: "leftovers", path, message: `Leftover: ${path}`, fix: "Delete it only after the user agrees" });
  }
  for (const m of scan.metas.filter((x) => /\.xob\.meta$/i.test(x.rel))) {
    const modelDir = posix.dirname(m.rel);
    let text: string;
    try {
      text = readFileSync(join(addonDir, m.rel), "utf-8");
    } catch {
      continue;
    }
    for (const a of text.matchAll(/SourceMaterial\s+"([^"]+)"\s+AssignedMaterial\s+"(?:\{[0-9A-Fa-f]{16}\})?([^"]+)"/g)) {
      if (lower(a[2]) === lower(`${modelDir}/Data/${a[1]}.emat`)) {
        out.set(`${m.rel}|${a[1]}`, { id: "L2", level: "warning", check: "leftovers", path: m.rel, message: `${a[1]} is assigned ${a[2]}, the path Workbench uses for its fallback material`, fix: "Check it is the intended material, not Workbench's white default" });
      }
    }
  }
  return [...out.values()];
}

const PUBLIC_TEXT = /^(readme[^/]*|license[^/]*|credits[^/]*|\.github\/.+\.md)$/i;

/** T1 BOM scripts, T2 dashes or AI names in public text (only with ENFUSION_TEXT_STYLE=strict), T3 dev-only code, C1 licence and credits reminders. */
export function checkText(addonDir: string, scan: AddonScan): Finding[] {
  const out: Finding[] = [];
  const read = (rel: string) => readFileSync(join(addonDir, rel));
  const devCode: string[] = [];
  for (const f of scan.files) {
    if (/\.c$/i.test(f.rel)) {
      const b = read(f.rel);
      if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) out.push({ id: "T1", level: "blocker", check: "text", path: f.rel, message: "Starts with a UTF-8 BOM (Enforce rejects it)", fix: "Rewrite it without the BOM" });
      if (/#ifdef\s+(ENABLE_DIAG|WORKBENCH)\b/.test(b.toString("utf-8"))) devCode.push(f.rel);
    }
    if (textStyleStrict() && PUBLIC_TEXT.test(f.rel)) {
      const t = read(f.rel).toString("utf-8");
      const hits = [...new Set([...(t.match(/[\u2013\u2014]/g) ?? []).map(() => "en or em dash"), ...(t.match(/\b(claude|anthropic)\b/gi) ?? [])])];
      if (hits.length) out.push({ id: "T2", level: "warning", check: "text", path: f.rel, message: `Public text has ${hits.join(", ")}`, fix: "Public text style: no dashes, no AI names" });
    }
  }
  const devDirs = [...new Set(scan.files.map((f) => f.rel.match(/^(Scripts\/(?:.+\/)?(?:Dev|Tests))\//)?.[1]).filter((d): d is string => !!d))];
  if (devCode.length || devDirs.length) {
    out.push({ id: "T3", level: "info", check: "text", message: `Dev-only code: ${[...devDirs.map((d) => `${d}/`), ...devCode].length} places (${list([...devDirs.map((d) => `${d}/`), ...devCode], 5)})`, fix: "Compile once on a non-diag server" });
  }
  const has = (re: RegExp) => scan.files.filter((f) => re.test(f.rel)).map((f) => f.rel);
  if (!has(/^license\.txt$/i).length) out.push({ id: "C1", level: "info", check: "text", message: "No license.txt (needed only for a Custom licence)" });
  const credits = has(/^(readme|credits)[^/]*$/i);
  if (credits.length) out.push({ id: "C1", level: "info", check: "text", message: `${credits.join(", ")} ${credits.length > 1 ? "are" : "is"} not packed: put credits in the Workshop description` });
  return out;
}

export interface Sizes { packableBytes: number; largest: [string, number][] }

/** Files that do not ship: metas and texture import settings (per BI), repo-only files. */
const notPacked = (rel: string) => /\.(meta|txa|txo)$/i.test(rel) || /^\.github\//i.test(rel) || /^(readme|license|credits)[^/]*$/i.test(rel);

/** S1 packable size and the 10 largest files. */
export function checkSize(scan: AddonScan): { findings: Finding[]; sizes: Sizes } {
  const packable = scan.files.filter((f) => !notPacked(f.rel));
  const sizes: Sizes = {
    packableBytes: packable.reduce((n, f) => n + f.size, 0),
    largest: [...packable].sort((a, b) => b.size - a.size).slice(0, 10).map((f) => [f.rel, f.size]),
  };
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
  return { findings: [{ id: "S1", level: "info", check: "size", message: `About ${mb(sizes.packableBytes)} packable in ${packable.length} files; largest ${sizes.largest.slice(0, 3).map(([r, s]) => `${r} (${mb(s)})`).join(", ")}` }], sizes };
}

/** S2 files byte-identical to the copy a dependency already ships at the same path (topmost dependency first). */
export function checkOverrides(addonDir: string, scan: AddonScan, deps: Layer[]): Finding[] {
  const out: Finding[] = [];
  for (const f of scan.files.filter((x) => !notPacked(x.rel))) {
    const dep = [...deps].reverse().find((l) => l.exists(f.rel));
    const theirs = dep?.read(f.rel);
    if (dep && theirs && theirs.length === f.size && theirs.equals(readFileSync(join(addonDir, f.rel)))) {
      out.push({ id: "S2", level: "warning", check: "overrides", path: f.rel, message: `Byte-identical to ${dep.title || dep.id}'s copy`, fix: "Drop it from the addon" });
    }
  }
  return out;
}

/** V1 preview image: present, PNG or JPG, at most 2 MB; info when not 1920x1080. */
export function checkPreview(addonDir: string, scan: AddonScan, previewImage?: string): Finding[] {
  const path = previewImage ?? ["thumbnail.png", ".github/preview.png"].map((r) => scan.files.find((f) => lower(f.rel) === r)?.rel).find(Boolean);
  if (!path) return [{ id: "V1", level: "warning", check: "preview", message: "No preview image (thumbnail.png or .github/preview.png), and none passed", fix: "PNG or JPG, at most 2 MB, 1920x1080" }];
  let buf: Buffer;
  try {
    buf = readFileSync(previewImage ? path : join(addonDir, path));
  } catch (e) {
    return [{ id: "V1", level: "warning", check: "preview", path, message: `Cannot read the preview: ${(e as Error).message}` }];
  }
  const img = readPngJpegSize(buf);
  if (!img) return [{ id: "V1", level: "warning", check: "preview", path, message: "Preview is not a PNG or JPG" }];
  const out: Finding[] = [];
  if (buf.length > PREVIEW_MAX) out.push({ id: "V1", level: "warning", check: "preview", path, message: `Preview is ${buf.length} bytes, over the 2 MB limit` });
  if (img.width !== 1920 || img.height !== 1080) out.push({ id: "V1", level: "info", check: "preview", path, message: `Preview is ${img.width}x${img.height}; 1920x1080 recommended` });
  return out;
}

/** G1 to G6 from the repo state. */
export function checkGit(s: GitState): Finding[] {
  if (!s.repo) return [{ id: "G6", level: "info", check: "git", message: s.note ?? "Not a git repository: git checks skipped" }];
  const out: Finding[] = [];
  const changed = s.porcelain.filter((p) => !p.startsWith("??")).map((p) => p.slice(3));
  const untracked = s.porcelain.filter((p) => p.startsWith("??")).map((p) => p.slice(3)).filter((p) => /\.(et|conf|ent|layer|meta|c|emat|edds|png|tga|tif|tiff|dds|jpg|fbx|xob|txo|nmn|ntile)$/i.test(p));
  if (changed.length) out.push({ id: "G1", level: "blocker", check: "git", message: `${changed.length} staged or modified tracked files: ${list(changed)}`, fix: "Commit or revert; show the user the list" });
  if (untracked.length) out.push({ id: "G1", level: "blocker", check: "git", message: `${untracked.length} untracked resource files: ${list(untracked)}`, fix: "Commit them or ignore them; show the user the list" });
  if (s.trackedForbidden.length) out.push({ id: "G2", level: "blocker", check: "git", message: `Tracked or staged: ${list(s.trackedForbidden)}`, fix: "git rm --cached (ask the user first)" });
  if (!s.ignoresHandlers) out.push({ id: "G3", level: "warning", check: "git", message: `${HANDLER_DIR}/ is not ignored`, fix: "Add it to .git/info/exclude (local) or .gitignore (own repos)" });
  if (!s.hasCommitMsgHook) out.push({ id: "G4", level: "warning", check: "git", message: "No commit-msg hook (strips AI tool attribution)", fix: "addon_git_guard install" });
  if (s.scanError) out.push({ id: "G5", level: "blocker", check: "git", message: `Unpushed commit messages could not be scanned for AI attribution: ${s.scanError}`, fix: "Run git log in the repo to see why, then audit again" });
  if (s.aiMessages.length) out.push({ id: "G5", level: "blocker", check: "git", message: `${s.aiMessages.length} unpushed commits carry AI tool attribution: ${list(s.aiMessages)}`, fix: "Remove the lines (git commit --amend for the last commit, or an interactive rebase for older ones); for an AI author, recommit under your own name. Human Co-Authored-By lines are fine." });
  if (s.note) out.push({ id: "G6", level: "info", check: "git", message: s.note });
  if (s.unborn) out.push({ id: "G6", level: "info", check: "git", message: "No commit yet" });
  else out.push({ id: "G6", level: "info", check: "git", message: s.note ? `Branch ${s.branch}` : s.upstream ? `Branch ${s.branch}, upstream ${s.upstream}, ${s.ahead} commits not pushed` : `Branch ${s.branch} has no upstream; ${s.ahead} commits on no remote branch` });
  return out;
}
