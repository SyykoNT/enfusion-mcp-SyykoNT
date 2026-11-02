import { join } from "node:path";
import type { Config } from "../config.js";
import { parseAll, type EnfusionNode } from "../formats/enfusion-text.js";
import type { Layer } from "../pak/stack.js";
import { parseParentPath, readEtFile, stripGuid } from "../utils/prefab-ancestry.js";

export const SIDES = ["BLUFOR", "OPFOR", "INDFOR", "CIV"] as const;
export type Side = (typeof SIDES)[number];
// CIV is m_CIVSlots (validate_mission.py:204-212 field map)
export const SLOTS_FIELD: Record<Side, string> = { BLUFOR: "m_BLUFORSlots", OPFOR: "m_OPFORSlots", INDFOR: "m_INDFORSlots", CIV: "m_CIVSlots" };

export interface MissionEntity {
  layer: string;
  className: string;
  name?: string;
  /** "{GUID}path" the entity is placed from */
  prefab?: string;
  node: EnfusionNode;
  /** Set for an entity nested in another entity's child block */
  parent?: MissionEntity;
}

export interface Mission {
  /** The addon copy (clone folder or Workshop download) the world was read from */
  copy: Layer;
  /** That copy's folder */
  root: string;
  /** World path relative to root, forward slashes */
  worldRel: string;
  layers: { name: string; entities: number; error?: string }[];
  entities: MissionEntity[];
  /** The entity placed from a COA_Lobby.et prefab (validate_mission.py:172-178) */
  lobby?: MissionEntity;
  /** COA_SlottingGroup nodes per side, only sides that have at least one */
  slots: Partial<Record<Side, EnfusionNode[]>>;
  /** Mission .conf files under Missions/<Terrain>/ whose SCR_MissionHeader World is this world (root-relative) */
  confs: string[];
}

export const prop = (n: EnfusionNode | undefined, key: string): string | undefined => {
  const v = n?.properties.find((p) => p.key === key)?.value;
  return typeof v === "string" ? v : undefined;
};
export const member = (n: EnfusionNode | undefined, key: string) => n?.children.find((c) => c.type === key);
export const components = (e: MissionEntity) => member(e.node, "components")?.children ?? [];

/** A file's text from a copy, or undefined when the copy does not have it. */
export const textOf = (copy: Layer, path: string) => copy.read(path)?.toString("utf-8");
/** Files directly in a folder of a copy (list is recursive). */
export const filesIn = (copy: Layer, dir: string) => copy.list(dir).filter((f) => !f.slice(dir.length + 1).includes("/"));

/**
 * A prefab and its ancestors, newest first: each read from the first copy that has it, else where
 * walkChain looks (the project path, then the game).
 */
export function chainOf(prefab: string, copies: Layer[], config: Config): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const seen = new Set<string>();
  for (let p: string | null = prefab; p && out.length < 20; ) {
    const path = stripGuid(p);
    if (seen.has(path.toLowerCase())) break;
    seen.add(path.toLowerCase());
    const text = copies.map((c) => textOf(c, path)).find((t) => t !== undefined) ?? readEtFile(path, config);
    if (!text) break;
    out.push({ path, text });
    p = parseParentPath(text).parentPath;
  }
  return out;
}

/** Entities of one layer: top-level nodes, `$grp` members and nested `{ ... }` child entities. */
function collect(nodes: EnfusionNode[], layer: string, out: MissionEntity[], parent?: MissionEntity): void {
  const add = (node: EnfusionNode, className: string, prefab?: string) => {
    const e: MissionEntity = { layer, className, name: node.id, prefab, node, parent };
    out.push(e);
    for (const c of node.children) if (c.type === "") collect(c.children, layer, out, e);
  };
  for (const n of nodes) {
    if (n.group) for (const m of n.children) add(m, n.type, n.inheritance);
    else add(n, n.type, n.inheritance);
  }
}

/**
 * Read a mission world's saved layers from a copy (worldRel from the copy's root, forward slashes).
 * Prefab ancestry is read from `copies`. Throws when the world or its _Layers folder is missing.
 */
export function loadMission(config: Config, copy: Layer, worldRel: string, copies: Layer[] = [copy]): Mission {
  if (!copy.exists(worldRel)) throw new Error(`World not found: ${join(copy.root, worldRel)}`);
  const layersDir = worldRel.replace(/\.ent$/i, "") + "_Layers";
  if (!copy.exists(layersDir)) throw new Error(`${worldRel} has no _Layers folder (${join(copy.root, layersDir)}).`);

  const layers: Mission["layers"] = [];
  const entities: MissionEntity[] = [];
  for (const file of filesIn(copy, layersDir).filter((f) => f.endsWith(".layer")).sort()) {
    const name = file.slice(layersDir.length + 1, -".layer".length);
    const before = entities.length;
    try {
      collect(parseAll(textOf(copy, file) ?? ""), name, entities);
      layers.push({ name, entities: entities.length - before });
    } catch (e) {
      entities.length = before;
      layers.push({ name, entities: 0, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const lobby = entities.find((e) => !e.parent && e.prefab && stripGuid(e.prefab).endsWith("COA_Lobby.et"));
  const slots: Mission["slots"] = {};
  if (lobby) {
    // Mission override first, then the COA_Lobby.et levels, newest first (mission_synopsis.py `levels`)
    let levels: EnfusionNode[] | undefined;
    for (const side of SIDES) {
      let field = member(lobby.node, SLOTS_FIELD[side]);
      if (!field) {
        levels ??= chainOf(lobby.prefab!, copies, config).map((l) => parseAll(l.text)[0]);
        field = levels.map((l) => member(l, SLOTS_FIELD[side])).find(Boolean);
      }
      const groups = field?.children.filter((c) => c.className === "COA_SlottingGroup" || c.type === "COA_SlottingGroup") ?? [];
      if (groups.length) slots[side] = groups;
    }
  }

  return { copy, root: copy.root, worldRel, layers, entities, lobby, slots, confs: findConfs(copy, worldRel) };
}

/** Same lookup as mission_synopsis.py:246-269: Missions/<Terrain>/*.conf whose SCR_MissionHeader.World is this world. */
function findConfs(copy: Layer, worldRel: string): string[] {
  const parts = worldRel.split("/");
  if (parts.length < 2) return [];
  const dir = `Missions/${parts[parts.length - 2]}`;
  return filesIn(copy, dir)
    .filter((f) => f.endsWith(".conf"))
    .map((f) => `${dir}/${f.slice(dir.length + 1)}`)
    .sort()
    .filter((f) => {
      try {
        const header = parseAll(textOf(copy, f) ?? "").find((n) => n.type === "SCR_MissionHeader");
        return stripGuid(prop(header, "World") ?? "") === worldRel;
      } catch {
        return false;
      }
    });
}

/** Slot roles of one side's groups (one role per m_aSlots entry, mission_synopsis.py count_slots). */
export const slotRoles = (groups: EnfusionNode[] = []) => groups.flatMap((g) => member(g, "m_aSlots")?.values ?? []);
