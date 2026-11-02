import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
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
    expect(await call({ world: "C:/Windows/x.ent" })).toMatchObject({ isError: true, text: expect.stringContaining("inside the project path") });
  });
});
