import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { alnum, branchSlug, buildNames, checkNames, dateNote, missionNames, registerMissionNames, stripDisplayPrefix, utcMmdd, type Header } from "../../src/tools/mission-names.js";
import { CRF_PATH_HELP, LOBBY_PATH_HELP } from "../../src/utils/coalition-paths.js";
import { makeProjects, write } from "../coalition/fixture.js";

// 01:30 UTC on 2 November is still 1 November in the Americas
const NOW = new Date(Date.UTC(2026, 10, 2, 1, 30));
const MODES = ["TVT", "COOP", "COTVT", "SPECIAL", "CACHEHUNT"];

describe("plugin 6 name format", () => {
  it("reproduces the guide's BoatPatrol example and its Tanaka placeholders", () => {
    expect(buildNames({ author: "SyykoNT", mode: "COTVT", name: "BoatPatrol", terrain: "VinDrinDop", slots: 45 }, NOW)).toEqual({
      branch: "mission/boatpatrol",
      world: "Worlds/VinDrinDop/SyykoNT_COTVT_BoatPatrol.ent",
      conf: "Missions/VinDrinDop/SyykoNT_1102_COTVT45_BoatPatrol.conf",
      inGame: "COA COTVT45 BoatPatrol",
      prTitle: "New Mission | SyykoNT COTVT45 BoatPatrol",
    });
    const t = buildNames({ author: "Tana ka", mode: "TVT", name: "The Patrol!", terrain: "Arland" }, NOW);
    expect([t.branch, t.world, t.conf, t.inGame, t.prTitle]).toEqual([
      "mission/the-patrol", "Worlds/Arland/Tanaka_TVT_ThePatrol.ent", "Missions/Arland/Tanaka_1102_TVTNN_ThePatrol.conf",
      "COA TVTNN The Patrol!", "New Mission | Tanaka TVTNN The Patrol!",
    ]);
  });

  it("filters to ASCII letters and digits, pads MMDD in UTC and strips the display prefix", () => {
    expect(alnum("Ünit_7 Zulu-1")).toBe("nit7Zulu1");
    expect(utcMmdd(new Date(Date.UTC(2026, 0, 5, 23, 59)))).toBe("0105");
    expect(branchSlug("  Boat  Patrol  ")).toBe("boat-patrol");
    expect(stripDisplayPrefix("COA TVT32 The Patrol")).toBe("The Patrol");
    expect(stripDisplayPrefix("Plain")).toBe("Plain");
    const note = dateNote(NOW);
    expect(note === undefined ? NOW.getDate() === NOW.getUTCDate() : note.text.includes("write 1102 now")).toBe(true);
  });
});

describe("checkNames", () => {
  const header = (h: Partial<Header> = {}): Header => ({ conf: "Missions/Arland/Tanaka_1101_TVT12_ThePatrol.conf", name: "COA TVT12 The Patrol", author: "Tanaka", mode: "TVT", terrain: "Arland", ...h });
  const world = (confs: Header[], slots = 12, worldRel = "Worlds/Arland/Tanaka_TVT_ThePatrol.ent") => ({ worldRel, slots, confs });

  it("passes a mission that follows every rule", () => {
    expect(checkNames(world([header()]), "mission/the-patrol", MODES, NOW).notes).toEqual([]);
  });

  it("flags each part of the .conf name and header that disagrees", () => {
    const texts = checkNames(world([header({ conf: "Missions/Arland/Tana_1399_COOP10_Patrol.conf", name: "COA COOP10 The Patrol", terrain: "Everon" })]), "main", MODES, NOW).notes.map((n) => `${n.level} ${n.text}`);
    expect(texts).toEqual(expect.arrayContaining([
      expect.stringMatching(/^warning CRF is on branch main: CI runs the Mission QA job only on branches starting with mission\//),
      expect.stringMatching(/^warning .*author part Tana differs from m_sAuthor "Tanaka"/),
      expect.stringMatching(/^warning .*date part 1399 is not a valid MMDD/),
      expect.stringMatching(/^warning .*mode part COOP differs from m_sGameMode TVT/),
      expect.stringMatching(/^info .*names 10 slots; the world now has 12/),
      expect.stringMatching(/^warning .*name part Patrol differs from the mission name in m_sName \("The Patrol", expected ThePatrol\)/),
      expect.stringMatching(/^warning .*m_sTerrainName "Everon" differs from the world's terrain folder Arland/),
      expect.stringMatching(/^warning .*m_sName mode COOP differs from m_sGameMode TVT/),
    ]));
  });

  it("notes a slot count that changed since plugin 6, two .conf files, no .conf and off-convention world names", () => {
    const later = checkNames(world([header()], 14), "mission/the-patrol", MODES, NOW);
    expect(later.notes.map((n) => n.level)).toEqual(["info", "info"]);
    expect(later.expected?.prTitle).toBe("New Mission | Tanaka TVT14 The Patrol");
    expect(checkNames(world([header(), header({ conf: "Missions/Arland/Tanaka_1102_TVT12_ThePatrol.conf" })]), "mission/x", MODES, NOW).notes[0].text).toMatch(/^2 \.conf files point at this world/);
    expect(checkNames(world([], 12, "Worlds/Arland/Patrol.ent"), null, MODES, NOW).notes.map((n) => n.text)).toEqual([
      expect.stringMatching(/^CRF branch unknown/),
      expect.stringMatching(/^World file Patrol\.ent does not follow the guide's Author_MODE_Name\.ent/),
      expect.stringMatching(/^No mission \.conf under Missions\/Arland\/ points at this world: run plugin 6/),
    ]);
    expect(checkNames(world([header()], 12, "Worlds/Arland/Tanaka_COOP_ThePatrol.ent"), "mission/the-patrol", MODES, NOW).notes[0].text).toContain("(Worlds/Arland/Tanaka_TVT_ThePatrol.ent)");
    expect(checkNames(world([header({ mode: "BOGUS", name: "COA BOGUS12 The Patrol", conf: "Missions/Arland/Tanaka_1101_BOGUS12_ThePatrol.conf" })]), "mission/the-patrol", MODES, NOW).notes.map((n) => n.text)).toContain(
      "Missions/Arland/Tanaka_1101_BOGUS12_ThePatrol.conf: m_sGameMode BOGUS is not a COA_EGamemode member."
    );
  });
});

describe("missionNames on a CRF and Lobby fixture", () => {
  let fx: ReturnType<typeof makeProjects>;
  beforeAll(() => {
    fx = makeProjects();
    write(fx.root, "COALITION-Lobby/Scripts/Game/COA_Gamemode_Enums.c", "enum COA_EGamemode\n{\n\tTVT,\n\tCOOP,\n\tCOTVT,\n\tSPECIAL,\n}\n");
    write(fx.root, "CRF/Scripts/Game/CRF_COA_Gamemode_Enums.c", "modded enum COA_EGamemode\n{\n\tCACHEHUNT,\n\tRAID\n}\n");
    write(fx.root, "CRF/Missions/Test/Author_1031_TVT4_Fixture.conf",
      `SCR_MissionHeader {\n World "{8000000000000001}Worlds/Test/Author_TVT_Fixture.ent"\n m_sName "COA TVT4 Fixture"\n m_sAuthor "Author"\n m_sGameMode "TVT"\n m_sTerrainName "Test"\n}\n`);
  });
  afterAll(() => rmSync(fx.root, { recursive: true, force: true }));

  it("build checks the mode against Lobby and CRF's COA_EGamemode and refuses bad input", () => {
    expect(missionNames(fx.config, { action: "build", author: "Tanaka", mode: "raid", name: "Dawn", terrain: "Arland", slots: 20 }, NOW)).toContain("MISSION CONFIG      Missions/Arland/Tanaka_1102_RAID20_Dawn.conf");
    expect(() => missionNames(fx.config, { action: "build", author: "T", mode: "KOTH", name: "D", terrain: "Arland" }, NOW)).toThrow(/Unknown game mode "KOTH".*TVT, COOP, COTVT, SPECIAL, CACHEHUNT, RAID/);
    expect(() => missionNames(fx.config, { action: "build", author: "T", mode: "TVT", name: "D", terrain: "../x" }, NOW)).toThrow(/terrain must be one folder name/);
    expect(() => missionNames(fx.config, { action: "build", author: "!!", mode: "TVT", name: "D", terrain: "A" }, NOW)).toThrow(/author "!!" has no letters or digits/);
    expect(() => missionNames(fx.config, { action: "build", mode: "TVT" }, NOW)).toThrow("build needs author, name, terrain.");
  });

  it("check counts the world's slots, reads its .conf and refuses worlds outside the project path", () => {
    const text = missionNames(fx.config, { action: "check", world: "Worlds/Test/Author_TVT_Fixture.ent" }, NOW);
    expect(text).toMatch(/^mission_names check Worlds\/Test\/Author_TVT_Fixture\.ent {2}\(6 slots, branch unknown\)/);
    expect(text).toContain('conf Missions/Test/Author_1031_TVT4_Fixture.conf: m_sName "COA TVT4 Fixture"');
    expect(text).toContain("INFO Missions/Test/Author_1031_TVT4_Fixture.conf: names 4 slots; the world now has 6.");
    expect(text).toContain("PULL REQUEST TITLE  New Mission | Author TVT6 Fixture");
    expect(() => missionNames(fx.config, { action: "check", world: join(fx.root, "..", "elsewhere.ent") }, NOW)).toThrow(/inside the project path/);
  });

  it("names the CRF and Lobby copies it read in build and check replies", () => {
    const copies = [`CRF: clone unknown (${fx.crf})`, `Lobby: clone unknown (${fx.lobby})`];
    const build = missionNames(fx.config, { action: "build", author: "T", mode: "TVT", name: "D", terrain: "Arland" }, NOW);
    const check = missionNames(fx.config, { action: "check", world: "Worlds/Test/Author_TVT_Fixture.ent" }, NOW);
    for (const text of [build, check]) expect(text.split("\n").slice(1, 3)).toEqual(copies);
  });

  it("describes crfPath and lobbyPath with the shared Coalition help", () => {
    let schema: Record<string, { description?: string }> = {};
    registerMissionNames({ registerTool: (_n: string, d: { inputSchema: typeof schema }) => void (schema = d.inputSchema) } as unknown as McpServer, fx.config);
    expect([schema.crfPath.description, schema.lobbyPath.description]).toEqual([CRF_PATH_HELP, LOBBY_PATH_HELP]);
  });
});
