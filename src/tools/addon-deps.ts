import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { Config } from "../config.js";
import { closure, installedAddons, rdbOf, type AddonInfo } from "../pak/stack.js";
import { parseResourceDatabase } from "../pak/rdb.js";
import { classifyRefs, collectRefs, metaGuids, type ClassifiedRef } from "../release/refs.js";
import { addonScripts, baseGameNames, declaredNames, usedNames } from "../release/script-use.js";
import { resolveGproj, workbenchProfileDir } from "../workbench/cli.js";

/**
 * Offline dependency report for an addon: names, versions and sources of its dependencies,
 * missing, undeclared and dangling references, unused and redundant dependencies, cycles,
 * incomplete downloads, gameVersion drift, override stacks and load order. Read only.
 */

export interface DepsArgs {
  addonName?: string;
  gprojPath?: string;
  files?: string[];
  scripts?: boolean;
  searchInstalled?: boolean;
  format?: "text" | "json";
}

export interface Finding { id: string; level: "blocker" | "warning" | "info"; text: string }

interface DepRow {
  guid: string;
  name: string;
  version: string;
  source: string;
  refs: number;
  /** Resource GUIDs of this dependency that the target ships again (overrides) */
  overrides: number;
  scriptNames: string[] | null;
  gameVersion: string;
  notes: string[];
}

const LIST = 20;

const label = (a: AddonInfo) => `${a.name} {${a.guid}}`;
const majorMinor = (v: string) => v.match(/^(\d+\.\d+)/)?.[1] ?? "";
const samePath = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();
const inDocs = (file: string) => file.split("/").some((s) => s.startsWith("!Docs"));

/** Game version from the newest Workbench console.log (the Tools build; equal to the game while both are one release). */
function workbenchVersion(config: Config): string {
  try {
    const logs = join(workbenchProfileDir(config), "logs");
    const latest = readdirSync(logs).sort().reverse().find((d) => existsSync(join(logs, d, "console.log")));
    return latest ? readFileSync(join(logs, latest, "console.log"), "utf-8").match(/version (\d+\.\d+\.\d+\.\d+)/)?.[1] ?? "" : "";
  } catch {
    return "";
  }
}

/** Resource GUIDs an addon ships: its rdb, plus its .meta files when unpacked. */
function ownedGuids(a: AddonInfo, warnings: string[]): Set<string> {
  const out = a.source === "loose" ? metaGuids(a.dir) : new Set<string>();
  try {
    for (const e of rdbOf(a.dir).values()) out.add(e.guid);
  } catch (e) {
    warnings.push(`${label(a)}: resourceDatabase.rdb unreadable (${(e as Error).message})`);
  }
  return out;
}

export function addonDepsReport(config: Config, args: DepsArgs): { text: string; json: unknown; isError: boolean } {
  const fail = (text: string) => ({ text, json: { error: text }, isError: true });
  const gproj = resolveGproj(config, args.addonName ?? config.defaultMod, args.gprojPath);
  if (!gproj) return fail(`Addon not found. Pass addonName (a folder under ${config.projectPath}) or gprojPath.`);
  if (!config.workshopPath || !existsSync(config.workshopPath)) return fail(`Workshop cache not found at ${config.workshopPath}; set ENFUSION_WORKSHOP_PATH`);

  const c = closure(config, gproj);
  const warnings = [...c.warnings];
  const target = c.order.at(-1)!;
  const deps = c.order.slice(0, -1);
  const byGuid = new Map(c.order.map((a) => [a.guid, a]));
  const findings: Finding[] = [];
  const add = (id: string, level: Finding["level"], text: string) => findings.push({ id, level, text });

  // Resource GUID -> closure addons shipping it, in load order
  const ownGuids = ownedGuids(target, warnings);
  const owners = new Map<string, string[]>();
  for (const a of c.order) for (const g of a === target ? ownGuids : ownedGuids(a, warnings)) owners.set(g, [...(owners.get(g) ?? []), a.guid]);
  const closureOwners = new Map([...owners].filter(([g]) => !ownGuids.has(g)).map(([g, o]) => [g, o.at(-1)!]));

  const refs = collectRefs(target.dir, args.files);
  const installedOwners = new Map<string, string>();
  const installed = installedAddons(config);
  const unresolved = new Set(refs.map((r) => r.guid).filter((g) => !ownGuids.has(g) && !closureOwners.has(g)));
  if (unresolved.size && args.searchInstalled !== false) {
    // shortcut: rdbs only, so an installed project whose rdb is stale is missed; rescan it in Workbench first
    for (const a of installed.values()) {
      if (byGuid.has(a.guid) || !existsSync(join(a.dir, "resourceDatabase.rdb"))) continue;
      try {
        for (const e of parseResourceDatabase(readFileSync(join(a.dir, "resourceDatabase.rdb"))).values()) {
          if (unresolved.has(e.guid) && !installedOwners.has(e.guid)) installedOwners.set(e.guid, a.guid);
        }
      } catch (e) {
        warnings.push(`${label(a)}: resourceDatabase.rdb unreadable (${(e as Error).message})`);
      }
    }
  }
  const classified = classifyRefs(refs, ownGuids, closureOwners, installedOwners);
  const of = (kind: ClassifiedRef["kind"]) => classified.filter((x) => x.kind === kind);

  // D1, D6
  const names = Object.assign({}, ...c.order.map((a) => a.depNames)) as Record<string, string>;
  for (const g of c.missing) add("D1", "blocker", `Dependency {${g}}${names[g] ? ` (${names[g]})` : ""} is not installed: not in the projects, the Workshop cache or the base game`);
  for (const cy of c.cycles) add("D6", "blocker", `Dependency cycle: ${cy.map((g) => byGuid.get(g)?.name ?? g).join(" -> ")}`);

  // D2: grouped by the mod that owns the refs
  const undeclared = new Map<string, ClassifiedRef[]>();
  for (const x of of("undeclared")) undeclared.set(x.owner!, [...(undeclared.get(x.owner!) ?? []), x]);
  for (const [g, xs] of undeclared) {
    const a = installed.get(g)!;
    add("D2", "blocker", `Undeclared dependency ${label(a)} (${a.source}: ${basename(a.dir)}): ${xs.length} refs resolve only there, e.g. ` +
      `${xs.slice(0, 3).map((x) => `{${x.ref.guid}}${x.ref.path} in ${x.ref.file}`).join("; ")}. Add it to Dependencies (for a mission, to the framework addon that loads it)`);
  }

  // D3: docs folders are not loaded by the game (unverified), so they are counted apart
  const dangling = of("dangling");
  const live = dangling.filter((x) => !inDocs(x.ref.file));
  for (const x of live.slice(0, LIST)) add("D3", "warning", `Dangling ref {${x.ref.guid}}${x.ref.path} in ${x.ref.file}: no installed addon ships this GUID`);
  if (live.length > LIST) add("D3", "warning", `${live.length - LIST} more dangling refs`);
  if (dangling.length > live.length) add("D3", "info", `${dangling.length - live.length} dangling refs in !Docs folders (not counted above)`);

  // Direct dependencies: refs into each, script use, D4, D5, D7, D8, D10, D11
  const gameVersion = workbenchVersion(config);
  // A file subset (one mission) need not use every dependency of the whole addon
  const whole = !args.files;
  const doScripts = args.scripts !== false && whole;
  let targetScripts: string[] | undefined;
  let base: Set<string> | undefined;
  const reach = (g: string, seen = new Set<string>()): Set<string> => {
    for (const d of byGuid.get(g)?.deps ?? []) if (!seen.has(d)) { seen.add(d); reach(d, seen); }
    return seen;
  };
  const rows: DepRow[] = [];
  let emptyGameVersion = 0;
  for (const g of target.deps) {
    const a = byGuid.get(g);
    if (!a || a === target) {
      rows.push({ guid: g, name: a?.name ?? names[g] ?? "", version: "", source: a ? "itself" : "MISSING", refs: 0, overrides: 0, scriptNames: null, gameVersion: "", notes: [a ? "D6" : "D1"] });
      continue;
    }
    const notes: string[] = [];
    const n = of("closure").filter((x) => x.owner === g).length;
    const overrides = [...ownGuids].filter((x) => owners.get(x)?.includes(g)).length;
    let scriptNames: string[] | null = null;
    // Script use can only clear D4, so it is read only where refs and overrides found no use (CRF: 4 s saved)
    if (doScripts && a.source !== "vanilla" && n + overrides === 0) {
      const s = addonScripts(a);
      if (s.unreadable) notes.push(`scripts unreadable (${s.unreadable})`);
      else scriptNames = usedNames((targetScripts ??= addonScripts(target).sources), declaredNames(s.sources), (base ??= baseGameNames(config.gamePath)));
    }
    if (whole && a.source !== "vanilla" && n + overrides === 0 && scriptNames?.length === 0) {
      notes.push("D4");
      add("D4", "info", `${label(a)}: no resource refs, overrides or script names used ("no use found"); it may still be needed for behaviour or for its own dependencies`);
    }
    // Every addon reaches the base game, so its direct line is not worth a note
    const via = a.source === "vanilla" ? undefined : target.deps.find((o) => o !== g && o !== target.guid && reach(o).has(g));
    if (via) {
      notes.push("D5");
      add("D5", "info", `${label(a)} is also reached through ${byGuid.get(via)?.name ?? via}; the direct line is redundant (harmless)`);
    }
    rows.push({ guid: g, name: a.name, version: a.version, source: a.source, refs: n, overrides, scriptNames, gameVersion: a.gameVersion, notes });
  }
  for (const a of deps) {
    const tag = (id: string) => rows.find((r) => r.guid === a.guid)?.notes.push(id);
    const temp = join(a.dir, "temp");
    if (a.source === "workshop" && existsSync(temp)) {
      const entries = readdirSync(temp);
      const gp = entries.some((e) => e.toLowerCase() === "addon.gproj");
      tag("D7");
      add("D7", gp ? "warning" : "info", gp
        ? `${label(a)}: temp\\ holds an addon.gproj entry (incomplete download; Workbench logs "Can't find game project file .../temp/addon.gproj"). Re-download the mod`
        : `${label(a)}: temp\\ holds only ${entries.join(", ") || "nothing"} (left over from a download; normally harmless)`);
    }
    if (a.source === "workshop") {
      if (!a.gameVersion) emptyGameVersion++;
      else if (gameVersion && majorMinor(a.gameVersion) !== majorMinor(gameVersion)) {
        tag("D8");
        add("D8", "warning", `${label(a)} ${a.version} was built for game ${a.gameVersion}; Workbench here is ${gameVersion}`);
      }
    }
    if (a.shadowed.length) {
      tag("D10");
      add("D10", "warning", `${label(a)}: ${a.source} copy ${a.dir} wins over ${a.shadowed.join(", ")} (projects before the Workshop cache, under the current ENFUSION_ADDONS_DIR)`);
    }
    const addonsDirs = (config.addonsDir ?? "").split(",").map((d) => d.trim()).filter(Boolean);
    if (a.source === "loose" && !addonsDirs.some((d) => samePath(d, dirname(a.dir)))) {
      tag("D11");
      add("D11", "warning", `${label(a)} is only in ${dirname(a.dir)}, which is not in ENFUSION_ADDONS_DIR (${addonsDirs.join(", ") || "unset"}): Workbench and servers the MCP starts will not find it`);
    }
  }
  if (emptyGameVersion) add("D8", "info", `${emptyGameVersion} Workshop dependencies leave gameVersion empty; compared against ${gameVersion || "an unknown game version (no Workbench console.log)"}`);

  // D9: resource GUIDs shipped by more than one closure addon (override stacks), grouped by stack;
  // overlaps inside the base game are not the author's to act on
  const stacks = new Map<string, string[]>();
  for (const [g, o] of owners) {
    if (o.length < 2 || o.every((x) => byGuid.get(x)?.source === "vanilla")) continue;
    const key = o.map((x) => byGuid.get(x)?.name ?? x).join(" < ");
    stacks.set(key, [...(stacks.get(key) ?? []), g]);
  }
  for (const [key, gs] of [...stacks].sort((a, b) => b[1].length - a[1].length).slice(0, LIST)) {
    add("D9", "info", `${gs.length} resource GUID${gs.length === 1 ? "" : "s"} shipped by ${key} (load order as resolved; sibling order unverified), e.g. ${gs.slice(0, 3).map((g) => `{${g}}`).join(", ")}`);
  }
  if (stacks.size > LIST) add("D9", "info", `${stacks.size - LIST} more override stacks`);

  const order = ["blocker", "warning", "info"];
  findings.sort((a, b) => order.indexOf(a.level) - order.indexOf(b.level));
  const counts = { guids: new Set(refs.map((r) => r.guid)).size, danglingGuids: new Set(dangling.map((x) => x.ref.guid)).size, total: refs.length, own: of("own").length, closure: of("closure").length, undeclared: of("undeclared").length, dangling: dangling.length };
  const json = {
    target: { name: target.name, guid: target.guid, gproj: target.gproj, files: args.files ?? null },
    gameVersion,
    refs: counts,
    dependencies: rows,
    findings,
    loadOrder: c.order.map((a) => ({ guid: a.guid, name: a.name, source: a.source, dir: a.dir })),
    warnings,
  };
  if (args.format === "json") return { text: JSON.stringify(json, null, 2), json, isError: false };

  const text = [
    `addon_deps ${label(target)}  ${target.gproj}${args.files ? `  files: ${args.files.join(", ")}` : ""}`,
    `refs: ${counts.total} to ${counts.guids} GUIDs (own ${counts.own}, dependencies ${counts.closure}, undeclared ${counts.undeclared}, dangling ${counts.dangling} to ${counts.danglingGuids} GUIDs); ` +
      `closure ${c.order.length} addons; game ${gameVersion || "unknown"}`,
    ...(whole ? [] : ["files set: script use and D4 skipped (they describe the whole addon)"]),
    "",
    "Direct dependencies",
    "GUID | name | version | source | refs | overrides | script names used | gameVersion | notes",
    ...rows.map((r) => [
      r.guid, r.name || "?", r.version || "-", r.source, r.refs, r.overrides,
      r.scriptNames === null ? (r.refs + r.overrides ? "not checked" : "-") : r.scriptNames.length ? `${r.scriptNames.length}, e.g. ${r.scriptNames.slice(0, 3).join(", ")}` : "0",
      r.gameVersion || "-", r.notes.join(" ") || "-",
    ].join(" | ")),
    "",
    `Findings (${findings.filter((f) => f.level === "blocker").length} blockers, ${findings.filter((f) => f.level === "warning").length} warnings)`,
    ...(findings.length ? findings.map((f) => `${f.id} ${f.level.toUpperCase()} ${f.text}`) : ["none"]),
    ...warnings.map((w) => `WARNING ${w}`),
    "",
    "Load order (dependencies first; order among siblings unverified)",
    ...c.order.map((a, i) => `${String(i).padStart(3)} ${label(a)}  ${a.source}  ${a.dir}`),
  ].join("\n");
  return { text, json, isError: false };
}

export function registerAddonDeps(server: McpServer, config: Config): void {
  server.registerTool(
    "addon_deps",
    {
      description:
        "Offline, read-only dependency check for an addon before publishing: each dependency's name, version and source " +
        "(project, Workshop cache or base game), refs into it and script names used; findings D1 not installed, D2 undeclared " +
        "(refs resolve only in a mod outside the dependencies, names the mod), D3 dangling refs, D4 no use found, D5 redundant, " +
        "D6 cycle, D7 incomplete download, D8 gameVersion drift, D9 override stacks, D10 project shadows Workshop copy, " +
        "D11 not under ENFUSION_ADDONS_DIR; and the load order. Script use is checked only for dependencies with no resource refs. Pass files to check one mission's world, layers and conf.",
      inputSchema: {
        addonName: z.string().optional().describe("Addon folder under the project path (default ENFUSION_DEFAULT_MOD)"),
        gprojPath: z.string().optional().describe(".gproj path instead, e.g. a test addon outside the project path"),
        files: z.array(z.string()).optional().describe("Only scan these relative files or folder prefixes for refs, e.g. a mission's .ent, its _Layers/ folder and its .conf"),
        scripts: z.boolean().optional().describe("Check script use of each dependency (default true)"),
        searchInstalled: z.boolean().optional().describe("Name the installed mod that owns each unresolved GUID (default true)"),
        format: z.enum(["text", "json"]).optional(),
      },
    },
    async (args) => {
      try {
        const r = addonDepsReport(config, args);
        return { content: [{ type: "text" as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `addon_deps: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }
  );
}
