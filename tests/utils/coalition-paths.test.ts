import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../../src/config.js";
import { resolveCoalitionRoots } from "../../src/utils/coalition-paths.js";

let root: string;
let projects: string;

function makeCrf(dir: string) {
  mkdirSync(join(dir, "Tools", "Validation"), { recursive: true });
  writeFileSync(join(dir, "Tools", "Validation", "validate_mission.py"), "");
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "emcp-coa-"));
  projects = join(root, "projects");
  mkdirSync(join(projects, "AAA-NotCrf"), { recursive: true });
  makeCrf(join(projects, "CrfClone"));
  makeCrf(join(projects, "CrfOther"));
  mkdirSync(join(projects, "COALITION-Lobby"));
  makeCrf(join(root, "outside"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const cfg = (defaultMod?: string) => ({ projectPath: projects, defaultMod }) as Config;

describe("resolveCoalitionRoots", () => {
  it("finds CRF by its validator marker and the sibling Lobby", () => {
    expect(resolveCoalitionRoots(cfg())).toEqual({
      crf: join(projects, "CrfClone"),
      lobby: join(projects, "COALITION-Lobby"),
    });
  });

  it("prefers the default mod folder when it holds the marker", () => {
    expect(resolveCoalitionRoots(cfg("CrfOther")).crf).toBe(join(projects, "CrfOther"));
    expect(resolveCoalitionRoots(cfg("AAA-NotCrf")).crf).toBe(join(projects, "CrfClone"));
  });

  it("rejects a crfPath or lobbyPath outside the project path", () => {
    expect(() => resolveCoalitionRoots(cfg(), join(root, "outside"))).toThrow("crfPath must be inside");
    expect(() => resolveCoalitionRoots(cfg(), undefined, join(root, "outside"))).toThrow("lobbyPath must be inside");
  });

  it("reports a missing CRF and a missing Lobby", () => {
    expect(() => resolveCoalitionRoots(cfg(), "AAA-NotCrf")).toThrow("No CRF clone");
    expect(() => resolveCoalitionRoots({ projectPath: join(root, "none") } as Config)).toThrow("No CRF clone");
    expect(() => resolveCoalitionRoots(cfg(), undefined, "Missing-Lobby")).toThrow("COALITION-Lobby not found");
  });
});
