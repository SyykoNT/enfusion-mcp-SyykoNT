import { describe, it, expect, vi } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import { changedWorld, formatMissionGit, missionGit, registerMissionGit } from "../../src/tools/mission-git.js";
import { CRF_GUID, LOBBY_GUID } from "../../src/utils/coalition-paths.js";
import { makeProjects, write } from "../coalition/fixture.js";

// The guide's Documents\My Games folder is a temp folder, never the real one
const myGames = mkdtempSync(join(tmpdir(), "mission-git-mygames-"));
vi.mock("../../src/utils/game-paths.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/utils/game-paths.js")>()),
  myGamesDir: () => myGames,
}));

const hasGit = spawnSync("git", ["--version"]).status === 0;
const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });

/** The fixture CRF as a clone of a bare origin with a release branch, on mission/test. */
function setup() {
  const fx = makeProjects();
  const origin = join(fx.root, "..", `${fx.root.split(/[\\/]/).pop()}-origin.git`);
  execFileSync("git", ["init", "-q", "--bare", origin]);
  git(fx.crf, "init", "-q", "-b", "release");
  git(fx.crf, "add", ".");
  git(fx.crf, "commit", "-q", "-m", "release");
  git(fx.crf, "remote", "add", "origin", origin);
  git(fx.crf, "push", "-q", "origin", "release");
  git(fx.crf, "fetch", "-q", "origin");
  git(fx.crf, "checkout", "-q", "-b", "mission/test");
  return { ...fx, origin };
}
const state = (dir: string) => [git(dir, "status", "--porcelain=v1", "--untracked-files=all"), git(dir, "show-ref"), statSync(join(dir, ".git", "index")).mtimeMs, statSync(join(dir, ".git", "FETCH_HEAD")).mtimeMs].join("|");

describe.skipIf(!hasGit)("mission_git", { timeout: 30_000 }, () => {
  it("clean mission branch: nothing ahead or behind, no files, no warnings, and nothing changes in the clone", () => {
    const fx = setup();
    const before = state(fx.crf);
    const r = missionGit(fx.config);
    expect(r).toMatchObject({ branch: "mission/test", base: "origin/release", ahead: 0, behind: 0, files: [], warnings: [], fetched: false });
    expect(r.fetchedAt).not.toBeNull();
    expect(state(fx.crf)).toBe(before);
    expect(formatMissionGit(r)).toContain("- Against origin/release (");
  });

  it("groups committed, uncommitted and untracked changes and warns on handlers, outside files, world without .conf, bad .conf and missing metas", () => {
    const fx = setup();
    write(fx.crf, "Worlds/Test/New.ent", "SubScene {\n}\n");
    write(fx.crf, "Configs/Gearscripts/Custom/Me/GS.conf", "COA_GearScriptConfig {\n}\n");
    write(fx.crf, "Configs/Gearscripts/Custom/Me/GS.conf.meta", 'MetaFileClass {\n Name "{1234567890ABCDEF}Configs/Gearscripts/Custom/Me/GS.conf"\n}\n');
    git(fx.crf, "add", ".");
    git(fx.crf, "commit", "-q", "-m", "mission");
    write(fx.crf, "Missions/Test/Other.conf", 'SCR_MissionHeader {\n World "{8000000000000002}Worlds/Test/Gone.ent"\n}\n');
    write(fx.crf, "Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Ping.c", "class A {}\n");
    write(fx.crf, "Scripts/Game/Framework.c", "class B {}\n");
    const r = missionGit(fx.config);
    expect(r.ahead).toBe(1);
    const where = Object.fromEntries(r.files.map((f) => [f.path, `${f.group} ${f.status} ${f.where.join("+")}`]));
    expect(where).toEqual({
      "Worlds/Test/New.ent": "world A committed",
      "Configs/Gearscripts/Custom/Me/GS.conf": "gearscripts A committed",
      "Configs/Gearscripts/Custom/Me/GS.conf.meta": "gearscripts A committed",
      "Missions/Test/Other.conf": "conf M uncommitted",
      "Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Ping.c": "other A untracked",
      "Scripts/Game/Framework.c": "other A untracked",
    });
    expect(r.warnings).toEqual([
      "MCP handler files in the change: Scripts/WorkbenchGame/EnfusionMCP/EMCP_WB_Ping.c (run wb_cleanup; never commit them)",
      "Files outside the mission folders (Worlds, Missions, Configs/Gearscripts, Prefabs): Scripts/Game/Framework.c",
      "World Worlds/Test/New.ent has no mission .conf in Missions/ (plugin 6 not run?)",
      "Missions/Test/Other.conf points at Worlds/Test/Gone.ent, which does not exist",
      "New resources without a .meta: Worlds/Test/New.ent (register them in Workbench)",
    ]);
    expect(formatMissionGit(r)).toContain("### World and layers (1)\n- A Worlds/Test/New.ent (committed)");
  });

  it("behind release: counts as of the last fetch until fetch: true", () => {
    const fx = setup();
    const other = mkdtempSync(join(tmpdir(), "mission-git-other-"));
    execFileSync("git", ["clone", "-q", "-b", "release", fx.origin, other]);
    write(other, "Missions/Test/New.conf", "SCR_MissionHeader {\n}\n");
    git(other, "add", ".");
    git(other, "commit", "-q", "-m", "someone else");
    git(other, "push", "-q", "origin", "release");
    expect(missionGit(fx.config).behind).toBe(0);
    const r = missionGit(fx.config, { fetch: true });
    expect(r).toMatchObject({ behind: 1, fetched: true });
    expect(r.warnings).toContain("1 commits behind origin/release: update the branch from release before you push");
  });

  it("changedWorld: a changed layer counts for its world; none or several asks for world", () => {
    const fx = setup();
    expect(() => changedWorld(missionGit(fx.config))).toThrow("No world changed against origin/release: pass world.");
    write(fx.crf, "Worlds/Test/Author_TVT_Fixture_Layers/PROPS.layer", "GenericEntity {\n}\n");
    expect(changedWorld(missionGit(fx.config))).toBe("Worlds/Test/Author_TVT_Fixture.ent");
    write(fx.crf, "Worlds/Test/Second.ent", "SubScene {\n}\n");
    expect(() => changedWorld(missionGit(fx.config))).toThrow(/^Several worlds changed/);
  });

  it("refuses a Workshop copy of CRF: it needs a clone to read the branch", () => {
    const root = mkdtempSync(join(tmpdir(), "mission-git-ws-"));
    for (const [name, version] of [[`COALITIONFramework-CRF_${CRF_GUID}`, "1.8.19"], [`COALITIONLobby_${LOBBY_GUID}`, "2.0.10"]]) {
      mkdirSync(join(root, "workshop", name), { recursive: true });
      writeFileSync(join(root, "workshop", name, "ServerData.json"), `{"name":"x","revision":{"version":"${version}"}}`);
    }
    mkdirSync(join(root, "projects"));
    const config = { projectPath: join(root, "projects"), workshopPath: join(root, "workshop") } as Config;
    expect(() => missionGit(config)).toThrow(/^mission_git needs a CRF clone: it reads the branch with git \(found Workshop 1\.8\.19 \(/);
  });

  it("warns on a branch that is not mission/<name>", () => {
    const fx = setup();
    git(fx.crf, "checkout", "-q", "release");
    expect(missionGit(fx.config).warnings).toEqual(["Branch release is not mission/<name>: CRF's Mission QA checklist job runs only on mission/ branches (validate.yml)"]);
  });

  it("never passes base to git as typed: an option-like or unknown base is an error and writes nothing", async () => {
    const fx = setup();
    const out = mkdtempSync(join(tmpdir(), "mission-git-base-"));
    let h: (a: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }> = async () => ({ content: [] });
    registerMissionGit({ registerTool: (_n: string, _d: unknown, f: typeof h) => { h = f; } } as unknown as McpServer, fx.config);
    for (const base of [`--output=${join(out, "PWNED")}`, "nope"]) {
      const r = await h({ base });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toBe(`${base} is not a commit in ${fx.crf}. Fetch release first (fetch: true) or pass base.`);
    }
    expect(readdirSync(out)).toEqual([]);
    expect(existsSync(join(fx.crf, "PWNED"))).toBe(false);
    expect(JSON.parse((await h({ base: "release", format: "json" })).content[0].text).base).toBe("release");
  });
});
