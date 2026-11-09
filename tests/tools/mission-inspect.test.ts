import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMissionInspect } from "../../src/tools/mission-inspect.js";
import { makeProjects, write } from "../coalition/fixture.js";

type Handler = (p: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
let fx: ReturnType<typeof makeProjects>;
let handler: Handler;
beforeAll(() => {
  fx = makeProjects();
  registerMissionInspect({ registerTool: (_n: string, _d: unknown, h: Handler) => void (handler = h) } as unknown as McpServer, fx.config);
});
afterAll(() => rmSync(fx.root, { recursive: true, force: true }));

const call = async (p: Record<string, unknown>) => {
  const r = await handler({ world: "Worlds/Test/Author_TVT_Fixture.ent", format: "markdown", ...p });
  return { text: r.content[0].text, isError: !!r.isError };
};

describe("mission_inspect", () => {
  it("renders the side table with a safestart warning", async () => {
    const { text, isError } = await call({ sections: ["sides"] });
    expect(isError).toBe(false);
    expect(text.split("\n").slice(1, 3)).toEqual([`CRF: clone unknown (${fx.crf})`, `Lobby: clone unknown (${fx.lobby})`]);
    expect(text).toContain("| Item | BLUFOR | OPFOR | INDFOR |");
    expect(text).toContain("| Slots (groups) | 3 (1) | 1 (1) | 2 (1) |");
    expect(text).toContain("| Spawn points | 1 | 2 | 0 |");
    expect(text).toContain("| Safestart zone | **0** | 1 | **0** |");
    expect(text).toContain("| Forward-deploy zone | 1 | 0 | 0 |");
    expect(text).toContain("Game borders: 1. GLOBAL objective markers (all sides): 2.");
    expect(text).toContain("Warning: BLUFOR has no safestart zone");
    expect(text).toContain("Mystery: spawn by class COA_StaticSpawnPoint, side unknown");
    expect(text).not.toContain("## Names");
  });

  it("reports missing names with suggestions and Task Creator anchors", async () => {
    const { text } = await call({ sections: ["names", "tasks"] });
    expect(text).toContain("**not found**: Intel_1 (CRF_TaskCreatorComponent.m_sSpawnEntityName on COA_Lobby), did you mean intel_1? names are case-sensitive");
    expect(text).toContain("**not found**: mcom_b_trigger");
    expect(text).toContain("not found: CacheHunt_Center (CRF_CacheHuntGamemodeManager.m_sRandomCenterEntityName default on COA_Lobby; unset in the mission");
    expect(text).toContain("- Intel: type COLLECT_INTEL (default), side OPFOR, anchor **Intel_1 not found**");
    expect(text).toContain("- New Task: type COLLECT_INTEL (default), side ALL (default), anchor Radio found, placed from Prefabs/Props/Radio.et (not CRF_task_empty.et)");
    expect(text).toContain("anchor **no anchor name**");
    expect(text).toMatch(/^3 issue\(s\)/m);
  });

  it("checks the rules", async () => {
    const { text } = await call({ sections: ["summary", "rules"] });
    expect(text).toContain("- broken: **parse error**: line 1");
    expect(text).toContain("- AI World in _INIT: yes");
    expect(text).toContain("- info: COA_Lobby entity is named COA_Lobby");
    expect(text).toContain("Vanilla composition on the guide's avoid list (suspected server crashes): Prefabs/Compositions/Slotted/SlotFlatLarge/Helipad_L_US_01.et x2");
    expect(text).not.toMatch(/CheckpointUnderConstruction|VehicleMaintenance_S_BLUFOR/);
    expect(text).toContain("- info: 1 CIV mission prefab(s) placed, but CIV has no slots");
    expect(text).not.toContain("mission .conf files point");
  });

  it("names the guide's COAL_ replacement when CRF has it, says when it does not, and lists off-list props (D-039)", async () => {
    const { text } = await call({ sections: ["rules"] });
    expect(text).toContain(
      "- warning: Vanilla composition on the guide's avoid list (suspected server crashes): Prefabs/Compositions/Slotted/SlotRoadLarge/Barricade_L_US_01.et; use Prefabs/Compositions/Slotted/SlotRoadLarge/COAL_Barricade_L_US_Green_01.et"
    );
    expect(text).toContain(`Helipad_L_US_01.et x2; the guide's replacement for it was not found in CRF clone unknown (${fx.crf}) or the game files`);
    expect(text).toContain("- info: PROPS compositions on neither the guide's safe list nor its avoid list: Prefabs/Compositions/Slotted/SlotFlatSmall/SandbagPosition_S_US_01.et");
  });

  it("adds progress, settings and standards only when asked", async () => {
    const plain = (await call({})).text;
    expect(plain).not.toMatch(/## (Progress|Settings|Standards)/);
    const { text } = await call({ sections: ["progress", "settings", "standards"] });
    expect(text).toContain("- [x] 1 Create initial layers and COA_Lobby: COA_Lobby placed; guide layers not in the world: SPAWNPOINTSGROUPS, VEHICLES");
    expect(text).toContain("- [ ] 5 Configure Descriptions:");
    expect(text).toContain("Next: Run plugin 2 Configure Settings (Plugins > Coalition Lobby Mission Plugins).");
    expect(text).toContain("| CVON | (unset) | unset |");
    expect(text).toContain("## Standards");
  });

  it("reads the per-side radio, BFT and Shareable Markers flags with their defaults from the Lobby and CRF scripts", async () => {
    write(fx.lobby, "Scripts/Game/Configs/COA_GearscriptConfig.c", `class COA_GearScriptContainer {\n [Attribute("true", UIWidgets.Hidden)]\n bool m_bEnableBFT;\n [Attribute("false", UIWidgets.Hidden)]\n bool m_bEnableGIRadios;\n}`);
    write(fx.crf, "Scripts/Game/Overrides/CRF_COA_GearscriptConfig.c", `modded class COA_GearScriptContainer {\n [Attribute("false", UIWidgets.Hidden)]\n bool m_bEnableShareableMarkers;\n}`);
    write(fx.crf, "Worlds/Test/Gear.ent", "SubScene {\n}\n");
    write(
      fx.crf,
      "Worlds/Test/Gear_Layers/_INIT.layer",
      `COA_Gamemode COA_Lobby : "{1000000000000002}Prefabs/Lobby/COA_Lobby.et" {\n m_BLUFORGearScriptSettings COA_GearScriptContainer "{5}" {\n  m_bEnableGIRadios 1\n  m_bEnableShareableMarkers 1\n }\n m_OPFORGearScriptSettings COA_GearScriptContainer "{6}" {\n  m_bEnableBFT 0\n }\n}\n`
    );
    const { text } = await call({ world: "Worlds/Test/Gear.ent", sections: ["settings"] });
    expect(text).toContain("| BLUFOR Enable GI Radios | yes | mission |");
    expect(text).toContain("| BLUFOR Enable BFT | yes | script default |");
    expect(text).toContain("| BLUFOR Enable Shareable Markers | yes | mission |");
    expect(text).toContain("| OPFOR Enable BFT | no | mission |");
    expect(text).toContain("| OPFOR Enable Shareable Markers | no | script default |");
  });

  it("warns on the PrefabsEditable (E_) copy of an avoid-list composition", async () => {
    const { text } = await call({ sections: ["rules"] });
    expect(text).toContain("avoid list (suspected server crashes): PrefabsEditable/Auto/Compositions/Slotted/SlotRoadSmall/E_Barricade_S_US_01.et");
  });

  it("spares an avoid-category composition shipped in the Lobby, like CRF's own", async () => {
    const { text } = await call({ sections: ["rules"] });
    expect(text).not.toContain("LivingArea_L_COA");
  });

  it("returns json with only the requested sections", async () => {
    const { text } = await call({ sections: ["sides"], format: "json" });
    const j = JSON.parse(text);
    expect(j.sides.OPFOR.spawn).toEqual(["COA_StaticSpawnPoint in SPAWNPOINTS", "OPFOR_Spawn2"]);
    expect(j.names).toBeUndefined();
  });

  it("flags a renamed COA_Lobby, a missing AI World and a second mission .conf", async () => {
    write(fx.crf, "Worlds/Test/Renamed.ent", "SubScene {\n}\n");
    write(fx.crf, "Worlds/Test/Renamed_Layers/_INIT.layer", `COA_Gamemode Lobby2 : "{1000000000000002}Prefabs/Lobby/COA_Lobby.et" {\n}\n`);
    write(fx.crf, "Missions/Test/A.conf", `SCR_MissionHeader {\n World "{8000000000000003}Worlds/Test/Renamed.ent"\n}\n`);
    write(fx.crf, "Missions/Test/B.conf", `SCR_MissionHeader {\n World "{8000000000000003}Worlds/Test/Renamed.ent"\n}\n`);
    const { text } = await call({ world: "Worlds/Test/Renamed.ent", sections: ["rules"] });
    expect(text).toContain("- error: The COA_Lobby entity is named Lobby2; it must be exactly COA_Lobby");
    expect(text).toContain("- warning: No AI World in _INIT");
    expect(text).toContain("2 mission .conf files point at this world");
  });

  it("errors for a world without COA_Lobby or outside the project path", async () => {
    write(fx.crf, "Worlds/Test/Plain.ent", "SubScene {\n}\n");
    write(fx.crf, "Worlds/Test/Plain_Layers/default.layer", "GenericEntity Thing {\n}\n");
    expect(await call({ world: "Worlds/Test/Plain.ent" })).toMatchObject({ isError: true, text: expect.stringContaining("has no COA_Lobby entity") });
    expect(await call({ world: resolve("/", "Windows", "x.ent") })).toMatchObject({ isError: true, text: expect.stringContaining("inside the project path") });
  });

  it("names the CRF copy searched when a relative world is missing", async () => {
    expect(await call({ world: "Worlds/Test/Nope.ent" })).toMatchObject({
      isError: true,
      text: `World not found: Worlds/Test/Nope.ent is not in CRF clone unknown (${fx.crf}) nor under ${fx.root}.`,
    });
  });
});
