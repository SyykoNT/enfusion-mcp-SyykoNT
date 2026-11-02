import { describe, it, expect, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../../src/config.js";
import { gitOrNull } from "../../src/release/git.js";
import { doctorRows, doctorText, type Probe, type Row } from "../../src/tools/coalition-doctor.js";

const hasGit = spawnSync("git", ["--version"]).status === 0;
const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

const put = (path: string, text = "") => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const gproj = (id: string, guid: string, deps: string[]) => `GameProject {\n ID "${id}"\n GUID "${guid}"\n TITLE "${id}"\n Dependencies {\n  ${deps.map((d) => `"${d}"`).join(" ")}\n }\n}\n`;
const g = (dir: string, ...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "pipe" });
function repo(dir: string, origin: string, ignoreHandlers = true) {
  g(dir, "init", "-q", "-b", "release");
  g(dir, "remote", "add", "origin", origin);
  g(dir, "add", "-A");
  g(dir, "commit", "-q", "-m", "init");
  g(dir, "update-ref", "refs/remotes/origin/release", "HEAD");
  if (ignoreHandlers) writeFileSync(join(dir, ".git", "info", "exclude"), "Scripts/WorkbenchGame/EnfusionMCP/\n");
}

/** A PC laid out as the guide's Tools Setup describes, under a temp folder; `docs` is the Documents folder name. */
function guidePc(opts: { docs?: string; link?: "junction" | "folder" | "none"; dep?: boolean; git?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "emcp-doctor-"));
  roots.push(root);
  const myGames = join(root, opts.docs ?? "Documents", "My Games");
  const gameAddons = join(myGames, "ArmaReforger", "addons");
  const wb = join(myGames, "ArmaReforgerWorkbench");
  const projects = join(wb, "Projects");
  const game = join(root, "steam", "Arma Reforger");
  put(join(game, "ArmaReforgerSteam.exe"));
  put(join(game, "addons", "data", "ArmaReforger.gproj"), gproj("ArmaReforger", "58D0FB3206B6F859", []));
  put(join(root, "steam", "Arma Reforger Tools", "Workbench", "ArmaReforgerWorkbenchSteamDiag.exe"));
  put(join(root, "steam", "Arma Reforger Server", "ArmaReforgerServer.exe"));
  put(join(gameAddons, "ModX_AAAAAAAAAAAAAAAA", "addon.gproj"), gproj("ModX", "AAAAAAAAAAAAAAAA", ["58D0FB3206B6F859"]));
  const crf = join(projects, "Coalition-Reforger-Framework");
  put(join(crf, "Tools", "Validation", "validate_mission.py"));
  put(join(crf, "addon.gproj"), gproj("COALITIONFramework", "5EB3564A02CE294F", ["58D0FB3206B6F859", "69EA43E490A50DBE", "AAAAAAAAAAAAAAAA", ...(opts.dep ? ["BBBBBBBBBBBBBBBB"] : [])]));
  const lobby = join(projects, "COALITION-Lobby");
  put(join(lobby, "addon.gproj"), gproj("COALITIONLobby", "69EA43E490A50DBE", ["58D0FB3206B6F859"]));
  if (opts.git !== false) {
    repo(crf, "https://github.com/CoalitionArma/Coalition-Reforger-Framework.git");
    g(crf, "checkout", "-q", "-b", "mission/the-patrol");
    repo(lobby, "https://github.com/CoalitionArma/COALITION-Lobby.git");
  }
  if (opts.link === "folder") mkdirSync(join(wb, "addons"), { recursive: true });
  else if (opts.link !== "none") symlinkSync(gameAddons, join(wb, "addons"), "junction");
  const config = {
    workbenchPath: join(root, "steam", "Arma Reforger Tools"), gamePath: game, serverPath: join(root, "steam", "Arma Reforger Server"),
    projectPath: projects, workshopPath: gameAddons, protectedAddons: ["5EB3564A02CE294F", "69EA43E490A50DBE"],
  } as Config;
  const probe: Probe = {
    myGames,
    // The machine's global git identity is not part of the fixture
    git: (dir, args) => (args[0] === "config" ? (args.at(-1) === "user.name" ? "Tanaka" : "tanaka@example.com") : gitOrNull(dir, args)),
    gitHubDesktop: join(root, "GitHubDesktop.exe"), python: "3.11.9", enfusionProtocol: true,
  };
  return { root, config, probe, crf };
}
const row = (rows: Row[], item: string) => rows.find((r) => r.item === item)!;
const snapshot = (dir: string) => readdirSync(dir, { recursive: true }).map((f) => `${f}|${statSync(join(dir, String(f))).mtimeMs}`).sort();

describe.skipIf(!hasGit)("coalition_doctor", () => {
  it("turns every row green on a PC laid out as the guide says, and writes nothing", () => {
    const pc = guidePc();
    const before = snapshot(pc.root);
    const rows = doctorRows(pc.config, pc.probe);
    // The Workbench Launcher's project list is never read, so that row is always by hand
    expect(rows.filter((r) => r.state !== "ok").map((r) => [r.item, r.state])).toEqual([["Open the framework project", "manual"]]);
    expect(rows).toHaveLength(20);
    expect(row(rows, "Check the link").found).toContain("the game's addons");
    expect(row(rows, "Create your mission branch").found).toBe("mission/the-patrol");
    expect(snapshot(pc.root)).toEqual(before);
  });

  it("explains a missing link with the mklink command, and a real folder on OneDrive as expected", () => {
    const missing = guidePc({ link: "none", git: false });
    const r = doctorRows(missing.config, missing.probe);
    expect(row(r, "Link the game's mods into the Workbench")).toMatchObject({ state: "missing", fix: expect.stringContaining('mklink /J "') });
    expect(row(r, "Check the link").state).toBe("missing");

    const od = guidePc({ docs: join("OneDrive", "Documents"), link: "folder", git: false });
    const o = doctorRows(od.config, od.probe);
    expect(row(o, "Link the game's mods into the Workbench")).toMatchObject({ state: "info", found: expect.stringContaining("(Documents is on OneDrive)"), fix: expect.stringContaining("copy your addons over by hand") });
    expect(row(o, "Check the link").state).toBe("info");

    const real = guidePc({ link: "folder", git: false });
    expect(row(doctorRows(real.config, real.probe), "Link the game's mods into the Workbench").state).toBe("warn");
  });

  it("flags a missing dependency, a foreign origin, unignored handlers, unprotected addons and a missing PC tool", () => {
    const pc = guidePc({ dep: true });
    g(pc.crf, "remote", "set-url", "origin", "https://github.com/someone/fork.git");
    writeFileSync(join(pc.crf, ".git", "info", "exclude"), "");
    const rows = doctorRows({ ...pc.config, protectedAddons: ["5EB3564A02CE294F"] }, { ...pc.probe, python: null, gitHubDesktop: null });
    expect(row(rows, "Download the server mods in the game")).toMatchObject({ state: "warn", found: expect.stringContaining("1 CRF/Lobby dependencies not downloaded: ? {BBBBBBBBBBBBBBBB}") });
    expect(row(rows, "Clone the framework").state).toBe("warn");
    expect(row(rows, "Workbench handler files git-ignored")).toMatchObject({ state: "warn", found: `not ignored in ${pc.crf}` });
    expect(row(rows, "ENFUSION_PROTECTED_ADDONS").state).toBe("warn");
    expect(row(rows, "Python 3.11+ (mission_validate)").state).toBe("missing");
    expect(row(rows, "GitHub Desktop, signed in").state).toBe("missing");
    expect(doctorText(rows)).toMatch(/^## Coalition Tools Setup check\n\n\d+ OK, 2 missing, 4 to check/);
  });
});
