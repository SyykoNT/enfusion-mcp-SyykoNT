import { describe, it, expect } from "vitest";
import { loadConfig } from "../../src/config.js";
import { GUIDE_LAYERS } from "../../src/coalition/mission-checks.js";
import { SLOTS_FIELD } from "../../src/coalition/mission-model.js";
import { CLASS_FALLBACK, RULES } from "../../src/coalition/mission-prefabs.js";
import { NAME_FIELD, NAME_LIST, NOT_NAMES, nameDefaults } from "../../src/coalition/name-refs.js";
import { CVON_ROLES_CONFIG, LEADER_SLOTS, LOBBY_PREFAB, MANAGER, POOLS, ROLES_CONFIG, SETTINGS_FIELD, SINGLES } from "../../src/tools/gearscript-inspect.js";
import { CHECKS_END, CHECKS_START, SCRIPTS, SYNOPSIS_END, SYNOPSIS_START } from "../../src/tools/mission-validate.js";
import { resolveCoalitionRoots, type CoalitionCopy, type CoalitionRoots } from "../../src/utils/coalition-paths.js";
import { loadLobbyEnums } from "../../src/utils/lobby-enums.js";

// Read-only check of the CRF and COALITION-Lobby copies (clones in ENFUSION_PROJECT_PATH, and the Workshop
// downloads) for every class, field, enum, prefab family, entity name and fixed path the MCP's CRF/Lobby
// code names. Runs only when ENFUSION_PROJECT_PATH is set. Holds names only, never file contents.
// With it set the clone test always runs: a failed clone lookup fails the test. The Workshop test is
// skipped when no Workshop copy is found (not needed to develop the MCP).

const projectPath = process.env.ENFUSION_PROJECT_PATH;
const config = { ...loadConfig(), projectPath: projectPath! };
let workshop: CoalitionRoots | undefined;
let workshopWhy = "";
if (projectPath) {
  try {
    workshop = resolveCoalitionRoots(config, undefined, undefined, "workshop");
  } catch (e) {
    workshopWhy = (e as Error).message;
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
  // mission-names.ts reads the enum live; only its parameter help names these three
  ["COA_EGamemode", ["TVT", "COOP", "COTVT"], "mission-names.ts mode"],
];
// Entity names the gamemode components look up themselves (name-refs.ts gamemodeNames); each must stay a string literal in CRF Scripts
const GAMEMODE_NAMES = [
  "aSiteTrigger", "bSiteTrigger",
  "mcom_a_trigger", "mcom_b_trigger", "mcom_c_trigger", "mcom_d_trigger", "mcom_e_trigger", "mcom_f_trigger", "mcom_%1_trigger",
  "z1_alpha_trigger", "z1_beta_trigger", "z2_alpha_trigger", "z2_beta_trigger", "z3_alpha_trigger", "z3_beta_trigger",
  "rally_start", "rally_end", "rally_cp%1", "spawnpoint",
];
// Plugin 6 text the name rules copy (mission-names.ts buildNames, alnum, utcMmdd); the Lobby builds the names in COA_MissionConfigurationPlugin.c
const PLUGIN6: [text: string, source: string][] = [
  ['string.Format("COA %1%2 %3"', "mission-names.ts buildNames (in-game name)"],
  ['"%1_%2%3_%4%5_%6"', "mission-names.ts buildNames (.conf name)"],
  ["SCR_StringHelper.ALPHANUMERICAL", "mission-names.ts alnum"],
  ["Workbench.GetPackedUtcTime()", "mission-names.ts utcMmdd"],
];
// Flags mission-validate.ts passes: --project to all three scripts, the target flags to qa and synopsis only (resources gets only --project)
const FLAGS: [script: string, flags: string[]][] = [
  [SCRIPTS.qa, ["--project", "--world", "--base-ref"]],
  [SCRIPTS.synopsis, ["--project", "--world", "--base-ref"]],
  [SCRIPTS.resources, ["--project"]],
];
// Not checked on purpose: the guide's safe compositions (mission-checks.ts SAFE: no COAL_ composition in CRF today, the vanilla ones are in
// the game paks, and mission_inspect checks each file exists at run time, D-039) and the avoid categories (vanilla file names).

const CLASS_HEAD = /^\s*(?:modded\s+)?class\s+(\w+)\s*(?::\s*(\w+))?/gm;
const FIELD = /\b(m_\w+)\s*(?:;|=(?!=))/g;

type Script = { copy: CoalitionCopy; path: string; text: string };

/** Every .c under a folder of each copy, comments stripped. */
function readScripts(copies: CoalitionCopy[], dir: string): Script[] {
  return copies.flatMap((copy) =>
    copy.list(dir).filter((p) => p.endsWith(".c")).map((path) => ({ copy, path, text: (copy.read(path)?.toString("utf-8") ?? "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "") }))
  );
}

/** Classes declared in the scripts, with their parent and the m_ names declared or assigned in their bodies. */
function readClasses(scripts: Script[]) {
  const classes = new Map<string, { parents: Set<string>; fields: Set<string> }>();
  for (const { text } of scripts) {
    const heads = [...text.matchAll(CLASS_HEAD)];
    // shortcut: a class body runs to the next class header; fine while Enforce classes are not nested
    heads.forEach((h, i) => {
      const c = classes.get(h[1]) ?? { parents: new Set<string>(), fields: new Set<string>() };
      if (h[2]) c.parents.add(h[2]);
      for (const f of text.slice(h.index!, heads[i + 1]?.index ?? text.length).matchAll(FIELD)) c.fields.add(f[1]);
      classes.set(h[1], c);
    });
  }
  return classes;
}

/** `{GUID}path` or a plain path: missing if absent from every copy, or if the file's GUID differs. */
function checkResource(res: string, copies: CoalitionCopy[]): string | undefined {
  const guid = /^\{([0-9A-Fa-f]{16})\}/.exec(res)?.[1];
  const rel = res.replace(/^\{[0-9A-Fa-f]{16}\}/, "");
  const copy = copies.find((c) => c.exists(rel));
  if (!copy) return "file not found";
  if (!guid) return undefined;
  const actual = copy.guidOf(rel);
  return actual?.toUpperCase() === guid.toUpperCase() ? undefined : `GUID is ${actual ?? "unknown"}, not ${guid}`;
}

/** Throws when anything the MCP relies on is gone from the two copies. Clone-only rows: Tools/Validation and .github are not in a Workshop download. */
function check(roots: CoalitionRoots, kind: "clone" | "workshop") {
  const { crf, lobby } = roots;
  const both = [lobby, crf];
  const missing: string[] = [];
  const miss = (area: string, name: string, source: string, detail = "") => missing.push(`${area}: ${name}${detail ? ` (${detail})` : ""} [${source}]`);

  const scripts = readScripts(both, "Scripts");
  const classes = readClasses(scripts);
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
  if (!nameDefaults(both).size) miss("declaration pattern", "name-refs.ts ATTR matches no [Attribute] string field", "name-refs.ts nameDefaults");

  const enums = loadLobbyEnums([lobby, crf]);
  for (const [name, members, source] of ENUMS) {
    const e = enums.get(name);
    if (!e) miss("enum", name, source);
    else {
      if (![...e.values()].includes(0)) miss("enum", `${name} has no member with value 0`, source);
      for (const m of members) if (!e.has(m)) miss("enum member", `${name}.${m}`, source);
    }
  }

  const crfText = scripts.filter((s) => s.copy === crf).map((s) => s.text).join("\n");
  for (const n of GAMEMODE_NAMES) if (!crfText.includes(`"${n}"`)) miss("gamemode name", `"${n}"`, "name-refs.ts gamemodeNames");

  // Prefab families are matched against mission-maker prefabs only (mission-prefabs.ts loadMissionPrefabs)
  const prefabs = both.flatMap((c) => c.list("PrefabsMissionMaking").filter((f) => f.endsWith(".et")).map((f) => `/${f}`));
  for (const [k, re] of RULES) if (!prefabs.some((p) => re.test(p))) miss("prefab pattern", `${k} ${re}`, "mission-prefabs.ts RULES");

  const fixed: [res: string, copies: CoalitionCopy[], source: string][] = [
    [ROLES_CONFIG, both, `${GS} ROLES_CONFIG`],
    [CVON_ROLES_CONFIG, both, `${GS} CVON_ROLES_CONFIG`],
    [MANAGER, [lobby], `${GS} MANAGER`],
    [`{6A996BBFCEB37E78}${LOBBY_PREFAB}`, [lobby], `${GS} LOBBY_PREFAB`],
    // CRF's same-GUID override that most missions place COA_Lobby from (gearscript-inspect.ts missionSide comment)
    ["{6A996BBFCEB37E78}Prefabs/Modded Overrides/Coalition Lobby/COA_Lobby.et", [crf], `${GS} missionSide`],
    // MAY_THROW in tests/formats/enfusion-text.corpus.test.ts:15
    ["Prefabs/Structures/Rush/CRF_Rush_MCOM_NoNet.et", [crf], "enfusion-text.corpus.test.ts MAY_THROW"],
  ];
  if (kind === "clone") for (const s of Object.values(SCRIPTS)) fixed.push([`Tools/Validation/${s}`, [crf], "mission-validate.ts SCRIPTS"]);
  for (const [res, copies, source] of fixed) {
    const problem = checkResource(res, copies);
    if (problem) miss("fixed path", res, source, problem);
  }
  // gearscript-inspect.ts rolesConfigResource reads these constants from MANAGER by name
  const manager = lobby.read(MANAGER)?.toString("utf-8") ?? "";
  for (const c of ["C_RolesConfigResource", "C_CVONRolesConfigResource"]) if (!manager.includes(c)) miss("constant", `${c} in ${MANAGER}`, `${GS} rolesConfigResource`);

  // GI-19: the guide facts the tools hard-code, checked against the code COALITION ships
  const plugins = scripts.filter((s) => s.copy === lobby && s.path.startsWith("Scripts/WorkbenchGame/"));
  const pluginText = (file: string) => plugins.find((s) => s.path.endsWith(`/${file}`))?.text;
  // mission_inspect requires the Lobby entity to be named COA_Lobby (mission-inspect.ts:154)
  if (!plugins.some((s) => s.text.includes('FindEntityByName("COA_Lobby")'))) miss("lobby entity name", 'FindEntityByName("COA_Lobby")', "mission-inspect.ts COA_Lobby");
  const creation = pluginText("COA_MissionCreationPlugin.c");
  if (creation === undefined) miss("plugin", "COA_MissionCreationPlugin.c", "mission-checks.ts GUIDE_LAYERS");
  else {
    const created = new Set([...creation.matchAll(/CreateSubsceneLayer\(\s*\d+\s*,\s*"([^"]+)"/g)].map((m) => m[1]));
    for (const l of GUIDE_LAYERS) if (!created.has(l)) miss("layer", l, "mission-checks.ts GUIDE_LAYERS", "plugin 1 does not create it");
    for (const l of created) if (!GUIDE_LAYERS.includes(l)) miss("layer", l, "mission-checks.ts GUIDE_LAYERS", "plugin 1 creates it, GUIDE_LAYERS lacks it");
  }
  const configuration = pluginText("COA_MissionConfigurationPlugin.c");
  if (configuration === undefined) miss("plugin", "COA_MissionConfigurationPlugin.c", "mission-names.ts");
  else for (const [text, source] of PLUGIN6) if (!configuration.includes(text)) miss("plugin 6 format", text, source);

  if (kind === "clone") {
    // mission-validate.ts: the four markers and the flags its scripts take
    const read = (path: string) => crf.read(path)?.toString("utf-8");
    const synopsis = read(`Tools/Validation/${SCRIPTS.synopsis}`) ?? "";
    for (const [m, n] of [[CHECKS_START, "CHECKS_START"], [CHECKS_END, "CHECKS_END"], [SYNOPSIS_START, "SYNOPSIS_START"], [SYNOPSIS_END, "SYNOPSIS_END"]]) {
      if (!synopsis.includes(m)) miss("marker", m, `mission-validate.ts ${n}`, `not in ${SCRIPTS.synopsis}`);
    }
    for (const [script, flags] of FLAGS) {
      const text = read(`Tools/Validation/${script}`) ?? "";
      for (const f of flags) if (!text.includes(`add_argument("${f}"`)) miss("script flag", `add_argument("${f}"`, "mission-validate.ts", script);
    }
    // "Same arguments as CRF's CI" (mission-validate.ts) and Mission QA only on mission/ branches (mission-names.ts:64)
    const ci: [file: string, wants: string[]][] = [
      ["validate.yml", ["validate_mission.py --project ../COALITION-Lobby --base-ref origin/release", "validate_resources.py --project ../COALITION-Lobby", "startsWith(github.head_ref || github.ref_name, 'mission/')"]],
      ["mission-pr.yml", ["mission_synopsis.py --project ../COALITION-Lobby --base-ref origin/release"]],
    ];
    for (const [file, wants] of ci) {
      const text = read(`.github/workflows/${file}`)?.replace(/\s*\\\r?\n\s*/g, " ");
      if (text === undefined) miss("fixed path", `.github/workflows/${file}`, "mission-validate.ts projectArgs", "file not found");
      else for (const w of wants) if (!text.includes(w)) miss("CI argument", w, "mission-validate.ts projectArgs", file);
    }
  }

  expect(missing, `${missing.length} item(s) the MCP relies on are gone from CRF or the Lobby (${kind}):\n${missing.join("\n")}`).toEqual([]);
}

describe.skipIf(!projectPath)(`CRF and Lobby drift${projectPath ? "" : " (skipped: ENFUSION_PROJECT_PATH is not set)"}`, () => {
  it("clone: every class, field, enum, prefab family, entity name and fixed path the MCP names still exists", () => {
    check(resolveCoalitionRoots(config, undefined, undefined, "clone"), "clone");
  });
  it.skipIf(!workshop)(`Workshop: the same checks on the Workshop copies${workshop ? ` (CRF ${workshop.crf.label}; Lobby ${workshop.lobby.label})` : ` (skipped: ${workshopWhy})`}`, () => {
    check(workshop!, "workshop");
  });
});
