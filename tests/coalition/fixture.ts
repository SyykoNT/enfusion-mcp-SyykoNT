import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../../src/config.js";

// Hand-written fixtures only: CRF and the Lobby are under the Arma Public License, so nothing is copied from them.

const meta = (resource: string) => `MetaFileClass {\n Name "${resource}"\n}\n`;
const MM = "PrefabsMissionMaking";

const INIT = `SCR_AIWorld : "{1000000000000001}Prefabs/AI/SCR_AIWorld.et" {
 coords 1 2 3
}
COA_Gamemode COA_Lobby : "{1000000000000002}Prefabs/Lobby/COA_Lobby.et" {
 components {
  CRF_TaskCreatorComponent "{2000000000000001}" {
   m_aTaskEntries {
    CRF_TaskCreatorEntry "{2000000000000002}" {
     m_sTaskLabel "Intel"
     m_eAssignedSide OPFOR
     m_sSpawnEntityName "Intel_1"
    }
    CRF_TaskCreatorEntry "{2000000000000003}" {
     m_sSpawnEntityName "Radio"
    }
    CRF_TaskCreatorEntry "{2000000000000004}" {
     m_sSpawnEntityName ""
    }
   }
  }
  CRF_RushGamemodeManager "{2000000000000005}" {
   m_iNumberOfZones 1
   m_aZones {
    CRF_RushZone "{2000000000000006}" {
     m_sZoneName "Zone 1"
    }
   }
  }
  CRF_CacheHuntGamemodeManager "{2000000000000007}" {
   m_aCacheSpawnPointNames {
    "cache1"
    "Cache2"
   }
  }
 }
 m_aMissionDescriptors {
  COA_MissionDescriptor "{2000000000000008}" {
   m_sTextData "Say \\"hold\\""\\
   ""\\
   "end"
  }
 }
 m_BLUFORSlots {
  COA_SlottingGroup "{3000000000000001}" {
   m_aSlots {
    SQUAD_LEAD
    MEDIC
    RIFLEMAN
   }
  }
 }
 m_OPFORSlots {
  COA_SlottingGroup "{3000000000000002}" {
   m_aSlots {
    SQUAD_LEAD
   }
  }
 }
}
`;

const SPAWNPOINTS = `COA_StaticSpawnPoint BLUFOR_Spawn1 : "{4000000000000001}${MM}/SpawnPoints/SpawnPoints/BLUFOR_Spawn.et" {
 coords 1 0 1
 {
  COA_ManualMarker SpawnMarker1 {
   coords 0 0 0
  }
 }
}
COA_StaticSpawnPoint : "{4000000000000002}${MM}/Systems/SpawnPoints/OPFOR_Spawn.et" {
}
COA_StaticSpawnPoint OPFOR_Spawn2 : "{4000000000000009}Prefabs/Mine/MySpawn.et" {
}
COA_StaticSpawnPoint Mystery : "{4000000000000010}Prefabs/Unknown.et" {
}
`;

const GAMEBORDERS = `COA_GameBorder : "{4000000000000003}${MM}/GameBorders/GameBorder.et" {
}
COA_SafestartBorder : "{4000000000000004}${MM}/GameBorders/Safestart/OPFOR_SafestartZone.et" {
}
COA_ForwardDeployBorder : "{4000000000000005}${MM}/GameBorders/ForwardDeploy/BLUFOR_ForardDeployZone.et" {
}
`;

const MARKERS = `$grp COA_ManualMarker : "{4000000000000006}${MM}/Markers/ObjectiveMarkers/GLOBAL_ObjectiveMarker_et.et" {
 {
  coords 1 1 1
 }
 {
  coords 2 2 2
 }
}
COA_ManualMarker : "{4000000000000007}${MM}/Markers/ObjectiveMarkers/NEW/CIVILIAN_NewObjectiveMarker.et" {
}
`;

const OBJECTIVES = `$grp GenericEntity : "{4000000000000008}${MM}/Systems/TaskCreator/CRF_task_empty.et" {
 intel_1 {
  coords 1 1 1
 }
}
GenericEntity Radio : "{6000000000000001}Prefabs/Props/Radio.et" {
}
$grp BaseGameTriggerEntity {
 mcom_a_trigger {
 }
 z1_alpha_trigger {
 }
}
GenericEntity cache1 {
}
GenericEntity cache2 {
}
GenericEntity CacheHunt_HomeFlag {
}
`;

const PROPS = `GenericEntity : "{7000000000000001}Prefabs/Compositions/Slotted/SlotFlatLarge/Helipad_L_US_01.et" {
}
GenericEntity : "{7000000000000001}Prefabs/Compositions/Slotted/SlotFlatLarge/Helipad_L_US_01.et" {
}
GenericEntity : "{7000000000000002}Prefabs/Compositions/Slotted/SlotRoadLarge/CheckpointUnderConstruction_L_US_01.et" {
}
GenericEntity : "{7000000000000003}Prefabs/Compositions/Slotted/SlotFlatSmall/VehicleMaintenance_S_BLUFOR.et" {
}
`;

const CACHE_HUNT = `class CRF_CacheHuntGamemodeManagerClass : SCR_BaseGameModeComponentClass {}
class CRF_CacheHuntGamemodeManager : SCR_BaseGameModeComponent
{
\t[Attribute("CacheHunt_Center", UIWidgets.EditBox, desc: "Only used when randomising")]
\tprotected string m_sRandomCenterEntityName;
\t[Attribute("CacheHunt_HomeFlag", UIWidgets.EditBox, desc: "Flag pole name")]
\tstring m_sDefenderHomeFlagName;
\t[Attribute("", UIWidgets.EditBox)]
\tstring m_sTargetEntityName;
}
`;

const WORLD = "Worlds/Test/Author_TVT_Fixture.ent";

/** A project path with CRF, COALITION-Lobby and one mission world. Returns the project path and a Config for it. */
export function makeProjects(): { root: string; crf: string; lobby: string; world: string; config: Config } {
  const root = mkdtempSync(join(tmpdir(), "mission-inspect-"));
  const crf = join(root, "CRF");
  const lobby = join(root, "COALITION-Lobby");
  const files: Record<string, string> = {
    "CRF/Tools/Validation/validate_mission.py": "",
    "CRF/Scripts/Game/CacheHunt.c": CACHE_HUNT,
    "CRF/Prefabs/Lobby/COA_Lobby.et": `COA_Gamemode : "{1000000000000099}Prefabs/!Systems/!Lobby/COA_Lobby.et" {\n}\n`,
    "CRF/Prefabs/Mine/MySpawn.et": `COA_StaticSpawnPoint : "{4000000000000002}${MM}/SpawnPoints/SpawnPoints/OPFOR_Spawn.et" {\n}\n`,
    "CRF/Prefabs/Compositions/Slotted/SlotFlatSmall/VehicleMaintenance_S_BLUFOR.et": "GenericEntity {\n}\n",
    [`CRF/${MM}/Systems/TaskCreator/CRF_task_empty.et.meta`]: meta(`{4000000000000008}${MM}/Systems/TaskCreator/CRF_task_empty.et`),
    [`CRF/${MM}/Markers/ObjectiveMarkers/NEW/CIVILIAN_NewObjectiveMarker.et.meta`]: meta(`{4000000000000007}${MM}/Markers/ObjectiveMarkers/NEW/CIVILIAN_NewObjectiveMarker.et`),
    "COALITION-Lobby/Prefabs/!Systems/!Lobby/COA_Lobby.et": `COA_Gamemode {\n m_INDFORSlots {\n  COA_SlottingGroup "{3000000000000009}" {\n   m_aSlots {\n    RIFLEMAN\n    RIFLEMAN\n   }\n  }\n }\n}\n`,
    [`COALITION-Lobby/${MM}/SpawnPoints/SpawnPoints/OPFOR_Spawn.et`]: "COA_StaticSpawnPoint {\n}\n",
    [`COALITION-Lobby/${MM}/SpawnPoints/SpawnPoints/OPFOR_Spawn.et.meta`]: meta(`{4000000000000002}${MM}/SpawnPoints/SpawnPoints/OPFOR_Spawn.et`),
    [`COALITION-Lobby/${MM}/SpawnPoints/SpawnPoints/BLUFOR_Spawn.et.meta`]: meta(`{4000000000000001}${MM}/SpawnPoints/SpawnPoints/BLUFOR_Spawn.et`),
    [`CRF/${WORLD}`]: `SubScene {\n Parent "{9000000000000001}Worlds/Test/Test.ent"\n}\n`,
    "CRF/Worlds/Test/Author_TVT_Fixture_Layers/_INIT.layer": INIT,
    "CRF/Worlds/Test/Author_TVT_Fixture_Layers/SPAWNPOINTS.layer": SPAWNPOINTS,
    "CRF/Worlds/Test/Author_TVT_Fixture_Layers/GameBorderS.layer": GAMEBORDERS,
    "CRF/Worlds/Test/Author_TVT_Fixture_Layers/MARKERS.layer": MARKERS,
    "CRF/Worlds/Test/Author_TVT_Fixture_Layers/OBJECTIVES.layer": OBJECTIVES,
    "CRF/Worlds/Test/Author_TVT_Fixture_Layers/PROPS.layer": PROPS,
    "CRF/Worlds/Test/Author_TVT_Fixture_Layers/broken.layer": "GenericEntity Broken {\n coords 1 1 1\n",
    "CRF/Missions/Test/Author_1031_TVT4_Fixture.conf": `SCR_MissionHeader {\n World "{8000000000000001}${WORLD}"\n}\n`,
    "CRF/Missions/Test/Other.conf": `SCR_MissionHeader {\n World "{8000000000000002}Worlds/Test/Other.ent"\n}\n`,
  };
  for (const [rel, text] of Object.entries(files)) write(root, rel, text);
  // gamePath only has to exist as a string: ancestry reads fall back to it and find nothing
  return { root, crf, lobby, world: join(crf, WORLD), config: { projectPath: root, gamePath: join(root, "no-game") } as Config };
}

export function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}
