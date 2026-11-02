import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ZodTypeAny } from "zod";
import type { Config } from "../../src/config.js";
import { documentsDir, findMissionHeader, registerServerParams, serverParams } from "../../src/tools/server-params.js";

const config = { serverPath: "C:\\Srv", gamePath: "C:\\Game" };
const paramsLine = (out: string) => out.match(/^- Params: (.*)$/m)?.[1];

describe("server_params", () => {
  it.skipIf(process.platform !== "win32")("matches the guide's Params builder for a standard Documents folder [p16]", () => {
    const out = serverParams({}, config, () => "C:\\Users\\you\\Documents");
    expect(paramsLine(out)).toBe(
      '-addonsDir "C:\\Users\\you\\Documents\\My Games\\ArmaReforgerWorkbench\\Projects,C:\\Users\\you\\Documents\\My Games\\ArmaReforgerWorkbench\\addons" -addons "COALITIONFramework"'
    );
    expect(out).toContain("- Config: DedicatedServerPluginCLI_Server");
    expect(out).toContain("- No Throw: ticked");
    expect(out).toContain("- Executable: C:\\Srv\\ArmaReforgerServerDiag.exe (NOT FOUND)");
    expect(out).toContain("- Peer Executable: C:\\Game\\ArmaReforgerSteamDiag.exe (NOT FOUND)");
    expect(out).toContain("leave Rpl Auto Join ticked");
  });

  it("finds a OneDrive Documents folder from the Windows shell folder entry", () => {
    const prev = process.env.USERPROFILE;
    process.env.USERPROFILE = "C:\\Users\\you";
    const reg = "\r\nHKEY_CURRENT_USER\\Software\\...\\User Shell Folders\r\n    Personal    REG_EXPAND_SZ    %USERPROFILE%\\OneDrive\\Documents\r\n";
    expect(documentsDir(() => reg)).toBe("C:\\Users\\you\\OneDrive\\Documents");
    process.env.USERPROFILE = prev;
    expect(documentsDir(() => { throw new Error("no reg"); })).toMatch(/Documents$/);
  });

  it.skipIf(process.platform !== "win32")("uses a given mods folder, as the builder's optional box does", () => {
    expect(paramsLine(serverParams({ modsFolder: "D:\\Mods" }, config, () => "C:\\Users\\you\\Documents"))).toBe(
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
    expect(serverParams({ world }, config, () => "C:\\D")).toContain("- Mission Header: {1234567890ABCDEF}Missions/Map/Me_1102_TVT1_Test.conf");
    const lone = join(addon, "Worlds", "Map", "NoHeader.ent");
    writeFileSync(lone, "");
    expect(serverParams({ world: lone }, config, () => "C:\\D")).toContain("names this world: run Lobby plugin 6 first");
  });

  it("refuses folders that would break the Params line", () => {
    let schema: Record<string, ZodTypeAny> = {};
    registerServerParams({ registerTool: (_n: string, def: { inputSchema: typeof schema }) => (schema = def.inputSchema) } as unknown as McpServer, config as Config);
    expect(schema.modsFolder.safeParse('C:\\Mods" -addons "Evil').success).toBe(false);
    expect(schema.modsFolder.safeParse("Mods").success).toBe(false);
    expect(schema.modsFolder.safeParse("C:\\Mods").success).toBe(true);
  });
});
