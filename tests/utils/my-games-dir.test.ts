import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { myGamesDir } from "../../src/utils/game-paths.js";

const docs = mkdtempSync(join(tmpdir(), "emcp-docs-"));
afterAll(() => rmSync(docs, { recursive: true, force: true }));

describe("myGamesDir", () => {
  it("uses the Documents folder Windows records when it holds an Arma folder", () => {
    mkdirSync(join(docs, "My Games", "ArmaReforger"), { recursive: true });
    expect(myGamesDir(docs)).toBe(join(docs, "My Games"));
  });

  it("re-bases a shell folder inside the real profile on the home folder, as %USERPROFILE% would", () => {
    const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
    const fakeHome = join(docs, "home");
    mkdirSync(join(fakeHome, "Docs", "My Games", "ArmaReforger"), { recursive: true });
    process.env.USERPROFILE = process.env.HOME = fakeHome;
    try {
      expect(myGamesDir(join(userInfo().homedir, "Docs"))).toBe(join(fakeHome, "Docs", "My Games"));
    } finally {
      Object.assign(process.env, saved);
    }
  });

  it("falls back to Documents or OneDrive\\Documents in the home folder, as before, when the shell folder has none or was not read", () => {
    const fixed = [join(homedir(), "Documents", "My Games"), join(homedir(), "OneDrive", "Documents", "My Games")];
    const before = fixed.find((d) => existsSync(join(d, "ArmaReforgerWorkbench")) || existsSync(join(d, "ArmaReforger"))) ?? fixed[0];
    expect(myGamesDir(join(docs, "elsewhere"))).toBe(before);
    expect(myGamesDir(null)).toBe(before);
  });
});
