import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { missionPrDraft, registerMissionPrDraft } from "../../src/tools/mission-pr-draft.js";
import { makeProjects, write } from "../coalition/fixture.js";

const hasGit = spawnSync("git", ["--version"]).status === 0;
const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "ignore" });
const MM = "PrefabsMissionMaking";

const INIT = `COA_Gamemode COA_Lobby : "{1000000000000002}Prefabs/Lobby/COA_Lobby.et" {
 components {
  CRF_RushGamemodeManager "{2000000000000005}" {
  }
  CRF_TaskCreatorComponent "{2000000000000001}" {
   m_aTaskEntries {
    CRF_TaskCreatorEntry "{2000000000000002}" {
     m_sTaskLabel "Sink the sampan"
     m_eTaskType PLANT_DEFUSE_BOMB
     m_eAssignedSide BLUFOR
    }
   }
  }
 }
 m_BLUFORSlots {
  COA_SlottingGroup "{3000000000000001}" {
   m_aSlots {
    SQUAD_LEAD
   }
  }
 }
 m_OPFORSlots {
  COA_SlottingGroup "{3000000000000002}" {
   m_aSlots {
    RIFLEMAN
   }
  }
 }
 m_BLUFORGearScriptSettings COA_GearScriptContainer "{6000000000000001}" {
  m_rGearScript "{6000000000000002}Configs/Gearscripts/Custom/Me/COA_GS_SeaTigers.conf"
 }
 m_OPFORGearScriptSettings COA_GearScriptContainer "{6000000000000003}" {
  m_rGearScript "{6000000000000004}Configs/Gearscripts/Standard/COA_GS_NoName.conf"
 }
}
`;
const SPAWNPOINTS = `GenericEntity BLU_MSP : "{4000000000000011}${MM}/Vehicles/BLUFOR_MSP.et" {
}
GenericEntity : "{4000000000000012}${MM}/VehicleSpawner/BLUFOR_VehicleSpawner.et" {
}
GenericEntity Boat1 : "{5000000000000001}Prefabs/Vehicles/Naval/Sampan.et" {
}
`;

describe.skipIf(!hasGit)("mission_pr_draft", { timeout: 30_000 }, () => {
  let fx: ReturnType<typeof makeProjects>;
  beforeAll(() => {
    fx = makeProjects();
    const profile = mkdtempSync(join(tmpdir(), "pr-draft-profile-"));
    write(profile, "logs/logs_2026-11-02_10-00-00/error.log", "10:00:02.000 SCRIPT    (E): Faction '12' is not a valid SCR_Faction\n");
    process.env.ENFUSION_WORKBENCH_PROFILE = profile;
    write(fx.crf, "addon.gproj", 'GameProject {\n Dependencies {\n  "58D0FB3206B6F859"\n }\n}\n');
    const origin = join(fx.root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", origin]);
    git(fx.crf, "init", "-q", "-b", "release");
    git(fx.crf, "add", ".");
    git(fx.crf, "commit", "-q", "-m", "release");
    git(fx.crf, "remote", "add", "origin", origin);
    git(fx.crf, "push", "-q", "origin", "release");
    git(fx.crf, "fetch", "-q", "origin");
    git(fx.crf, "checkout", "-q", "-b", "mission/draft");
    write(fx.crf, "Worlds/Test/Draft.ent", "SubScene {\n}\n");
    write(fx.crf, "Worlds/Test/Draft_Layers/_INIT.layer", INIT);
    write(fx.crf, "Worlds/Test/Draft_Layers/SPAWNPOINTS.layer", SPAWNPOINTS);
    write(fx.crf, "Missions/Test/Draft.conf", 'SCR_MissionHeader {\n World "{8000000000000009}Worlds/Test/Draft.ent"\n}\n');
    write(fx.crf, "Configs/Gearscripts/Custom/Me/COA_GS_SeaTigers.conf", 'COA_GearScriptConfig {\n m_FactionName "Sea Tigers"\n}\n');
    write(fx.crf, "addon.gproj", 'GameProject {\n Dependencies {\n  "58D0FB3206B6F859"\n  "AAAA000000000001"\n }\n}\n');
  }, 30_000);
  afterAll(() => delete process.env.ENFUSION_WORKBENCH_PROFILE);

  it("drafts faction lines in the template's SIDE - faction - role format, with assets per side", async () => {
    const { text } = await missionPrDraft(fx.config, { roles: { BLUFOR: "Attacking" } });
    const lines = text.split("\n").filter((l) => /^(BLUFOR|OPFOR|INDFOR|CIV) - /.test(l));
    expect(lines).toEqual(["BLUFOR - Sea Tigers - Attacking", "OPFOR - COA_GS_NoName - Attacking/Defending/NA", "INDFOR - (fill in faction) - Attacking/Defending/NA"]);
    for (const l of lines) expect(l).toMatch(/^(BLUFOR|OPFOR|INDFOR|CIV) - .+ - (Attacking|Defending|NA|Attacking\/Defending\/NA)$/);
    expect(text).toContain("BLUFOR Assets: 1 MSP (BLU_MSP), 1 vehicle spawner");
    expect(text).toContain("OPFOR Assets: (none in the files)");
  });

  it("fills objectives, the testing note and added mods, and lists what it could not fill", async () => {
    const { text, unfilled } = await missionPrDraft(fx.config);
    expect(text).toContain("- Game mode: CRF_RushGamemodeManager\n- Sink the sampan: PLANT_DEFUSE_BOMB for BLUFOR");
    expect(text).toContain("Newest Workbench session logs_2026-11-02_10-00-00: 1 script error and 0 VM exceptions in 1 group (script_errors has the details). <enter text here>");
    expect(text).toContain("- AAAA000000000001: https://reforger.armaplatform.com/workshop/AAAA000000000001 (purpose: fill in)");
    expect(text).toContain("<!-- Draft from Worlds/Test/Draft.ent by mission_pr_draft.");
    expect(text).not.toContain("**Automated Checks:**");
    expect(text).not.toContain("**Mission Synopsis:**");
    expect(unfilled).toEqual(expect.arrayContaining([
      "BLUFOR: Attacking, Defending or NA (your call)",
      "INDFOR faction: no gearscript set in m_INDFORGearScriptSettings",
      "Placed vehicles have no side in the files; add them to the right Assets line: Boat1",
      "CIV: no slots, line left out",
      "Links to Added Mods: the purpose of each mod",
    ]));
  });

  it("picks the one changed world, and asks for world when the branch changes none or several", async () => {
    let h: (a: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }> = async () => ({ content: [] });
    registerMissionPrDraft({ registerTool: (_n: string, _d: unknown, f: typeof h) => { h = f; } } as unknown as McpServer, fx.config);
    const ok = await h({});
    expect(ok.isError).toBeFalsy();
    expect(ok.content[0].text).toContain("Not filled from the files:");
    write(fx.crf, "Worlds/Test/Second.ent", "SubScene {\n}\n");
    const two = await h({});
    expect(two).toMatchObject({ isError: true });
    expect(two.content[0].text).toMatch(/^Several worlds changed \(.*Worlds\/Test\/Draft\.ent.*Worlds\/Test\/Second\.ent.*\): pass world\.$/);
    // With world given, a refused base only costs the mods section
    const refused = await h({ world: "Worlds/Test/Draft.ent", base: "-x" });
    expect(refused.isError).toBeFalsy();
    expect(refused.content[0].text).toContain("- Links to Added Mods: -x is not a commit in");
  });
});
