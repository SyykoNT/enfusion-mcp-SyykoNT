import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EnfusionNode } from "../formats/enfusion-text.js";
import { levenshtein } from "../utils/fuzzy.js";
import { components, member, prop, type MissionEntity } from "./mission-model.js";

// CRF gamemodes find their objectives by entity name at run time (FindEntityByName). These rules
// describe CRF's game scripts in our own words; line citations are to CRF Scripts/Game.

export interface NameRef {
  entity: string;
  component: string;
  /** Field the name came from, or "(gamemode name)" for a name the gamemode code looks up by itself */
  field: string;
  value: string;
  /** Unset in the mission: the script's [Attribute] default, which some gamemodes use only when an option is on */
  fromDefault?: boolean;
  found?: boolean;
  suggestions?: string[];
}
export interface NameNote { level: "warning" | "info"; text: string }

// Field suffixes from the FindEntityByName call sites (e.g. CRF_TaskCreatorComponent.c:321, CRF_CTF_Game.c:157)
const NAME_FIELD = /^m_s\w*(EntityName|BaseName|FlagName|BoundaryName|SpawnName|TriggerName|ZoneName)$/;
const NAME_LIST = /^m_a\w*Names$/;
// Look like names but are labels: Rush m_sZoneName "does NOT do anything outside of MM organization" (CRF_Rush_Game.c:38)
const NOT_NAMES = new Set(["m_sZoneName"]);

const label = (e: MissionEntity) => e.name ?? `${e.className} in ${e.layer}`;

const ATTR = /\[Attribute\(\s*"([^"]*)"[^\]]*\]\s*(?:(?:protected|private|static)\s+)*string\s+(m_s\w+)\s*;/g;
const CLASS = /^\s*(?:modded\s+)?class\s+(\w+)/gm;

/**
 * Non-empty `[Attribute("default")] string m_s...Name;` defaults per script class under `<root>/Scripts/Game`:
 * a gamemode uses the default when the mission leaves the field unset (e.g. CRF_CacheHunt_Game.c:185).
 */
export function nameDefaults(roots: string[]): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const root of roots) {
    const dir = join(root, "Scripts", "Game");
    if (!existsSync(dir)) continue;
    for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
      if (!rel.endsWith(".c")) continue;
      const text = readFileSync(join(dir, rel), "utf-8");
      if (!text.includes("Name;")) continue;
      const classes = [...text.matchAll(CLASS)];
      for (const m of text.matchAll(ATTR)) {
        if (!m[1] || !NAME_FIELD.test(m[2]) || NOT_NAMES.has(m[2])) continue;
        // shortcut: the field belongs to the last class declared above it; fine while classes are not nested
        const cls = classes.filter((c) => c.index! < m.index!).pop()?.[1];
        if (!cls) continue;
        const fields = out.get(cls) ?? new Map<string, string>();
        fields.set(m[2], m[1]);
        out.set(cls, fields);
      }
    }
  }
  return out;
}

/** Name references in every component block of every entity (fields and string lists, nested entries included), plus unset fields' script defaults. */
export function collectNameRefs(entities: MissionEntity[], defaults = new Map<string, Map<string, string>>()): NameRef[] {
  const refs: NameRef[] = [];
  for (const e of entities) {
    for (const comp of components(e)) {
      for (const [field, value] of defaults.get(comp.type) ?? []) {
        if (prop(comp, field) === undefined) refs.push({ entity: label(e), component: comp.type, field, value, fromDefault: true });
      }
      const walk = (n: EnfusionNode) => {
        for (const p of n.properties) {
          if (typeof p.value === "string" && p.value && NAME_FIELD.test(p.key) && !NOT_NAMES.has(p.key)) {
            refs.push({ entity: label(e), component: comp.type, field: p.key, value: p.value });
          }
        }
        for (const c of n.children) {
          if (NAME_LIST.test(c.type)) for (const v of c.values) if (v) refs.push({ entity: label(e), component: comp.type, field: c.type, value: v });
          walk(c);
        }
      };
      walk(comp);
    }
  }
  return refs;
}

/** Names the attached gamemode components look up by themselves, plus notes on numbered sequences. */
export function gamemodeNames(entities: MissionEntity[], names: Set<string>): { refs: NameRef[]; notes: NameNote[] } {
  const refs: NameRef[] = [];
  const notes: NameNote[] = [];
  const fixed = (e: MissionEntity, comp: string, ...values: string[]) =>
    refs.push(...values.map((value) => ({ entity: label(e), component: comp, field: "(gamemode name)", value })));
  /** prefix0/1.. or prefix1/2..: count until the first gap, as the gamemode loops do */
  const run = (prefix: string, from: number) => {
    let i = from;
    while (names.has(`${prefix}${i}`)) i++;
    return i - from;
  };

  for (const e of entities) {
    for (const comp of components(e)) {
      switch (comp.type) {
        case "CRF_SearchAndDestroyGamemodeManager":
          // CRF_S&D_Game.c:88-89 reads both triggers' origins without a null check
          fixed(e, comp.type, "aSiteTrigger", "bSiteTrigger");
          break;
        case "CRF_RushGamemodeManager": {
          // [Attribute] defaults 3 zones, 2 MCOMs per zone (CRF_Rush_Game.c:80-84); names from GetTriggerName :418-436
          const zones = Number(prop(comp, "m_iNumberOfZones") ?? 3);
          const perZone = Number(prop(comp, "m_iMCOMsPerZone") ?? 2);
          for (let g = 0; g < zones * perZone; g++) fixed(e, comp.type, g < 6 ? `mcom_${"abcdef"[g]}_trigger` : `mcom_${g + 1}_trigger`);
          // InitializeLegacyMCOMs runs after the mcom_* loop either way (CRF_Rush_Game.c:353-374, 465-476)
          const legacy = [1, 2, 3].flatMap((z) => [`z${z}_alpha_trigger`, `z${z}_beta_trigger`]).filter((n) => names.has(n));
          if (legacy.length) notes.push({ level: "info", text: `Rush legacy names present (both schemes run): ${legacy.join(", ")}` });
          break;
        }
        case "CRF_RallyGamemodeComponent": {
          // rally_start, rally_cp1.. up to the first gap, rally_end (CRF_RallyGamemodeComponent.c:380-396)
          fixed(e, comp.type, "rally_start", "rally_end");
          notes.push({ level: "info", text: `Rally checkpoints rally_cp1.. found: ${run("rally_cp", 1)} (counting stops at the first gap)` });
          break;
        }
        case "CRF_GunGame": {
          // spawnpoint0, spawnpoint1.. up to the first gap (CRF_GunGame.c:263-268)
          const n = run("spawnpoint", 0);
          notes.push(
            n
              ? { level: "info", text: `Gun Game spawn points spawnpoint0..spawnpoint${n - 1} found: ${n}` }
              : { level: "warning", text: "Gun Game: no entity named spawnpoint0, so no spawn point is found (CRF_GunGame.c:263-268)" }
          );
          break;
        }
      }
    }
  }
  return { refs, notes };
}

/** Mark each reference found (exact, case-sensitive) and suggest near misses: same name ignoring case, or edit distance 1 or 2. */
export function resolveNames(refs: NameRef[], names: Set<string>): NameRef[] {
  const all = [...names];
  return refs.map((r) => {
    if (names.has(r.value)) return { ...r, found: true };
    const v = r.value.toLowerCase();
    const suggestions = all
      .map((n) => ({ n, d: levenshtein(v, n.toLowerCase()) }))
      .filter((x) => x.d <= 2)
      .sort((a, b) => a.d - b.d || a.n.localeCompare(b.n))
      .slice(0, 3)
      .map((x) => x.n);
    return { ...r, found: false, suggestions };
  });
}

/** Task Creator entries (CRF_TaskCreatorComponent.c:75-137). Enum fields left unset are reported as undefined. */
export function taskEntries(entities: MissionEntity[]) {
  return entities.flatMap((e) =>
    components(e)
      .filter((c) => c.type === "CRF_TaskCreatorComponent")
      .flatMap((c) => member(c, "m_aTaskEntries")?.children ?? [])
      .map((t) => ({
        label: prop(t, "m_sTaskLabel"),
        type: prop(t, "m_eTaskType"),
        side: prop(t, "m_eAssignedSide"),
        anchor: prop(t, "m_sSpawnEntityName") ?? "",
      }))
  );
}
