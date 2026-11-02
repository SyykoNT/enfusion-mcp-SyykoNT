import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodTypeAny } from "zod";
import type { Config } from "../../src/config.js";
import { findMissionHeader, registerServerParams, serverParams } from "../../src/tools/server-params.js";
import { myGamesDir } from "../../src/utils/game-paths.js";

const config = { serverPath: "C:\\Srv", gamePath: "C:\\Game" };
const paramsLine = (out: string) => out.match(/^- Params: (.*)$/m)?.[1];

describe("server_params", () => {
  it.skipIf(process.platform !== "win32")("matches the guide's Params builder for a standard Documents folder [p16]", () => {
    const out = serverParams({}, config, () => "C:\\Users\\you\\Documents\\My Games");
    expect(paramsLine(out)).toBe(
      '-addonsDir "C:\\Users\\you\\Documents\\My Games\\ArmaReforgerWorkbench\\Projects,C:\\Users\\you\\Documents\\My Games\\ArmaReforgerWorkbench\\addons" -addons "COALITIONFramework"'
    );
    expect(out).toContain("- Config: DedicatedServerPluginCLI_Server");
    expect(out).toContain("- No Throw: ticked");
    expect(out).toContain("- Executable: C:\\Srv\\ArmaReforgerServerDiag.exe (NOT FOUND)");
    expect(out).toContain("- Peer Executable: C:\\Game\\ArmaReforgerSteamDiag.exe (NOT FOUND)");
    expect(out).toContain("leave Rpl Auto Join ticked");
  });

  it("follows a OneDrive Documents folder through the shared myGamesDir (Windows shell folder)", () => {
    // myGamesDir's own tests cover the shell folder read (COAL-WS); here a OneDrive Documents folder with Workbench in it is used.
    const docs = join(mkdtempSync(join(tmpdir(), "emcp-sp-od-")), "OneDrive", "Documents");
    mkdirSync(join(docs, "My Games", "ArmaReforgerWorkbench"), { recursive: true });
    const out = serverParams({}, config, () => myGamesDir(docs));
    const wb = join(docs, "My Games", "ArmaReforgerWorkbench");
    expect(paramsLine(out)).toBe(`-addonsDir "${join(wb, "Projects")},${join(wb, "addons")}" -addons "COALITIONFramework"`);
    expect(out).toContain(`My Games: ${join(docs, "My Games")} (Windows Documents shell folder)`);
  });

  it.skipIf(process.platform !== "win32")("uses a given mods folder, as the builder's optional box does", () => {
    expect(paramsLine(serverParams({ modsFolder: "D:\\Mods" }, config, () => "C:\\Users\\you\\Documents\\My Games"))).toBe(
      '-addonsDir "C:\\Users\\you\\Documents\\My Games\\ArmaReforgerWorkbench\\Projects,D:\\Mods" -addons "COALITIONFramework"'
    );
  });

  it("finds the Mission Header .conf whose World is the given .ent, as a {GUID}path", () => {
    const addon = mkdtempSync(join(tmpdir(), "emcp-sp-"));
    writeFileSync(join(addon, "addon.gproj"), "GameProject {}");
    mkdirSync(join(addon, "Worlds", "Map"), { recursive: true });
    mkdirSync(join(addon, "Missions", "Map"), { recursive: true });
    const world = join(addon, "Worlds", "Map", "Me_TVT_Test.ent");
    writeFileSync(world, "");
    const header = (w: string) => `SCR_MissionHeader "{3D094352621EA88C}Missions/COA_BaseMissionConfig.conf" {\n World "{AA800BA35E7062AE}${w}"\n m_sName "X"\n}`;
    writeFileSync(join(addon, "Missions", "Map", "Other.conf"), header("Worlds/Map/Other.ent"));
    writeFileSync(join(addon, "Missions", "Map", "Me_1102_TVT1_Test.conf"), header("Worlds/Map/Me_TVT_Test.ent"));
    writeFileSync(join(addon, "Missions", "Map", "Me_1102_TVT1_Test.conf.meta"), 'MetaFileClass {\n Name "{1234567890ABCDEF}Missions/Map/Me_1102_TVT1_Test.conf"\n}');
    expect(findMissionHeader(world).header).toBe("{1234567890ABCDEF}Missions/Map/Me_1102_TVT1_Test.conf");
    expect(serverParams({ world }, config, () => "C:\\D\\My Games")).toContain("- Mission Header: {1234567890ABCDEF}Missions/Map/Me_1102_TVT1_Test.conf");
    const lone = join(addon, "Worlds", "Map", "NoHeader.ent");
    writeFileSync(lone, "");
    expect(serverParams({ world: lone }, config, () => "C:\\D\\My Games")).toContain("names this world: run Lobby plugin 6 first");
  });

  it("refuses folders that would break the Params line", () => {
    let schema: Record<string, ZodTypeAny> = {};
    registerServerParams({ registerTool: (_n: string, def: { inputSchema: typeof schema }) => (schema = def.inputSchema) } as unknown as McpServer, config as Config);
    // Absolute on the running system: a C:\ path is relative off Windows.
    const abs = (s: string) => resolve("/", s);
    expect(schema.modsFolder.safeParse(abs('Mods" -addons "Evil')).success).toBe(false);
    expect(schema.modsFolder.safeParse("Mods").success).toBe(false);
    // A comma would split the -addonsDir list into two folders (review GI-12 N2).
    expect(schema.modsFolder.safeParse(abs("My,Mods")).success).toBe(false);
    expect(schema.modsFolder.safeParse(abs("Mods")).success).toBe(true);
  });
});
