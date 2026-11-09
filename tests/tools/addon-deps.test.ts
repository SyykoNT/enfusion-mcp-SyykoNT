import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { Config } from "../../src/config.js";
import { addonDepsReport, samePath, type Finding } from "../../src/tools/addon-deps.js";
import { buildTestPak, buildRdb } from "../pak/test-pak.js";

const V = "58D0FB3206B6F859";
const root = mkdtempSync(join(tmpdir(), "emcp-deps-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const put = (dir: string, files: Record<string, string>) => {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
};
const gproj = (id: string, guid: string, deps: string[]) => `GameProject {\n ID "${id}"\n GUID "${guid}"\n TITLE "${id}"\n Dependencies {\n  ${deps.map((d) => `"${d}"`).join(" ")}\n }\n}\n`;
/** A Workshop-style packed addon: gproj, scripts in data.pak, GUIDs in its rdb, optional Workshop files. */
const packed = (dir: string, gp: string, scripts: Record<string, string>, guids: Record<string, string>, extra: Record<string, string> = {}) => {
  put(dir, { "addon.gproj": gp, ...extra });
  writeFileSync(join(dir, "data.pak"), buildTestPak(Object.entries(scripts).map(([path, content]) => ({ path, content, compress: false }))));
  writeFileSync(join(dir, "resourceDatabase.rdb"), buildRdb(guids));
};
const sd = (name: string, version: string, gameVersion: string, deps: Array<[string, string]> = []) => ({
  "ServerData.json": `﻿{"name":"${name}","revision":{"version":"${version}"}}`,
  meta: `﻿{"meta":{"versions":[{"version":"${version}","gameVersion":"${gameVersion}","dependencies":[${deps.map(([id, n]) => `{"assetId":"${id}","assetName":"${n}"}`).join(",")}]}]}}`,
});

const game = join(root, "game"), ws = join(root, "workshop"), projects = join(root, "projects");
packed(join(game, "addons", "data"), gproj("ArmaReforger", V, []), { "scripts/Game/Base.c": "class BaseThing\n{\n\tvoid OnInit() {}\n}\n" }, { "Prefabs/V.et": "1000000000000001" });
// Mod B: used by refs; built for 1.7; its temp holds an addon.gproj entry
packed(join(ws, "ModB_BBBBBBBBBBBBBBBB"), gproj("ModB", "BBBBBBBBBBBBBBBB", [V]), {}, { "Prefabs/B.et": "2000000000000001", "Prefabs/Shared.et": "2000000000000002" }, sd("Mod B", "1.0", "1.7.0.54"));
mkdirSync(join(ws, "ModB_BBBBBBBBBBBBBBBB", "temp", "addon.gproj"), { recursive: true });
// Mod E: used only by script names; pulls Mod B, and names the missing Mod D
packed(join(ws, "ModE_EEEEEEEEEEEEEEEE"), gproj("ModE", "EEEEEEEEEEEEEEEE", [V, "BBBBBBBBBBBBBBBB"]),
  { "scripts/Game/E.c": "class E_Used\n{\n\toverride void OnInit() {}\n}\n" }, {}, sd("Mod E", "2.0", "1.8.0.13", [["dddddddddddddddd", "Mod D"]]));
// Mod F: no use found (its name is used only by an MCP handler); ships Shared.et too; temp holds a download stub
packed(join(ws, "ModF_FFFFFFFFFFFFFFFF"), gproj("ModF", "FFFFFFFFFFFFFFFF", [V]), { "scripts/Game/F.c": "class F_Only\n{\n}\n" }, { "Prefabs/Shared.et": "2000000000000002" }, sd("Mod F", "1.0", ""));
mkdirSync(join(ws, "ModF_FFFFFFFFFFFFFFFF", "temp", "data.pak"), { recursive: true });
// Mod O: used only because the target ships one of its GUIDs again (an override)
packed(join(ws, "ModO_0A0A0A0A0A0A0A0A"), gproj("ModO", "0A0A0A0A0A0A0A0A", [V]), { "scripts/Game/O.c": "class O_Unused\n{\n}\n" }, { "Prefabs/O.et": "5000000000000001" }, sd("Mod O", "1.0", ""));
// Mod U: installed but not a dependency; owns the boat
packed(join(ws, "ModU_9999999999999999"), gproj("ModU", "9999999999999999", [V]), {}, { "Prefabs/Boat.et": "3000000000000001" }, sd("Mod U", "1.0", ""));
// Mod C: a project shadowing its Workshop copy, in the project path only
packed(join(ws, "ModC_CCCCCCCCCCCCCCCC"), gproj("ModC", "CCCCCCCCCCCCCCCC", [V]), {}, {}, sd("Mod C", "1.0", ""));
put(join(projects, "ModC"), { "addon.gproj": gproj("ModC", "CCCCCCCCCCCCCCCC", [V]) });
put(join(projects, "Target"), {
  "addon.gproj": gproj("Target", "AAAAAAAAAAAAAAAA", [V, "BBBBBBBBBBBBBBBB", "EEEEEEEEEEEEEEEE", "FFFFFFFFFFFFFFFF", "CCCCCCCCCCCCCCCC", "0A0A0A0A0A0A0A0A", "DDDDDDDDDDDDDDDD", "AAAAAAAAAAAAAAAA"]),
  "Prefabs/T.et": 'X : "{1000000000000001}Prefabs/V.et" {\n A "{2000000000000001}Prefabs/B.et"\n B "{3000000000000001}Prefabs/Boat.et"\n C "{7777777777777777}Prefabs/Gone.et"\n D "{4000000000000001}Prefabs/T2.et"\n E "{0000000000000000}Prefabs/Unset.et"\n}\n',
  "Prefabs/T2.et": "X {\n}\n",
  "Prefabs/O.et.meta": 'MetaFileClass {\n Name "{5000000000000001}Prefabs/O.et"\n}\n',
  "Prefabs/T2.et.meta": 'MetaFileClass {\n Name "{4000000000000001}Prefabs/T2.et"\n}\n',
  "Scripts/Game/T.c": "class T : E_Used\n{\n\toverride void OnInit() {}\n}\n",
  "Scripts/Game/!Docs/Doc.c": 'string s = "{8888888888888888}Prefabs/DocOnly.et";\n',
  "Scripts/WorkbenchGame/EnfusionMCP/EMCP_X.c": "class EMCP_X\n{\n\tvoid F() { F_Only f; }\n}\n",
});
put(root, { "logs/logs_2026-10-31_10-00-00/console.log": "Engine version 1.8.0.13 (Tools)\n", "elsewhere/.keep": "" });

const config = { gamePath: game, projectPath: projects, workshopPath: ws, addonsDir: join(root, "elsewhere") } as Config;
const ids = (fs: Finding[], id: string) => fs.filter((f) => f.id === id);
const snapshot = (dir: string): string[] => readdirSync(dir, { recursive: true }).map((f) => `${f}|${statSync(join(dir, String(f))).mtimeMs}`).sort();

describe("addonDepsReport", () => {
  const before = snapshot(root);
  const r = addonDepsReport(config, { addonName: "Target" });
  const json = r.json as { findings: Finding[]; dependencies: Array<{ guid: string; refs: number; scriptNames: string[] | null; notes: string[] }>; refs: Record<string, number>; loadOrder: Array<{ name: string }> };
  const f = json.findings;
  const row = (g: string) => json.dependencies.find((d) => d.guid === g)!;

  it("raises every finding from D1 to D11 on the fixture stack", () => {
    expect(r.isError).toBe(false);
    expect([...new Set(f.map((x) => x.id))].sort()).toEqual(["D1", "D10", "D11", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9"]);
    expect(ids(f, "D1")[0].text).toMatch(/\{DDDDDDDDDDDDDDDD\} \(Mod D\) is not installed/);
    expect(ids(f, "D2")).toEqual([expect.objectContaining({ level: "blocker", text: expect.stringMatching(/Mod U \{9999999999999999\}.*1 refs.*Prefabs\/Boat\.et in Prefabs\/T\.et/) })]);
    expect(ids(f, "D3").map((x) => [x.level, x.text])).toEqual([
      ["warning", expect.stringContaining("{7777777777777777}Prefabs/Gone.et in Prefabs/T.et")],
      ["info", "1 dangling refs in !Docs folders (not counted above)"],
    ]);
    expect(ids(f, "D6")[0].text).toBe("Dependency cycle: Target -> Target");
    expect(ids(f, "D7").map((x) => [x.level, x.text.slice(0, 5)])).toEqual([["warning", "Mod B"], ["info", "Mod F"]]);
    expect(ids(f, "D8").map((x) => x.level)).toEqual(["warning", "info"]);
    expect(ids(f, "D8")[0].text).toContain("Mod B {BBBBBBBBBBBBBBBB} 1.0 was built for game 1.7.0.54; Workbench here is 1.8.0.13");
    expect(ids(f, "D9")[0].text).toMatch(/^1 resource GUID shipped by Mod B < Mod F/);
    expect(ids(f, "D10")[0].text).toContain(join(ws, "ModC_CCCCCCCCCCCCCCCC"));
    expect(ids(f, "D11")[0].text).toMatch(/^ModC \{CCCCCCCCCCCCCCCC\} is only in/);
    expect(f.findIndex((x) => x.level !== "blocker")).toBe(f.filter((x) => x.level === "blocker").length);
  });

  it("counts refs per dependency and checks script use only where refs found none", () => {
    expect(json.refs).toMatchObject({ guids: 6, total: 6, own: 1, closure: 2, undeclared: 1, dangling: 2 });
    expect([row(V).refs, row("BBBBBBBBBBBBBBBB").refs]).toEqual([1, 1]);
    expect(row("BBBBBBBBBBBBBBBB").scriptNames).toBeNull();
    expect(row("BBBBBBBBBBBBBBBB").notes).toEqual(expect.arrayContaining(["D5", "D7", "D8"]));
    // OnInit is a base game name; F_Only appears only in the MCP's handler
    expect(row("EEEEEEEEEEEEEEEE")).toMatchObject({ refs: 0, scriptNames: ["E_Used"], notes: [] });
    expect(row("FFFFFFFFFFFFFFFF")).toMatchObject({ scriptNames: [], notes: expect.arrayContaining(["D4"]) });
    expect(row("0A0A0A0A0A0A0A0A")).toMatchObject({ refs: 0, overrides: 1, scriptNames: null, notes: [] });
    expect(row("AAAAAAAAAAAAAAAA")).toMatchObject({ source: "itself", notes: ["D6"] });
    expect(json.loadOrder.map((a) => a.name)).toEqual(["ArmaReforger", "Mod B", "Mod E", "Mod F", "ModC", "Mod O", "Target"]);
    expect(r.text).toMatch(/^addon_deps Target \{AAAAAAAAAAAAAAAA\}/);
    expect(r.text).toContain("Load order (dependencies first");
  });

  it("limits refs to files, prints JSON on request and writes nothing", () => {
    const sub = addonDepsReport(config, { addonName: "Target", files: ["Prefabs/T2.et"], scripts: false, format: "json" });
    const j = JSON.parse(sub.text);
    expect(j.refs.total).toBe(0);
    expect(j.findings.map((x: Finding) => x.id)).not.toContain("D2");
    // D4 describes the whole addon, not one mission
    expect(j.findings.map((x: Finding) => x.id)).not.toContain("D4");
    expect(addonDepsReport(config, { addonName: "Target", files: ["Prefabs/T2.et"] }).text).toContain("files set: script use and D4 skipped");
    expect(snapshot(root)).toEqual(before);
  });

  it("samePath (D11) compares real paths: a junction to the folder is the same folder (B-042)", () => {
    const holder = mkdtempSync(join(tmpdir(), "emcp-deps-link-"));
    try {
      const link = join(holder, "ProjectsLink");
      symlinkSync(projects, link, "junction"); // on POSIX the type is ignored and this is a symlink
      expect(samePath(link, projects)).toBe(true);
      expect(samePath(link, ws)).toBe(false);
      expect(samePath("bad\0path", "bad\0path")).toBe(true); // a path realpath cannot read falls back to the typed spelling
      expect(samePath("bad\0path", "other\0path")).toBe(false);
      expect(samePath(join(root, "no", "such"), join(root, "NO", "such"))).toBe(process.platform === "win32"); // a missing path still compares, case-blind on Windows only
    } finally {
      rmSync(holder, { recursive: true, force: true });
    }
  });

  it("names the missing addon and a missing Workshop cache", () => {
    expect(addonDepsReport(config, { addonName: "Nope" })).toMatchObject({ isError: true, text: `Addon not found. Pass addonName (a folder under ${projects}) or gprojPath.` });
    expect(addonDepsReport({ ...config, workshopPath: join(root, "none") }, { addonName: "Target" }).text).toBe(`Workshop cache not found at ${join(root, "none")}; set ENFUSION_WORKSHOP_PATH`);
  });
});
