import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { enumDefault, loadLobbyEnums, type LobbyEnums } from "../../src/utils/lobby-enums.js";

let root: string;
let enums: LobbyEnums;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "emcp-enums-"));
  const base = join(root, "Base", "Scripts", "Game", "Deep", "Dir");
  const mod = join(root, "Mod", "Scripts", "Game");
  mkdirSync(base, { recursive: true });
  mkdirSync(mod, { recursive: true });
  writeFileSync(
    join(base, "Fruit_Enums.c"),
    [
      "// enum Commented { NOPE }",
      "enum Fruit",
      "{",
      "  SPECIAL = 99, // trailing comment",
      "  APPLE = 0,",
      "  /* block, comment */",
      "  PEAR,",
      "  PLUM",
      "}",
      "enum Hex { A = 0x10, B }",
      "class NotAnEnum { int x; }",
    ].join("\n")
  );
  // The modded file sorts before nothing in particular; the base must still be numbered first
  writeFileSync(join(mod, "AAA_Fruit_Mod.c"), "modded enum Fruit\n{\n  KIWI,\n  LIME,\n}\nmodded enum Menu : BaseMenu { EXTRA }\n");
  writeFileSync(join(mod, "notes.txt"), "enum Ignored { X }");
  enums = loadLobbyEnums([join(root, "Mod"), join(root, "Base"), join(root, "Missing")]);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("loadLobbyEnums", () => {
  it("reads names and values in source order, ignoring comments", () => {
    expect([...enums.get("Fruit")!.entries()].slice(0, 4)).toEqual([
      ["SPECIAL", 99],
      ["APPLE", 0],
      ["PEAR", 1],
      ["PLUM", 2],
    ]);
    expect(enums.has("Commented")).toBe(false);
    expect(enums.has("NotAnEnum")).toBe(false);
    expect(enums.has("Ignored")).toBe(false);
  });

  it("merges a modded enum into its base after the highest value", () => {
    expect(enums.get("Fruit")!.get("KIWI")).toBe(100);
    expect(enums.get("Fruit")!.get("LIME")).toBe(101);
  });

  it("reads hex values and a modded enum with a base class", () => {
    expect([...enums.get("Hex")!.entries()]).toEqual([["A", 16], ["B", 17]]);
    expect([...enums.get("Menu")!.keys()]).toEqual(["EXTRA"]);
  });

  it("enumDefault names the member with value 0", () => {
    expect(enumDefault(enums, "Fruit")).toBe("APPLE");
    expect(enumDefault(enums, "Hex")).toBeUndefined();
    expect(enumDefault(enums, "Nope")).toBeUndefined();
  });
});
