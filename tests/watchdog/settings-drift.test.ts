import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { depth1Names, driftLine, loadSnapshot, lostBlocks, saveSnapshot, settingsFiles, takeSnapshot } from "../../src/watchdog/settings-drift.js";

// Temp profiles only; nothing here reads or writes a real settings file.

/** The form of the real ReforgerGameSettings.conf: one root block, depth-1 settings classes, deeper blocks inside them. */
const conf = (classes: string[]) =>
  [
    "GameUserSettings {",
    ...classes.flatMap((c, i) => [
      ` ${c} ${c} "{6AB07B176D3DEE${String(i).padStart(2, "0")}}" {`,
      "  m_aShownHints {",
      "   EDITOR_MODE_EDIT MANUAL_CAMERA_MOVE",
      "  }",
      `  Nested ${c}Info "{6AC36D92E11900AB}" {`,
      "   m_iSavedLabels {",
      "    1 2 3",
      "   }",
      "  }",
      " }",
    ]),
    "}",
    "",
  ].join("\r\n");

const profile = () => mkdtempSync(join(tmpdir(), "emcp-sd-"));
function put(root: string, rel: string[], text: string) {
  const dir = join(root, "profile", ".save", ...rel.slice(0, -1));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, rel.at(-1)!);
  writeFileSync(file, text);
  return realpathSync.native(file);
}
const hashAll = (root: string): string[] => {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : [`${p}:${createHash("sha256").update(readFileSync(p)).digest("hex")}`];
    });
  return walk(root).sort();
};

describe("depth1Names", () => {
  it("holds the class names of the root block's direct children, not the deeper blocks", () => {
    expect(depth1Names(conf(["SCR_VideoSettings", "WCS_EarplugSettings"]))).toEqual(["SCR_VideoSettings", "WCS_EarplugSettings"]);
    expect(depth1Names("")).toEqual([]);
  });

  it("is the same in another order and with LF line endings", () => {
    expect(depth1Names(conf(["B", "A", "C"]).replace(/\r\n/g, "\n"))).toEqual(depth1Names(conf(["C", "B", "A"])));
  });
});

describe("settingsFiles", () => {
  it("lists every .conf in .save\\settings and .save\\app1_x\\settings of both profiles, and nothing else", () => {
    const game = profile();
    const wb = profile();
    const files = [
      put(game, ["settings", "ReforgerGameSettings.conf"], conf(["A"])),
      put(game, ["app1_x", "settings", "ReforgerEngineSettings.conf"], conf(["A"])),
      put(wb, ["app2_y", "settings", "InputUserSettings.conf"], conf(["A"])),
    ];
    put(wb, ["app2_y", "settings", "notes.txt"], "x");
    put(wb, ["app2_y", "settings.bak-1", "Old.conf"], conf(["A"]));
    put(wb, ["settings", "customInputConfigs", "Deep.conf"], conf(["A"]));
    expect(settingsFiles([game, wb]).sort()).toEqual(files.sort());
  });

  it("reads a junctioned folder through its real path, once", () => {
    const root = profile();
    const real = put(root, ["settings", "ReforgerGameSettings.conf"], conf(["A"]));
    const target = join(root, "profile", ".save", "settings");
    mkdirSync(join(root, "profile", ".save", "app3_z"), { recursive: true });
    symlinkSync(target, join(root, "profile", ".save", "app3_z", "settings"), "junction");
    expect(settingsFiles([root, root])).toEqual([real]);
    expect(Object.keys(takeSnapshot([root]))).toEqual([real]);
  });

  it("gives nothing and does not throw for profile folders that do not exist", () => {
    const missing = join(profile(), "nope");
    expect(settingsFiles([missing, join(missing, "again")])).toEqual([]);
    expect(takeSnapshot([missing])).toEqual({});
  });
});

describe("lostBlocks", () => {
  it("the same blocks in another order give nothing; a missing block is named once with its file", () => {
    const before = { "f.conf": depth1Names(conf(["A", "B", "C"])) };
    expect(lostBlocks(before, { "f.conf": depth1Names(conf(["C", "A", "B"])) })).toEqual([]);
    expect(lostBlocks(before, { "f.conf": depth1Names(conf(["C", "A"])) })).toEqual([{ file: "f.conf", names: ["B"] }]);
  });

  it("counts a name that repeats, ignores blocks that are new and files that are gone", () => {
    expect(lostBlocks({ "f.conf": ["A", "A"], "g.conf": ["A"] }, { "f.conf": ["A", "N"] })).toEqual([{ file: "f.conf", names: ["A"] }]);
  });

  it("the report line names the file and the blocks", () => {
    expect(driftLine("10:00:00", "C:\\p\\f.conf", ["WCS_EarplugSettings", "CSI_X"])).toBe(
      "SETTINGS 10:00:00 C:\\p\\f.conf: blocks gone: WCS_EarplugSettings, CSI_X (a run without those mods drops their settings; restore from your own backup)"
    );
  });
});

describe("snapshot file", () => {
  it("round-trips in the watch dir, keeps the baseline of a file this run could not read, and ignores a damaged file", () => {
    const dir = profile();
    expect(loadSnapshot(dir)).toBeUndefined();
    saveSnapshot(dir, { "a.conf": ["A"], "b.conf": ["B"] });
    saveSnapshot(dir, { "a.conf": ["A", "C"] });
    expect(loadSnapshot(dir)).toEqual({ "a.conf": ["A", "C"], "b.conf": ["B"] });
    writeFileSync(join(dir, "settings.json"), "[1]");
    expect(loadSnapshot(dir)).toBeUndefined();
    writeFileSync(join(dir, "settings.json"), "{ broken");
    expect(loadSnapshot(dir)).toBeUndefined();
    expect(readdirSync(dir)).toEqual(["settings.json"]);
  });

  it("taking a snapshot writes nothing in the profiles", () => {
    const game = profile();
    const wb = profile();
    put(game, ["app1_x", "settings", "ReforgerGameSettings.conf"], conf(["A", "B"]));
    put(wb, ["settings", "ReforgerEngineSettings.conf"], conf(["C"]));
    const before = [...hashAll(game), ...hashAll(wb)];
    takeSnapshot([game, wb]);
    expect([...hashAll(game), ...hashAll(wb)]).toEqual(before);
  });
});
