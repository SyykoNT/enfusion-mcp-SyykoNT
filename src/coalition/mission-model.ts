import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { Config } from "../config.js";
import { parseAll, type EnfusionNode } from "../formats/enfusion-text.js";
import { stripGuid, walkChain } from "../utils/prefab-ancestry.js";

export const SIDES = ["BLUFOR", "OPFOR", "INDFOR", "CIV"] as const;
export type Side = (typeof SIDES)[number];
// CIV is m_CIVSlots (validate_mission.py:204-212 field map)
const SLOTS_FIELD: Record<Side, string> = { BLUFOR: "m_BLUFORSlots", OPFOR: "m_OPFORSlots", INDFOR: "m_INDFORSlots", CIV: "m_CIVSlots" };

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
  world: string;
  /** Addon folder holding the world's Worlds/ folder */
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

/** Read a mission world's saved layers. Throws when the world or its _Layers folder is missing. */
export function loadMission(config: Config, world: string): Mission {
  if (!existsSync(world)) throw new Error(`World not found: ${world}`);
  const layersDir = world.replace(/\.ent$/i, "") + "_Layers";
  if (!existsSync(layersDir)) throw new Error(`${world} has no _Layers folder (${layersDir}).`);

  let root = dirname(world);
  for (let d = dirname(world); dirname(d) !== d; d = dirname(d)) {
    if (basename(d) === "Worlds") {
      root = dirname(d);
      break;
    }
  }
  const worldRel = relative(root, world).replace(/\\/g, "/");

  const layers: Mission["layers"] = [];
  const entities: MissionEntity[] = [];
  for (const file of readdirSync(layersDir).filter((f) => f.endsWith(".layer")).sort()) {
    const name = file.slice(0, -".layer".length);
    const before = entities.length;
    try {
      collect(parseAll(readFileSync(join(layersDir, file), "utf-8")), name, entities);
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
        levels ??= walkChain(lobby.prefab!, config).levels.reverse().map((l) => parseAll(l.rawContent)[0]);
        field = levels.map((l) => member(l, SLOTS_FIELD[side])).find(Boolean);
      }
      const groups = field?.children.filter((c) => c.className === "COA_SlottingGroup" || c.type === "COA_SlottingGroup") ?? [];
      if (groups.length) slots[side] = groups;
    }
  }

  return { world, root, worldRel, layers, entities, lobby, slots, confs: findConfs(root, worldRel) };
}

/** Same lookup as mission_synopsis.py:246-269: Missions/<Terrain>/*.conf whose SCR_MissionHeader.World is this world. */
function findConfs(root: string, worldRel: string): string[] {
  const parts = worldRel.split("/");
  const dir = join(root, "Missions", parts[parts.length - 2] ?? "");
  if (parts.length < 2 || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".conf"))
    .sort()
    .filter((f) => {
      try {
        const header = parseAll(readFileSync(join(dir, f), "utf-8")).find((n) => n.type === "SCR_MissionHeader");
        return stripGuid(prop(header, "World") ?? "") === worldRel;
      } catch {
        return false;
      }
    })
    .map((f) => `Missions/${parts[parts.length - 2]}/${f}`);
}

/** Slot roles of one side's groups (one role per m_aSlots entry, mission_synopsis.py count_slots). */
export const slotRoles = (groups: EnfusionNode[] = []) => groups.flatMap((g) => member(g, "m_aSlots")?.values ?? []);
