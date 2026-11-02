import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { loadMission, prop, slotRoles, type Mission } from "../../src/coalition/mission-model.js";
import type { Layer } from "../../src/pak/stack.js";
import { makeProjects } from "./fixture.js";

let fx: ReturnType<typeof makeProjects>;
let m: Mission;
beforeAll(() => {
  fx = makeProjects();
  m = loadMission(fx.config, fx.crfCopy, fx.worldRel, [fx.crfCopy, fx.lobbyCopy]);
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

  it("reads a world through any copy, such as a Workshop pak (here an in-memory one)", () => {
    const files = new Map([
      ["Worlds/T/W.ent", "SubScene {\n}\n"],
      ["Worlds/T/W_Layers/_INIT.layer", `COA_Gamemode COA_Lobby : "{1000000000000099}Prefabs/!Systems/!Lobby/COA_Lobby.et" {\n m_BLUFORSlots {\n  COA_SlottingGroup "{2000000000000001}" {\n   m_aSlots {\n    RIFLEMAN\n   }\n  }\n }\n}\n`],
      ["Missions/T/W.conf", `SCR_MissionHeader {\n World "{3000000000000001}Worlds/T/W.ent"\n}\n`],
    ]);
    const keys = [...files.keys()];
    const pak = {
      root: "pak", kind: "workshop", guidOf: () => undefined,
      exists: (p: string) => files.has(p) || keys.some((f) => f.startsWith(`${p}/`)),
      read: (p: string) => (files.has(p) ? Buffer.from(files.get(p)!) : null),
      list: (d: string) => keys.filter((f) => f.startsWith(`${d}/`)),
    } as unknown as Layer;
    const w = loadMission(fx.config, pak, "Worlds/T/W.ent", [pak, fx.lobbyCopy]);
    expect([w.lobby?.name, slotRoles(w.slots.BLUFOR), slotRoles(w.slots.INDFOR), w.confs]).toEqual(["COA_Lobby", ["RIFLEMAN"], ["RIFLEMAN", "RIFLEMAN"], ["Missions/T/W.conf"]]);
  });

  it("throws for a missing world or _Layers folder", () => {
    expect(() => loadMission(fx.config, fx.crfCopy, fx.worldRel.replace("Fixture", "Nope"))).toThrow(/World not found/);
  });
});
