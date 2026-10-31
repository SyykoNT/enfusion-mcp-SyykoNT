import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { classifyPath, prefabClassifier } from "../../src/coalition/mission-prefabs.js";
import { makeProjects } from "./fixture.js";

let fx: ReturnType<typeof makeProjects>;
let classify: ReturnType<typeof prefabClassifier>;
beforeAll(() => {
  fx = makeProjects();
  classify = prefabClassifier(fx.config, [fx.lobby, fx.crf]);
});
afterAll(() => rmSync(fx.root, { recursive: true, force: true }));

describe("classifyPath", () => {
  it.each([
    ["PrefabsMissionMaking/SpawnPoints/SpawnPoints/BLUFOR_Spawn.et", "spawn", "BLUFOR"],
    ["PrefabsMissionMaking/SpawnPoints/SpawnPoints/Vehicles/CIV_MSP.et", "msp", "CIV"],
    ["PrefabsMissionMaking/GameBorders/Safestart/CIVILIAN_SafestartZone.et", "safestart", "CIV"],
    ["PrefabsMissionMaking/Markers/ObjectiveMarkers/NEW/INDFOR_Ins_ObjectiveMarker.et", "objectiveMarker", "INDFOR"],
    ["PrefabsMissionMaking/Markers/ObjectiveMarkers/GLOBAL_ObjectiveMarker_et.et", "objectiveMarker", "GLOBAL"],
    ["PrefabsMissionMaking/Systems/VehicleDepot/OPFORVehicleDepot.et", "depot", "OPFOR"],
    ["PrefabsMissionMaking/GameBorders/GameBorder.et", "gameBorder", undefined],
  ])("%s", (path, kind, side) => {
    expect(classifyPath(path)).toEqual({ kind, side });
  });

  it("leaves base prefabs out", () => {
    expect(classifyPath("PrefabsMissionMaking/Markers/ObjectiveMarkers/ObjectiveMarker_Base.et")).toBeUndefined();
    expect(classifyPath("PrefabsMissionMaking/Systems/VehicleDepot/VehicleDepot.et")).toBeUndefined();
  });
});

describe("prefabClassifier", () => {
  it("classifies by GUID from .meta when the mission points at an old path", () => {
    expect(classify("{4000000000000002}PrefabsMissionMaking/Systems/SpawnPoints/OPFOR_Spawn.et", "COA_StaticSpawnPoint"))
      .toEqual({ kind: "spawn", side: "OPFOR", via: "prefab" });
  });

  it("follows a mission maker's child prefab to its ancestor", () => {
    expect(classify("{4000000000000009}Prefabs/Mine/MySpawn.et", "COA_StaticSpawnPoint")).toEqual({ kind: "spawn", side: "OPFOR", via: "ancestor" });
  });

  it("falls back to the entity class, without a side", () => {
    expect(classify("{4000000000000010}Prefabs/Unknown.et", "COA_StaticSpawnPoint")).toEqual({ kind: "spawn", via: "class" });
    expect(classify(undefined, "GenericEntity")).toBeUndefined();
  });
});
