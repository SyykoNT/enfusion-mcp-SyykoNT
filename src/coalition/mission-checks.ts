import { basename } from "node:path";
import type { Config } from "../config.js";
import { parseAll, type EnfusionNode } from "../formats/enfusion-text.js";
import type { Layer } from "../pak/stack.js";
import type { LobbyEnums } from "../utils/lobby-enums.js";
import { readEtFile, stripGuid } from "../utils/prefab-ancestry.js";
import { member, prop, SETTINGS_FIELD, SIDES, SLOTS_FIELD, slotRoles, textOf, type Mission, type MissionEntity, type Side } from "./mission-model.js";
import type { Classified } from "./mission-prefabs.js";

// The guide's build steps and standards, described from the Lobby's mission plugins in our own words.
// Line citations are to COALITION-Lobby Scripts/WorkbenchGame/MissionPlugins unless another file is named.

export interface Note { level: "error" | "warning" | "info"; text: string }
type Lobby = Mission & { lobby: MissionEntity };

const firstOf = <T>(nodes: EnfusionNode[], f: (n: EnfusionNode) => T | undefined): T | undefined => {
  for (const n of nodes) {
    const v = f(n);
    if (v !== undefined) return v;
  }
  return undefined;
};

// ── GI-03 progress ──────────────────────────────────────────────────────────

// Plugin 1's layers, in its order (COA_MissionCreationPlugin.c:39-46)
export const GUIDE_LAYERS = ["_INIT", "MARKERS", "SPAWNPOINTS", "SPAWNPOINTSGROUPS", "OBJECTIVES", "GameBorderS", "VEHICLES", "PROPS"];
// Fields plugin 2 writes on COA_Lobby (COA_MissionGamemodePlugin.c:141-152)
export const PLUGIN2_FIELDS = [
  "m_iTimeLimitMinutes", "m_bLockUnusedSlots", "m_bRespawnEnabled", "m_bRallyPointsEnabled", "m_bWaveRespawn", "m_iTimeToRespawn",
  "m_iRespawnCutoffMinutes", "m_eRespawnMode", "m_bUseSafestartTimeLimit", "m_iSafestartTimeLimit", "m_bUseCVON", "m_fMissionTimeScale",
];
// Plugin 3 writes every side's tickets (COA_MissionFactionPlugin.c:172-175)
export const TICKETS_FIELD: Record<Side, string> = { BLUFOR: "m_iBLUFORTickets", OPFOR: "m_iOPFORTickets", INDFOR: "m_iINDFORTickets", CIV: "m_iCIVTickets" };

export interface Step { step: string; done: boolean; detail: string }

const descriptors = (n: EnfusionNode | undefined, field: string) =>
  (member(n, field)?.children ?? []).map((d) => ({
    title: prop(d, "m_sTitle") ?? "",
    text: prop(d, "m_sTextData") ?? "",
    keys: member(d, "m_aFactionKeys")?.values ?? [],
    any: prop(d, "m_bShowForAnyFaction") === "1",
  }));

/** Which of the guide's build steps (plugins 1 to 6, the AI World) a mission's saved files show as done, and the next one. */
export function progress(m: Lobby, nodes: EnfusionNode[]): { steps: Step[]; next: string; warnings: string[] } {
  const e = m.lobby.node;
  const layers = new Set(m.layers.map((l) => l.name.toLowerCase()));
  const missingLayers = GUIDE_LAYERS.filter((l) => !layers.has(l.toLowerCase()));
  const slotted = SIDES.filter((s) => m.slots[s]);
  const own = (field: string) => member(e, field) !== undefined || prop(e, field) !== undefined;
  // A briefing counts when its text is not empty and its (title, text) pair is not a COA_Lobby.et default, as CRF's
  // PR check reads it (Tools/Validation/mission_synopsis.py:561-566, validate_mission.py:887-921)
  const defaultsNode = firstOf(nodes.slice(1), (n) => (member(n, "m_aDefaultMissionDescriptors") ? n : undefined));
  const pair = (d: { title: string; text: string }) => `${d.title}\u0000${d.text}`;
  const defaults = new Set(descriptors(defaultsNode, "m_aDefaultMissionDescriptors").map(pair));
  const all = descriptors(e, "m_aMissionDescriptors");
  const written = all.filter((d) => d.text && !defaults.has(pair(d)));
  // The Lobby UI lists a descriptor with m_bShowForAnyFaction for every faction (COA_MissionDescriptionUI.c:85-100)
  const briefed = slotted.filter((s) => written.some((d) => d.any || d.keys.includes(s)));
  const gearscripts = SIDES.map((s) => `${s} ${prop(member(e, SETTINGS_FIELD[s]), "m_rGearScript") ? basename(stripGuid(prop(member(e, SETTINGS_FIELD[s]), "m_rGearScript")!)) : "(COA_Lobby.et default)"}`);

  const steps: Step[] = [
    // COA_Lobby is there (or the tool would have stopped), so plugin 1 ran; missing layers were renamed or removed since
    { step: "1 Create initial layers and COA_Lobby", done: true, detail: missingLayers.length ? `COA_Lobby placed; guide layers not in the world: ${missingLayers.join(", ")}` : "all 8 layers, COA_Lobby placed" },
    { step: "AI World in _INIT", done: m.entities.some((x) => x.layer === "_INIT" && /AIWorld/.test(x.className)), detail: "the terrain's own AI World, else SCR_AIWorld (guide, Create the World)" },
    { step: "2 Configure Settings", done: PLUGIN2_FIELDS.some(own), detail: PLUGIN2_FIELDS.some(own) ? "settings saved on COA_Lobby" : "no plugin 2 field on COA_Lobby" },
    { step: "3 Configure Factions", done: SIDES.some((s) => own(TICKETS_FIELD[s])), detail: `gearscripts: ${gearscripts.join(", ")}` },
    { step: "4 Configure Slots", done: SIDES.some((s) => own(SLOTS_FIELD[s])), detail: slotted.length ? slotted.map((s) => `${s} ${slotRoles(m.slots[s]).length}`).join(", ") : "no slots" },
    {
      step: "5 Configure Descriptions",
      done: slotted.length > 0 && briefed.length === slotted.length,
      detail: slotted.length ? `briefing written for ${briefed.join(", ") || "no side"}${briefed.length < slotted.length ? `; missing for ${slotted.filter((s) => !briefed.includes(s)).join(", ")}` : ""}` : "no slotted side yet",
    },
    { step: "6 Generate Config File", done: m.confs.length === 1, detail: m.confs.length > 1 ? `${m.confs.length} .conf files: run once only` : m.confs[0] ?? "no .conf yet" },
  ];
  // CRF's "Side-based briefings" tick wants a filled descriptor keyed to every slotted side; show-for-any does not count (mission_synopsis.py:573-580)
  const warnings = slotted.filter((s) => !written.some((d) => d.keys.includes(s))).map((s) =>
    all.some((d) => d.keys.includes(s))
      ? `${s}: the side briefing is still the template text (CRF's PR check leaves "Side-based briefings" unticked)`
      : `${s}: no side briefing (only all-sides or other sides' briefings); CRF's PR check leaves "Side-based briefings" unticked`
  );
  for (const d of written.filter((d) => !d.keys.length && !d.any)) {
    warnings.push(`Briefing "${d.title}" is shown to nobody: it has no faction key and Show For Any Faction is off (Lobby UI, COA_MissionDescriptionUI.c:85-100)`);
  }
  const todo = steps.find((s) => !s.done);
  const next = !todo
    ? "All plugin steps are done: test it with the Dedicated Server Tool (guide section 5)."
    : todo.step === "AI World in _INIT"
      ? "Drag the terrain's own AI World (else SCR_AIWorld) into _INIT."
      : todo.step.startsWith("6") && m.confs.length > 1
        ? "Delete the extra mission .conf: plugin 6 was run more than once."
        : `Run plugin ${todo.step} (Plugins > Coalition Lobby Mission Plugins).`;
  return { steps, next, warnings };
}

// ── GI-04 settings ──────────────────────────────────────────────────────────

export interface Setting { name: string; value: string; from: "mission" | "COA_Lobby.et" | "script default" | "unset" }

const ATTRIBUTE = /\[Attribute\(\s*"([^"]*)"[\s\S]*?\)\]\s*(?:(?:protected|private|static|ref)\s+)*[\w<>,]+\s+(m_\w+)\s*;/g;
/** `[Attribute("default")]` values per field of one script file. */
export function attributeDefaults(script: string): Map<string, string> {
  return new Map([...script.matchAll(ATTRIBUTE)].map((a) => [a[2], a[1]]));
}

const CIV_FACTION_INDEX = 3;
const SHAREABLE = "m_bEnableShareableMarkers";
const FLAGS = [
  ["Enable Leadership Radios", "m_bEnableLeadershipRadios"], ["Enable GI Radios", "m_bEnableGIRadios"], ["Enable RTO Radios", "m_bEnableRTORadios"],
  ["Enable BFT", "m_bEnableBFT"], ["Enable Shareable Markers", SHAREABLE],
] as const;

const yesNo = (v: string) => (v === "1" || v.toLowerCase() === "true" ? "yes" : v === "0" || v.toLowerCase() === "false" ? "no" : v);

/** Plugin 2 to 4 values as saved: the mission's COA_Lobby, then COA_Lobby.et, then COA_Gamemode.c's attribute defaults. */
export function settings(m: Lobby, nodes: EnfusionNode[], enums: LobbyEnums, defaults: Map<string, string>): Setting[] {
  const rows: Setting[] = [];
  const at = (f: (n: EnfusionNode) => string | undefined, def?: string): Pick<Setting, "value" | "from"> => {
    const i = nodes.findIndex((n) => f(n) !== undefined);
    if (i >= 0) return { value: f(nodes[i])!, from: i === 0 ? "mission" : "COA_Lobby.et" };
    return def !== undefined ? { value: def, from: "script default" } : { value: "", from: "unset" };
  };
  const field = (name: string, key: string, show = (v: string) => v) => {
    const r = at((n) => prop(n, key), defaults.get(key));
    rows.push({ name, ...r, value: r.from === "unset" ? "" : show(r.value) });
  };
  const respawnModes = [...(enums.get("COA_ERespawnMode") ?? [])];
  const mode = (v: string) => respawnModes.find(([, n]) => String(n) === v)?.[0] ?? v;
  field("Time limit (minutes)", "m_iTimeLimitMinutes");
  field("Safe start time limit on", "m_bUseSafestartTimeLimit", yesNo);
  field("Safe start time limit", "m_iSafestartTimeLimit");
  field("Lock unused slots (plugin 2's Disable JIP)", "m_bLockUnusedSlots", yesNo);
  field("Respawn", "m_bRespawnEnabled", yesNo);
  field("Respawn mode", "m_eRespawnMode", mode);
  field("Wave respawn", "m_bWaveRespawn", yesNo);
  field("Rally points", "m_bRallyPointsEnabled", yesNo);
  field("Time to respawn", "m_iTimeToRespawn");
  field("Respawn cutoff (minutes)", "m_iRespawnCutoffMinutes");
  field("Time scale", "m_fMissionTimeScale");
  field("CVON", "m_bUseCVON", yesNo);
  // Weather and time live in SCR_TimeAndWeatherHandlerComponent (COA_MissionGamemodePlugin.c:155-164)
  const weather = (n: EnfusionNode) => member(n, "components")?.children.find((c) => c.type === "SCR_TimeAndWeatherHandlerComponent");
  const start = (n: EnfusionNode) => member(weather(n), "m_aStartingWeatherAndTime")?.children[0];
  for (const [name, key] of [["Starting weather", "m_sWeatherPresetName"], ["Starting hour", "m_iStartingHour"], ["Starting minutes", "m_iStartingMinutes"]]) {
    rows.push({ name, ...at((n) => prop(start(n), key)) });
  }
  for (const [name, key] of [["Random starting weather", "m_bRandomStartingWeather"], ["Random weather changes", "m_bRandomWeatherChanges"]]) {
    const r = at((n) => prop(weather(n), key));
    rows.push({ name, ...r, value: r.value && yesNo(r.value) });
  }
  for (const s of SIDES) {
    field(`${s} tickets (0 off, -1 unlimited)`, TICKETS_FIELD[s]);
    const g = at((n) => prop(member(n, SETTINGS_FIELD[s]), "m_rGearScript"));
    rows.push({ name: `${s} gearscript`, ...g, value: g.value && stripGuid(g.value) });
    // Defaults are the last declaration per field, the dialog's COA_SimplifiedGearScriptContainer (COA_GearscriptConfig.c:47-57, CRF_COA_GearscriptConfig.c:62-63; equal to COA_GearScriptContainer's today)
    for (const [label, key] of FLAGS) {
      const r = at((n) => prop(member(n, SETTINGS_FIELD[s]), key), defaults.get(key));
      // Without CRF's script the field has no default and the dialog has no such row
      if (r.from !== "unset" || key !== SHAREABLE) rows.push({ name: `${s} ${label}`, ...r, value: r.from === "unset" ? "" : yesNo(r.value) });
    }
  }
  field("Faction one key", "m_sFactionOneKey");
  field("Faction one ratio", "m_iFactionOneRatio");
  field("Faction two key", "m_sFactionTwoKey");
  field("Faction two ratio", "m_iFactionTwoRatio");
  // Friendly factions sit on the faction manager child of COA_Lobby, keyed by faction GUID (COA_MissionFactionPlugin.c:222-262)
  const manager = m.entities.find((x) => x.parent === m.lobby && x.className === "SCR_FactionManager");
  // The prefab's faction manager is a child entity (an anonymous block) holding each faction's FactionKey
  const managerOf = (n: EnfusionNode) => n.children.filter((c) => c.type === "").flatMap((c) => c.children).find((c) => c.type === "SCR_FactionManager");
  const keyOf = (id: string | undefined) => firstOf(nodes.slice(1), (n) => prop(member(managerOf(n), "Factions")?.children.find((f) => f.id === id), "FactionKey"));
  // The prefab gives CIV no FactionKey: the plugin addresses it as the 4th faction (COA_MissionFactionPlugin.c:13,236).
  // Read the list from the base end of the chain: CRF's override of COA_Lobby.et lists only the factions it changes.
  const civId = firstOf(nodes.slice(1).reverse(),(n) => member(managerOf(n), "Factions")?.children[CIV_FACTION_INDEX]?.id);
  for (const f of member(manager?.node, "Factions")?.children ?? []) {
    const friends = member(f, "m_aFriendlyFactionsIds")?.values;
    if (friends) rows.push({ name: `${keyOf(f.id) ?? (f.id === civId ? "CIVILIAN" : `faction ${f.id}`)} friendly with`, value: friends.join(", ") || "none", from: "mission" });
  }
  return rows;
}

// ── GI-05 standards ─────────────────────────────────────────────────────────

// Guide section 6: callsigns COY, <n>PLT, <p>-<s>, <p>-<s>R|G; the standard 9-man squad
const CALLSIGN = /^(COY( [A-Z])?|\d+PLT|\d+-\d+[RG]?)$/;
export const STANDARD_SQUAD = [
  "SQUAD_LEAD", "MEDIC", "TEAM_LEAD", "AUTOMATIC_RIFLEMAN", "ASSISTANT_AUTOMATIC_RIFLEMAN", "TEAM_LEAD", "RIFLEMAN_ANTITANK", "RIFLEMAN_ANTITANK", "RIFLEMAN_DEMO",
];

const diff = (have: string[], want: string[]) => {
  const left = [...have];
  const missing = want.filter((r) => {
    const i = left.indexOf(r);
    if (i < 0) return true;
    left.splice(i, 1);
    return false;
  });
  return { missing, extra: left };
};

/**
 * The guide's standards per side, from the slotted groups. Slotting stores no hierarchy (groups are a flat list,
 * COA_MissionSlottingPlugin.c:290-327), so the Rule of Twos is read from the callsigns. Warnings and info only.
 */
export function standards(m: Mission): Note[] {
  const notes: Note[] = [];
  for (const side of SIDES.filter((s) => m.slots[s])) {
    const groups = m.slots[side]!.map((g) => ({ callsign: (prop(g, "m_sCallsign") ?? "").trim(), roles: member(g, "m_aSlots")?.values ?? [] }));
    const odd = groups.filter((g) => !CALLSIGN.test(g.callsign)).map((g) => g.callsign || "(none)");
    if (odd.length) notes.push({ level: "info", text: `${side} callsigns not in the guide's form (COY, 1PLT, 1-1, 1-1R): ${odd.join(", ")}` });
    const platoons = groups.map((g) => /^(\d+)PLT$/.exec(g.callsign)?.[1]).filter((p): p is string => !!p);
    for (const p of platoons) {
      const squads = groups.filter((g) => new RegExp(`^${p}-\\d+$`).test(g.callsign)).length;
      if (squads < 2 || squads > 4) notes.push({ level: "warning", text: `${side} ${p}PLT leads ${squads} squad(s); the Rule of Twos wants 2 to 4` });
    }
    if (groups.some((g) => /^COY/.test(g.callsign)) && platoons.length < 2) {
      notes.push({ level: "warning", text: `${side} COY leads ${platoons.length} platoon(s); the Rule of Twos wants 2 to 4` });
    }
    for (const g of groups.filter((x) => /^\d+-\d+$/.test(x.callsign))) {
      const teams = Math.max(g.roles.filter((r) => r === "TEAM_LEAD").length, groups.filter((x) => new RegExp(`^${g.callsign}[RG]$`).test(x.callsign)).length);
      if (teams < 2) notes.push({ level: "warning", text: `${side} ${g.callsign} has ${teams} fireteam(s); the Rule of Twos wants a squad over its two colour teams` });
      // The Lobby's own rifle squad (Configs/SlottingGroups/Squads/COA_RifleSquad.conf) has GRENADIER where the guide says Demo
      const { missing, extra } = diff(g.roles.includes("RIFLEMAN_DEMO") ? g.roles : g.roles.map((r, i, a) => (r === "GRENADIER" && a.indexOf("GRENADIER") === i ? "RIFLEMAN_DEMO" : r)), STANDARD_SQUAD);
      if (missing.length || extra.length) {
        notes.push({ level: "info", text: `${side} ${g.callsign} differs from the guide's 9-man squad: missing ${missing.join(", ") || "none"}; extra ${extra.join(", ") || "none"}` });
      }
    }
  }
  return notes;
}

// ── GI-06 safe compositions ─────────────────────────────────────────────────

// Guide, Safe Compositions: replacements by avoid category and slot size, then by slot row
const SAFE: Record<string, string[]> = {
  Barricade_L: ["COAL_Barricade_L", "COAL_Checkpoint_L_USSR", "CheckpointUnderConstruction_L_US"], Checkpoint_L: ["COAL_Checkpoint_L_USSR", "CheckpointUnderConstruction_L_US"],
  LivingArea_L: ["COAL_Barracks_L"], Helipad_L: ["COAL_Helipad_L"],
  road_M: ["CheckpointUnderConstruction_M_US"], road_S: ["CheckpointUnderConstruction_S_US"],
  flat_L: ["COAL_Barracks_L", "COAL_Helipad_L"], flat_M: ["COAL_FieldHospital_M"], flat_S: ["COAL_SandbagPos_S"],
};
/** Every name on the guide's safe list. */
export const SAFE_NAMES = [...new Set(Object.values(SAFE).flat())];

/** The guide's replacement names for one avoid-list composition (category and size from its file name). */
export function replacements(path: string): string[] {
  const m = /(Barricade|Checkpoint|LivingArea|Helipad|FieldHospital|VehicleMaintenance|FiringRange|AmmoStorage)_([LMS])_/.exec(basename(path));
  if (!m) return [];
  const road = m[1] === "Barricade" || m[1] === "Checkpoint";
  return SAFE[`${m[1]}_${m[2]}`] ?? SAFE[`${road ? "road" : "flat"}_${m[2]}`] ?? [];
}

// ── GI-07 world structure ───────────────────────────────────────────────────

/** The world's sub-scene parent, terrain folder and AI World against the guide's Create the World steps. */
export function worldChecks(config: Config, m: Mission, copies: Layer[]): Note[] {
  const notes: Note[] = [];
  let ent: EnfusionNode | undefined;
  try {
    ent = parseAll(textOf(m.copy, m.worldRel) ?? "")[0];
  } catch {
    // reported below as not a sub-scene
  }
  const parent = ent?.type === "SubScene" ? prop(ent, "Parent") : undefined;
  if (!parent) {
    notes.push({ level: "warning", text: `${m.worldRel} is not a sub-scene of a terrain: the guide makes the mission a Sub-Scene (of current world) so it never edits the map` });
    return notes;
  }
  const terrain = basename(stripGuid(parent), ".ent");
  if (/empty/i.test(terrain)) notes.push({ level: "warning", text: `Parent world ${stripGuid(parent)} is an "Empty" variant; the guide says to skip those` });
  const parts = m.worldRel.split("/");
  if (parts.length !== 3 || parts[0].toLowerCase() !== "worlds") {
    notes.push({ level: "warning", text: `Plugin 6 names the terrain after the world's folder (COA_MissionConfigurationPlugin.c:100-105): save it as Worlds/<Terrain>/<name>.ent, not ${m.worldRel}` });
  } else if (parts[1].toLowerCase() !== terrain.toLowerCase()) {
    notes.push({ level: "info", text: `World folder ${parts[1]}, parent world ${terrain}: plugin 6 names the terrain ${parts[1]}` });
  }
  // shortcut: a terrain's own AI World is found only as Prefabs/AI/SCR_AIWorld_<parent world name>.et; others (SCR_AIWorld_Cherno) are missed
  const ai = m.entities.find((x) => x.layer === "_INIT" && /AIWorld/.test(x.className));
  const own = `Prefabs/AI/SCR_AIWorld_${terrain}.et`;
  if (ai?.prefab && basename(stripGuid(ai.prefab)) === "SCR_AIWorld.et" && (copies.some((c) => c.exists(own)) || readEtFile(own, config) !== null)) {
    notes.push({ level: "warning", text: `_INIT uses the default SCR_AIWorld, but the terrain has its own: ${own} (guide: use the terrain's own AI World)` });
  }
  return notes;
}

// ── GI-08 zone geometry ─────────────────────────────────────────────────────

type Pt = [number, number];
const xz = (s: string | undefined): Pt | undefined => {
  const v = s?.trim().split(/\s+/).map(Number);
  return v && v.length >= 3 && v.every(Number.isFinite) ? [v[0], v[2]] : undefined;
};

/** A zone's outline in world x/z: its ShapePoint positions are offsets from the entity's coords. */
export function outline(e: MissionEntity): Pt[] | undefined {
  const o = xz(prop(e.node, "coords"));
  const pts = (member(e.node, "Points")?.children ?? []).map((p) => xz(prop(p, "Position")));
  if (!o || pts.length < 3 || pts.some((p) => !p)) return undefined;
  return pts.map((p) => [o[0] + p![0], o[1] + p![1]]);
}

const inside = ([x, z]: Pt, poly: Pt[]) => {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
};
const edgeDistance = ([x, z]: Pt, poly: Pt[]) =>
  Math.min(...poly.map(([ax, az], i) => {
    const [bx, bz] = poly[(i + 1) % poly.length];
    const dx = bx - ax, dz = bz - az;
    const t = dx || dz ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz))) : 0;
    return Math.hypot(x - (ax + t * dx), z - (az + t * dz));
  }));

/** Spawns inside their side's safe start zone; spawns, objectives, markers and forward deploy zones inside the game border. */
export function zoneChecks(m: Mission, classes: Map<MissionEntity, Classified | undefined>): Note[] {
  const notes: Note[] = [];
  const name = (e: MissionEntity) => e.name ?? `${e.className} in ${e.layer}`;
  // Child entities' coords are relative to their parent, so only top-level entities are checked
  const top = [...classes].filter(([e]) => !e.parent);
  const rotated = (e: MissionEntity) => ["angleX", "angleY", "angleZ", "angles"].some((k) => prop(e.node, k) !== undefined);
  // Every zone of one kind (and side), or none when one of them cannot be read: a point outside the others may sit in it
  const zones = (kind: string, side?: string): Pt[][] => {
    const polys: Pt[][] = [];
    for (const [e] of top.filter(([, c]) => c?.kind === kind && (!side || c.side === side))) {
      const o = rotated(e) ? undefined : outline(e);
      if (!o) {
        notes.push({ level: "info", text: `${name(e)} ${rotated(e) ? "is rotated" : "has no readable outline"}; zone checks against it were skipped` });
        return [];
      }
      polys.push(o);
    }
    return polys;
  };
  // Under 1 m counts as on the edge
  const miss = (pt: Pt, polys: Pt[][]) => {
    if (polys.some((p) => inside(pt, p))) return undefined;
    const d = Math.round(Math.min(...polys.map((p) => edgeDistance(pt, p))));
    return d >= 1 ? d : undefined;
  };
  for (const side of SIDES.filter((s) => m.slots[s])) {
    const safe = zones("safestart", side);
    if (!safe.length) continue;
    for (const [e] of top.filter(([, c]) => (c?.kind === "spawn" || c?.kind === "groupSpawn") && c.side === side)) {
      const pt = xz(prop(e.node, "coords"));
      const d = pt && miss(pt, safe);
      if (d !== undefined) notes.push({ level: "warning", text: `${name(e)} is ${d} m outside the ${side} safe start zone (fine for a respawn point used after safe start)` });
    }
  }
  const border = zones("gameBorder");
  if (border.length) {
    const inPlay = top.filter(([e, c]) => ["spawn", "groupSpawn", "objectiveMarker", "spawnMarker"].includes(c?.kind ?? "") || e.layer.toUpperCase() === "OBJECTIVES");
    for (const [e] of inPlay) {
      const pt = xz(prop(e.node, "coords"));
      const d = pt && miss(pt, border);
      if (d !== undefined) notes.push({ level: "warning", text: `${name(e)} is ${d} m outside the game border` });
    }
    for (const [e] of top.filter(([, c]) => c?.kind === "forwardDeploy")) {
      if (rotated(e)) {
        notes.push({ level: "info", text: `${name(e)} is rotated; zone checks against it were skipped` });
        continue;
      }
      const o = outline(e);
      const worst = o && Math.max(...o.map((p) => miss(p, border) ?? 0));
      if (worst) notes.push({ level: "warning", text: `Forward deploy zone ${name(e)} reaches ${worst} m outside the game border` });
    }
  }
  return notes;
}
