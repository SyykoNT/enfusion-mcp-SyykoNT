import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../../src/config.js";
import { parseAll } from "../../src/formats/enfusion-text.js";
import type { Layer } from "../../src/pak/stack.js";
import { attributeDefaults, progress, replacements, settings, standards, worldChecks, zoneChecks } from "../../src/coalition/mission-checks.js";
import { loadMission, type Mission, type MissionEntity } from "../../src/coalition/mission-model.js";
import type { Classified } from "../../src/coalition/mission-prefabs.js";

// Hand-written fixtures only: CRF and the Lobby are under the Arma Public License, so nothing is copied from them.

const config = { projectPath: join(tmpdir(), "emcp-no-such-dir"), gamePath: join(tmpdir(), "emcp-no-game") } as Config;

/** A copy held in memory, standing in for a clone or a Workshop pak. */
function memCopy(files: Record<string, string>): Layer {
  const keys = Object.keys(files);
  return {
    root: "mem", kind: "loose", guidOf: () => undefined,
    exists: (p: string) => p in files || keys.some((f) => f.startsWith(`${p}/`)),
    read: (p: string) => (p in files ? Buffer.from(files[p]) : null),
    list: (d: string) => keys.filter((f) => f.startsWith(`${d}/`)),
  } as unknown as Layer;
}

const WORLD = "Worlds/Test/Me_TVT_Test.ent";
const LAYERS = "Worlds/Test/Me_TVT_Test_Layers";
const ent = (parent = "{9000000000000001}worlds/Test/Test.ent") => `SubScene {\n Parent "${parent}"\n}\n`;
const lobbyEntity = (body = "") => `COA_Gamemode COA_Lobby : "{1000000000000099}Prefabs/!Systems/!Lobby/COA_Lobby.et" {\n${body}}\n`;
const group = (callsign: string, roles: string[]) =>
  `  COA_SlottingGroup "{3000000000000001}" {\n   m_sCallsign "${callsign}"\n   m_aSlots {\n${roles.map((r) => `    ${r}\n`).join("")}   }\n  }\n`;
const briefing = (text: string, key: string) =>
  `  COA_MissionDescriptor "{4000000000000001}" {\n   m_sTitle "${key} Briefing"\n   m_sTextData "${text}"\n   m_aFactionKeys {\n    "${key}"\n   }\n  }\n`;
const conf = (name: string) => [`Missions/Test/${name}.conf`, `SCR_MissionHeader {\n World "{8000000000000001}${WORLD}"\n}\n`];
// What COA_Lobby.et would hold: default briefings, a faction manager keyed by GUID
const PREFAB = parseAll(
  `COA_Gamemode {\n m_iTimeLimitMinutes 45\n m_aDefaultMissionDescriptors {\n${briefing("Add the briefing.", "BLUFOR")} }\n {\n  SCR_FactionManager "6A39" {\n   Factions {\n    SCR_Faction "{628B}" {\n     FactionKey "BLUFOR"\n    }\n   }\n  }\n }\n}\n`
)[0];

function mission(files: Record<string, string>): Mission & { lobby: MissionEntity } {
  const m = loadMission(config, memCopy({ [WORLD]: ent(), ...files }), WORLD);
  return m as Mission & { lobby: MissionEntity };
}
const nodesOf = (m: Mission & { lobby: MissionEntity }) => [m.lobby.node, PREFAB];

describe("progress (GI-03)", () => {
  it("names the next guide step at three stages of a mission", () => {
    // Fresh: plugin 1 ran, nothing else
    const fresh = mission({ [`${LAYERS}/_INIT.layer`]: lobbyEntity() });
    let p = progress(fresh, nodesOf(fresh));
    expect(p.steps[0]).toMatchObject({ done: true, detail: expect.stringContaining("guide layers not in the world: MARKERS, SPAWNPOINTS") });
    expect(p.next).toBe("Drag the terrain's own AI World (else SCR_AIWorld) into _INIT.");

    // Settings, factions and slots done; only the default briefing text
    const ai = `SCR_AIWorld : "{1000000000000001}Prefabs/AI/SCR_AIWorld.et" {\n}\n`;
    const middle = { m_iTimeLimitMinutes: " m_iTimeLimitMinutes 60\n", tickets: " m_iBLUFORTickets 0\n", slots: ` m_BLUFORSlots {\n${group("1-1", ["SQUAD_LEAD"])} }\n` };
    const partial = mission({
      [`${LAYERS}/_INIT.layer`]: ai + lobbyEntity(Object.values(middle).join("") + ` m_aMissionDescriptors {\n${briefing("Add the briefing.", "BLUFOR")} }\n`),
    });
    p = progress(partial, nodesOf(partial));
    expect(p.steps.map((s) => s.done)).toEqual([true, true, true, true, true, false, false]);
    expect(p.steps[5].detail).toBe("briefing written for no side; missing for BLUFOR");
    expect(p.next).toBe("Run plugin 5 Configure Descriptions (Plugins > Coalition Lobby Mission Plugins).");

    // Briefing written and one .conf: done
    const [cf, cfText] = conf("Me_1101_TVT1_Test");
    const done = mission({
      [`${LAYERS}/_INIT.layer`]: ai + lobbyEntity(Object.values(middle).join("") + ` m_aMissionDescriptors {\n${briefing("Hold the bridge.", "BLUFOR")} }\n`),
      [cf]: cfText,
    });
    p = progress(done, nodesOf(done));
    expect(p.steps.every((s) => s.done)).toBe(true);
    expect(p.next).toMatch(/^All plugin steps are done/);
  });

  it("counts a briefing shown for any faction as written for every slotted side", () => {
    const allSides = `  COA_MissionDescriptor "{4000000000000001}" {\n   m_sTitle "Briefing"\n   m_sTextData "Hold the bridge."\n   m_bShowForAnyFaction 1\n  }\n`;
    const m = mission({
      [`${LAYERS}/_INIT.layer`]: `SCR_AIWorld X {\n}\n` + lobbyEntity(` m_iTimeLimitMinutes 1\n m_iBLUFORTickets 0\n m_BLUFORSlots {\n${group("1-1", ["MEDIC"])} }\n m_OPFORSlots {\n${group("2-1", ["MEDIC"])} }\n m_aMissionDescriptors {\n${allSides} }\n`),
    });
    const step = progress(m, nodesOf(m)).steps[5];
    expect(step.done).toBe(true);
    expect(step.detail).toBe("briefing written for BLUFOR, OPFOR");
  });

  it("asks to delete the extra .conf when plugin 6 ran twice", () => {
    const [a, at] = conf("A"), [b, bt] = conf("B");
    const m = mission({ [`${LAYERS}/_INIT.layer`]: `SCR_AIWorld X {\n}\n` + lobbyEntity(" m_iTimeLimitMinutes 1\n m_iBLUFORTickets 0\n"), [a]: at, [b]: bt });
    expect(progress(m, nodesOf(m)).next).toBe("Run plugin 4 Configure Slots (Plugins > Coalition Lobby Mission Plugins).");
    const slotted = mission({ [`${LAYERS}/_INIT.layer`]: `SCR_AIWorld X {\n}\n` + lobbyEntity(` m_iTimeLimitMinutes 1\n m_iBLUFORTickets 0\n m_BLUFORSlots {\n${group("1-1", ["MEDIC"])} }\n m_aMissionDescriptors {\n${briefing("Go.", "BLUFOR")} }\n`), [a]: at, [b]: bt });
    expect(progress(slotted, nodesOf(slotted)).next).toBe("Delete the extra mission .conf: plugin 6 was run more than once.");
  });
});

describe("settings (GI-04)", () => {
  it("reads values from the mission, then COA_Lobby.et, then the script defaults, with enum names and faction keys", () => {
    const m = mission({
      [`${LAYERS}/_INIT.layer`]: lobbyEntity(
        ` m_eRespawnMode 1\n m_bUseCVON 0\n m_BLUFORGearScriptSettings COA_GearScriptContainer "{5}" {\n  m_rGearScript "{ABCDEF0123456789}Configs/Gearscripts/GS.conf"\n }\n {\n  SCR_FactionManager "6A39" {\n   Factions {\n    SCR_Faction "{628B}" {\n     m_aFriendlyFactionsIds {\n      "OPFOR"\n     }\n    }\n   }\n  }\n }\n`
      ),
    });
    const defaults = attributeDefaults(`class COA_Gamemode {\n [Attribute("60", UIWidgets.EditBox, "Respawn time (s)")]\n protected int m_iTimeToRespawn;\n [Attribute("true")] bool m_bUseCVON;\n}`);
    const enums = new Map([["COA_ERespawnMode", new Map([["TEAM", 0], ["SLOT", 1]])]]);
    const rows = Object.fromEntries(settings(m, nodesOf(m), enums, defaults).map((r) => [r.name, `${r.value} [${r.from}]`]));
    expect(rows["Respawn mode"]).toBe("SLOT [mission]");
    expect(rows["CVON"]).toBe("no [mission]");
    expect(rows["Time limit (minutes)"]).toBe("45 [COA_Lobby.et]");
    expect(rows["Time to respawn"]).toBe("60 [script default]");
    expect(rows["Respawn"]).toBe(" [unset]");
    expect(rows["BLUFOR gearscript"]).toBe("Configs/Gearscripts/GS.conf [mission]");
    expect(rows["BLUFOR friendly with"]).toBe("OPFOR [mission]");
  });
});

describe("standards (GI-05)", () => {
  it("checks callsigns, the Rule of Twos from callsigns and the 9-man squad, as warnings and info only", () => {
    const nine = ["SQUAD_LEAD", "MEDIC", "TEAM_LEAD", "AUTOMATIC_RIFLEMAN", "ASSISTANT_AUTOMATIC_RIFLEMAN", "TEAM_LEAD", "RIFLEMAN_ANTITANK", "RIFLEMAN_ANTITANK"];
    const m = mission({
      [`${LAYERS}/_INIT.layer`]: lobbyEntity(
        ` m_BLUFORSlots {\n${group("COY", ["COMMANDER"])}${group("1PLT", ["PLATOON_LEADER"])}${group("1-1", [...nine, "GRENADIER"])}${group("1-2", ["SQUAD_LEAD", "TEAM_LEAD", "RIFLEMAN"])}${group("Recon", ["SNIPER"])} }\n`
      ),
    });
    expect(standards(m)).toEqual([
      { level: "info", text: "BLUFOR callsigns not in the guide's form (COY, 1PLT, 1-1, 1-1R): Recon" },
      { level: "warning", text: "BLUFOR COY leads 1 platoon(s); the Rule of Twos wants 2 to 4" },
      { level: "warning", text: "BLUFOR 1-2 has 1 fireteam(s); the Rule of Twos wants a squad over its two colour teams" },
      { level: "info", text: "BLUFOR 1-2 differs from the guide's 9-man squad: missing MEDIC, AUTOMATIC_RIFLEMAN, ASSISTANT_AUTOMATIC_RIFLEMAN, TEAM_LEAD, RIFLEMAN_ANTITANK, RIFLEMAN_ANTITANK, RIFLEMAN_DEMO; extra RIFLEMAN" },
    ]);
  });
});

describe("safe composition replacements (GI-06)", () => {
  it("maps each avoid-list category and slot size to the guide's safe list", () => {
    expect(replacements("Prefabs/Compositions/Slotted/SlotRoadLarge/Barricade_L_US_01.et")).toEqual(["COAL_Barricade_L", "COAL_Checkpoint_L_USSR", "CheckpointUnderConstruction_L_US"]);
    expect(replacements("Prefabs/Compositions/Slotted/SlotRoadLarge/Checkpoint_L_USSR_01.et")).toEqual(["COAL_Checkpoint_L_USSR", "CheckpointUnderConstruction_L_US"]);
    expect(replacements("PrefabsEditable/Auto/Compositions/Slotted/SlotRoadMedium/E_Checkpoint_M_US_01.et")).toEqual(["CheckpointUnderConstruction_M_US"]);
    expect(replacements("Prefabs/Compositions/Slotted/SlotFlatMedium/VehicleMaintenance_M_US_01.et")).toEqual(["COAL_FieldHospital_M"]);
    expect(replacements("Prefabs/Compositions/Slotted/SlotFlatSmall/AmmoStorage_S_FIA_01.et")).toEqual(["COAL_SandbagPos_S"]);
    expect(replacements("Prefabs/Compositions/Slotted/SlotFlatLarge/LivingArea_L_US_01.et")).toEqual(["COAL_Barracks_L"]);
    expect(replacements("Prefabs/Compositions/Slotted/SlotFlatLarge/FieldHospital_L_US_01.et")).toEqual(["COAL_Barracks_L", "COAL_Helipad_L"]);
  });
});

describe("world structure (GI-07)", () => {
  const init = (ai: string) => ({ [`${LAYERS}/_INIT.layer`]: `SCR_AIWorld : "{1}${ai}" {\n}\n` + lobbyEntity() });
  const run = (files: Record<string, string>, world = WORLD, copies: Layer[] = []) => {
    const copy = memCopy(files);
    return worldChecks(config, loadMission(config, copy, world), [copy, ...copies]).map((n) => `${n.level}: ${n.text}`);
  };

  it("accepts a sub-scene in Worlds/<Terrain>/ with the terrain's AI World", () => {
    expect(run({ [WORLD]: ent(), ...init("Prefabs/AI/SCR_AIWorld.et") })).toEqual([]);
  });

  it("flags a world that is not a sub-scene, an Empty parent, the wrong folder depth and a differing folder name", () => {
    expect(run({ [WORLD]: "GenericWorldEntity world {\n}\n", ...init("Prefabs/AI/SCR_AIWorld.et") })).toEqual([
      expect.stringMatching(/^warning: Worlds\/Test\/Me_TVT_Test\.ent is not a sub-scene of a terrain/),
    ]);
    expect(run({ [WORLD]: ent("{9000000000000002}worlds/Test/Test_Empty.ent"), ...init("Prefabs/AI/SCR_AIWorld.et") })).toEqual([
      expect.stringMatching(/^warning: Parent world worlds\/Test\/Test_Empty\.ent is an "Empty" variant/),
      "info: World folder Test, parent world Test_Empty: plugin 6 names the terrain Test",
    ]);
    const flat = { "Worlds/Me_TVT_Test.ent": ent(), "Worlds/Me_TVT_Test_Layers/_INIT.layer": init("Prefabs/AI/SCR_AIWorld.et")[`${LAYERS}/_INIT.layer`] };
    expect(run(flat, "Worlds/Me_TVT_Test.ent")).toEqual([expect.stringMatching(/^warning: Plugin 6 names the terrain after the world's folder/)]);
  });

  it("warns when the default SCR_AIWorld is used and the terrain has its own", () => {
    const own = memCopy({ "Prefabs/AI/SCR_AIWorld_Test.et": "SCR_AIWorld {\n}\n" });
    expect(run({ [WORLD]: ent(), ...init("Prefabs/AI/SCR_AIWorld.et") }, WORLD, [own])).toEqual([
      "warning: _INIT uses the default SCR_AIWorld, but the terrain has its own: Prefabs/AI/SCR_AIWorld_Test.et (guide: use the terrain's own AI World)",
    ]);
    expect(run({ [WORLD]: ent(), ...init("Prefabs/AI/SCR_AIWorld_Test.et") }, WORLD, [own])).toEqual([]);
  });
});

describe("zone geometry (GI-08)", () => {
  // Squares of half-size h around (x, z), written as a zone entity: coords plus ShapePoint offsets
  const square = (type: string, x: number, z: number, h: number, extra = "") =>
    `${type} : "{1}P.et" {\n coords ${x} 0 ${z}\n${extra} Points {\n${[[-h, -h], [h, -h], [h, h], [-h, h]].map(([a, b]) => `  ShapePoint "{2}" {\n   Position ${a} 0 ${b}\n  }\n`).join("")} }\n}\n`;
  const point = (name: string, x: number, z: number) => `GenericEntity ${name} {\n coords ${x} 0 ${z}\n}\n`;
  const check = (layer: string, kinds: Record<string, Classified>) => {
    const m = mission({ [`${LAYERS}/_INIT.layer`]: lobbyEntity(` m_BLUFORSlots {\n${group("1-1", ["MEDIC"])} }\n`), [`${LAYERS}/ZONES.layer`]: layer });
    const classes = new Map<MissionEntity, Classified | undefined>(m.entities.map((e) => [e, kinds[e.name ?? e.className]]));
    return zoneChecks(m, classes).map((n) => `${n.level}: ${n.text}`);
  };
  const safe: Classified = { kind: "safestart", side: "BLUFOR", via: "class" };
  const border: Classified = { kind: "gameBorder", via: "class" };
  const spawn: Classified = { kind: "spawn", side: "BLUFOR", via: "class" };
  const fd: Classified = { kind: "forwardDeploy", side: "BLUFOR", via: "class" };

  it("reports spawns outside their safe start zone and anything outside the game border, with the distance", () => {
    const layer = square("COA_SafestartBorder", 0, 0, 50) + square("COA_GameBorder", 0, 0, 1000) + square("COA_ForwardDeployBorder", 980, 0, 50) +
      point("SpawnIn", 49, 0) + point("SpawnOut", 60, 0) + point("FarOut", 1500, 0) + point("Edge", 50.4, 0);
    expect(check(layer, { COA_SafestartBorder: safe, COA_GameBorder: border, COA_ForwardDeployBorder: fd, SpawnIn: spawn, SpawnOut: spawn, FarOut: spawn, Edge: spawn })).toEqual([
      "warning: SpawnOut is 10 m outside the BLUFOR safe start zone (fine for a respawn point used after safe start)",
      "warning: FarOut is 1450 m outside the BLUFOR safe start zone (fine for a respawn point used after safe start)",
      "warning: FarOut is 500 m outside the game border",
      "warning: Forward deploy zone COA_ForwardDeployBorder in ZONES reaches 30 m outside the game border",
    ]);
  });

  it("skips checks against a rotated zone instead of guessing its outline", () => {
    const layer = square("COA_SafestartBorder", 0, 0, 50, " angleY 30\n") + point("SpawnOut", 60, 0);
    expect(check(layer, { COA_SafestartBorder: safe, SpawnOut: spawn })).toEqual([
      "info: COA_SafestartBorder in ZONES is rotated; zone checks against it were skipped",
    ]);
  });
});
