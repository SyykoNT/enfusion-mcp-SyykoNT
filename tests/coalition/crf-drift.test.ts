import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../../src/config.js";
import { SLOTS_FIELD } from "../../src/coalition/mission-model.js";
import { CLASS_FALLBACK, RULES } from "../../src/coalition/mission-prefabs.js";
import { NAME_FIELD, NAME_LIST, NOT_NAMES } from "../../src/coalition/name-refs.js";
import { CVON_ROLES_CONFIG, LEADER_SLOTS, LOBBY_PREFAB, MANAGER, POOLS, ROLES_CONFIG, SETTINGS_FIELD, SINGLES } from "../../src/tools/gearscript-inspect.js";
import { SCRIPTS } from "../../src/tools/mission-validate.js";
import { CRF_MARKER, resolveCoalitionRoots, type CoalitionRoots } from "../../src/utils/coalition-paths.js";
import { loadLobbyEnums } from "../../src/utils/lobby-enums.js";

// Read-only check of the live CRF and COALITION-Lobby clones for every class, field, enum, prefab
// family and fixed path the MCP's CRF/Lobby code names. Runs only when ENFUSION_PROJECT_PATH holds
// both clones (as for the MCP itself). Holds names only, never file contents.

let roots: CoalitionRoots | undefined;
let why = "ENFUSION_PROJECT_PATH is not set";
if (process.env.ENFUSION_PROJECT_PATH) {
  try {
    roots = resolveCoalitionRoots({ projectPath: process.env.ENFUSION_PROJECT_PATH, defaultMod: process.env.ENFUSION_DEFAULT_MOD } as Config);
  } catch (e) {
    why = (e as Error).message;
  }
}

const GS = "gearscript-inspect.ts";
// Fields read inside function bodies (gearscript-inspect.ts resolveLoadout :96-193, missionSide :280-286, header :391;
// name-refs.ts taskEntries and gamemodeNames; mission-model.ts loadMission :99, slotRoles :127)
const FIELDS: [cls: string, fields: string[], source: string][] = [
  ["COA_GearScriptConfig", [...Object.values(POOLS), ...Object.values(SINGLES)], `${GS} POOLS, SINGLES`],
  ["COA_GearScriptConfig", ["m_DefaultClothing", "m_RolesToSetCustomSettings", "m_sLeadershipBinocularsPrefab", "m_sAssistantBinocularsPrefab", "m_MedicMedicalItems", "m_InfantryMedicalItems", "m_DefaultInventoryItems", "m_FactionName"], `${GS} resolveLoadout`],
  ["COA_Weapon_Class", ["m_Weapon", "m_MagazineArray"], `${GS} option`],
  ["COA_Spec_Weapon_Class", ["m_Weapon", "m_MagazineArray"], `${GS} option`],
  ["COA_Spec_Magazine_Class", ["m_Magazine", "m_MagazineCount", "m_AssistantMagazineCount"], `${GS} option`],
  ["COA_Clothing", ["m_ClothingPrefabs", "m_iClothingType"], `${GS} resolveLoadout`],
  ["COA_Role_Custom_Gear", ["m_Role", "m_Clothing", "m_PrimaryWeapon", "m_SecondaryWeapon", "m_Pistols", "m_AdditionalInventoryItems"], `${GS} resolveLoadout`],
  ["COA_Inventory_Item", ["m_sItemPrefab", "m_iItemCount"], `${GS} resolveLoadout`],
  ["COA_RolesConfig", ["m_RoleConfigs"], `${GS} gearscriptInspect`],
  ["COA_RoleConfig", ["m_Role", "m_SlottingType", "m_sRoleName", "m_aWeapons", "m_aMagazines", "m_aItems"], `${GS} resolveLoadout`],
  ["COA_GearScriptContainer", ["m_rGearScript", "m_bEnableLeadershipRadios", "m_bEnableGIRadios", "m_bEnableRTORadios"], `${GS} missionSide`],
  ["COA_Gamemode", [...Object.values(SETTINGS_FIELD), "m_bUseCVON"], `${GS} SETTINGS_FIELD, missionSide`],
  ["COA_Gamemode", Object.values(SLOTS_FIELD), "mission-model.ts SLOTS_FIELD"],
  ["COA_SlottingGroup", ["m_aSlots"], "mission-model.ts slotRoles"],
  ["CVON_VONGameModeComponent", [], `${GS} missionSide`],
  ["CRF_TaskCreatorComponent", ["m_aTaskEntries"], "name-refs.ts taskEntries"],
  ["CRF_TaskCreatorEntry", ["m_sTaskLabel", "m_eTaskType", "m_eAssignedSide", "m_sSpawnEntityName"], "name-refs.ts taskEntries"],
  ["CRF_SearchAndDestroyGamemodeManager", [], "name-refs.ts gamemodeNames"],
  ["CRF_RushGamemodeManager", ["m_iNumberOfZones", "m_iMCOMsPerZone"], "name-refs.ts gamemodeNames"],
  ["CRF_RallyGamemodeComponent", [], "name-refs.ts gamemodeNames"],
  ["CRF_GunGame", [], "name-refs.ts gamemodeNames"],
  ...Object.keys(CLASS_FALLBACK).map((c): [string, string[], string] => [c, [], "mission-prefabs.ts CLASS_FALLBACK"]),
];
// Enum members the tools compare against (gearscript-inspect.ts resolveLoadout :96-187); the tools read value-0 defaults live
const ENUMS: [enumName: string, members: string[], source: string][] = [
  ["COA_EGearRole", [], `${GS} roleOf`],
  ["COA_ESlotType", [...LEADER_SLOTS, "ASSISTANT"], `${GS} LEADER_SLOTS, resolveLoadout`],
  ["COA_EGearscriptClothing", [], `${GS} resolveLoadout`],
  ["COA_EGearscriptWeapons", [...Object.keys(POOLS), ...Object.keys(SINGLES)], `${GS} POOLS, SINGLES`],
  ["COA_EGearscriptMagazines", [...Object.keys(POOLS), ...Object.keys(SINGLES)].map((c) => `${c}_MAG`), `${GS} resolveLoadout`],
  ["COA_EGearscriptItems", ["SHORTRANGE_RADIO", "LONGRANGE_RADIO", "RTO_RADIO", "LEADERSHIP_BINO", "ASSISTANT_BINO", "MEDIC_ITEMS"], `${GS} resolveLoadout`],
  ["CRF_EObjectiveTaskType", [], "mission-inspect.ts tasks"],
  ["CRF_EObjectiveNotifySide", [], "mission-inspect.ts tasks"],
];

const CLASS_HEAD = /^\s*(?:modded\s+)?class\s+(\w+)\s*(?::\s*(\w+))?/gm;
const FIELD = /\b(m_\w+)\s*(?:;|=(?!=))/g;

/** Classes declared in each root's Scripts, with their parent and the m_ names declared or assigned in their bodies. */
function readClasses(dirs: string[]) {
  const classes = new Map<string, { parents: Set<string>; fields: Set<string> }>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const rel of readdirSync(dir, { recursive: true }) as string[]) {
      if (!rel.endsWith(".c")) continue;
      const text = readFileSync(join(dir, rel), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      const heads = [...text.matchAll(CLASS_HEAD)];
      // shortcut: a class body runs to the next class header; fine while Enforce classes are not nested
      heads.forEach((h, i) => {
        const c = classes.get(h[1]) ?? { parents: new Set<string>(), fields: new Set<string>() };
        if (h[2]) c.parents.add(h[2]);
        for (const f of text.slice(h.index!, heads[i + 1]?.index ?? text.length).matchAll(FIELD)) c.fields.add(f[1]);
        classes.set(h[1], c);
      });
    }
  }
  return classes;
}

/** `{GUID}path` or a plain path: missing if absent from every root, or if its .meta names another GUID. */
function checkResource(res: string, rootList: string[]): string | undefined {
  const guid = /^\{([0-9A-Fa-f]{16})\}/.exec(res)?.[1];
  const rel = res.replace(/^\{[0-9A-Fa-f]{16}\}/, "");
  const file = rootList.map((r) => join(r, rel)).find(existsSync);
  if (!file) return "file not found";
  if (!guid) return undefined;
  const meta = existsSync(`${file}.meta`) ? readFileSync(`${file}.meta`, "utf-8") : "";
  return meta.toUpperCase().includes(`{${guid.toUpperCase()}}`) ? undefined : `.meta has no {${guid}}`;
}

describe.skipIf(!roots)(`CRF and Lobby drift${roots ? "" : ` (skipped: ${why})`}`, () => {
  it("every class, field, enum, prefab family and fixed path the MCP names still exists", () => {
    const { crf, lobby } = roots!;
    const both = [lobby, crf];
    const missing: string[] = [];
    const miss = (area: string, name: string, source: string, detail = "") => missing.push(`${area}: ${name}${detail ? ` (${detail})` : ""} [${source}]`);

    const classes = readClasses(both.map((r) => join(r, "Scripts")));
    const has = (cls: string, field: string, seen = new Set<string>()): boolean => {
      const c = classes.get(cls);
      if (!c || seen.has(cls)) return false;
      seen.add(cls);
      return c.fields.has(field) || [...c.parents].some((p) => has(p, field, seen));
    };
    for (const [cls, fields, source] of FIELDS) {
      if (!classes.has(cls)) miss("class", cls, source);
      else for (const f of fields) if (!has(cls, f)) miss("field", `${cls}.${f}`, source);
    }
    const allFields = [...classes.values()].flatMap((c) => [...c.fields]);
    if (!allFields.some((f) => NAME_FIELD.test(f) && !NOT_NAMES.has(f))) miss("field pattern", String(NAME_FIELD), "name-refs.ts NAME_FIELD");
    if (!allFields.some((f) => NAME_LIST.test(f))) miss("field pattern", String(NAME_LIST), "name-refs.ts NAME_LIST");
    for (const f of NOT_NAMES) if (!allFields.includes(f)) miss("field", f, "name-refs.ts NOT_NAMES");
    // Task Creator anchors are only checked because their field matches NAME_FIELD
    if (!NAME_FIELD.test("m_sSpawnEntityName")) miss("field pattern", "m_sSpawnEntityName no longer matches NAME_FIELD", "name-refs.ts NAME_FIELD");

    const enums = loadLobbyEnums(both);
    for (const [name, members, source] of ENUMS) {
      const e = enums.get(name);
      if (!e) miss("enum", name, source);
      else {
        if (![...e.values()].includes(0)) miss("enum", `${name} has no member with value 0`, source);
        for (const m of members) if (!e.has(m)) miss("enum member", `${name}.${m}`, source);
      }
    }

    // Prefab families are matched against mission-maker prefabs only (mission-prefabs.ts loadMissionPrefabs)
    const prefabs = both.flatMap((r) => {
      const dir = join(r, "PrefabsMissionMaking");
      return existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".et")).map((f) => `/PrefabsMissionMaking/${f.replace(/\\/g, "/")}`) : [];
    });
    for (const [kind, re] of RULES) if (!prefabs.some((p) => re.test(p))) miss("prefab pattern", `${kind} ${re}`, "mission-prefabs.ts RULES");

    const fixed: [res: string, rootList: string[], source: string][] = [
      [ROLES_CONFIG, both, `${GS} ROLES_CONFIG`],
      [CVON_ROLES_CONFIG, both, `${GS} CVON_ROLES_CONFIG`],
      [MANAGER, [lobby], `${GS} MANAGER`],
      [`{6A996BBFCEB37E78}${LOBBY_PREFAB}`, [lobby], `${GS} LOBBY_PREFAB`],
      // CRF's same-GUID override that most missions place COA_Lobby from (gearscript-inspect.ts missionSide comment)
      ["{6A996BBFCEB37E78}Prefabs/Modded Overrides/Coalition Lobby/COA_Lobby.et", [crf], `${GS} missionSide`],
      [CRF_MARKER.replace(/\\/g, "/"), [crf], "coalition-paths.ts CRF_MARKER"],
      ...Object.values(SCRIPTS).map((s): [string, string[], string] => [`Tools/Validation/${s}`, [crf], "mission-validate.ts SCRIPTS"]),
      // MAY_THROW in tests/formats/enfusion-text.corpus.test.ts:15
      ["Prefabs/Structures/Rush/CRF_Rush_MCOM_NoNet.et", [crf], "enfusion-text.corpus.test.ts MAY_THROW"],
    ];
    for (const [res, rootList, source] of fixed) {
      const problem = checkResource(res, rootList);
      if (problem) miss("fixed path", res, source, problem);
    }
    // gearscript-inspect.ts rolesConfigResource reads these constants from MANAGER by name
    const manager = existsSync(join(lobby, MANAGER)) ? readFileSync(join(lobby, MANAGER), "utf-8") : "";
    for (const c of ["C_RolesConfigResource", "C_CVONRolesConfigResource"]) if (!manager.includes(c)) miss("constant", `${c} in ${MANAGER}`, `${GS} rolesConfigResource`);

    expect(missing, `${missing.length} item(s) the MCP relies on are gone from CRF or the Lobby:\n${missing.join("\n")}`).toEqual([]);
  });
});
