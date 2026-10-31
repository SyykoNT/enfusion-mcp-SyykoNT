import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PakVirtualFS } from "../../src/pak/vfs.js";
import { buildTestPak } from "./test-pak.js";

// ── Tests ────────────────────────────────────────────────────────────────────

const TEST_DIR = join(tmpdir(), "enfusion-mcp-vfs-test-" + process.pid);
const GAME_DIR = join(TEST_DIR, "game");
const ADDONS_DIR = join(GAME_DIR, "addons");

beforeAll(() => {
  mkdirSync(ADDONS_DIR, { recursive: true });

  // Create two pak files to test merging
  const pak1 = buildTestPak([
    { path: "Scripts/Game/player.c", content: "class Player {}", compress: false },
    { path: "Prefabs/box.et", content: 'GenericEntity { ID "box" }', compress: false },
  ]);
  writeFileSync(join(ADDONS_DIR, "data.pak"), pak1);

  const pak2 = buildTestPak([
    { path: "Scripts/Game/vehicle.c", content: "class Vehicle {}", compress: true },
    { path: "Configs/game.conf", content: "GameConfig { mode coop }", compress: true },
  ]);
  writeFileSync(join(ADDONS_DIR, "scripts.pak"), pak2);

  // Reset singleton between test runs
  (PakVirtualFS as any).instance = null;
  (PakVirtualFS as any).instanceGamePath = null;
});

afterAll(() => {
  // Reset singleton
  (PakVirtualFS as any).instance = null;
  (PakVirtualFS as any).instanceGamePath = null;
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("PakVirtualFS", () => {
  it("returns null when no addons directory exists", () => {
    const vfs = PakVirtualFS.get(join(TEST_DIR, "nonexistent"));
    expect(vfs).toBeNull();
  });

  it("initializes from pak files in addons/", () => {
    const vfs = PakVirtualFS.get(GAME_DIR);
    expect(vfs).not.toBeNull();
    expect(vfs!.fileCount).toBe(4);
  });

  it("lists root directory", () => {
    const vfs = PakVirtualFS.get(GAME_DIR)!;
    const entries = vfs.listDir("");
    const names = entries.map((e) => e.name).sort();
    expect(names).toContain("Scripts");
    expect(names).toContain("Prefabs");
    expect(names).toContain("Configs");
  });

  it("lists subdirectory", () => {
    const vfs = PakVirtualFS.get(GAME_DIR)!;
    const entries = vfs.listDir("Scripts/Game");
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["player.c", "vehicle.c"]);
    expect(entries.every((e) => !e.isDirectory)).toBe(true);
  });

  it("returns empty for nonexistent directory", () => {
    const vfs = PakVirtualFS.get(GAME_DIR)!;
    expect(vfs.listDir("DoesNotExist")).toEqual([]);
  });

  it("checks file existence", () => {
    const vfs = PakVirtualFS.get(GAME_DIR)!;
    expect(vfs.exists("Scripts/Game/player.c")).toBe(true);
    expect(vfs.exists("Scripts/Game/vehicle.c")).toBe(true);
    expect(vfs.exists("nope.c")).toBe(false);
  });

  it("checks directory existence", () => {
    const vfs = PakVirtualFS.get(GAME_DIR)!;
    expect(vfs.exists("Scripts")).toBe(true);
    expect(vfs.exists("Scripts/Game")).toBe(true);
    expect(vfs.exists("Nonexistent")).toBe(false);
  });

  it("reads uncompressed file", () => {
    const vfs = PakVirtualFS.get(GAME_DIR)!;
    const content = vfs.readTextFile("Scripts/Game/player.c");
    expect(content).toBe("class Player {}");
  });

  it("reads compressed file", () => {
    const vfs = PakVirtualFS.get(GAME_DIR)!;
    const content = vfs.readTextFile("Scripts/Game/vehicle.c");
    expect(content).toBe("class Vehicle {}");
  });

  it("reads file as buffer", () => {
    const vfs = PakVirtualFS.get(GAME_DIR)!;
    const buf = vfs.readFile("Prefabs/box.et");
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.toString("utf-8")).toBe('GenericEntity { ID "box" }');
  });

  it("throws on nonexistent file read", () => {
    const vfs = PakVirtualFS.get(GAME_DIR)!;
    expect(() => vfs.readFile("no/such/file.c")).toThrow("File not found in pak");
  });

  it("returns all file paths", () => {
    const vfs = PakVirtualFS.get(GAME_DIR)!;
    const paths = vfs.allFilePaths().sort();
    expect(paths).toEqual([
      "Configs/game.conf",
      "Prefabs/box.et",
      "Scripts/Game/player.c",
      "Scripts/Game/vehicle.c",
    ]);
  });

  it("caches singleton instance", () => {
    const a = PakVirtualFS.get(GAME_DIR);
    const b = PakVirtualFS.get(GAME_DIR);
    expect(a).toBe(b);
  });

  it("forPaks builds separate instances that share no files with the singleton", () => {
    const one = PakVirtualFS.forPaks([join(ADDONS_DIR, "data.pak")]);
    const two = PakVirtualFS.forPaks([join(ADDONS_DIR, "scripts.pak")]);
    expect(one.allFilePaths().sort()).toEqual(["Prefabs/box.et", "Scripts/Game/player.c"]);
    expect(two.readTextFile("Scripts/Game/vehicle.c")).toBe("class Vehicle {}");
    expect(one.exists("Scripts/Game/vehicle.c")).toBe(false);
    expect(PakVirtualFS.get(GAME_DIR)!.fileCount).toBe(4);
    expect(PakVirtualFS.get(GAME_DIR)).not.toBe(one);
  });
});
