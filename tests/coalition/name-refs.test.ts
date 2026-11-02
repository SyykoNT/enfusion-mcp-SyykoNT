import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { parseAll } from "../../src/formats/enfusion-text.js";
import { loadMission, type Mission, type MissionEntity } from "../../src/coalition/mission-model.js";
import { collectNameRefs, gamemodeNames, nameDefaults, resolveNames } from "../../src/coalition/name-refs.js";
import { makeProjects } from "./fixture.js";

let fx: ReturnType<typeof makeProjects>;
let m: Mission;
let names: Set<string>;
beforeAll(() => {
  fx = makeProjects();
  m = loadMission(fx.config, fx.crfCopy, fx.worldRel, [fx.crfCopy, fx.lobbyCopy]);
  names = new Set(m.entities.flatMap((e) => (e.name ? [e.name] : [])));
});
afterAll(() => rmSync(fx.root, { recursive: true, force: true }));

const entity = (text: string): MissionEntity => {
  const node = parseAll(text)[0];
  return { layer: "_INIT", className: node.type, name: node.id, node };
};

describe("name references", () => {
  it("collects name fields and name lists, skips empty values and labels", () => {
    const refs = collectNameRefs(m.entities);
    expect(refs.map((r) => r.value)).toEqual(["Intel_1", "Radio", "cache1", "Cache2"]);
    expect(refs[0]).toMatchObject({ entity: "COA_Lobby", component: "CRF_TaskCreatorComponent", field: "m_sSpawnEntityName" });
  });

  it("adds a script default for an unset name field", () => {
    const defaults = nameDefaults([fx.crfCopy]);
    expect(defaults.get("CRF_CacheHuntGamemodeManager")).toEqual(
      new Map([["m_sRandomCenterEntityName", "CacheHunt_Center"], ["m_sDefenderHomeFlagName", "CacheHunt_HomeFlag"]])
    );
    const refs = resolveNames(collectNameRefs(m.entities, defaults), names).filter((r) => r.fromDefault);
    expect(refs.map((r) => [r.value, r.found])).toEqual([["CacheHunt_Center", false], ["CacheHunt_HomeFlag", true]]);
  });

  it("resolves case-sensitively and suggests near misses", () => {
    const refs = resolveNames(collectNameRefs(m.entities), names);
    expect(refs.find((r) => r.value === "Radio")?.found).toBe(true);
    expect(refs.find((r) => r.value === "Intel_1")).toMatchObject({ found: false, suggestions: ["intel_1"] });
    expect(refs.find((r) => r.value === "Cache2")).toMatchObject({ found: false, suggestions: ["cache2", "cache1"] });
  });

  it("builds Rush trigger names from the zone settings and notes legacy names", () => {
    const { refs, notes } = gamemodeNames(m.entities, names);
    expect(refs.map((r) => r.value)).toEqual(["mcom_a_trigger", "mcom_b_trigger"]);
    expect(notes).toEqual([{ level: "info", text: "Rush legacy names present (both schemes run): z1_alpha_trigger" }]);
    const big = entity(`COA_Gamemode COA_Lobby {\n components {\n  CRF_RushGamemodeManager "{1}" {\n   m_iNumberOfZones 4\n  }\n }\n}\n`);
    expect(gamemodeNames([big], names).refs.map((r) => r.value).slice(5)).toEqual(["mcom_f_trigger", "mcom_7_trigger", "mcom_8_trigger"]);
  });

  it("checks S&D and Rally names only when the component is attached", () => {
    const sd = entity(`COA_Gamemode COA_Lobby {\n components {\n  CRF_SearchAndDestroyGamemodeManager "{1}" {\n  }\n  CRF_RallyGamemodeComponent "{2}" {\n  }\n }\n}\n`);
    const { refs, notes } = gamemodeNames([sd], new Set(["rally_cp1", "rally_cp2", "rally_cp4"]));
    expect(refs.map((r) => r.value)).toEqual(["aSiteTrigger", "bSiteTrigger", "rally_start", "rally_end"]);
    expect(notes[0].text).toMatch(/found: 2/);
    expect(gamemodeNames([entity("GenericEntity X {\n}\n")], names).refs).toEqual([]);
  });

  it("warns when Gun Game has no spawnpoint0", () => {
    const gg = entity(`COA_Gamemode COA_Lobby {\n components {\n  CRF_GunGame "{1}" {\n  }\n }\n}\n`);
    expect(gamemodeNames([gg], new Set(["spawnpoint1"])).notes[0].level).toBe("warning");
    expect(gamemodeNames([gg], new Set(["spawnpoint0", "spawnpoint1"])).notes[0].text).toMatch(/found: 2/);
  });
});
