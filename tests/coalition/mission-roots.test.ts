import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import { makeProjects, write } from "./fixture.js";

// The guide's Documents\My Games folder is a temp folder, never the real one; git calls are counted
const myGames = mkdtempSync(join(tmpdir(), "mission-roots-mygames-"));
vi.mock("../../src/utils/game-paths.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/utils/game-paths.js")>()),
  myGamesDir: () => myGames,
}));
vi.mock("node:child_process", async (importActual) => {
  const actual = await importActual<typeof import("node:child_process")>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});
const { CRF_MARKER, CRF_PATH_HELP, LOBBY_PATH_HELP, resolveCoalitionRoots } = await import("../../src/utils/coalition-paths.js");
const { loadLobbyMission } = await import("../../src/tools/mission-inspect.js");
const { missionGit } = await import("../../src/tools/mission-git.js");
const { findGearscriptUsage, registerGearscriptInspect } = await import("../../src/tools/gearscript-inspect.js");
const { registerMissionGit } = await import("../../src/tools/mission-git.js");
const { registerMissionNames } = await import("../../src/tools/mission-names.js");
const { registerMissionPrDraft } = await import("../../src/tools/mission-pr-draft.js");
const { registerMissionPreflight } = await import("../../src/tools/mission-preflight.js");
const { registerMissionValidate } = await import("../../src/tools/mission-validate.js");
const { registerMissionInspect } = await import("../../src/tools/mission-inspect.js");

const hasGit = spawnSync("git", ["--version"]).status === 0;
const gitCalls = vi.mocked(execFileSync);
const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
const GS_GUID = "ABCDEF0123456789";

/** A repo with the CRF marker and one commit. */
function makeRepo(dir: string) {
  write(dir, CRF_MARKER, "");
  git(dir, "init", "-q", "-b", "release");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "release");
}

let fx!: ReturnType<typeof makeProjects>;
let roots = ""; // temp folder holding the mission-roots layout and the "outside" clones
let missionDir = ""; // mission-roots/M
let wt = ""; // mission-roots/M/Coalition-Reforger-Framework, a worktree of fx.crf
let cfg!: Config;
const temp = () => mkdtempSync(join(roots, "t-"));

describe.skipIf(!hasGit)("COALITION tools with a worktree CRF", { timeout: 30_000 }, () => {
  beforeAll(() => {
    fx = makeProjects();
    cfg = fx.config;
    write(fx.crf, "Worlds/Test/Gs_Layers/_INIT.layer", `GenericEntity {\n m_rGearScript "{${GS_GUID}}Configs/Gearscripts/Test/GS.conf"\n}\n`);
    git(fx.crf, "init", "-q", "-b", "release");
    git(fx.crf, "add", ".");
    git(fx.crf, "commit", "-q", "-m", "release");
    roots = mkdtempSync(join(tmpdir(), "mission-roots-"));
    missionDir = join(roots, "mission-roots", "M");
    mkdirSync(missionDir, { recursive: true });
    wt = join(missionDir, "Coalition-Reforger-Framework");
    git(fx.crf, "worktree", "add", "-q", "-b", "mission/M", wt);
    symlinkSync(fx.lobby, join(missionDir, "COALITION-Lobby"), "junction");
  });
  afterAll(() => {
    // the junction first, so recursive removal never reaches the Lobby clone through it
    for (const p of [join(missionDir, "COALITION-Lobby")]) rmSync(p, { recursive: true, force: true, maxRetries: 3 });
    for (const d of [roots, fx.root, myGames]) rmSync(d, { recursive: true, force: true, maxRetries: 3 });
  });

  it("accepts a git worktree of a CRF clone in the project path, names its branch and finds the Lobby through the junction", () => {
    const r = resolveCoalitionRoots(cfg, wt);
    expect(r.crf.root).toBe(wt);
    expect(r.crf.label).toContain("mission/M");
    expect(r.lobby.root).toBe(join(missionDir, "COALITION-Lobby"));
    expect(r.lobby.exists("Prefabs/!Systems/!Lobby/COA_Lobby.et")).toBe(true);
  });

  it("reads a relative gitdir in the worktree's .git file", () => {
    const rel = join(missionDir, "rel");
    git(fx.crf, "worktree", "add", "-q", "-b", "mission/rel", rel);
    const name = readdirSync(join(fx.crf, ".git", "worktrees")).find((n) => existsSync(join(fx.crf, ".git", "worktrees", n, "HEAD")) && n.startsWith("rel"))!;
    rmSync(join(rel, ".git")); // hidden on Windows, so it is replaced rather than rewritten
    writeFileSync(join(rel, ".git"), `gitdir: ${relative(rel, join(fx.crf, ".git", "worktrees", name)).replace(/\\/g, "/")}\n`);
    expect(resolveCoalitionRoots(cfg, rel).crf.root).toBe(rel);
  });

  it("runs git only in the main clone", () => {
    gitCalls.mockClear();
    resolveCoalitionRoots(cfg, wt);
    const dirs = gitCalls.mock.calls.map((c) => (c[1] as string[])[1]);
    expect(dirs.length).toBeGreaterThan(0);
    // on windows-latest the temp folder is an 8.3 name (RUNNER~1) while git reports the long one
    const real = (p: string) => realpathSync.native(p);
    expect(new Set(dirs.map(real))).toEqual(new Set([real(fx.crf)]));
  });

  describe("refusals say where a worktree is also accepted", () => {
    const refused = (crfPath: string) => expect(() => resolveCoalitionRoots(cfg, crfPath)).toThrow(/crfPath must be inside .*A git worktree of a CRF clone inside them is also accepted\./);

    it("a worktree of a clone outside the allowed folders", () => {
      const outside = temp();
      makeRepo(outside);
      const other = join(temp(), "Coalition-Reforger-Framework");
      git(outside, "worktree", "add", "-q", "-b", "mission/X", other);
      refused(other);
    });

    it("a plain copy outside, git folder included", () => {
      const copy = temp();
      cpSync(fx.crf, copy, { recursive: true });
      expect(existsSync(join(copy, ".git"))).toBe(true);
      refused(copy);
    });

    it("a worktree without the CRF marker", () => {
      const bare = join(missionDir, "no-marker");
      git(fx.crf, "worktree", "add", "-q", "-b", "mission/nomarker", bare);
      rmSync(join(bare, CRF_MARKER));
      refused(bare);
    });

    it("a folder that is not a git repo", () => {
      const dir = temp();
      write(dir, CRF_MARKER, "");
      refused(dir);
    });

    it("a forged .git file pointing at an allowed clone's worktrees folder, listed or not", () => {
      const listed = readdirSync(join(fx.crf, ".git", "worktrees"))[0];
      for (const target of [listed, "nowhere"]) {
        const forged = temp();
        write(forged, CRF_MARKER, "");
        writeFileSync(join(forged, ".git"), `gitdir: ${join(fx.crf, ".git", "worktrees", target)}\n`);
        refused(forged);
      }
    });

    it("a subfolder of a real worktree", () => {
      write(wt, `Sub/${CRF_MARKER}`, "");
      refused(join(wt, "Sub"));
    });

    it.each([["a '..' segment", () => `${wt}${sep}..${sep}Coalition-Reforger-Framework`], ["a device name", () => join(missionDir, "NUL")], ["a trailing dot", () => join(missionDir, "Coalition-Reforger-Framework.")]])(
      "%s is refused before any git call",
      (_n, path) => {
        gitCalls.mockClear();
        refused(path());
        expect(gitCalls).not.toHaveBeenCalled();
      }
    );

    it("git missing from PATH gives the normal refusal, not a crash", () => {
      const saved = process.env.PATH;
      process.env.PATH = temp();
      try {
        refused(wt);
      } finally {
        process.env.PATH = saved;
      }
    });
  });

  describe("Lobby beside a worktree CRF", () => {
    const junction = () => join(missionDir, "COALITION-Lobby");

    it("an explicit lobbyPath that is the folder beside the worktree is accepted", () => {
      expect(resolveCoalitionRoots(cfg, wt, junction()).lobby.root).toBe(junction());
    });

    it("an explicit lobbyPath outside the allowed folders is refused, even next to a worktree CRF", () => {
      const elsewhere = join(temp(), "COALITION-Lobby");
      mkdirSync(elsewhere);
      expect(() => resolveCoalitionRoots(cfg, wt, elsewhere)).toThrow(/lobbyPath must be inside .*COALITION-Lobby folder next to a git worktree CRF is also accepted/);
      expect(() => resolveCoalitionRoots(cfg, wt, join(junction(), "Prefabs"))).toThrow(/lobbyPath must be inside/);
    });

    it("the folder beside a worktree is not accepted for a CRF that is not a worktree", () => {
      expect(() => resolveCoalitionRoots(cfg, fx.crf, junction())).toThrow(/lobbyPath must be inside/);
    });
  });

  it("mission_inspect reads an absolute world inside the worktree, and still refuses one elsewhere", () => {
    const r = resolveCoalitionRoots(cfg, wt);
    const m = loadLobbyMission(cfg, r, join(wt, fx.worldRel));
    expect(m.copy.root).toBe(wt);
    expect(m.worldRel).toBe(fx.worldRel);
    expect(() => loadLobbyMission(cfg, r, join(temp(), "x.ent"))).toThrow(/inside the project path/);
  });

  it("mission_git reports the worktree's branch", () => {
    expect(missionGit(cfg, { crfPath: wt, base: "release" })).toMatchObject({ branch: "mission/M", ahead: 0, behind: 0 });
  });

  it("gearscript usedBy lists each mission once, from the worktree and not again from the main clone", () => {
    const used = (crf?: string) => findGearscriptUsage(GS_GUID, cfg.projectPath, resolveCoalitionRoots(cfg, crf)).map((u) => u.file.replace(/\\/g, "/"));
    expect(used(wt)).toEqual(["Coalition-Reforger-Framework/Worlds/Test/Gs_Layers/_INIT.layer"]);
    expect(used()).toEqual(["CRF/Worlds/Test/Gs_Layers/_INIT.layer"]);
  });

  it("the path help and every tool's crfPath description say a git worktree is accepted", () => {
    expect(CRF_PATH_HELP).toContain("git worktree");
    expect(LOBBY_PATH_HELP).toContain("git worktree");
    const seen: [string, string, string][] = [];
    const server = { registerTool: (n: string, d: { inputSchema: Record<string, { description?: string }> }) => void seen.push([n, d.inputSchema.crfPath?.description ?? "", d.inputSchema.lobbyPath?.description ?? ""]) } as unknown as McpServer;
    for (const register of [registerMissionGit, registerMissionPrDraft, registerMissionPreflight, registerMissionValidate, registerMissionNames, registerGearscriptInspect, registerMissionInspect]) register(server, cfg);
    expect(seen.length).toBeGreaterThanOrEqual(7);
    for (const [name, crf, lobby] of seen) {
      expect(crf, name).toContain("worktree");
      expect(lobby, name).toMatch(/junction|worktree/);
    }
  });

  it("no change for a crfPath inside the allowed folders", () => {
    expect(resolveCoalitionRoots(cfg, fx.crf).crf.root).toBe(fx.crf);
    expect(resolveCoalitionRoots(cfg).crf.root).toBe(fx.crf);
  });

});
