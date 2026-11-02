import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import { components, loadMission, slotRoles, SIDES, type Mission, type MissionEntity, type Side } from "../coalition/mission-model.js";
import { prefabClassifier, type Classified, type PrefabKind } from "../coalition/mission-prefabs.js";
import { collectNameRefs, gamemodeNames, nameDefaults, resolveNames, taskEntries, type NameRef } from "../coalition/name-refs.js";
import type { Layer } from "../pak/stack.js";
import {
  cloneCopy, CRF_PATH_HELP, guideProjectsDir, LOBBY_PATH_HELP, resolveCoalitionRoots, SOURCE_HELP, type CoalitionCopy, type CoalitionRoots,
} from "../utils/coalition-paths.js";
import { enumDefault, loadLobbyEnums } from "../utils/lobby-enums.js";
import { stripGuid } from "../utils/prefab-ancestry.js";
import { validateProjectPath } from "../utils/safe-path.js";

const SECTIONS = ["summary", "sides", "names", "tasks", "rules"] as const;
type Section = (typeof SECTIONS)[number];
type SideKind = Exclude<PrefabKind, "gameBorder" | "taskAnchor">;

// Side table rows, in the order of the official guide's layer table
const ROWS: [SideKind, string][] = [
  ["spawn", "Spawn points"],
  ["groupSpawn", "Initial group spawns"],
  ["safestart", "Safestart zone"],
  ["forwardDeploy", "Forward-deploy zone"],
  ["objectiveMarker", "Objective markers (own side)"],
  ["spawnMarker", "Spawn markers"],
  ["msp", "MSP"],
  ["vehicleSpawner", "Vehicle spawners"],
  ["depot", "CRF vehicle depots"],
];
// Layer each family belongs on, from the official guide's layer table (reference 05, section 4)
const LAYER: Partial<Record<PrefabKind, string>> = {
  spawn: "SPAWNPOINTS", msp: "SPAWNPOINTS", vehicleSpawner: "SPAWNPOINTS", groupSpawn: "SPAWNPOINTSGROUPS",
  gameBorder: "GameBorderS", safestart: "GameBorderS", forwardDeploy: "GameBorderS",
  objectiveMarker: "MARKERS", spawnMarker: "MARKERS", depot: "VEHICLES",
};
// Guide's avoid list (D-035) as vanilla slotted names; "_" after the category spares the guide-safe CheckpointUnderConstruction
const AVOID = /\/Compositions\/Slotted\/(?:\w+\/)?(?:E_)?(Barricade|Checkpoint|LivingArea|Helipad|FieldHospital|VehicleMaintenance|FiringRange|AmmoStorage)_[^/]*\.et$/;

interface Rule { level: "error" | "warning" | "info"; text: string }
interface Params { world: string; sections?: Section[]; crfPath?: string; lobbyPath?: string; source?: "clone" | "workshop"; format: "markdown" | "json" }

const label = (e: MissionEntity) => e.name ?? `${e.className} in ${e.layer}`;

/** The copy holding a world and its path in it: CRF (clone or Workshop) first, else a folder under the project path or the guide's Projects folder. */
function locateWorld(config: Config, crf: CoalitionCopy, world: string): { copy: Layer; rel: string } {
  const slashed = world.replace(/\\/g, "/");
  if (!isAbsolute(world) && crf.exists(slashed)) return { copy: crf, rel: slashed };
  const abs = isAbsolute(world) ? world : join(config.projectPath, world);
  let file: string | undefined;
  for (const base of [config.projectPath, guideProjectsDir()]) {
    try {
      file = validateProjectPath(base, abs);
      break;
    } catch {
      // try the next allowed folder
    }
  }
  if (!file) throw new Error(`World must be inside the project path ${config.projectPath}.`);
  // The addon is the folder holding the nearest Worlds folder
  let root = dirname(file);
  for (let d = dirname(file); dirname(d) !== d; d = dirname(d)) {
    if (basename(d) === "Worlds") {
      root = dirname(d);
      break;
    }
  }
  const copy = crf.kind === "loose" && relative(crf.root, root) === "" ? crf : cloneCopy(root);
  return { copy, rel: relative(root, file).replace(/\\/g, "/") };
}

/** A mission world (CRF-relative, project-relative or absolute) that has a COA_Lobby entity, with its prefabs read from the CRF and Lobby copies. */
export function loadLobbyMission(config: Config, roots: CoalitionRoots, world: string): Mission & { lobby: MissionEntity } {
  const { copy, rel } = locateWorld(config, roots.crf, world);
  const m = loadMission(config, copy, rel, [...new Set([copy, roots.crf, roots.lobby])]);
  if (!m.lobby) {
    throw new Error(`${m.worldRel} has no COA_Lobby entity: not a Lobby mission, or plugin 1 (Automatically Create Initial Layers/Objects) was not run.`);
  }
  return m as Mission & { lobby: MissionEntity };
}

function missionInspect(config: Config, p: Params): string {
  const roots = resolveCoalitionRoots(config, p.crfPath, p.lobbyPath, p.source);
  const { crf, lobby: lobbyCopy } = roots;
  const m = loadLobbyMission(config, roots, p.world);
  const want = new Set<Section>(p.sections?.length ? p.sections : SECTIONS);
  const lobby = m.lobby;
  const classify = prefabClassifier(config, [...new Set([lobbyCopy, crf, m.copy])]);
  const classes = new Map<MissionEntity, Classified | undefined>(m.entities.map((e) => [e, classify(e.prefab, e.className)]));
  const names = new Set(m.entities.flatMap((e) => (e.name ? [e.name] : [])));

  // ── sides ──
  const slotted = SIDES.filter((s) => m.slots[s]);
  const sides = Object.fromEntries(
    slotted.map((s) => [s, {
      slotGroups: m.slots[s]!.length,
      slots: slotRoles(m.slots[s]).length,
      ...Object.fromEntries(ROWS.map(([k]) => [k, [] as string[]])),
    }])
  ) as Record<Side, { slotGroups: number; slots: number } & Record<SideKind, string[]>>;
  const global = { gameBorders: [] as string[], objectiveMarkers: [] as string[] };
  const unclassified: string[] = [];
  const offSide = new Map<string, number>();
  for (const [e, c] of classes) {
    if (!c) {
      if (e.prefab?.includes("PrefabsMissionMaking/")) unclassified.push(`${label(e)}: ${stripGuid(e.prefab)} (not counted)`);
      continue;
    }
    if (c.kind === "gameBorder") global.gameBorders.push(label(e));
    else if (c.kind === "taskAnchor") continue;
    else if (c.side === "GLOBAL") global.objectiveMarkers.push(label(e));
    else if (!c.side) unclassified.push(`${label(e)}: ${c.kind} by class ${e.className}, side unknown`);
    else if (sides[c.side]) sides[c.side][c.kind as SideKind].push(label(e));
    else offSide.set(c.side, (offSide.get(c.side) ?? 0) + 1);
  }
  const sideWarnings = slotted.filter((s) => !sides[s].safestart.length).map((s) => `${s} has no safestart zone`);

  // ── names and tasks ──
  const gm = gamemodeNames(m.entities, names);
  const refs = resolveNames([...collectNameRefs(m.entities, nameDefaults([lobbyCopy, crf])), ...gm.refs], names);
  const byName = new Map(m.entities.filter((e) => e.name).map((e) => [e.name!, e]));
  const entries = taskEntries(m.entities);
  // Unset enum fields read as the member with value 0 (CRF_TaskCreatorComponent.c:83-87, Attribute "0")
  const enums = entries.length ? loadLobbyEnums([lobbyCopy, crf]) : new Map();
  const unset = (name: string) => `${enumDefault(enums, name) ?? "?"} (default)`;
  const tasks = entries.map((t) => {
    const anchor = byName.get(t.anchor);
    return { ...t, type: t.type ?? unset("CRF_EObjectiveTaskType"), side: t.side ?? unset("CRF_EObjectiveNotifySide"), found: !!anchor, anchorPrefab: anchor?.prefab, emptyAnchor: anchor ? classes.get(anchor)?.kind === "taskAnchor" : undefined };
  });

  // ── rules ──
  const rules: Rule[] = [];
  // Plugins, QA and CI find the gamemode by this name (Lobby COA_MissionConfigurationPlugin.c:158-161)
  rules.push(lobby.name === "COA_Lobby"
    ? { level: "info", text: "COA_Lobby entity is named COA_Lobby" }
    : { level: "error", text: `The COA_Lobby entity is named ${lobby.name ?? "(no name)"}; it must be exactly COA_Lobby` });
  const aiWorld = m.entities.some((e) => e.layer === "_INIT" && /AIWorld/.test(e.className));
  if (!aiWorld) rules.push({ level: "warning", text: "No AI World in _INIT" });
  if (m.confs.length !== 1) {
    rules.push({ level: "warning", text: m.confs.length
      ? `${m.confs.length} mission .conf files point at this world (plugin 6 run more than once?): ${m.confs.join(", ")}`
      : `No mission .conf in Missions/ points at ${m.worldRel} (plugin 6 not run yet?)` });
  }
  const comps = new Map<string, number>();
  for (const e of m.entities) {
    const path = e.prefab ? stripGuid(e.prefab) : "";
    // CRF's and the Lobby's own compositions are never flagged (D-035)
    if (AVOID.test(path) && ![crf, lobbyCopy].some((c) => c.exists(path))) {
      comps.set(path, (comps.get(path) ?? 0) + 1);
    }
  }
  for (const [path, n] of comps) rules.push({ level: "warning", text: `Vanilla composition on the guide's avoid list (suspected server crashes): ${path}${n > 1 ? ` x${n}` : ""}` });
  const misplaced = new Map<string, number>();
  for (const [e, c] of classes) {
    const layer = c && LAYER[c.kind];
    if (layer && !e.parent && e.layer.toLowerCase() !== layer.toLowerCase()) {
      const key = `${c.kind} in ${e.layer} (guide layer: ${layer})`;
      misplaced.set(key, (misplaced.get(key) ?? 0) + 1);
    }
  }
  for (const [key, n] of misplaced) rules.push({ level: "info", text: `${n} ${key}` });
  for (const [side, n] of offSide) rules.push({ level: "info", text: `${n} ${side} mission prefab(s) placed, but ${side} has no slots` });

  const lobbyInfo = { name: lobby.name, layer: lobby.layer, prefab: lobby.prefab, components: components(lobby).map((c) => c.type) };

  if (p.format === "json") {
    const pick = <T>(s: Section, v: T) => (want.has(s) ? v : undefined);
    return JSON.stringify({
      world: m.worldRel,
      root: m.root,
      copies: { crf: crf.label, lobby: lobbyCopy.label },
      note:"From saved files; unsaved World Editor changes are not included.",
      ...pick("summary", { layers: m.layers, lobby: lobbyInfo, confs: m.confs, aiWorld }),
      ...pick("sides", { sides, global, unclassified, sideWarnings }),
      ...pick("names", { names: refs, nameNotes: gm.notes }),
      ...pick("tasks", { tasks }),
      ...pick("rules", { rules }),
    }, null, 2);
  }

  const out = [
    `# Mission ${basename(m.worldRel, ".ent")}`,
    `CRF: ${crf.label}`,
    `Lobby: ${lobbyCopy.label}`,
    `${m.worldRel} in ${m.root}`,
    "From saved files; unsaved World Editor changes are not included.",
  ];
  if (want.has("summary")) {
    out.push("", "## Summary");
    for (const l of m.layers) out.push(`- ${l.name}: ${l.error ? `**parse error**: ${l.error}` : `${l.entities} entities`}`);
    out.push(`- COA_Lobby: ${lobby.name ?? "(no name)"} in ${lobby.layer}, from ${lobby.prefab ? stripGuid(lobby.prefab) : "no prefab"}`);
    out.push(`- Components on it: ${lobbyInfo.components.join(", ") || "none"}`);
    out.push(`- Mission .conf: ${m.confs.join(", ") || "none"}`);
    out.push(`- AI World in _INIT: ${aiWorld ? "yes" : "**no**"}`);
  }
  if (want.has("sides")) {
    out.push("", "## Sides");
    if (!slotted.length) out.push("No side has slot groups.");
    else {
      const cell = (n: number) => (n ? String(n) : "**0**");
      out.push(`| Item | ${slotted.join(" | ")} |`, `|---|${slotted.map(() => "---|").join("")}`);
      out.push(`| Slots (groups) | ${slotted.map((s) => `${sides[s].slots} (${sides[s].slotGroups})`).join(" | ")} |`);
      for (const [k, title] of ROWS) out.push(`| ${title} | ${slotted.map((s) => (k === "safestart" ? cell : String)(sides[s][k].length)).join(" | ")} |`);
      out.push("", `Game borders: ${global.gameBorders.length}. GLOBAL objective markers (all sides): ${global.objectiveMarkers.length}.`);
      for (const s of slotted) if (sides[s].spawn.length) out.push(`- ${s} spawn points: ${sides[s].spawn.join(", ")}`);
      for (const w of sideWarnings) out.push(`- Warning: ${w} (the guide expects one per side; not proven mandatory)`);
      if (unclassified.length) out.push("Mission prefabs not in the table:", ...unclassified.map((u) => `- ${u}`));
    }
  }
  if (want.has("names")) {
    out.push("", "## Names", "Names the mission's components refer to, checked against entity names in this world's layers (case-sensitive).");
    if (!refs.length) out.push("- none");
    const where = (r: NameRef) => `${r.component}.${r.field}${r.fromDefault ? " default" : ""} on ${r.entity}`;
    for (const r of refs) {
      const hint = r.suggestions?.length ? `, did you mean ${r.suggestions.join(" or ")}? names are case-sensitive` : "";
      out.push(r.found ? `- ok: ${r.value} (${where(r)})`
        : r.fromDefault ? `- not found: ${r.value} (${where(r)}; unset in the mission, matters only if the gamemode uses this field)${hint}`
        : `- **not found**: ${r.value} (${where(r)})${hint}`);
    }
    for (const n of gm.notes) out.push(`- ${n.level}: ${n.text}`);
  }
  if (want.has("tasks")) {
    out.push("", "## Tasks");
    if (!tasks.length) out.push("- no CRF_TaskCreatorComponent entries");
    for (const t of tasks) {
      const anchor = !t.anchor ? "**no anchor name**" : t.found ? `${t.anchor} found${t.emptyAnchor ? "" : `, placed from ${t.anchorPrefab ? stripGuid(t.anchorPrefab) : "no prefab"} (not CRF_task_empty.et)`}` : `**${t.anchor} not found**`;
      out.push(`- ${t.label ?? "New Task"}: type ${t.type}, side ${t.side}, anchor ${anchor}`);
    }
  }
  if (want.has("rules")) {
    out.push("", "## Rules", ...rules.map((r) => `- ${r.level}: ${r.text}`));
  }
  const issues = (want.has("names") ? refs.filter((r) => !r.found && !r.fromDefault).length : 0) + (want.has("rules") ? rules.filter((r) => r.level !== "info").length : 0) + (want.has("sides") ? sideWarnings.length : 0);
  out.push("", `${issues} issue(s). Read-only.`);
  return out.join("\n");
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function registerMissionInspect(server: McpServer, config: Config): void {
  server.registerTool(
    "mission_inspect",
    {
      description:
        "Per-side readiness report for a COALITION mission world, read from its saved layer files: slots, spawn points, " +
        "safestart and forward-deploy zones, markers, MSPs, vehicle spawners and depots per side; every entity name the " +
        "mission's components refer to (Task Creator anchors, Cache Hunt caches, CTF bases, Rush triggers...) checked " +
        "against the world's entity names with near-miss suggestions; Task Creator entries; and rule checks (COA_Lobby " +
        "name, AI World, mission .conf count, vanilla compositions the guide says to avoid). Read-only and offline, no Workbench.",
      inputSchema: {
        world: z.string().min(1).describe("Mission world .ent, CRF-relative (e.g. 'Worlds/Arland/MyMission.ent'; also a published mission in the Workshop CRF), project-path-relative or absolute. Must be inside the project path or the guide's Projects folder."),
        sections: z.array(z.enum(SECTIONS)).optional().describe("Limit the report. Default: all of summary, sides, names, tasks, rules."),
        format: z.enum(["markdown", "json"]).default("markdown").describe("json returns the same data with entity names per row."),
        crfPath: z.string().optional().describe(CRF_PATH_HELP),
        lobbyPath: z.string().optional().describe(LOBBY_PATH_HELP),
        source: z.enum(["clone", "workshop"]).optional().describe(SOURCE_HELP),
      },
    },
    async (params) => {
      try {
        return { content: [{ type: "text" as const, text: missionInspect(config, params) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: errorText(e) }], isError: true };
      }
    }
  );
}
