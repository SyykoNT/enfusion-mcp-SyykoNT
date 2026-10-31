import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import type { Config } from "../config.js";
import { mergeNode } from "../formats/config-override.js";
import { parseAll, type EnfusionNode } from "../formats/enfusion-text.js";
import { gitRevision, resolveCoalitionRoots } from "../utils/coalition-paths.js";
import { levenshtein } from "../utils/fuzzy.js";
import { enumDefault, loadLobbyEnums, type LobbyEnums } from "../utils/lobby-enums.js";
import { validateProjectPath } from "../utils/safe-path.js";

// The rules below describe COALITION-Lobby's COA_GearscriptManager.c in our own words; line
// citations are to that file unless another is named. If the Lobby changes them, this drifts.

// Fallbacks for the constants at COA_GearscriptManager.c:8-9, which are read at run time
const ROLES_CONFIG = "{4388548E9F600148}Configs/Gearscripts/COA_Global_Roles_Config.conf";
const CVON_ROLES_CONFIG = "{F04F02DBFC65553E}Configs/Gearscripts/Additional Configs/COA_CVON_Global_Roles_Config.conf";
const MANAGER = "Scripts/Game/Systems/Core/Managers/Gamemode/Gearscript/COA_GearscriptManager.c";
const LOBBY_PREFAB = "Prefabs/!Systems/!Lobby/COA_Lobby.et";

// ApplyDefaultWeapons :287-384: these four pick one weapon at random, the rest are single fields
const POOLS: Record<string, string> = { RIFLE: "m_Rifles", RIFLEUGL: "m_RifleUGLs", CARBINE: "m_Carbines", PISTOL: "m_Pistols" };
const SINGLES: Record<string, string> = {
  SNIPER: "m_SNIPER", AR: "m_AR", MMG: "m_MMG", HMG: "m_HMG", AT: "m_AT", MAT: "m_MAT", HAT: "m_HAT", AA: "m_AA",
};
// ApplyInventoryItems :532-536: slot types that get an SR radio when only leadership radios are on
const LEADER_SLOTS = ["TEAM_LEADER", "SQUAD_LEADER", "SPECIALTY", "SPECIALTY_ASSISTANT"];

export interface Radios {
  leadership: boolean;
  gi: boolean;
  rto: boolean;
}
// COA_GearScriptContainer attribute defaults (COA_GearscriptConfig.c:14-24)
const DEFAULT_RADIOS: Radios = { leadership: true, gi: false, rto: true };

export interface Mag { prefab: string; count: number }
export interface WeaponOption { prefab: string; source: string; mags: Mag[] }
/** The gear manager picks one option at random per spawn. */
export interface WeaponPick { category: string; options: WeaponOption[] }
export interface MagLine { category: string; source: string; mags: Mag[] }
export interface ClothingSlot { slot: string; source: string; options: string[] }
export interface Item { what: string; count: number; source: string; given: boolean; why?: string }
export interface Loadout {
  role: string;
  name?: string;
  slotType: string;
  weaponsFrom: "custom" | "role config";
  weapons: WeaponPick[];
  magazines: MagLine[];
  clothing: ClothingSlot[];
  items: Item[];
  /** Things the gear manager silently skips */
  notes: string[];
}

// ── Reading parsed nodes ────────────────────────────────────────────────────

const prop = (n: EnfusionNode | undefined, key: string): string | undefined => {
  const v = n?.properties.find((p) => p.key === key)?.value;
  return typeof v === "string" ? v : undefined;
};
const member = (n: EnfusionNode | undefined, key: string) => n?.children.find((c) => c.type === key);
/** A list field's elements, or an object field (`m_AR COA_Spec_Weapon_Class "{..}" {`) as a one-element list. */
const items = (n: EnfusionNode | undefined, key: string): EnfusionNode[] => {
  const m = member(n, key);
  return !m ? [] : m.className !== undefined ? [m] : m.children;
};
const values = (n: EnfusionNode | undefined, key: string) => member(n, key)?.values ?? [];
const count = (n: EnfusionNode, key: string) => Number(prop(n, key) ?? 0) || 0;
const short = (res: string) => res.split("/").pop()!;
const roleOf = (n: EnfusionNode, enums: LobbyEnums) => prop(n, "m_Role") ?? enumDefault(enums, "COA_EGearRole") ?? "UNARMED";

const option = (w: EnfusionNode, source: string, assistant = false): WeaponOption => ({
  prefab: prop(w, "m_Weapon") ?? "",
  source,
  mags: items(w, "m_MagazineArray").map((m) => ({
    prefab: prop(m, "m_Magazine") ?? "",
    count: count(m, assistant ? "m_AssistantMagazineCount" : "m_MagazineCount"),
  })),
});

// ── Rules ───────────────────────────────────────────────────────────────────

/** What one role spawns with: SetEntityGear's ApplyClothing, ApplyWeapons and ApplyInventoryItems (:107-113). */
export function resolveLoadout(
  gs: EnfusionNode,
  roleCfg: EnfusionNode | undefined,
  role: string,
  radios: Radios,
  enums: LobbyEnums
): Loadout {
  const slotType = prop(roleCfg, "m_SlottingType") ?? enumDefault(enums, "COA_ESlotType") ?? "GENERAL_INFANTRY";
  const out: Loadout = {
    role, name: prop(roleCfg, "m_sRoleName"), slotType, weaponsFrom: "role config",
    weapons: [], magazines: [], clothing: [], items: [], notes: [],
  };
  const customs = items(gs, "m_RolesToSetCustomSettings")
    .map((c, j) => [c, `m_RolesToSetCustomSettings[${j}]`] as const)
    .filter(([c]) => roleOf(c, enums) === role);
  if (!roleCfg) out.notes.push("role not in the roles config: default weapons, magazines, role items, infantry medical and default items fail (null role config)");

  // Clothing :168-194: defaults, then custom entries; each entry replaces its slot with a random pick
  // of its list, and an empty list changes nothing (COA_ClothingHelper.UpdateClothingSlot)
  const slots = new Map<string, ClothingSlot>();
  const wear = (c: EnfusionNode, source: string) => {
    const options = values(c, "m_ClothingPrefabs");
    const slot = prop(c, "m_iClothingType") ?? enumDefault(enums, "COA_EGearscriptClothing") ?? "HEADGEAR";
    if (options.length) slots.set(slot, { slot, source, options });
  };
  items(gs, "m_DefaultClothing").forEach((c, i) => wear(c, `m_DefaultClothing[${i}]`));
  for (const [c, src] of customs) items(c, "m_Clothing").forEach((k, i) => wear(k, `${src}.m_Clothing[${i}]`));
  out.clothing = [...slots.values()];

  // Custom weapons :204-278 replace every default weapon and magazine when any is set
  for (const [c, src] of customs) {
    for (const field of ["m_PrimaryWeapon", "m_SecondaryWeapon", "m_Pistols"]) {
      // shortcut: an option without m_Weapon is dropped; in game a random pick of it sets nothing, so the role may fall back to defaults
      const options = items(c, field).map((w, i) => option(w, `${src}.${field}[${i}]`)).filter((o) => o.prefab);
      if (options.length) out.weapons.push({ category: field.slice(2), options });
    }
  }
  if (out.weapons.length) out.weaponsFrom = "custom";
  else if (roleCfg) {
    const cats = values(roleCfg, "m_aWeapons");
    const mags = values(roleCfg, "m_aMagazines");
    for (const cat of cats) {
      const field = POOLS[cat] ?? SINGLES[cat];
      if (!field) {
        out.notes.push(`${cat}: weapon category this tool does not know`);
        continue;
      }
      const options = items(gs, field).map((w, i) => option(w, POOLS[cat] ? `${field}[${i}]` : field)).filter((o) => o.prefab);
      if (!options.length) {
        out.notes.push(`${cat}: ${field} is empty or missing in the gearscript, so no weapon`);
        continue;
      }
      // Pool magazines come only from the weapon picked from that pool, and only with <cat>_MAG
      // (ApplyDefaultMagazines :393-466, COA_WeaponHelper.FindMagArrayForWeaponsSelected); single fields' come below
      if (!POOLS[cat] || !mags.includes(`${cat}_MAG`)) for (const o of options) o.mags = [];
      if (POOLS[cat] && !mags.includes(`${cat}_MAG`)) out.notes.push(`${cat}: no ${cat}_MAG in the role config, so no magazines for it`);
      out.weapons.push({ category: cat, options });
    }
    // Specialty magazines take m_AssistantMagazineCount on assistant slots (:400, ConvertSpecMagArrayIntoMagArray);
    // they and the sniper's are given whether or not the role carries the weapon
    const assistant = slotType === "ASSISTANT" || slotType === "SPECIALTY_ASSISTANT";
    for (const mag of mags) {
      const cat = mag.replace(/_MAG$/, "");
      if (POOLS[cat]) {
        if (!cats.includes(cat)) out.notes.push(`${mag}: no ${cat} weapon picked, so no magazines`);
        continue;
      }
      const field = SINGLES[cat];
      const w = field ? member(gs, field) : undefined;
      if (!w) {
        out.notes.push(field ? `${mag}: no ${field} in the gearscript, so no magazines` : `${mag}: magazine category this tool does not know`);
        continue;
      }
      out.magazines.push({ category: mag, source: `${field}.m_MagazineArray`, mags: option(w, field, cat !== "SNIPER" && assistant).mags });
    }
  }

  // Items :508-573: custom extras, then role items, then infantry medical and default items for everyone
  const add = (list: EnfusionNode[], source: string, why?: string) =>
    list.forEach((it, i) =>
      out.items.push({ what: prop(it, "m_sItemPrefab") ?? "", count: count(it, "m_iItemCount"), source: `${source}[${i}]`, given: !why, ...(why ? { why } : {}) })
    );
  const onOff = (b: boolean) => (b ? "on" : "off");
  const radio = (what: string, given: boolean, why: string) => out.items.push({ what, count: 1, source: "role m_aItems", given, why });
  const bino = (field: string) => {
    const p = prop(gs, field);
    out.items.push({ what: p || field, count: 1, source: field, given: !!p, ...(p ? {} : { why: "not set in the gearscript" }) });
  };
  for (const [c, src] of customs) add(items(c, "m_AdditionalInventoryItems"), `${src}.m_AdditionalInventoryItems`);
  for (const item of values(roleCfg, "m_aItems")) {
    if (item === "SHORTRANGE_RADIO") {
      const lead = LEADER_SLOTS.includes(slotType);
      radio("SR radio", radios.gi || (radios.leadership && lead),
        radios.gi ? "GI radios on" : `GI radios off, leadership radios ${onOff(radios.leadership)}, ${slotType} slot${lead ? "" : " (not a leadership slot)"}`);
    } else if (item === "LONGRANGE_RADIO") radio("LR radio", radios.leadership, `leadership radios ${onOff(radios.leadership)}`);
    else if (item === "RTO_RADIO") radio("RTO radio", radios.rto, `RTO radios ${onOff(radios.rto)}`);
    else if (item === "LEADERSHIP_BINO") bino("m_sLeadershipBinocularsPrefab");
    else if (item === "ASSISTANT_BINO") bino("m_sAssistantBinocularsPrefab");
    else if (item === "MEDIC_ITEMS") add(items(gs, "m_MedicMedicalItems"), "m_MedicMedicalItems");
    else out.notes.push(`${item}: item category this tool does not know`);
  }
  // A null role config fails at rolesConfig.m_aItems (:526-528), before these are given (:567-572)
  const noRole = roleCfg ? undefined : "role not in the roles config";
  add(items(gs, "m_InfantryMedicalItems"), "m_InfantryMedicalItems", noRole);
  add(items(gs, "m_DefaultInventoryItems"), "m_DefaultInventoryItems", noRole);
  return out;
}

// ── Files ───────────────────────────────────────────────────────────────────

/** `{GUID}path` or a repo path to a file in the first root that has it (never outside a root). */
function resolveResource(name: string, roots: string[]): string | undefined {
  const rel = name.replace(/^\{[0-9A-Fa-f]{16}\}/, "");
  for (const root of roots) {
    try {
      const f = validateProjectPath(root, rel);
      if (existsSync(f)) return f;
    } catch {
      // outside this root
    }
  }
  return undefined;
}

/**
 * A resource as the game loads it with CRF on top of the Lobby: the base copy, then each later
 * root's copy at the same path merged over it as an override delta (config-override.ts).
 * CRF overrides COA_Global_Roles_Config.conf this way to add its roles.
 */
function loadResource(name: string, roots: string[]): { node?: EnfusionNode; from: string[] } {
  let node: EnfusionNode | undefined;
  const from: string[] = [];
  for (const root of roots) {
    const f = resolveResource(name, [root]);
    if (!f) continue;
    const n = parseAll(readFileSync(f, "utf-8"))[0];
    node = node && n ? mergeNode(node, n) : n ?? node;
    from.push(basename(root));
  }
  return { node, from };
}

const slash = (p: string) => p.replace(/\\/g, "/");
const confsUnder = (root: string) => {
  const dir = join(root, "Configs", "Gearscripts");
  return existsSync(dir)
    ? (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".conf")).map((f) => slash(join("Configs", "Gearscripts", f)))
    : [];
};

/** A gearscript's root-relative path from `{GUID}path`, a CRF or Lobby path (relative or absolute) or a bare file name. */
function findGearscript(input: string, roots: string[]): string {
  if (/[\\/]/.test(input)) {
    const rel = isAbsolute(input)
      ? roots.map((r) => relative(r, input)).find((r) => r && !r.startsWith("..") && !isAbsolute(r))
      : input.replace(/^\{[0-9A-Fa-f]{16}\}/, "");
    if (rel && resolveResource(rel, roots)) return slash(rel);
  }
  const want = basename(slash(input)).toLowerCase().replace(/(\.conf)?$/, ".conf");
  // One path in both roots is one resource (a CRF override of a Lobby file), not two matches
  const all = [...new Set(roots.flatMap(confsUnder))];
  const hits = all.filter((f) => basename(f).toLowerCase() === want);
  const list = (fs: string[]) => fs.map((f) => `- ${f}`).join("\n");
  if (!/[\\/]/.test(input) && hits.length === 1) return hits[0];
  if (!/[\\/]/.test(input) && hits.length > 1) throw new Error(`"${input}" matches ${hits.length} gearscripts; pass one path:\n${list(hits)}`);
  const closest = all
    .map((f) => [f, levenshtein(basename(f).toLowerCase(), want)] as const)
    .sort((a, b) => a[1] - b[1])
    .slice(0, 10)
    .map(([f]) => f);
  throw new Error(`Gearscript "${input}" not found under Configs/Gearscripts in CRF or COALITION-Lobby.${closest.length ? ` Closest:\n${list(closest)}` : ""}`);
}

function rolesConfigResource(lobby: string, cvon: boolean): string {
  const src = existsSync(join(lobby, MANAGER)) ? readFileSync(join(lobby, MANAGER), "utf-8") : "";
  const constant = cvon ? "C_CVONRolesConfigResource" : "C_RolesConfigResource";
  return new RegExp(`\\b${constant}\\s*=\\s*"([^"]+)"`).exec(src)?.[1] ?? (cvon ? CVON_ROLES_CONFIG : ROLES_CONFIG);
}

export interface Usage { file: string; fields: string[] }

/** Mission layers and worlds (every project's Worlds folder) and the Lobby prefab that name this gearscript GUID. */
export function findGearscriptUsage(guid: string, projectPath: string, lobby: string): Usage[] {
  const files = readdirSync(projectPath, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(projectPath, d.name, "Worlds")))
    .flatMap((d) => {
      const dir = join(projectPath, d.name, "Worlds");
      return (readdirSync(dir, { recursive: true }) as string[]).filter((f) => /\.(layer|ent)$/i.test(f)).map((f) => join(dir, f));
    });
  if (existsSync(join(lobby, LOBBY_PREFAB))) files.push(join(lobby, LOBBY_PREFAB));

  const id = guid.toUpperCase();
  const usage: Usage[] = [];
  for (const f of files) {
    const text = readFileSync(f, "utf-8");
    if (!text.toUpperCase().includes(id)) continue;
    const fields: string[] = [];
    const walk = (n: EnfusionNode) => {
      if (/GearScriptSettings$/.test(n.type) && prop(n, "m_rGearScript")?.toUpperCase().includes(id)) fields.push(n.type);
      n.children.forEach(walk);
    };
    try {
      parseAll(text).forEach(walk);
    } catch {
      // A malformed file still counts as a reference; the field stays unknown
    }
    usage.push({ file: relative(projectPath, f), fields: fields.length ? fields : ["(GUID found outside a gearscript settings field)"] });
  }
  return usage;
}

// ── Tool ────────────────────────────────────────────────────────────────────

interface Params {
  gearscript: string;
  roles?: string[];
  radios?: Partial<Radios>;
  cvon: boolean;
  usedBy: boolean;
  format: "markdown" | "json";
  crfPath?: string;
  lobbyPath?: string;
}

function gearscriptInspect(config: Config, p: Params): string {
  const { crf, lobby } = resolveCoalitionRoots(config, p.crfPath, p.lobbyPath);
  const roots = [lobby, crf]; // base first: CRF depends on the Lobby
  const gsPath = findGearscript(p.gearscript, roots);
  const gs = loadResource(gsPath, roots).node;
  if (gs?.type !== "COA_GearScriptConfig") {
    throw new Error(`${gsPath} is not a COA_GearScriptConfig (its root is ${gs?.type ?? "empty"}).`);
  }
  const metaFile = resolveResource(`${gsPath}.meta`, roots);
  const meta = metaFile ? prop(parseAll(readFileSync(metaFile, "utf-8"))[0], "Name") : undefined;
  const guid = /^\{([0-9A-Fa-f]{16})\}/.exec(meta ?? "")?.[1];

  const enums = loadLobbyEnums(roots);
  const roleNames = [...(enums.get("COA_EGearRole")?.keys() ?? [])];
  const unknown = (p.roles ?? []).filter((r) => !roleNames.includes(r));
  if (roleNames.length && unknown.length) {
    throw new Error(`Unknown role ${unknown.join(", ")}. COA_EGearRole names: ${roleNames.join(", ")}`);
  }

  // Seam for MM-N2: a mission world and side will fill radios, cvon and the slotted roles from loadMission
  const radios: Radios = { ...DEFAULT_RADIOS, ...p.radios };
  const rcName = rolesConfigResource(lobby, p.cvon);
  const rc = loadResource(rcName, roots);
  if (!rc.node) throw new Error(`Roles config ${rcName} not found in ${lobby}. Pass lobbyPath.`);
  // COA_RolesConfig keeps the last entry per role (COA_RoleConfig.c:24-28)
  const roleCfgs = new Map(items(rc.node, "m_RoleConfigs").map((r) => [roleOf(r, enums), r]));

  const loadouts = (p.roles?.length ? p.roles : [...roleCfgs.keys()]).map((r) => resolveLoadout(gs, roleCfgs.get(r), r, radios, enums));
  const orphans = [...new Set(items(gs, "m_RolesToSetCustomSettings").map((c) => roleOf(c, enums)))].filter((r) => !roleCfgs.has(r));
  const usage = p.usedBy && guid ? findGearscriptUsage(guid, config.projectPath, lobby) : undefined;
  const gsName = meta ?? gsPath;
  const rcFrom = `from ${rc.from.join(" + override in ")}`;

  if (p.format === "json") {
    return JSON.stringify(
      { gearscript: gsName, rolesConfig: rcName, rolesConfigFrom: rc.from, cvon: p.cvon, radios, loadouts, customRolesNotInRolesConfig: orphans, usedBy: usage },
      null,
      2
    );
  }

  const mags = (ms: Mag[]) => ms.map((m) => `${m.count} x ${short(m.prefab)}${m.count ? "" : " (adds nothing)"}`).join(", ");
  const out = [
    `# Gearscript ${short(gsName)}`,
    `${gsName}${prop(gs, "m_FactionName") ? `, faction "${prop(gs, "m_FactionName")}"` : ""}`,
    p.cvon
      ? `Roles config: CVON, ${rcName} (${rcFrom}). The gear manager uses it when the mission's lobby has a CVON_VONGameModeComponent (COA_GearscriptManager.c:773-783); pass cvon: false for a mission without CVON or with m_bUseCVON 0.`
      : `Roles config: global, ${rcName} (${rcFrom}; cvon: false).`,
    `Radios: leadership ${radios.leadership ? "on" : "off"}, GI ${radios.gi ? "on" : "off"}, RTO ${radios.rto ? "on" : "off"}${p.radios ? "" : " (container defaults; pass radios to change)"}. Radio prefabs come from the mission's gearscript settings.`,
    `Options joined by " | " are picked at random per spawn.`,
  ];
  for (const l of loadouts) {
    out.push("", `### ${l.role}${l.name ? ` "${l.name}"` : ""}  slot type ${l.slotType}`, `Weapons (${l.weaponsFrom}):`);
    if (!l.weapons.length) out.push("- none");
    for (const w of l.weapons) {
      const opts = w.options.map((o) => `${short(o.prefab)}${o.mags.length ? ` + ${mags(o.mags)}` : ""}`).join(" | ");
      out.push(`- ${w.category} (${w.options.map((o) => o.source).join(", ")}): ${opts}`);
    }
    if (l.magazines.length) out.push("Magazines:", ...l.magazines.map((m) => `- ${m.category} (${m.source}): ${mags(m.mags) || "none listed"}`));
    out.push("Clothing:", ...(l.clothing.length ? l.clothing.map((c) => `- ${c.slot} (${c.source}): ${c.options.map(short).join(" | ")}`) : ["- none"]));
    out.push("Items:", ...(l.items.length ? l.items.map((i) =>
      i.given
        ? `- ${i.count} x ${short(i.what)}${i.count ? "" : " (adds nothing)"} (${i.source})${i.why ? `: ${i.why}` : ""}`
        : `- no ${short(i.what)} (${i.source}): ${i.why}`) : ["- none"]));
    if (l.notes.length) out.push("Check:", ...l.notes.map((n) => `- ${n}`));
  }

  out.push("", "## Summary");
  const noWeapon = loadouts.filter((l) => !l.weapons.length).map((l) => l.role);
  const flagged = loadouts.filter((l) => l.notes.length);
  out.push(`- Roles: ${loadouts.length}; with no weapon: ${noWeapon.join(", ") || "none"}`);
  out.push(`- Roles with something skipped: ${flagged.map((l) => `${l.role} (${l.notes.length})`).join(", ") || "none"}`);
  out.push(`- Custom gear for roles not in the roles config: ${orphans.join(", ") || "none"}`);
  if (p.usedBy) {
    if (!usage) out.push("- Used by: unknown, the gearscript has no .meta with a GUID");
    else {
      const missions = usage.filter((u) => !u.file.endsWith(basename(LOBBY_PREFAB)));
      const lobbyUse = usage.find((u) => u.file.endsWith(basename(LOBBY_PREFAB)));
      out.push(`- Used by: ${missions.length} mission file(s)`, ...missions.map((u) => `  - ${u.file.replace(/\\/g, "/")}: ${u.fields.join(", ")}`));
      out.push(`- Lobby default (COA_Lobby.et): ${lobbyUse ? lobbyUse.fields.join(", ") : "no"}`);
    }
  }
  out.push("", `Read-only. CRF @ ${gitRevision(crf)}, Lobby @ ${gitRevision(lobby)}`);
  return out.join("\n");
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function registerGearscriptInspect(server: McpServer, config: Config): void {
  server.registerTool(
    "gearscript_inspect",
    {
      description:
        "Show what each role in a COALITION gearscript (COA_GearScriptConfig) spawns with, using the same rules as " +
        "COALITION-Lobby's gear manager: weapon pools picked at random, magazines (assistant counts on assistant slots), " +
        "clothing per slot, items, and radios under the radio toggles. Lists what the gear manager silently skips, " +
        "and with usedBy which missions and Lobby defaults use the gearscript. Read-only and offline: reads CRF and " +
        "COALITION-Lobby files inside the project path, no Workbench.",
      inputSchema: {
        gearscript: z
          .string()
          .min(1)
          .describe("'{GUID}Configs/Gearscripts/...conf', a CRF or Lobby relative path, or a bare file name such as 'COA_GS_USSR_Late_War.conf' (searched under Configs/Gearscripts)."),
        roles: z
          .array(z.string())
          .optional()
          .describe("COA_EGearRole names to show, e.g. ['MEDIC','SQUAD_LEAD']. Default: every role in the roles config."),
        radios: z
          .object({ leadership: z.boolean().optional(), gi: z.boolean().optional(), rto: z.boolean().optional() })
          .optional()
          .describe("Radio toggles as the mission sets them. Default: the container defaults (leadership on, GI off, RTO on)."),
        cvon: z
          .boolean()
          .default(true)
          .describe("Use the CVON roles config, as the game does when the mission's lobby has a CVON_VONGameModeComponent (the Lobby default). false: the global roles config."),
        usedBy: z.boolean().default(false).describe("Also list mission layers and worlds, and the Lobby's COA_Lobby.et, that reference this gearscript."),
        format: z.enum(["markdown", "json"]).default("markdown").describe("json gives full {GUID}paths and source fields."),
        crfPath: z.string().optional().describe("CRF clone. Default: as mission_validate. Must be inside the project path."),
        lobbyPath: z.string().optional().describe("COALITION-Lobby clone. Default: next to CRF. Must be inside the project path."),
      },
    },
    async (params) => {
      try {
        return { content: [{ type: "text" as const, text: gearscriptInspect(config, params) }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: errorText(e) }], isError: true };
      }
    }
  );
}
