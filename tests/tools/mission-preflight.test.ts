import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

// Real git (execFileSync) for mission_git; CRF's Python scripts (execFile) answer from fixtures
const replies: Record<string, { code: number; stdout: string }> = {};
vi.mock("node:child_process", async (orig) => {
  const actual = await orig<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: vi.fn((_cmd: string, args: string[], _o: unknown, cb: (e: unknown, out: string, err: string) => void) => {
      const r = replies[basename(args.find((a) => a.endsWith(".py"))!)];
      cb(r.code ? Object.assign(new Error("exit"), { code: r.code }) : null, r.stdout, "");
    }),
  };
});
vi.mock("../../src/utils/python.js", () => ({ findPython: vi.fn(() => ({ cmd: "python", args: [], version: "3.14.2" })) }));

const { execFileSync, spawnSync } = await import("node:child_process");
const { findPython } = await import("../../src/utils/python.js");
const { formatPreflight, missionPreflight } = await import("../../src/tools/mission-preflight.js");
const { missionNames } = await import("../../src/tools/mission-names.js");
const { makeProjects, write } = await import("../coalition/fixture.js");
const { buildTestPak } = await import("../pak/test-pak.js");
const { LOBBY_GUID } = await import("../../src/utils/coalition-paths.js");

const hasGit = spawnSync("git", ["--version"]).status === 0;
const git = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "ignore" });
const fixture = (name: string) => readFileSync(join(import.meta.dirname, "../fixtures/mission", name), "utf-8");

describe.skipIf(!hasGit)("mission_preflight", { timeout: 30_000 }, () => {
  let fx: ReturnType<typeof makeProjects>;
  beforeAll(() => {
    fx = makeProjects();
    const profile = mkdtempSync(join(tmpdir(), "preflight-profile-"));
    write(profile, "logs/logs_2026-11-02_10-00-00/error.log", "10:00:02.000 SCRIPT    (E): Faction '12' is not a valid SCR_Faction\n");
    process.env.ENFUSION_WORKBENCH_PROFILE = profile;
    const origin = join(fx.root, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", origin]);
    git(fx.crf, "init", "-q", "-b", "release");
    git(fx.crf, "add", ".");
    git(fx.crf, "commit", "-q", "-m", "release");
    git(fx.crf, "remote", "add", "origin", origin);
    git(fx.crf, "push", "-q", "origin", "release");
    git(fx.crf, "fetch", "-q", "origin");
    git(fx.crf, "checkout", "-q", "-b", "mission/fixture");
    // The fixture world, changed on the branch and not committed
    write(fx.crf, "Worlds/Test/Author_TVT_Fixture.ent", 'SubScene {\n Parent "{9000000000000001}Worlds/Test/Test.ent"\n}\n\n');
    Object.assign(replies, {
      "validate_mission.py": { code: 1, stdout: fixture("qa_fail.txt") },
      "mission_synopsis.py": { code: 0, stdout: fixture("synopsis.txt") },
      "validate_resources.py": { code: 0, stdout: "All checks passed.\n" },
    });
  }, 30_000);
  afterAll(() => delete process.env.ENFUSION_WORKBENCH_PROFILE);

  it("marks automatic rows from the tools, leaves the in-game rows open, and says no-go", async () => {
    const r = await missionPreflight(fx.config, { world: "Worlds/Test/Author_TVT_Fixture.ent" });
    const status = Object.fromEntries(r.rows.map((x) => [x.item, x.status]));
    expect(r.verdict).toBe("no-go");
    expect(status).toMatchObject({
      "Branch is mission/<name> (CI runs Mission QA only there)": "pass",
      "Up to date with release": "pass",
      "World, layers, .conf and added files committed": "fail",
      "No MCP handler files in the change": "pass",
      "Mission QA (validate_mission.py, as CI)": "fail",
      "Resource integrity (validate_resources.py, as CI)": "pass",
      "Automatic boxes: mission file, .conf, play area and markers, briefings": "pass",
      "Logs: no script errors": "fail",
      "Slot in as each side: slotting menu, factions and ratios": "in game",
      "Read every side's briefing in game": "in game",
      "Spawn in: each side's gearscript and safe start zone": "in game",
      "Play every objective through to a win for each side": "in game",
      "Check map markers and the play area border for each side": "in game",
      "Join in progress with Start only clients": "in game",
      "Gearscripts tested in game": "in game",
      "Faction(s), Objectives and the briefing screenshot filled in": "you",
    });
    const row = (item: string) => r.rows.find((x) => x.item.startsWith(item))!;
    expect(row("Mission QA").detail).toBe("3 failures, 0 warnings");
    expect(row("Automatic boxes").detail).toBe("5/5 ticked");
    expect(row("Spawn in").detail).toBe("files: BLUFOR has no safestart zone; INDFOR has no safestart zone");
    // The same verdict mission_names and mission_inspect give on their own
    const names = missionNames(fx.config, { action: "check", world: "Worlds/Test/Author_TVT_Fixture.ent" }).split("\n").filter((l) => l.startsWith("WARNING "));
    expect(row("Names follow plugin 6").status).toBe(names.length ? "fail" : "pass");
    expect(row("mission_inspect rules").status).toBe("warn");
    expect(row("mission_inspect rules").detail).toContain("Vanilla composition on the guide's avoid list");
    const text = formatPreflight(r);
    expect(text).toMatch(/^# Preflight Worlds\/Test\/Author_TVT_Fixture\.ent: NO-GO/);
    expect(text.indexOf("## Before you submit")).toBeLessThan(text.indexOf("## Submitting"));
    expect(text).toContain("- [in game] Join in progress with Start only clients");
  });

  it("picks the changed world itself, and marks the CRF checks not run without Python", async () => {
    vi.mocked(findPython).mockReturnValueOnce(null);
    const r = await missionPreflight(fx.config);
    expect(r.world).toBe("Worlds/Test/Author_TVT_Fixture.ent");
    const qa = r.rows.find((x) => x.item.startsWith("Mission QA"))!;
    expect(qa).toMatchObject({ status: "not run" });
    expect(qa.detail).toMatch(/Python 3 not found/);
    expect(r.verdict).toBe("no-go");
  });

  it("an option-like base stops mission_git, which shows as not run, and nothing runs with it", async () => {
    const r = await missionPreflight(fx.config, { world: "Worlds/Test/Author_TVT_Fixture.ent", base: "--output=x" });
    expect(r.rows.find((x) => x.item.startsWith("mission_git"))).toMatchObject({ status: "not run", detail: expect.stringContaining("--output=x is not a commit") });
  });

  // Last: it moves the Lobby clone into a Workshop pak
  it("reads the Lobby through its Workshop copy when no clone is beside CRF", async () => {
    const files = readdirSync(fx.lobby, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => relative(fx.lobby, join(e.parentPath, e.name)).replace(/\\/g, "/"));
    const ws = join(fx.root, "workshop", `COALITIONLobby_${LOBBY_GUID}`);
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "ServerData.json"), '{"name":"x","revision":{"version":"2.0.10"}}');
    writeFileSync(join(ws, "data.pak"), buildTestPak(files.map((p) => ({ path: p, content: readFileSync(join(fx.lobby, p), "utf-8"), compress: false }))));
    rmSync(fx.lobby, { recursive: true });
    const r = await missionPreflight({ ...fx.config, workshopPath: join(fx.root, "workshop") }, { world: "Worlds/Test/Author_TVT_Fixture.ent" });
    const row = (item: string) => r.rows.find((x) => x.item.startsWith(item))!;
    expect(row("Names follow plugin 6").status).not.toBe("not run");
    expect(row("mission_inspect rules")).toMatchObject({ status: "warn" });
    // INDFOR's slots come from the Lobby's COA_Lobby.et, now read from the pak
    expect(row("Spawn in").detail).toBe("files: BLUFOR has no safestart zone; INDFOR has no safestart zone");
  });
});
