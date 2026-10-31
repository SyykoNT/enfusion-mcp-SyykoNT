import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { basename } from "node:path";
import type { Config } from "../config.js";
import { parse, createNode, type EnfusionNode } from "../formats/enfusion-text.js";
import { mergeNode, stripGuid } from "../formats/config-override.js";
import { buildStack, pathOfGuid, type Layer, type Stack } from "../pak/stack.js";
import { pageLines } from "../utils/paging.js";

/**
 * Offline effective view of a prefab or config across an addon stack: the inheritance chain,
 * then every same-path override in load order, with the layer that set each property.
 */

export interface Provider { layer: Layer; guid?: string; role: "defines" | "overrides" | "shadows" }

/** Layers that ship path. The first defines it; later ones override it with the same GUID, or shadow it with another. */
export function providers(layers: Layer[], path: string): Provider[] {
  const out: Provider[] = [];
  for (const layer of layers) {
    if (layer.read(path) === null) continue;
    const guid = layer.guidOf(path);
    out.push({ layer, guid, role: !out.length ? "defines" : guid === out[0].guid ? "overrides" : "shadows" });
  }
  return out;
}

export interface Effective {
  root: EnfusionNode;
  /** `<{ID} path>\t<key>` -> "LayerID:path" of the file that set it last */
  origins: Map<string, string>;
  /** Defining file of each inheritance step, root ancestor first */
  chain: string[];
  applied: number;
  warnings: string[];
}

const MAX_DEPTH = 20;

/** Effective tree of path in this stack, or null when no layer ships it. Throws when no file of it parses. */
export function resolve(layers: Layer[], path: string, warnings: string[] = [], seen = new Set<string>()): Effective | null {
  const provs = providers(layers, path).filter((p) => p.role !== "shadows");
  if (!provs.length) return null;
  seen.add(stripGuid(path).toLowerCase());
  const files = provs.map((p) => {
    const label = `${p.layer.id}:${stripGuid(path)}`;
    const text = p.layer.read(path)!.toString("utf-8");
    text.split(/\r?\n/).forEach((l, i) => {
      if (/^\s*#/.test(l)) warnings.push(`${label} line ${i + 1}: '#' comment, Workbench drops this prefab's components`);
    });
    try {
      return { label, node: parse(text) as EnfusionNode | null };
    } catch (e) {
      warnings.push(`${label}: ${(e as Error).message}; file skipped`);
      return { label, node: null };
    }
  });
  const def = files[0].node;
  const origins = new Map<string, string>();
  let root = createNode(def?.type ?? "");
  let chain: string[] = [], applied = 0;
  if (def?.inheritance) {
    const ref = def.inheritance;
    const guid = ref.match(/^\{([0-9A-Fa-f]{16})\}/)?.[1].toUpperCase();
    // GUID first, as the engine follows it when a parent moved; the path covers parents no rdb knows
    const parent = (guid && pathOfGuid(layers, guid)) || stripGuid(ref);
    if (!parent) warnings.push(`${files[0].label}: parent ${ref} is in no layer`);
    else if (seen.has(parent.toLowerCase()) || seen.size >= MAX_DEPTH) warnings.push(`${files[0].label}: inheritance cycle or deeper than ${MAX_DEPTH} at ${parent}; chain cut`);
    else {
      const eff = resolve(layers, parent, warnings, seen);
      if (!eff) warnings.push(`${files[0].label}: parent ${parent} is in no layer`);
      else {
        ({ root, chain, applied } = eff);
        eff.origins.forEach((v, k) => origins.set(k, v));
      }
    }
  }
  for (const f of files) {
    if (!f.node) continue;
    root = mergeNode(root, f.node, (e) => {
      if (e.kind === "set") origins.set(`${e.path}\t${e.key}`, f.label);
      else warnings.push(`type change: ${e.path} was ${e.from}, is ${e.to} in ${f.label}; properties of the old class may not apply (engine behavior unverified)`);
    });
    applied++;
  }
  if (!files.some((f) => f.node)) throw new Error(`No file of ${stripGuid(path)} parses:\n${warnings.join("\n")}`);
  return { root, origins, chain: [...chain, files[0].label], applied, warnings };
}

export interface FlatProp { key: string; label: string; value: string; origin?: string }

/** One entry per property (and per value list), keyed by `{ID}` path, labelled `Type{ID}` for display. */
export function flat(root: EnfusionNode, origins: Map<string, string>): FlatProp[] {
  const out: FlatProp[] = [];
  const walk = (n: EnfusionNode, key: string, label: string) => {
    for (const p of n.properties) {
      if (typeof p.value !== "string") continue;
      const k = `${key}\t${p.key}`;
      out.push({ key: k, label: label ? `${label}/${p.key}` : p.key, value: p.value, origin: origins.get(k) });
    }
    // shortcut: value lists carry no origin (merge events cover properties only)
    if (n.values.length) out.push({ key: `${key}\t[]`, label: label || "(values)", value: `[${n.values.map((v) => JSON.stringify(v)).join(", ")}]` });
    for (const c of n.children) {
      const name = c.id === undefined ? "" : c.id.startsWith("{") ? c.id : `(${c.id})`; // a bare name is not a GUID
      walk(c, (key ? `${key}/` : "") + (c.id ?? c.type), (label ? `${label}/` : "") + c.type + name);
    }
  };
  walk(root, "", "");
  return out;
}

/** `+` added, `-` removed, `~` changed, each with the origin of its value. */
export function diffFlat(a: FlatProp[], b: FlatProp[]): string[] {
  const at = (o?: string) => (o ? `  <- ${o}` : "");
  const left = new Map(a.map((p) => [p.key, p])), right = new Map(b.map((p) => [p.key, p]));
  const out: string[] = [];
  for (const p of a) {
    const q = right.get(p.key);
    if (!q) out.push(`- ${p.label} = ${p.value}${at(p.origin)}`);
    else if (q.value !== p.value) out.push(`~ ${q.label}: ${p.value}${at(p.origin)}  ->  ${q.value}${at(q.origin)}`);
  }
  for (const q of b) if (!left.has(q.key)) out.push(`+ ${q.label} = ${q.value}${at(q.origin)}`);
  return out;
}

/** Layers up to and including upTo (ID, GUID or folder name). */
function cut(stack: Stack, upTo?: string): Layer[] {
  if (!upTo) return stack.layers;
  const u = upTo.toLowerCase();
  const i = stack.layers.findIndex((l) => [l.id, l.guid, basename(l.root)].some((v) => v.toLowerCase() === u));
  if (i < 0) throw new Error(`upTo "${upTo}" is not in this stack; layers: ${stack.layers.map((l) => l.id).join(", ")}`);
  return stack.layers.slice(0, i + 1);
}

/** A bare `{GUID}` becomes its path through the stack's rdb files. */
function pathIn(layers: Layer[], path: string): string {
  const bare = path.match(/^\{([0-9A-Fa-f]{16})\}$/);
  if (!bare) return stripGuid(path).replace(/\\/g, "/");
  const p = pathOfGuid(layers, bare[1].toUpperCase());
  if (!p) throw new Error(`GUID ${path} is in no resourceDatabase.rdb of this stack`);
  return p;
}

const layerName = (l: Layer) => `${l.id} (${l.kind}${l.kind === "workshop" ? `: ${basename(l.root)}` : ""})`;

function effectiveText(stack: Stack, layers: Layer[], path: string, filter?: string): string {
  const eff = resolve(layers, path);
  if (!eff) throw new Error(`${path} is in none of ${layers.length} layers; try asset_search`);
  const f = filter?.toLowerCase();
  const props = flat(eff.root, eff.origins).filter((p) => !f || p.label.toLowerCase().includes(f));
  return [
    `${path}  [${eff.root.type}]`,
    `stack: ${stack.layers.at(-1)!.id} (${layers.length} layers), applied: ${eff.applied} files`,
    `chain: ${eff.chain.map((c, i) => `[${i}] ${c}`).join("  ")}`,
    ...eff.warnings.map((w) => `WARNING ${w}`),
    ...props.map((p) => `${p.label} = ${p.value}${p.origin ? `   <- ${p.origin}` : ""}`),
  ].join("\n");
}

export function registerResourceResolve(server: McpServer, config: Config): void {
  server.registerTool(
    "resource_resolve",
    {
      description:
        "Offline, read-only view of a prefab or config (.et, .conf, .ct, .layout) across an addon's whole dependency stack: " +
        "base game, Workshop cache and loose projects. effective: merged properties after the inheritance chain and every " +
        "same-path override, each with the addon and file that set it, plus warnings for an {ID} whose class changed, '#' lines " +
        "and parse errors. providers: which addons ship the path (defines, overrides with the same GUID, or shadows with another). " +
        "diff: property changes between two effective views (another path, stack or upTo). stack: the load order and missing " +
        "dependencies. Output is paged: follow 'continue with offset=N'. Load order among sibling dependencies is unverified.",
      inputSchema: {
        action: z.enum(["effective", "diff", "providers", "stack"]),
        path: z.string().optional().describe("Resource path ({GUID} prefix accepted) or a bare {GUID}; not needed for stack"),
        stack: z.string().optional().describe("Addon whose dependencies form the stack: project folder, Workshop folder, GUID, ID, .gproj path or 'vanilla'. Default ENFUSION_DEFAULT_MOD, else vanilla"),
        upTo: z.string().optional().describe("Stop after this layer (ID, GUID or folder), e.g. 'ArmaReforger' for the base game value"),
        filter: z.string().optional().describe("Only properties whose path (class, {ID} or name) contains this"),
        against: z.string().optional().describe("diff: the other path (default: the same path)"),
        againstStack: z.string().optional().describe("diff: the other stack (default: stack)"),
        againstUpTo: z.string().optional().describe("diff: upTo for the other side (default: whole stack)"),
        offset: z.number().int().min(0).optional().describe("First output line (0-based)"),
        limit: z.number().int().min(1).max(2000).optional().describe("Lines per page (default 400)"),
      },
    },
    async ({ action, path, stack: target, upTo, filter, against, againstStack, againstUpTo, offset, limit }) => {
      try {
        const stack = buildStack(config, target ?? config.defaultMod ?? "vanilla");
        let text: string;
        if (action === "stack") {
          text = [
            ...stack.layers.map((l) => `${String(l.index).padStart(3)} ${l.id}  {${l.guid}}  ${l.kind}  ${l.root}`),
            ...stack.missing.map((g) => `MISSING dependency ${g}: not in the projects, the Workshop cache or the base game (not downloaded?)`),
            ...stack.warnings.map((w) => `WARNING ${w}`),
          ].join("\n");
        } else {
          if (!path) return { content: [{ type: "text" as const, text: `action "${action}" needs path.` }], isError: true };
          const layers = cut(stack, upTo);
          const p = pathIn(layers, path);
          if (action === "providers") {
            const provs = providers(layers, p);
            if (!provs.length) throw new Error(`${p} is in none of ${layers.length} layers; try asset_search`);
            const g = provs[0].guid;
            text = [
              `${p}  GUID ${g ? `{${g}}` : "(none)"}`,
              ...provs.map((v, i) => `${String(i + 1).padStart(3)} ${layerName(v.layer)}  ` +
                (v.role === "defines" ? "defines" : v.role === "overrides" ? "overrides (same GUID)" : `SHADOWS: same path, ${v.guid ? `GUID {${v.guid}}` : "no GUID"} (a new resource, not an override)`)),
            ].join("\n");
          } else if (action === "effective") {
            text = effectiveText(stack, layers, p, filter);
          } else {
            const other = againstStack ? buildStack(config, againstStack) : stack;
            const otherLayers = cut(other, againstUpTo);
            const q = against ? pathIn(otherLayers, against) : p;
            const a = resolve(layers, p), b = resolve(otherLayers, q);
            if (!a || !b) throw new Error(`${!a ? p : q} is in none of the layers; try asset_search`);
            const lines = diffFlat(flat(a.root, a.origins), flat(b.root, b.origins)).filter((l) => !filter || l.toLowerCase().includes(filter.toLowerCase()));
            text = [`diff ${p} (${layers.at(-1)!.id}) -> ${q} (${otherLayers.at(-1)!.id})`, ...[...a.warnings, ...b.warnings].map((w) => `WARNING ${w}`), ...(lines.length ? lines : ["(no property differences)"])].join("\n");
          }
        }
        const page = pageLines(text, offset ?? 0, limit ?? 400);
        return { content: [{ type: "text" as const, text: `${page.body.replace(/\n?$/, "\n")}-- ${page.footer}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `resource_resolve: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
  );
}
