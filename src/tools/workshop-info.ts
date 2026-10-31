import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../config.js";
import { parse, type EnfusionNode } from "../formats/enfusion-text.js";
import { findGproj, resolveAddonDir } from "../utils/game-paths.js";
import { buildStack, type LayerKind } from "../pak/stack.js";
import { readPngJpegSize } from "../release/scan.js";
import { CHANGE_NOTES_MAX, DESCRIPTION_MAX, NAME_MAX, SUMMARY_MAX, workshopNameIssues, workshopTextIssues } from "../release/workshop-rules.js";

export function registerWorkshopInfo(server: McpServer, config: Config): void {
  server.registerTool(
    "workshop_info",
    {
      description:
        "Read Workshop metadata from a mod's .gproj file. Shows mod ID, GUID, title, " +
        "dependencies (named, with the closure), and configurations; lints planned Workshop name, summary, description, " +
        "change notes and preview image; shows the published state from the local Workshop cache and, with online: true, " +
        "the public Workshop page. Useful for checking publish state before releasing. Read only, never publishes.",
      inputSchema: {
        projectPath: z
          .string()
          .optional()
          .describe(
            "Absolute path to the mod directory (containing the .gproj). Uses configured default if omitted."
          ),
        modName: z
          .string()
          .optional()
          .describe(
            "Addon folder name under projectPath (or the projects path); any .gproj inside counts. Defaults to ENFUSION_DEFAULT_MOD."
          ),
        name: z.string().optional().describe("Planned Workshop Project Name to lint (default: the .gproj TITLE)"),
        summary: z.string().optional().describe("Planned Workshop summary to lint"),
        description: z.string().optional().describe("Planned Workshop description to lint"),
        changeNotes: z.string().optional().describe("Planned change notes to lint"),
        textFiles: z
          .object({ summary: z.string().optional(), description: z.string().optional(), changeNotes: z.string().optional() })
          .optional()
          .describe("Paths of UTF-8 text files to lint instead of passing the text"),
        previewImage: z.string().optional().describe("Preview image to check: PNG or JPG, at most 2 MB, 1920x1080 recommended"),
        online: z.boolean().optional().describe("Also read the public Workshop page for this GUID (one anonymous GET, no login). Default false"),
      },
    },
    async ({ projectPath, modName, name, summary, description, changeNotes, textFiles, previewImage, online }) => {
      try {
        const basePath = projectPath || config.projectPath;
        if (!basePath) {
          return {
            content: [
              { type: "text", text: "No project path configured. Set ENFUSION_PROJECT_PATH or provide projectPath parameter." },
            ],
            isError: true,
          };
        }
        // projectPath may be the addon folder itself; otherwise look under it by name (any .gproj name)
        const addonName = modName ?? config.defaultMod;
        const gprojPath = (projectPath && findGproj(projectPath)) || findGproj(resolveAddonDir(basePath, addonName) ?? "");

        if (!gprojPath) {
          return {
            content: [
              {
                type: "text",
                text: `No .gproj found in ${projectPath ? `${projectPath} or ` : ""}${addonName ? join(basePath, addonName) : `any folder under ${basePath}`}.`,
              },
            ],
            isError: true,
          };
        }

        const raw = readFileSync(gprojPath, "utf-8");
        const root = parse(raw);

        const id = getProperty(root, "ID") || "(unknown)";
        const guid = getProperty(root, "GUID") || "(unknown)";
        const title = getProperty(root, "TITLE") || id;

        // Extract dependencies
        const deps: string[] = [];
        const depNode = findChild(root, "Dependencies");
        if (depNode) {
          for (const val of depNode.values) {
            deps.push(String(val));
          }
        }

        // Extract configurations
        const configs: string[] = [];
        const configsNode = findChild(root, "Configurations");
        if (configsNode) {
          for (const child of configsNode.children) {
            const name = child.id || getProperty(child, "name") || child.type;
            if (name) configs.push(name);
          }
        }

        const lines: string[] = [];
        lines.push("**Workshop Info**\n");
        lines.push(`- **ID:** ${id}`);
        lines.push(`- **GUID:** ${guid}`);
        lines.push(`- **Title:** ${title}`);
        lines.push(`- **File:** ${gprojPath}`);

        const depInfo = dependencyLines(config, gprojPath, deps);
        if (deps.length > 0) {
          lines.push(`\n### Dependencies (${deps.length})`);
          lines.push(...depInfo.lines);
        }

        if (configs.length > 0) {
          lines.push(`\n### Configurations`);
          for (const cfg of configs) {
            lines.push(`- ${cfg}`);
          }
        }

        lines.push("\n### Workshop text");
        lines.push(...lintLines(dirname(gprojPath), title, name ?? title, { summary, description, changeNotes }, textFiles ?? {}));

        if (previewImage) lines.push("\n### Preview", previewLine(previewImage));

        lines.push("\n### Published state", cacheLine(config, guid));
        if (online) lines.push(...(await onlineLines(guid, depInfo.closure)));

        lines.push("\nPublishing is done by Don in Workbench > Publish Project (first publish in the GUI). This tool does not publish.");

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Error reading workshop info: ${msg}` }],
        isError: true,
        };
      }
    }
  );
}

type TextField = "summary" | "description" | "changeNotes";
const TEXT_MAX: Record<TextField, number> = { summary: SUMMARY_MAX, description: DESCRIPTION_MAX, changeNotes: CHANGE_NOTES_MAX };

/** One line per Workshop field given (the name always), plus the licence file and credits reminder. */
function lintLines(addonDir: string, title: string, name: string, text: Partial<Record<TextField, string>>, files: Partial<Record<TextField, string>>): string[] {
  const nameIssues = workshopNameIssues(name);
  const lines = [`- name: ${nameIssues.length ? nameIssues.join("; ") : `ok (${[...name].length}/${NAME_MAX})`}${name !== title ? ` (info: .gproj TITLE is "${title}")` : ""}`];
  for (const f of Object.keys(TEXT_MAX) as TextField[]) {
    let t = text[f];
    if (t === undefined && files[f]) {
      try {
        t = readFileSync(files[f]!, "utf-8").replace(/^\uFEFF/, "").replace(/\r?\n$/, ""); // the dialog gets the text, not the file's last newline
      } catch (e) {
        lines.push(`- ${f}: cannot read ${files[f]}: ${(e as Error).message}`);
        continue;
      }
    }
    if (t === undefined) continue;
    const n = [...t].length;
    const issues = [...(n > TEXT_MAX[f] ? [`${n}/${TEXT_MAX[f]} characters`] : []), ...workshopTextIssues(t)];
    const note = f === "summary" ? " (measured dialog limit; BI documents 1024)" : "";
    lines.push(`- ${f}: ${issues.length ? issues.join("; ") : `ok (${n}/${TEXT_MAX[f]})`}${note}`);
  }
  lines.push(`- licence: license.txt ${existsSync(join(addonDir, "license.txt")) ? "present" : "absent"} (needed only for a Custom licence)`);
  // README and CREDITS are not packed, so credits they carry must go in the description
  const credits = readdirSync(addonDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /^(readme|credits)/i.test(e.name) && /credit|licen[cs]e/i.test(readFileSync(join(addonDir, e.name), "utf-8")))
    .map((e) => e.name);
  if (credits.length) lines.push(`- reminder: ${credits.join(", ")} mention credits or a licence; these files are not packed, so put that text in the description`);
  return lines;
}

const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

function previewLine(path: string): string {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (e) {
    return `- cannot read ${path}: ${(e as Error).message}`;
  }
  const img = readPngJpegSize(buf);
  if (!img) return `- ${path}: not a PNG or JPG`;
  const issues = [
    ...(buf.length > PREVIEW_MAX_BYTES ? [`${buf.length} bytes, over the 2 MB limit`] : []),
    ...(img.width !== 1920 || img.height !== 1080 ? [`info: ${img.width}x${img.height}, 1920x1080 recommended`] : []),
  ];
  return `- ${img.format.toUpperCase()} ${img.width}x${img.height}, ${buf.length} bytes: ${issues.length ? issues.join("; ") : "ok"}`;
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf-8").replace(/^\uFEFF/, ""));

/** What the local Workshop cache (a subscribed copy) says about this GUID. */
function cacheLine(config: Config, guid: string): string {
  const root = config.workshopPath;
  let dir: string | undefined;
  try {
    dir = root ? readdirSync(root).find((d) => d.toUpperCase().endsWith(`_${guid.toUpperCase()}`)) : undefined;
  } catch {
    // no cache folder: same as not subscribed
  }
  if (!root || !dir) return `- Workshop cache: no folder for ${guid} in ${root ?? "(no Workshop path)"} (not subscribed or not published)`;
  try {
    const installed = readJson(join(root, dir, "ServerData.json")).revision?.version;
    const m = readJson(join(root, dir, "meta")).meta ?? {};
    const versions = (m.versions ?? []).map((v: { version?: string }) => v.version).join(", ");
    return `- Workshop cache ${dir}: installed ${installed ?? "?"}; name "${m.name}"; summary "${m.summary ?? ""}"; licence ${m.license ?? "?"}; versions ${versions || "?"}`;
  } catch (e) {
    return `- Workshop cache ${dir}: unreadable (${(e as Error).message})`;
  }
}

// The base game addons are implied, the Workshop page does not list them
const VANILLA = new Set(["58D0FB3206B6F859", "5614BBCCBB55ED1C"]);

/** Next patch version (each part at most 32000 per BI), or why there is none. */
export function nextVersion(v: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) return `none (version "${v}" is not x.y.z)`;
  const patch = Number(m[3]) + 1;
  return patch <= 32000 ? `${m[1]}.${m[2]}.${patch}` : "none (patch would pass 32000; bump the minor version)";
}

interface PageAsset {
  name?: string;
  license?: string | { name?: string };
  currentVersionNumber?: string;
  currentVersionSize?: number;
  gameVersion?: string;
  versions?: { version?: string; approved?: boolean }[];
  dependencies?: { asset?: { id?: string; name?: string }; version?: string }[];
  tags?: (string | { name?: string })[];
  previews?: { width?: number; height?: number }[];
  dependencyTree?: { deletedAt?: string | null };
}

/** The public Workshop page's state for this GUID (anonymous GET; undocumented page JSON, so every failure is one line). */
async function onlineLines(guid: string, closure: string[]): Promise<string[]> {
  const id = guid.toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(id)) return [`- online check failed: GUID "${guid}" is not 16 hex digits`];
  const url = `https://reforger.armaplatform.com/workshop/${id}`;
  let asset: PageAsset | undefined;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) return [`- online (${url}): not published yet (HTTP 404)`];
    if (!res.ok) return [`- online check failed: HTTP ${res.status} from ${url}`];
    const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(await res.text());
    if (!m) return [`- online check failed: no __NEXT_DATA__ on ${url}`];
    asset = JSON.parse(m[1])?.props?.pageProps?.asset;
  } catch (e) {
    return [`- online check failed: ${(e as Error).message}`];
  }
  if (!asset) return [`- online check failed: page JSON has no props.pageProps.asset (layout changed?)`];
  if (asset.dependencyTree?.deletedAt) return [`- online (${url}): deleted from the Workshop (${asset.dependencyTree.deletedAt})`];

  const or = (v: unknown, field: string) => (v === undefined || v === null ? `(no ${field})` : String(v));
  const cur = asset.currentVersionNumber;
  const latest = asset.versions?.find((v) => v.version === cur);
  const lic = typeof asset.license === "object" ? asset.license?.name : asset.license;
  const deps = asset.dependencies ?? [];
  const published = new Set(deps.map((d) => (d.asset?.id ?? "").toUpperCase()));
  const local = new Set(closure.filter((g) => !VANILLA.has(g)));
  const onlyPublished = [...published].filter((g) => !local.has(g));
  const onlyLocal = [...local].filter((g) => !published.has(g));
  const p = asset.previews?.[0];
  return [
    `- online (${url}): name "${or(asset.name, "name")}"; version ${or(cur, "currentVersionNumber")} (${latest ? (latest.approved ? "approved" : "not approved") : "approval unknown"}); gameVersion ${or(asset.gameVersion, "gameVersion")}; size ${or(asset.currentVersionSize, "currentVersionSize")}; licence ${or(lic, "license")}`,
    `- tags: ${(asset.tags ?? []).map((t) => (typeof t === "string" ? t : t.name)).join(", ") || "none"}; preview ${p ? `${p.width}x${p.height}` : "none"}`,
    `- published dependencies (${deps.length}): ${deps.map((d) => `${d.asset?.name ?? "?"} ${d.asset?.id ?? "?"} ${d.version ?? ""}`.trim()).join("; ") || "none"}`,
    `- dependencies vs local closure: ${onlyPublished.length || onlyLocal.length ? `only published: ${onlyPublished.join(", ") || "none"}; only local: ${onlyLocal.join(", ") || "none"}` : "same"}`,
    `- next version: ${cur ? nextVersion(cur) : "unknown"}`,
  ];
}

const SOURCE: Record<LayerKind, string> = { loose: "local", workshop: "workshop", vanilla: "game" };

/** Direct dependencies named from the addon stack, and the closure's GUIDs (missing ones included). Raw GUIDs when the stack cannot be built. */
function dependencyLines(config: Config, gproj: string, deps: string[]): { lines: string[]; closure: string[] } {
  try {
    const stack = buildStack(config, gproj);
    const layers = stack.layers.slice(0, -1); // the last layer is the addon itself
    const byGuid = new Map(layers.map((l) => [l.guid, l]));
    // RL-N3 (addon_deps) adds installed versions to these lines
    const lines = deps.map((d) => {
      const l = byGuid.get(d.toUpperCase());
      return l ? `- ${d} ${l.title || l.id} (${SOURCE[l.kind]})` : `- ${d} (missing: not in a local project, the Workshop cache or the base game)`;
    });
    lines.push(`Closure: ${layers.length} addons found${stack.missing.length ? `, ${stack.missing.length} missing (${stack.missing.join(", ")})` : ""}`);
    return { lines, closure: [...layers.map((l) => l.guid), ...stack.missing] };
  } catch (e) {
    return { lines: [...deps.map((d) => `- ${d}`), `(names unavailable: ${(e as Error).message})`], closure: deps.map((d) => d.toUpperCase()) };
  }
}

function getProperty(node: EnfusionNode, key: string): string {
  for (const prop of node.properties) {
    if (prop.key === key) return String(prop.value ?? "");
  }
  return "";
}

function findChild(node: EnfusionNode, type: string): EnfusionNode | null {
  return node.children.find((c) => c.type === type) || null;
}
