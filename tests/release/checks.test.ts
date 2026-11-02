import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RdbEntry } from "../../src/pak/rdb.js";
import type { Layer } from "../../src/pak/stack.js";
import { walkAddon } from "../../src/release/scan.js";
import {
  checkGprojFindings, checkHandlers, checkLeftovers, checkMeta, checkOverrides, checkPreview, checkSize, checkText, type Finding, type GuidOwners,
} from "../../src/release/checks.js";

const root = mkdtempSync(join(tmpdir(), "emcp-checks-"));
const addon = (name: string, files: Record<string, string | Buffer>) => {
  const dir = join(root, name);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
};
const gproj = (title: string, configs: string[], extra = "") =>
  `GameProject {\n ID "T"\n GUID "1234567890ABCDEF"\n TITLE "${title}"\n Dependencies {\n  "58D0FB3206B6F859"\n }\n Configurations {\n${configs.map((c) => `  GameProjectConfig ${c} {\n  }\n`).join("")} }\n${extra}}\n`;
const meta = (guid: string, path: string) => `MetaFileClass {\n Name "{${guid}}${path}"\n}\n`;
const png = (w: number, h: number) => {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
const ALL = ["PC", "XBOX_ONE", "XBOX_SERIES", "PS4", "PS5", "HEADLESS"];

const bad = addon("Bad", {
  "addon.gproj": gproj("Bad (Addon)", ["PC"]),
  "extra.gproj": gproj("Extra", ALL),
  "Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Ping.c": "class A {}\n",
  "Scripts/WorkbenchGame/EnfusionMCP/SYK_Probe.c": "class B {}\n",
  "Prefabs/A.et": "GenericEntity {\n}\n",
  "Prefabs/A.et.meta": meta("AAAA000000000001", "Prefabs/Old/A.et"),
  "Prefabs/B.et": "GenericEntity {\n}\n",
  "Prefabs/B.et.meta": meta("AAAA000000000002", "prefabs/b.et"),
  "Prefabs/Dup.et": "GenericEntity {\n}\n",
  "Prefabs/Dup.et.meta": meta("AAAA000000000002", "Prefabs/Dup.et"),
  "Prefabs/Clash.et": "GenericEntity {\n}\n",
  "Prefabs/Clash.et.meta": meta("BBBB000000000001", "Prefabs/Clash.et"),
  "Prefabs/Override.et": "GenericEntity {\n}\n",
  "Prefabs/Override.et.meta": meta("BBBB000000000002", "Prefabs/Override.et"),
  "Prefabs/NoMeta.et": "GenericEntity {\n}\n",
  "Textures/Orphan.edds.meta": meta("CCCC000000000001", "Textures/Orphan.edds"),
  "Textures/Odd.weird.meta": meta("CCCC000000000002", "Textures/Odd.weird"),
  "Textures/Odd.psd": "psd",
  "UI/Img.edds": "compiled",
  "UI/Img.edds.meta": meta("EEEE000000000001", "UI/Img.edds"),
  "Missions/M.conf": 'SCR_MissionHeader {\n m_sIcon "{EEEE000000000001}UI/Img.edds"\n}\n',
  "Missions/M.conf.meta": meta("EEEE000000000002", "Missions/M.conf"),
  "Configs/Gear.conf": 'COA_GearScriptConfig {\n m_FactionIcon "{EEEE000000000001}UI/Img.edds"\n}\n',
  "Configs/Gear.conf.meta": meta("EEEE000000000003", "Configs/Gear.conf"),
  "Models/M.fbx": "fbx",
  "Models/M.xob.meta": `MetaFileClass {\n Name "{DDDD000000000001}Models/M.xob"\n MaterialAssigns {\n  MaterialAssignClass "{5B1D0000000000A0}" {\n   SourceMaterial "Mat1"\n   AssignedMaterial "{DDDD000000000002}Models/Data/Mat1.emat"\n  }\n }\n}\n`,
  "temp/x.txt": "x",
  "a.bak": "x",
  "__pycache__/y.pyc": "x",
  "VehParts$n.txt": "x",
  "Scripts/Game/Bom.c": "\uFEFFclass C {}\n",
  "Scripts/Game/Dev/Tool.c": "class D {}\n",
  "Scripts/Game/Diag.c": "#ifdef WORKBENCH\nclass E {}\n#endif\n",
  "README.md": "Made with Claude \u2014 by Don\n",
});

const good = addon("Good", {
  "addon.gproj": gproj("Good Addon", ALL),
  "Prefabs/A.et": "GenericEntity {\n}\n",
  "Prefabs/A.et.meta": meta("FFFF000000000001", "Prefabs/A.et"),
  "Textures/T.edds.meta": meta("FFFF000000000002", "Textures/T.edds"),
  "Textures/T.png": "png",
  "Scripts/Game/Clean.c": "class F {}\n",
  "license.txt": "Custom licence\n",
  "thumbnail.png": png(1920, 1080),
});

const rdbOf = (entries: [string, string][]) => new Map<string, RdbEntry>(entries.map(([path, guid]) => [path.toLowerCase(), { guid, path }]));
const badRdb = rdbOf([["Prefabs/A.et", "AAAA000000000001"], ["Prefabs/B.et", "9999999999999999"]]);
const goodRdb = rdbOf([["Prefabs/A.et", "FFFF000000000001"], ["Textures/T.edds", "FFFF000000000002"]]);
const owners: GuidOwners = new Map([
  ["BBBB000000000001", { path: "Prefabs/Other.et", addon: "Dep" }],
  ["BBBB000000000002", { path: "prefabs/override.et", addon: "Dep" }],
]);

function all(dir: string, rdb: Map<string, RdbEntry> | null, preview?: string): Finding[] {
  const scan = walkAddon(dir);
  return [
    ...checkHandlers(dir), ...checkGprojFindings(dir), ...checkMeta(dir, scan, rdb, owners), ...checkLeftovers(dir, scan),
    ...checkText(dir, scan), ...checkSize(scan).findings, ...checkPreview(dir, scan, preview),
  ];
}
const ids = (fs: Finding[]) => fs.map((f) => `${f.id} ${f.level}${f.path ? ` ${f.path}` : ""}`);

describe("release checks", () => {
  const b = all(bad, badRdb);
  const g = all(good, goodRdb);

  it("finds every problem in the bad fixture, with stable IDs and levels", () => {
    expect(ids(b)).toEqual(expect.arrayContaining([
      "H1 blocker Scripts/WorkbenchGame/EnfusionMCP",
      "H2 warning Scripts/WorkbenchGame/EnfusionMCP",
      "P2 warning addon.gproj",
      "P3 info addon.gproj",
      "M1 info Prefabs/A.et.meta",
      "M1 info Prefabs/B.et.meta",
      "M2 warning Prefabs/B.et",
      "M2 warning Prefabs/Dup.et",
      "M3 warning Textures/Orphan.edds.meta",
      "M3 info Textures/Odd.weird.meta",
      "M4 blocker",
      "M5 warning Prefabs/Clash.et",
      "M5 info Prefabs/Override.et",
      "M6 warning Prefabs/NoMeta.et",
      "M7 blocker Missions/M.conf",
      "L1 warning temp/",
      "L1 warning a.bak",
      "L1 warning __pycache__/",
      "L1 warning VehParts$n.txt",
      "L2 warning Models/M.xob.meta",
      "T1 blocker Scripts/Game/Bom.c",
      "T2 warning README.md",
      "T3 info",
      "C1 info",
      "S1 info",
      "V1 warning",
    ]));
    expect(ids(b)).toContain("P4 warning");
    // Only mission headers: the gearscript pointing at the same compiled-only image is not M7
    expect(ids(b).filter((x) => x.startsWith("M7"))).toEqual(["M7 blocker Missions/M.conf"]);
    expect(b.find((f) => f.id === "M2" && f.path === "Prefabs/Dup.et")?.fix).toMatch(/^Headless rescan: -gproj/);
    expect(b.find((f) => f.path === "Prefabs/B.et.meta")?.message).toContain("(case only)");
    expect(b.find((f) => f.id === "T2")?.message).toBe("Public text has en or em dash, Claude");
    expect(b.find((f) => f.id === "T3")?.message).toMatch(/Scripts\/Game\/Dev\/.*Scripts\/Game\/Diag\.c/);
    expect(b.find((f) => f.id === "H2")?.message).toContain("SYK_Probe.c");
  });

  it("finds nothing but the size line in the clean fixture", () => {
    expect(ids(g)).toEqual(["S1 info"]);
  });

  it("P1 for a .gproj without GUID or base dependency", () => {
    const d = addon("Broken", { "addon.gproj": 'GameProject {\n ID "X"\n}\n' });
    expect(checkGprojFindings(d).map((f) => f.id)).toEqual(["P1", "P1", "P3"]);
  });

  it("M2 for an addon without resourceDatabase.rdb", () => {
    expect(checkMeta(good, walkAddon(good), null).map((f) => f.id)).toEqual(["M2"]);
  });

  it("S1 counts only packable files and lists the largest", () => {
    const scan = walkAddon(good);
    const { sizes } = checkSize(scan);
    const gprojBytes = scan.files.find((f) => f.rel === "addon.gproj")!.size;
    expect(sizes.largest.map(([r]) => r)).toEqual(["addon.gproj", "thumbnail.png", "Prefabs/A.et", "Scripts/Game/Clean.c", "Textures/T.png"]);
    expect(sizes.packableBytes).toBe(gprojBytes + 33 + 18 + 11 + 3); // no .meta, no license.txt
  });

  it("S2 only for files byte-identical to a dependency's copy", () => {
    const dep = { title: "Dep", id: "Dep", exists: (p: string) => p === "Prefabs/A.et" || p === "Scripts/Game/Clean.c", read: (p: string) => Buffer.from(p === "Prefabs/A.et" ? "GenericEntity {\n}\n" : "other") } as unknown as Layer;
    expect(ids(checkOverrides(good, walkAddon(good), [dep]))).toEqual(["S2 warning Prefabs/A.et"]);
  });

  it("V1 for a passed preview over 2 MB or not 1920x1080", () => {
    writeFileSync(join(root, "big.png"), Buffer.concat([png(1280, 720), Buffer.alloc(2 * 1024 * 1024)]));
    expect(ids(checkPreview(good, walkAddon(good), join(root, "big.png")))).toEqual([`V1 warning ${join(root, "big.png")}`, `V1 info ${join(root, "big.png")}`]);
  });
});
