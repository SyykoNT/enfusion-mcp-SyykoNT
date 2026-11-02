import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { myGamesDir } from "../../src/utils/game-paths.js";

const docs = mkdtempSync(join(tmpdir(), "emcp-docs-"));
afterAll(() => rmSync(docs, { recursive: true, force: true }));

describe("myGamesDir", () => {
  it("uses the Documents folder Windows records when it holds an Arma folder", () => {
    mkdirSync(join(docs, "My Games", "ArmaReforger"), { recursive: true });
    expect(myGamesDir(docs)).toBe(join(docs, "My Games"));
  });

  it("falls back to Documents or OneDrive\\Documents in the home folder, as before, when the shell folder has none or was not read", () => {
    const fixed = [join(homedir(), "Documents", "My Games"), join(homedir(), "OneDrive", "Documents", "My Games")];
    const before = fixed.find((d) => existsSync(join(d, "ArmaReforgerWorkbench")) || existsSync(join(d, "ArmaReforger"))) ?? fixed[0];
    expect(myGamesDir(join(docs, "elsewhere"))).toBe(before);
    expect(myGamesDir(null)).toBe(before);
  });
});
