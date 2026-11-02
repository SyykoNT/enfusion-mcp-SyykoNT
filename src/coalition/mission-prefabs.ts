import type { Config } from "../config.js";
import type { Layer } from "../pak/stack.js";
import { stripGuid } from "../utils/prefab-ancestry.js";
import { chainOf, type Side } from "./mission-model.js";

export type PrefabKind =
  | "spawn" | "groupSpawn" | "msp" | "vehicleSpawner" | "gameBorder" | "safestart" | "forwardDeploy"
  | "objectiveMarker" | "spawnMarker" | "depot" | "taskAnchor";

export interface Classified {
  kind: PrefabKind;
  /** Missing for the class fallback and for kinds that have no side (game border, task anchor) */
  side?: Side | "GLOBAL";
  via: "prefab" | "ancestor" | "class";
}

const S = "(BLUFOR|OPFOR|INDFOR|CIVILIAN|CIV|GLOBAL)";
// Mission-maker prefab families in Lobby and CRF PrefabsMissionMaking (paths from their .meta listings)
export const RULES: [PrefabKind, RegExp][] = [
  ["spawn", new RegExp(`/SpawnPoints/${S}_Spawn\\.et$`)],
  ["groupSpawn", new RegExp(`/Groups/${S}_InitalGroupSpawn\\.et$`)],
  ["msp", new RegExp(`/Vehicles/${S}_MSP\\.et$`)],
  ["vehicleSpawner", new RegExp(`/VehicleSpawner/${S}_VehicleSpawner\\.et$`)],
  ["gameBorder", /\/GameBorders\/GameBorder\.et$/],
  ["safestart", new RegExp(`/Safestart/${S}_SafestartZone\\.et$`)],
  ["forwardDeploy", new RegExp(`/ForwardDeploy/${S}_ForardDeployZone\\.et$`)],
  ["objectiveMarker", new RegExp(`/ObjectiveMarkers/(?:NEW/)?${S}_\\w*ObjectiveMarker(?:_et)?\\.et$`)],
  ["spawnMarker", new RegExp(`/SpawnMarkers/${S}_SpawnMarker\\.et$`)],
  ["depot", new RegExp(`/VehicleDepot/${S}VehicleDepot\\.et$`)],
  ["taskAnchor", /\/TaskCreator\/CRF_task_empty\.et$/i],
];
// Entity classes as written in mission layers, for prefab-less or renamed prefabs
export const CLASS_FALLBACK: Record<string, PrefabKind> = {
  COA_StaticSpawnPoint: "spawn",
  COA_SafestartBorder: "safestart",
  COA_ForwardDeployBorder: "forwardDeploy",
  COA_GameBorder: "gameBorder",
};

export function classifyPath(path: string): Omit<Classified, "via"> | undefined {
  for (const [kind, re] of RULES) {
    const m = re.exec(`/${path}`);
    if (m) return { kind, side: m[1] ? (m[1] === "CIVILIAN" ? "CIV" : (m[1] as Side | "GLOBAL")) : undefined };
  }
  return undefined;
}

const guidOf = (res: string) => /^\{([0-9A-Fa-f]{16})\}/.exec(res)?.[1]?.toUpperCase();

/**
 * Mission-maker prefabs by GUID (from the `.meta` of a clone, the rdb of a Workshop copy) under each
 * copy's PrefabsMissionMaking, so a mission that still points at an old path of the same prefab is classified too.
 */
export function loadMissionPrefabs(copies: Layer[]): Map<string, { resource: string; kind: PrefabKind; side?: Side | "GLOBAL" }> {
  const table = new Map<string, { resource: string; kind: PrefabKind; side?: Side | "GLOBAL" }>();
  for (const copy of copies) {
    for (const path of copy.list("PrefabsMissionMaking")) {
      if (!path.endsWith(".et")) continue;
      const hit = classifyPath(path);
      const guid = hit && copy.guidOf(path);
      if (hit && guid) table.set(guid, { resource: `{${guid}}${path}`, ...hit });
    }
  }
  return table;
}

/**
 * Classify mission entities by prefab GUID, then prefab path, then the prefab's nearest five
 * ancestors (only for prefabs inside the given copies), then entity class. Ancestry is cached per classifier.
 */
export function prefabClassifier(config: Config, copies: Layer[]) {
  const table = loadMissionPrefabs(copies);
  const cache = new Map<string, Classified | undefined>();
  const direct = (res: string) => {
    const g = guidOf(res);
    const t = g ? table.get(g) : undefined;
    return t ? { kind: t.kind, side: t.side } : classifyPath(stripGuid(res));
  };
  const byPrefab = (prefab: string): Classified | undefined => {
    if (cache.has(prefab)) return cache.get(prefab);
    let hit: Classified | undefined;
    const d = direct(prefab);
    if (d) hit = { ...d, via: "prefab" };
    else if (copies.some((c) => c.exists(stripGuid(prefab)))) {
      // chainOf lists newest first, starting with the prefab itself
      const ancestors = chainOf(prefab, copies, config).slice(1, 6);
      const a = ancestors.map((l) => classifyPath(l.path)).find(Boolean);
      if (a) hit = { ...a, via: "ancestor" };
    }
    cache.set(prefab, hit);
    return hit;
  };
  return (prefab: string | undefined, className: string): Classified | undefined => {
    const hit = prefab ? byPrefab(prefab) : undefined;
    if (hit) return hit;
    const kind = CLASS_FALLBACK[className];
    return kind ? { kind, via: "class" } : undefined;
  };
}
