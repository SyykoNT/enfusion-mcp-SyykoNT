import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { loadMission, prop, slotRoles, type Mission } from "../../src/coalition/mission-model.js";
import { makeProjects } from "./fixture.js";

let fx: ReturnType<typeof makeProjects>;
let m: Mission;
beforeAll(() => {
  fx = makeProjects();
  m = loadMission(fx.config, fx.world);
});
afterAll(() => rmSync(fx.root, { recursive: true, force: true }));

describe("loadMission", () => {
  it("reads every layer and keeps going past one that fails to parse", () => {
    expect(m.layers.map((l) => l.name)).toEqual(["GameBorderS", "MARKERS", "OBJECTIVES", "PROPS", "SPAWNPOINTS", "_INIT", "broken"]);
    expect(m.layers.find((l) => l.name === "broken")?.error).toMatch(/line 1/);
    expect(m.layers.find((l) => l.name === "SPAWNPOINTS")?.entities).toBe(5);
  });

  it("expands $grp members and nested child entities", () => {
    const names = m.entities.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["intel_1", "mcom_a_trigger", "z1_alpha_trigger", "SpawnMarker1"]));
    const marker = m.entities.find((e) => e.name === "SpawnMarker1")!;
    expect(marker.parent?.name).toBe("BLUFOR_Spawn1");
    expect(m.entities.find((e) => e.name === "intel_1")?.prefab).toContain("CRF_task_empty.et");
    expect(m.entities.filter((e) => e.layer === "MARKERS" && e.className === "COA_ManualMarker")).toHaveLength(3);
  });

  it("finds the COA_Lobby entity and joins continued strings with escaped quotes", () => {
    expect(m.lobby?.name).toBe("COA_Lobby");
    const desc = m.lobby!.node.children.find((c) => c.type === "m_aMissionDescriptors")!.children[0];
    expect(prop(desc, "m_sTextData")).toBe('Say "hold"\n\nend');
  });

  it("takes slots from the mission, then from the COA_Lobby.et prefab chain", () => {
    expect(Object.keys(m.slots)).toEqual(["BLUFOR", "OPFOR", "INDFOR"]);
    expect(slotRoles(m.slots.BLUFOR)).toEqual(["SQUAD_LEAD", "MEDIC", "RIFLEMAN"]);
    expect(slotRoles(m.slots.INDFOR)).toEqual(["RIFLEMAN", "RIFLEMAN"]);
  });

  it("matches the mission .conf by its World path", () => {
    expect(m.worldRel).toBe("Worlds/Test/Author_TVT_Fixture.ent");
    expect(m.confs).toEqual(["Missions/Test/Author_1031_TVT4_Fixture.conf"]);
  });

  it("throws for a missing world or _Layers folder", () => {
    expect(() => loadMission(fx.config, fx.world.replace("Fixture", "Nope"))).toThrow(/World not found/);
  });
});
