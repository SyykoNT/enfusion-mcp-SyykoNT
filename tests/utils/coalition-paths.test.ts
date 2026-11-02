import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Config } from "../../src/config.js";

// The guide's Documents\My Games folder is a temp folder, never the real one
const root = mkdtempSync(join(tmpdir(), "emcp-coa-"));
const myGames = join(root, "My Games");
vi.mock("../../src/utils/game-paths.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/utils/game-paths.js")>()),
  myGamesDir: () => myGames,
}));
const { resolveCoalitionRoots, CRF_GUID, LOBBY_GUID } = await import("../../src/utils/coalition-paths.js");

const projects = join(root, "projects");
const empty = join(root, "empty-projects");
const workshop = join(root, "workshop");
const guideCrf = join(myGames, "ArmaReforgerWorkbench", "Projects", "Coalition-Reforger-Framework");

function makeCrf(dir: string) {
  mkdirSync(join(dir, "Tools", "Validation"), { recursive: true });
  writeFileSync(join(dir, "Tools", "Validation", "validate_mission.py"), "");
}
function makeWorkshop(name: string, version: string) {
  mkdirSync(join(workshop, name), { recursive: true });
  writeFileSync(join(workshop, name, "ServerData.json"), `﻿{"name":"x","revision":{"version":"${version}"}}`);
}

beforeAll(() => {
  mkdirSync(join(projects, "AAA-NotCrf"), { recursive: true });
  makeCrf(join(projects, "CrfClone"));
  makeCrf(join(projects, "CrfOther"));
  mkdirSync(join(projects, "COALITION-Lobby"));
  mkdirSync(empty);
  makeCrf(join(root, "outside"));
  makeWorkshop(`COALITIONFramework-CRF_${CRF_GUID}`, "1.8.19");
  makeWorkshop(`COALITIONLobby_${LOBBY_GUID}`, "2.0.10");
  mkdirSync(join(workshop, "SomeOtherMod_1111111111111111"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const cfg = (defaultMod?: string, projectPath = projects) => ({ projectPath, defaultMod, workshopPath: workshop }) as Config;
const where = (r: ReturnType<typeof resolveCoalitionRoots>) => [r.crf.kind, r.crf.root, r.lobby.kind, r.lobby.root];

describe("resolveCoalitionRoots", () => {
  it("finds a CRF clone in the project path by its validator marker, and the sibling Lobby clone", () => {
    expect(where(resolveCoalitionRoots(cfg()))).toEqual(["loose", join(projects, "CrfClone"), "loose", join(projects, "COALITION-Lobby")]);
  });

  it("prefers the default mod folder when it holds the marker", () => {
    expect(resolveCoalitionRoots(cfg("CrfOther")).crf.root).toBe(join(projects, "CrfOther"));
    expect(resolveCoalitionRoots(cfg("AAA-NotCrf")).crf.root).toBe(join(projects, "CrfClone"));
  });

  it("then the guide's Projects folder, with the Lobby from the Workshop when no clone is beside CRF", () => {
    makeCrf(guideCrf);
    try {
      const r = resolveCoalitionRoots(cfg(undefined, empty));
      expect(where(r)).toEqual(["loose", guideCrf, "workshop", join(workshop, `COALITIONLobby_${LOBBY_GUID}`)]);
      expect(r.lobby.label).toBe(`Workshop 2.0.10 (${join(workshop, `COALITIONLobby_${LOBBY_GUID}`)})`);
      // A crfPath inside the guide's Projects folder is allowed too
      expect(resolveCoalitionRoots(cfg(), guideCrf).crf.root).toBe(guideCrf);
    } finally {
      rmSync(guideCrf, { recursive: true, force: true });
    }
  });

  it("reads CRF and Lobby from the Workshop when no clone exists anywhere", () => {
    const r = resolveCoalitionRoots(cfg(undefined, empty));
    expect(where(r)).toEqual(["workshop", join(workshop, `COALITIONFramework-CRF_${CRF_GUID}`), "workshop", join(workshop, `COALITIONLobby_${LOBBY_GUID}`)]);
    expect(r.crf.label).toMatch(/^Workshop 1\.8\.19 \(/);
  });

  it("source forces clones or Workshop copies", () => {
    expect(where(resolveCoalitionRoots(cfg(), undefined, undefined, "workshop")).filter((_, i) => i % 2 === 0)).toEqual(["workshop", "workshop"]);
    expect(() => resolveCoalitionRoots(cfg(undefined, empty), undefined, undefined, "clone")).toThrow(/^No CRF clone .*Coalition Mission Making Guide/);
    expect(() => resolveCoalitionRoots({ ...cfg(), workshopPath: empty }, undefined, undefined, "workshop")).toThrow(/^source "workshop": no CRF Workshop copy/);
  });

  it("refuses crfPath or lobbyPath with source workshop instead of ignoring them", () => {
    expect(() => resolveCoalitionRoots(cfg(), "CrfClone", undefined, "workshop")).toThrow(/^source "workshop" reads the Workshop copies, but crfPath names a clone/);
    expect(() => resolveCoalitionRoots(cfg(), undefined, "COALITION-Lobby", "workshop")).toThrow(/but lobbyPath names a clone/);
  });

  it.skipIf(process.platform !== "win32")("finds a CRF clone that the project path holds as a junction", () => {
    const linked = join(root, "linked-projects");
    mkdirSync(linked);
    execFileSync("cmd", ["/d", "/c", "mklink", "/J", join(linked, "Crf"), join(projects, "CrfClone")], { stdio: "ignore", windowsHide: true });
    try {
      expect(resolveCoalitionRoots(cfg(undefined, linked)).crf).toMatchObject({ kind: "loose", root: join(linked, "Crf") });
    } finally {
      execFileSync("cmd", ["/d", "/c", "rmdir", join(linked, "Crf")], { stdio: "ignore", windowsHide: true }); // the junction only
    }
  });

  it("names a clone with its git revision", () => {
    expect(resolveCoalitionRoots(cfg()).crf.label).toBe(`clone unknown (${join(projects, "CrfClone")})`);
  });

  it("rejects a crfPath or lobbyPath outside the project path and the guide's Projects folder", () => {
    expect(() => resolveCoalitionRoots(cfg(), join(root, "outside"))).toThrow("crfPath must be inside");
    expect(() => resolveCoalitionRoots(cfg(), undefined, join(root, "outside"))).toThrow("lobbyPath must be inside");
  });

  it("reports a missing CRF and a missing Lobby", () => {
    expect(() => resolveCoalitionRoots(cfg(), "AAA-NotCrf")).toThrow("No CRF clone");
    expect(() => resolveCoalitionRoots({ projectPath: join(root, "none") } as Config)).toThrow(/^No CRF clone .*, and no CRF Workshop copy/);
    expect(() => resolveCoalitionRoots(cfg(), undefined, "Missing-Lobby")).toThrow("COALITION-Lobby not found");
  });
});
