import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import { registerGearscriptInspect, type Loadout } from "../../src/tools/gearscript-inspect.js";

// Hand-written fixtures only: CRF and the Lobby are under the Arma Public License, so nothing is copied from them.

const GUID = "ABCDEF0123456789";

const ENUMS = `enum COA_EGearRole
{
\tUNARMED = 0,
\t// leadership
\tSQUAD_LEAD,
\tTEAM_LEAD,
\tMEDIC,
\tAUTOMATIC_RIFLEMAN,
\tASSISTANT_AUTOMATIC_RIFLEMAN,
\tRIFLEMAN,
\tRIFLEMAN_ANTITANK,
\tVEHICLE_LEAD,
\tPILOT
}
enum COA_ESlotType { GENERAL_INFANTRY = 0, SQUAD_LEADER, TEAM_LEADER, MEDIC, ASSISTANT, SPECIALTY, SPECIALTY_ASSISTANT }
enum COA_EGearscriptClothing { UNDEFINED = 123456789, HEADGEAR = 0, SHIRT, VEST }
`;

const MANAGER = `class COA_GearscriptManager : ScriptComponent
{
\tprotected const ResourceName C_RolesConfigResource = "{1111222233334444}Configs/Gearscripts/COA_Global_Roles_Config.conf";
\tprotected const ResourceName C_CVONRolesConfigResource = "{5555666677778888}Configs/Gearscripts/Extra/CVON_Roles.conf";
}
`;

const list = (key: string, vals: string[]) => (vals.length ? [` ${key} {`, ...vals.map((v) => `  ${v}`), " }"] : []);
const role = (id: string, r: string | undefined, o: { name?: string; slot?: string; weapons?: string[]; mags?: string[]; items?: string[] } = {}) =>
  [
    `  COA_RoleConfig "{${id}}" {`,
    ...(r ? [`   m_Role ${r}`] : []),
    ...(o.name ? [`   m_sRoleName "${o.name}"`] : []),
    ...(o.slot ? [`   m_SlottingType ${o.slot}`] : []),
    ...list("m_aWeapons", o.weapons ?? []).map((l) => `  ${l}`),
    ...list("m_aMagazines", o.mags ?? []).map((l) => `  ${l}`),
    ...list("m_aItems", o.items ?? []).map((l) => `  ${l}`),
    "  }",
  ].join("\n");
const rolesConfig = (...roles: string[]) => `COA_RolesConfig {\n m_RoleConfigs {\n${roles.join("\n")}\n }\n}\n`;

const GLOBAL_ROLES = rolesConfig(
  role("2000000000000001", undefined, { name: "Unarmed" }),
  role("2000000000000002", "SQUAD_LEAD", { name: "Squad Leader", slot: "SQUAD_LEADER", weapons: ["RIFLE"], mags: ["RIFLE_MAG"], items: ["SHORTRANGE_RADIO", "LONGRANGE_RADIO", "LEADERSHIP_BINO"] }),
  role("2000000000000003", "TEAM_LEAD", { slot: "TEAM_LEADER", weapons: ["RIFLE"], mags: ["RIFLE_MAG"], items: ["SHORTRANGE_RADIO"] }),
  role("2000000000000004", "MEDIC", { slot: "MEDIC", weapons: ["CARBINE"], mags: ["CARBINE_MAG"], items: ["SHORTRANGE_RADIO", "MEDIC_ITEMS"] }),
  role("2000000000000005", "AUTOMATIC_RIFLEMAN", { weapons: ["AR", "PISTOL"], mags: ["AR_MAG", "PISTOL_MAG"] }),
  role("2000000000000006", "ASSISTANT_AUTOMATIC_RIFLEMAN", { slot: "ASSISTANT", weapons: ["RIFLE"], mags: ["RIFLE_MAG", "AR_MAG"], items: ["ASSISTANT_BINO"] }),
  role("2000000000000007", "RIFLEMAN", { weapons: ["RIFLE"], mags: ["CARBINE_MAG"] }),
  role("2000000000000008", "RIFLEMAN_ANTITANK", { weapons: ["RIFLE", "AT"], mags: ["RIFLE_MAG", "AT_MAG"] }),
  role("2000000000000009", "VEHICLE_LEAD", { slot: "SQUAD_LEADER", weapons: ["CARBINE"], mags: ["CARBINE_MAG"], items: ["LONGRANGE_RADIO"] })
);
// CRF-style override: same path and GUID, only a new role added by {ID}
const CRF_ROLES_OVERRIDE = rolesConfig(role("3000000000000001", "ZOMBIE", { name: "Zombie" }));
const CVON_ROLES = rolesConfig(
  role("4000000000000001", "RIFLEMAN", { weapons: ["RIFLE"], mags: ["RIFLE_MAG"], items: ["SHORTRANGE_RADIO"] }),
  role("4000000000000002", "SQUAD_LEAD", { slot: "SQUAD_LEADER", weapons: ["RIFLE"], mags: ["RIFLE_MAG"], items: ["SHORTRANGE_RADIO"] })
);

const weapon = (id: string, prefab: string, mags: [string, number][], cls = "COA_Weapon_Class", magCls = "COA_Magazine_Class") => [
  `COA_Weapon_Class "{${id}}" {`.replace("COA_Weapon_Class", cls),
  ` m_Weapon "{AAAAAAAAAAAAAAAA}Prefabs/Weapons/${prefab}"`,
  " m_MagazineArray {",
  ...mags.map(([m, n], i) => `  ${magCls} "{${id.slice(0, 15)}${i}}" {\n   m_Magazine "{BBBBBBBBBBBBBBBB}Prefabs/Mags/${m}"\n   m_MagazineCount ${n}\n  }`),
  " }",
  "}",
];
const indent = (lines: string[], pad: string) => lines.join("\n").split("\n").map((l) => pad + l).join("\n");

const GEARSCRIPT = `COA_GearScriptConfig {
 m_FactionName "Testland"
 m_Rifles {
${indent(weapon("1000000000000001", "RifleA.et", [["MagA.et", 8]]), "  ")}
${indent(weapon("1000000000000002", "RifleB.et", [["MagB.et", 6]]), "  ")}
 }
 m_Carbines {
 }
 m_Pistols {
${indent(weapon("1000000000000003", "Pistol.et", [["PistolMag.et", 4]]), "  ")}
 }
 m_AR COA_Spec_Weapon_Class "{1000000000000005}" {
  m_Weapon "{AAAAAAAAAAAAAAAA}Prefabs/Weapons/MG.et"
  m_MagazineArray {
   COA_Spec_Magazine_Class "{1000000000000006}" {
    m_Magazine "{BBBBBBBBBBBBBBBB}Prefabs/Mags/Belt.et"
    m_MagazineCount 6
   }
   COA_Spec_Magazine_Class "{1000000000000007}" {
    m_Magazine "{BBBBBBBBBBBBBBBB}Prefabs/Mags/Box.et"
    m_AssistantMagazineCount 2
   }
  }
 }
 m_DefaultClothing {
  COA_Clothing "{1000000000000008}" {
   m_ClothingPrefabs {
    "{CCCCCCCCCCCCCCCC}Prefabs/Clothing/HelmetA.et"
    "{CCCCCCCCCCCCCCCD}Prefabs/Clothing/HelmetB.et"
   }
  }
  COA_Clothing "{1000000000000009}" {
   m_iClothingType SHIRT
   m_ClothingPrefabs {
    "{CCCCCCCCCCCCCCCE}Prefabs/Clothing/Shirt.et"
   }
  }
  COA_Clothing "{100000000000000A}" {
   m_iClothingType VEST
   m_ClothingPrefabs {
   }
  }
 }
 m_sLeadershipBinocularsPrefab "{DDDDDDDDDDDDDDDD}Prefabs/Items/Bino.et"
 m_DefaultInventoryItems {
  COA_Inventory_Item "{100000000000000B}" {
   m_sItemPrefab "{EEEEEEEEEEEEEEEE}Prefabs/Items/Compass.et"
   m_iItemCount 1
  }
 }
 m_InfantryMedicalItems {
  COA_Inventory_Item "{100000000000000C}" {
   m_sItemPrefab "{EEEEEEEEEEEEEEEF}Prefabs/Items/Bandage.et"
   m_iItemCount 4
  }
 }
 m_MedicMedicalItems {
  COA_Inventory_Item "{100000000000000D}" {
   m_sItemPrefab "{EEEEEEEEEEEEEEE0}Prefabs/Items/Saline.et"
   m_iItemCount 3
  }
 }
 m_RolesToSetCustomSettings {
  COA_Role_Custom_Gear "{100000000000000E}" {
   m_Role VEHICLE_LEAD
   m_Pistols {
${indent(weapon("100000000000000F", "Revolver.et", [["RevolverAmmo.et", 3]]), "    ")}
   }
   m_Clothing {
    COA_Clothing "{1000000000000011}" {
     m_iClothingType SHIRT
     m_ClothingPrefabs {
      "{CCCCCCCCCCCCCCCF}Prefabs/Clothing/TankerShirt.et"
     }
    }
   }
   m_AdditionalInventoryItems {
    COA_Inventory_Item "{1000000000000012}" {
     m_sItemPrefab "{EEEEEEEEEEEEEEE1}Prefabs/Items/Wrench.et"
     m_iItemCount 1
    }
   }
  }
  COA_Role_Custom_Gear "{1000000000000013}" {
   m_Role PILOT
  }
 }
}
`;

const lobbyEntity = (body: string) => `COA_Gamemode COA_Lobby : "{7000000000000001}Prefabs/!Systems/!Lobby/COA_Lobby.et" {\n${body}\n}\n`;
const slotsField = (field: string, roles: string[]) =>
  ` ${field} {\n  COA_SlottingGroup "{6000000000000002}" {\n   m_aSlots {\n${roles.map((r) => `    ${r}`).join("\n")}\n   }\n  }\n }`;

const settings = (side: string) =>
  ` m_${side}GearScriptSettings COA_GearScriptContainer "{6000000000000001}" {\n  m_rGearScript "{${GUID}}Configs/Gearscripts/Test/GS_Alpha.conf"\n  m_bEnableGIRadios 0\n }`;

type Result = { content: { text: string }[]; isError?: boolean };
type Handler = (p: Record<string, unknown>) => Promise<Result>;

let root: string;
let handler: Handler;

const put = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "emcp-gs-"));
  put("CRF/Tools/Validation/validate_mission.py", "");
  put("CRF/Scripts/Game/Mod/CRF_Enums.c", "modded enum COA_EGearRole\n{\n\tZOMBIE,\n}\n");
  put("CRF/Configs/Gearscripts/COA_Global_Roles_Config.conf", CRF_ROLES_OVERRIDE);
  put("CRF/Configs/Gearscripts/Test/GS_Alpha.conf", GEARSCRIPT);
  put("CRF/Configs/Gearscripts/Test/GS_Alpha.conf.meta", `MetaFileClass {\n Name "{${GUID}}Configs/Gearscripts/Test/GS_Alpha.conf"\n}\n`);
  put("CRF/Configs/Gearscripts/Test/GS_Dup.conf", GEARSCRIPT);
  put("CRF/Configs/Gearscripts/Other/GS_Dup.conf", GEARSCRIPT);
  put("CRF/Configs/Gearscripts/Test/NotGs.conf", "COA_Something {\n}\n");
  put("CRF/Worlds/Testland/Mission_Layers/_INIT.layer", `COA_Lobby Lobby {\n${settings("CIVILIAN")}\n}\n`);
  put("CRF/Worlds/Testland/Unrelated_Layers/_INIT.layer", `COA_Lobby Lobby {\n m_sName "nothing here"\n}\n`);
  put("Other/Worlds/Stray.ent", `GenericEntity {\n m_sNote "{${GUID.toLowerCase()}}Configs/Gearscripts/Test/GS_Alpha.conf"\n}\n`);
  put("COALITION-Lobby/Scripts/Game/Systems/Core/Containers & Configs/COA_Enums.c", ENUMS);
  put("COALITION-Lobby/Scripts/Game/Systems/Core/Managers/Gamemode/Gearscript/COA_GearscriptManager.c", MANAGER);
  put("COALITION-Lobby/Configs/Gearscripts/COA_Global_Roles_Config.conf", GLOBAL_ROLES);
  put("COALITION-Lobby/Configs/Gearscripts/Extra/CVON_Roles.conf", CVON_ROLES);
  put("COALITION-Lobby/Prefabs/!Systems/!Lobby/COA_Lobby.et", `COA_Lobby {\n components {\n  CVON_VONGameModeComponent "{6000000000000009}" {\n  }\n }\n${settings("OPFOR")}\n}\n`);
  // CVON switched off with CIV settings in the mission; and a mission that inherits OPFOR settings and CVON from COA_Lobby.et
  put("CRF/Worlds/Testland/CivOff.ent", "SubScene {\n}\n");
  put("CRF/Worlds/Testland/CivOff_Layers/_INIT.layer", lobbyEntity(
    ` m_bUseCVON 0\n${slotsField("m_CIVSlots", ["MEDIC", "SQUAD_LEAD", "MEDIC"])}\n m_CIVILIANGearScriptSettings COA_GearScriptContainer "{6000000000000003}" {\n  m_rGearScript "{${GUID}}Configs/Gearscripts/Test/GS_Alpha.conf"\n  m_bEnableGIRadios 1\n }`
  ));
  put("CRF/Worlds/Testland/Cvon.ent", "SubScene {\n}\n");
  // Old missions place the Lobby from a path that no longer exists
  put("CRF/Worlds/Testland/Cvon_Layers/_INIT.layer", lobbyEntity(slotsField("m_OPFORSlots", ["RIFLEMAN"])).replace("!Systems/!Lobby", "Systems/!Lobby"));
  registerGearscriptInspect(
    { registerTool: (_n: string, _d: unknown, h: Handler) => void (handler = h) } as unknown as McpServer,
    { projectPath: root, gamePath: join(root, "no-game") } as Config
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const call = (p: Record<string, unknown>) => handler({ gearscript: "GS_Alpha.conf", cvon: false, usedBy: false, format: "markdown", ...p });
async function loadouts(p: Record<string, unknown> = {}): Promise<Record<string, Loadout>> {
  const r = await call({ format: "json", ...p });
  expect(r.isError).toBeUndefined();
  return Object.fromEntries((JSON.parse(r.content[0].text).loadouts as Loadout[]).map((l) => [l.role, l]));
}
const given = (l: Loadout) => l.items.filter((i) => i.given).map((i) => `${i.count} ${i.what.split("/").pop()}`);

describe("gearscript_inspect rules", () => {
  it("custom weapons replace every default weapon and magazine; custom clothing wins its slot", async () => {
    const l = (await loadouts()).VEHICLE_LEAD;
    expect(l.weaponsFrom).toBe("custom");
    expect(l.weapons).toEqual([
      {
        category: "Pistols",
        options: [{
          prefab: "{AAAAAAAAAAAAAAAA}Prefabs/Weapons/Revolver.et",
          source: "m_RolesToSetCustomSettings[0].m_Pistols[0]",
          mags: [{ prefab: "{BBBBBBBBBBBBBBBB}Prefabs/Mags/RevolverAmmo.et", count: 3 }],
        }],
      },
    ]);
    expect(l.magazines).toEqual([]);
    expect(l.clothing.find((c) => c.slot === "SHIRT")).toMatchObject({ source: "m_RolesToSetCustomSettings[0].m_Clothing[0]" });
    expect(given(l)).toEqual(["1 Wrench.et", "1 LR radio", "4 Bandage.et", "1 Compass.et"]);
  });

  it("flags an empty pool and a missing specialty field instead of guessing", async () => {
    const all = await loadouts();
    expect(all.MEDIC.weapons).toEqual([]);
    expect(all.MEDIC.notes).toContain("CARBINE: m_Carbines is empty or missing in the gearscript, so no weapon");
    expect(all.RIFLEMAN_ANTITANK.weapons.map((w) => w.category)).toEqual(["RIFLE"]);
    expect(all.RIFLEMAN_ANTITANK.notes).toEqual([
      "AT: m_AT is empty or missing in the gearscript, so no weapon",
      "AT_MAG: no m_AT in the gearscript, so no magazines",
    ]);
  });

  it("gives specialty magazines with the assistant count on assistant slots", async () => {
    const all = await loadouts();
    const counts = (l: Loadout) => l.magazines.find((m) => m.category === "AR_MAG")!.mags.map((m) => m.count);
    expect(all.AUTOMATIC_RIFLEMAN.slotType).toBe("GENERAL_INFANTRY");
    expect(counts(all.AUTOMATIC_RIFLEMAN)).toEqual([6, 0]);
    expect(counts(all.ASSISTANT_AUTOMATIC_RIFLEMAN)).toEqual([0, 2]);
    // The assistant's own rifle pool keeps both options, each with its own magazines
    expect(all.ASSISTANT_AUTOMATIC_RIFLEMAN.weapons[0].options.map((o) => o.mags[0].count)).toEqual([8, 6]);
  });

  it("gives pool magazines only with the matching <cat>_MAG", async () => {
    const l = (await loadouts()).RIFLEMAN;
    expect(l.weapons[0].options.every((o) => o.mags.length === 0)).toBe(true);
    expect(l.notes).toEqual(["RIFLE: no RIFLE_MAG in the role config, so no magazines for it", "CARBINE_MAG: no CARBINE weapon picked, so no magazines"]);
  });

  it("follows the SR radio rules for GI and leadership toggles", async () => {
    const sr = (l: Loadout) => l.items.find((i) => i.what === "SR radio")!.given;
    const def = await loadouts();
    expect([sr(def.SQUAD_LEAD), sr(def.TEAM_LEAD), sr(def.MEDIC)]).toEqual([true, true, false]);
    const gi = await loadouts({ radios: { gi: true } });
    expect(sr(gi.MEDIC)).toBe(true);
    const off = await loadouts({ radios: { leadership: false } });
    expect(sr(off.SQUAD_LEAD)).toBe(false);
    expect(off.SQUAD_LEAD.items.find((i) => i.what === "LR radio")!.given).toBe(false);
  });

  it("adds medic items for MEDIC_ITEMS and infantry medical and default items for everyone", async () => {
    const all = await loadouts();
    expect(given(all.MEDIC)).toEqual(["3 Saline.et", "4 Bandage.et", "1 Compass.et"]);
    expect(given(all.UNARMED)).toEqual(["4 Bandage.et", "1 Compass.et"]);
    expect(all.ASSISTANT_AUTOMATIC_RIFLEMAN.items.find((i) => i.source === "m_sAssistantBinocularsPrefab")).toMatchObject({ given: false });
  });

  it("reads an unset clothing type as HEADGEAR and skips an empty clothing list", async () => {
    const l = (await loadouts()).RIFLEMAN;
    expect(l.clothing.map((c) => [c.slot, c.options.length])).toEqual([["HEADGEAR", 2], ["SHIRT", 1]]);
  });
});

describe("gearscript_inspect lookup and output", () => {
  it("finds a gearscript by bare name, {GUID}path or absolute path", async () => {
    for (const gearscript of ["GS_Alpha", `{${GUID}}Configs/Gearscripts/Test/GS_Alpha.conf`, join(root, "CRF", "Configs", "Gearscripts", "Test", "GS_Alpha.conf")]) {
      const r = await call({ gearscript, roles: ["MEDIC"] });
      expect(r.isError).toBeUndefined();
      expect(r.content[0].text).toContain(`{${GUID}}Configs/Gearscripts/Test/GS_Alpha.conf, faction "Testland"`);
    }
  });

  it("lists every match for an ambiguous name and the closest names for a missing one", async () => {
    const dup = await call({ gearscript: "GS_Dup.conf" });
    expect(dup.isError).toBe(true);
    expect(dup.content[0].text).toContain("matches 2 gearscripts");
    expect(dup.content[0].text).toContain("- Configs/Gearscripts/Other/GS_Dup.conf");
    const miss = await call({ gearscript: "GS_Alpah.conf" });
    expect(miss.isError).toBe(true);
    expect(miss.content[0].text.split("\n")[1]).toBe("- Configs/Gearscripts/Test/GS_Alpha.conf");
  });

  it("refuses a file that is not a COA_GearScriptConfig and an unknown role", async () => {
    expect((await call({ gearscript: "NotGs.conf" })).content[0].text).toContain("is not a COA_GearScriptConfig (its root is COA_Something)");
    const r = await call({ roles: ["NOPE"] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Unknown role NOPE\. COA_EGearRole names: UNARMED, .*PILOT, ZOMBIE$/);
  });

  it("picks the roles config named in the gear manager; the global one gets CRF's override merged", async () => {
    const cvon = await call({ cvon: true });
    expect(cvon.content[0].text).toContain("Roles config: CVON, {5555666677778888}Configs/Gearscripts/Extra/CVON_Roles.conf (from COALITION-Lobby)");
    expect(Object.keys(await loadouts({ cvon: true }))).toEqual(["RIFLEMAN", "SQUAD_LEAD"]);
    expect((await call({})).content[0].text).toContain("(from COALITION-Lobby + override in CRF; cvon: false)");
    expect(Object.keys(await loadouts())).toContain("ZOMBIE");
  });

  it("reports custom gear for roles not in the roles config", async () => {
    expect((await call({})).content[0].text).toContain("- Custom gear for roles not in the roles config: PILOT");
    // Null role config: infantry medical and default items are listed but not given
    const pilot = (await loadouts({ roles: ["PILOT"] })).PILOT;
    expect(given(pilot)).toEqual([]);
    expect(pilot.items.map((i) => [i.source, i.why])).toEqual([
      ["m_InfantryMedicalItems[0]", "role not in the roles config"],
      ["m_DefaultInventoryItems[0]", "role not in the roles config"],
    ]);
  });

  it("usedBy lists mission files with their side field and the Lobby default", async () => {
    const text = (await call({ usedBy: true, roles: ["MEDIC"] })).content[0].text;
    expect(text).toContain("- Used by: 3 mission file(s)");
    expect(text).toContain("  - CRF/Worlds/Testland/Mission_Layers/_INIT.layer: m_CIVILIANGearScriptSettings");
    expect(text).toContain("  - Other/Worlds/Stray.ent: (GUID found outside a gearscript settings field)");
    expect(text).toContain("- Lobby default (COA_Lobby.et): m_OPFORGearScriptSettings");
  });

  it("markdown shows random options, counts of 0 and skipped items", async () => {
    const text = (await call({ roles: ["ASSISTANT_AUTOMATIC_RIFLEMAN", "MEDIC"] })).content[0].text;
    expect(text).toContain("- RIFLE (m_Rifles[0], m_Rifles[1]): RifleA.et + 8 x MagA.et | RifleB.et + 6 x MagB.et");
    expect(text).toContain("- AR_MAG (m_AR.m_MagazineArray): 0 x Belt.et (adds nothing), 2 x Box.et");
    expect(text).toContain("- no SR radio (role m_aItems): GI radios off, leadership radios on, MEDIC slot (not a leadership slot)");
    expect(text).toContain("- no m_sAssistantBinocularsPrefab (m_sAssistantBinocularsPrefab): not set in the gearscript");
  });
});

describe("gearscript_inspect from a mission world and side", () => {
  const mission = (world: string, side: string, p: Record<string, unknown> = {}) => handler({ world, side, usedBy: false, format: "json", ...p });

  it("reads the CIV settings field and slotted roles, and the global roles config when m_bUseCVON is 0", async () => {
    const text = (await mission("Worlds/Testland/CivOff.ent", "CIV", { format: "markdown" })).content[0].text;
    expect(text).toContain("Mission Worlds/Testland/CivOff.ent, CIV: 3 slots, 2 roles; gearscript and radios from m_CIVILIANGearScriptSettings; CVON_VONGameModeComponent present, m_bUseCVON 0.");
    expect(text).toContain("(from COALITION-Lobby + override in CRF; cvon: false)");
    expect(text).toContain("Radios: leadership on, GI on, RTO on (from m_CIVILIANGearScriptSettings)");
    const j = JSON.parse((await mission("Worlds/Testland/CivOff.ent", "CIV")).content[0].text);
    expect(j.loadouts.map((l: Loadout) => l.role)).toEqual(["MEDIC", "SQUAD_LEAD"]);
  });

  it("falls back to the COA_Lobby.et settings, also from an old prefab path, and picks the CVON roles config from its component", async () => {
    const j = JSON.parse((await mission("Worlds/Testland/Cvon.ent", "OPFOR")).content[0].text);
    expect(j.gearscript).toBe(`{${GUID}}Configs/Gearscripts/Test/GS_Alpha.conf`);
    expect(j.mission).toMatchObject({ side: "OPFOR", settings: "m_OPFORGearScriptSettings", slots: 1, cvonFrom: "CVON_VONGameModeComponent present, m_bUseCVON 1 (default)" });
    expect([j.cvon, j.rolesConfig]).toEqual([true, "{5555666677778888}Configs/Gearscripts/Extra/CVON_Roles.conf"]);
    expect(j.radios).toEqual({ leadership: true, gi: false, rto: true });
    expect(j.loadouts.map((l: Loadout) => l.role)).toEqual(["RIFLEMAN"]);
    expect((await handler({ world: "Worlds/Testland/Cvon.ent", usedBy: false, format: "json" })).content[0].text).toBe("Pass world and side together.");
  });
});
