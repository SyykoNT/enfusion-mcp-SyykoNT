import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";
import { checkPackOutput, handlerFiles, pakSummary } from "../../src/workbench/cli.js";
import { argValue } from "../../src/utils/process.js";
import { buildTestPak } from "../pak/test-pak.js";

const root = mkdtempSync(join(tmpdir(), "emcp-po-"));
const projects = join(root, "projects");
const addon = join(projects, "MyAddon");
mkdirSync(addon, { recursive: true });
const config = { projectPath: projects, addonsDir: join(root, "extra"), gamePath: join(root, "game"), workbenchPath: join(root, "tools") } as Config;
const GUID = "1111111111111111";
const check = (out: string, clean = false) => checkPackOutput(config, addon, GUID, out, clean);

describe("checkPackOutput", () => {
  it("allows a new folder outside the addons dirs", () => {
    expect(check(join(root, "packed", "MyAddon"))).toBeNull();
  });

  it("refuses an install folder, the addon itself and the addons dirs", () => {
    expect(check(join(root, "game", "x"))).toMatch(/Workshop cache \/ install/);
    expect(check(addon)).toMatch(/inside the addon itself/);
    expect(check(join(addon, "out"))).toMatch(/inside the addon itself/);
    expect(check(join(projects, "MyAddon_packed"))).toMatch(new RegExp(`addons dir .*GUID ${GUID}`));
    expect(check(join(root, "extra", "x"))).toMatch(/addons dir/);
  });

  it("refuses another addon's pack, allows its own", () => {
    const out = join(root, "packs", "a");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "addon.gproj"), `GameProject {\n ID "Other"\n GUID "2222222222222222"\n}\n`);
    expect(check(out)).toMatch(/another addon \(Other 2222222222222222\)/);
    writeFileSync(join(out, "addon.gproj"), `GameProject {\n ID "MyAddon"\n GUID "${GUID}"\n}\n`);
    writeFileSync(join(out, "data.pak"), "");
    writeFileSync(join(out, "resourceDatabase.rdb"), "");
    expect(check(out)).toBeNull();
  });

  it("refuses stray files unless cleanOutput, and deletes nothing", () => {
    const out = join(root, "packs", "b");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "notes.txt"), "x");
    expect(check(out)).toMatch(/other files: notes\.txt/);
    expect(check(out, true)).toBeNull();
    expect(existsSync(join(out, "notes.txt"))).toBe(true);
  });
});

describe("handlerFiles", () => {
  it("lists handler scripts and the folder meta", () => {
    const a = join(root, "h");
    mkdirSync(join(a, "Scripts", "WorkbenchGame", "EnfusionMCP"), { recursive: true });
    writeFileSync(join(a, "Scripts", "WorkbenchGame", "EnfusionMCP", "EMCP_WB_Ping.c"), "");
    writeFileSync(join(a, "Scripts", "WorkbenchGame", "EnfusionMCP.meta"), "");
    expect(handlerFiles(a).sort()).toEqual(["Scripts/WorkbenchGame/EnfusionMCP.meta", "Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Ping.c"]);
    expect(handlerFiles(addon)).toEqual([]);
  });
});

describe("-gproj from a command line (argValue)", () => {
  const gproj = (cmd: string) => argValue(cmd, "-gproj") ?? "";
  it("reads quoted and bare -gproj values", () => {
    const exe = `"C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arma Reforger Tools\\Workbench\\ArmaReforgerWorkbenchSteamDiag.exe"`;
    expect(gproj(`${exe} -gproj "C:\\Arma Reforger Modding\\test-addons\\My Addon\\addon.gproj" -addonsDir "C:\\x"`))
      .toBe("C:\\Arma Reforger Modding\\test-addons\\My Addon\\addon.gproj");
    expect(gproj(`${exe} -GPROJ C:\\a\\addon.gproj -wbSilent`)).toBe("C:\\a\\addon.gproj");
    expect(gproj(`${exe} -wbModule=ResourceManager`)).toBe("");
  });
});

describe("pakSummary", () => {
  it("counts entries per top folder, sizes and handler entries", () => {
    const pak = join(root, "data.pak");
    writeFileSync(pak, buildTestPak([
      { path: "Scripts/Game/A.c", content: "12345", compress: true },
      { path: "Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Ping.c", content: "1", compress: false },
      { path: "Configs/X.conf", content: "123", compress: false },
      { path: "addon.gproj", content: "12", compress: false },
    ]));
    expect(pakSummary(pak)).toEqual({
      entries: 4,
      bytes: 11,
      byTopFolder: { Scripts: 2, Configs: 1, "(root)": 1 },
      largest: [["Scripts/Game/A.c", 5], ["Configs/X.conf", 3], ["addon.gproj", 2], ["Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Ping.c", 1]],
      handlerEntries: 1,
    });
  });
});
