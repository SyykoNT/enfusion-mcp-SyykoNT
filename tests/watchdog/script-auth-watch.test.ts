import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWatcher, stamp, type WatchDeps, type WatchOpts } from "../../src/watchdog/wb-watch.js";
import type { LoadSet } from "../../src/watchdog/auth.js";
import type { ProbeSample } from "../../src/watchdog/probe.js";
import { textHash, type WinInfo } from "../../src/watchdog/signals.js";
import { eventLines } from "../../src/workbench/status.js";

// Temp folders and stubs only: no probe, PowerShell, process or Workbench runs, and the lock file is a temp file.
const at = (hms: string) => new Date(`2026-10-31T${hms}`).getTime();
const START = at("06:12:43.000");
const FIND = "Allow script 'Scripts/Game/MCPAuthProbe/MCPAuthProbe_GameCalls.c:32'\nto access potentially dangerous\nmethod 'FileIO.FindFiles'?";
const RUNCMD = "Allow script 'Scripts/WorkbenchGame/MCPAuthProbe/MCPAuthProbe_Plugins.c:43'\nto access potentially dangerous\nmethod 'Workbench.RunCmd'?";
const dialog = (hwnd: number): WinInfo => ({ hwnd, cls: "Qt683QWindowIcon", text: "Script Authorization Required", visible: true, owner: 0, enabled: true });
const withText = (hwnd: number, text: string): WinInfo => ({ ...dialog(hwnd), children: [{ hwnd: 0, cls: "Text", text }] });
const CRASH = "------------------------------------\r\n31.10 2026 09:32:55\r\nAssertion failed\r\n\r\nLine: 1287\r\n\r\nReason: Resources are leaking! Check log!\r\n";

/** The addons a fake Workbench loaded: script path to [addon, source text]. */
const loaded = (files: Record<string, [string, string]>, extra: Partial<LoadSet> = {}): LoadSet => ({
  find: (p) => (files[p] ? { addon: files[p][0], source: () => files[p][1] } : undefined),
  clones: [], looseRoots: [], ...extra,
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "emcp-auth-"));
  const logDir = join(root, "logs", "logs_2026-10-31_06-12-43");
  const stateDir = join(root, "watch");
  mkdirSync(logDir, { recursive: true });
  mkdirSync(stateDir);
  writeFileSync(join(logDir, "console.log"), "06:12:44.479   ENGINE       : CLI Params: -gproj x\r\n");
  const lock = join(root, "WORKBENCH_LOCK.txt");
  writeFileSync(lock, "owner: someone\r\npid: 19524\r\n");
  const clock = { now: at("06:13:30.000") };
  const sample: ProbeSample = { t: 0, alive: true, start: START, ws: 4e9, cpu: 100, wins: [], crs: [], port: null };
  const shown: Record<number, WinInfo> = {};
  const readAuth = vi.fn(async (_pid: number, hwnd: number) => shown[hwnd]);
  const answer = vi.fn(async (_pid: number, _hwnd: number, _choice: 1 | 2 | 3, _hash: number) => "answered");
  const opts = (over: Partial<WatchOpts> = {}): WatchOpts => ({
    pid: 19524, owned: false, stateDir, logsRoot: join(root, "logs"), dismiss: "watched", autoRecover: false, recoverAfterMin: 5,
    host: "127.0.0.1", port: 5775, lock, ...over,
  });
  const watcher = (over: Partial<WatchOpts> = {}, deps: Partial<WatchDeps> = {}) =>
    createWatcher(opts(over), {
      sample: () => sample, alive: () => true, now: () => clock.now, dismiss: vi.fn(async () => "clicked"), recover: vi.fn(async () => ""),
      readAuth, answer, loadSet: () => loaded({ "Scripts/Game/MCPAuthProbe/MCPAuthProbe_GameCalls.c": ["MCPAuthProbe", "x"] }), ...deps,
    });
  /** Open a dialog with `text` in the fake Workbench. */
  const open = (hwnd: number, text: string) => {
    shown[hwnd] = withText(hwnd, text);
    sample.wins = [dialog(hwnd)];
  };
  const events = () => readFileSync(join(stateDir, "events.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  const lockLines = () => readFileSync(lock, "utf-8").split("\r\n").filter((l) => l.startsWith("AUTH") || l.startsWith("CRASH"));
  return { root, logDir, stateDir, lock, clock, sample, readAuth, answer, opts, watcher, open, events, lockLines };
}

describe("Script Authorization in the watcher", () => {
  it.each([
    ["a test addon", "MCPAuthProbe"], ["a user mod", "MyMod"], ["CRF", "Coalition-Reforger-Framework"],
    ["COALITION-Lobby", "COALITION-Lobby"], ["a Workshop mod", "SomeMod_ABCDEF0123456789"], ["vanilla", "ArmaReforger"],
  ])("rules: Yes for a script call from %s, logged in the report, events.jsonl and the lock file", async (_n, addon) => {
    const t = setup();
    const w = t.watcher({}, { loadSet: () => loaded({ "Scripts/Game/MCPAuthProbe/MCPAuthProbe_GameCalls.c": [addon, ""] }) });
    t.open(9001, FIND);
    const s = await w.tick();
    expect(t.answer).toHaveBeenCalledWith(19524, 9001, 1, textHash(FIND));
    const line = `AUTH 06:13:30 PID 19524 YES script 'Scripts/Game/MCPAuthProbe/MCPAuthProbe_GameCalls.c:32' (${addon}) method 'FileIO.FindFiles' mode rules reason a script in a loaded addon`;
    expect(s.actions.some((a) => a.startsWith(line))).toBe(true);
    expect(s.dialog?.text).toBe("Allow script 'Scripts/Game/MCPAuthProbe/MCPAuthProbe_GameCalls.c:32' to access potentially dangerous method 'FileIO.FindFiles'?");
    expect(t.events().filter((e) => e.kind === "auth").map((e) => e.action.slice(0, line.length))).toEqual([line]);
    expect(t.lockLines().map((l) => l.slice(0, line.length))).toEqual([line]);
  });

  it("rules: No for a script that is in no loaded addon", async () => {
    const t = setup();
    t.open(9001, FIND);
    await t.watcher({}, { loadSet: () => loaded({}) }).tick();
    expect(t.answer).toHaveBeenCalledWith(19524, 9001, 2, textHash(FIND));
    expect(t.lockLines()[0]).toContain("NO script 'Scripts/Game/MCPAuthProbe/MCPAuthProbe_GameCalls.c:32' (not in a loaded addon)");
  });

  it("rules: a program run is left open and named with its command from the source line; it stays reported as blocked after 10 s", async () => {
    const plugin = "MCPAuthProbe_Plugins.c";
    const call = '    Workbench.RunCmd("cmd /c exit 0", true);';
    const path = `Scripts/WorkbenchGame/MCPAuthProbe/${plugin}`;
    // The dialog names line 43: the call is on it
    const t = setup();
    t.open(9002, RUNCMD);
    const file = `${Array(42).fill("").join("\n")}\n${call}\n`;
    const w = t.watcher({}, { loadSet: () => loaded({ [path]: ["MCPAuthProbe", file] }) });
    await w.tick();
    expect(t.answer).not.toHaveBeenCalled();
    expect(t.lockLines()[0]).toContain(`LEFT OPEN script '${path}:43' (MCPAuthProbe) method 'Workbench.RunCmd' command 'cmd /c exit 0' mode rules reason Workbench.RunCmd runs a program`);

    // The call is more than two lines after the named line: the command is not read from it
    const u = setup();
    u.open(9002, RUNCMD);
    await u.watcher({}, { loadSet: () => loaded({ [path]: ["MCPAuthProbe", `${Array(45).fill("").join("\n")}\n${call}\n`] }) }).tick();
    expect(u.lockLines()[0]).toContain("method 'Workbench.RunCmd' command not readable from source");

    // Still open 12 s later: the state is blocked_dialog and says what kind of dialog it is
    t.clock.now += 12_000;
    const s = await w.tick();
    expect([s.state, s.kind]).toEqual(["blocked_dialog", "script_authorization"]);
    expect(t.answer).not.toHaveBeenCalled();
  });
  it("rules: a dialog that cannot be read, or whose addons cannot be read, is left open", async () => {
    const t = setup();
    t.sample.wins = [dialog(9003)]; // readAuth finds nothing
    await t.watcher().tick();
    t.open(9004, FIND);
    await t.watcher({}, { loadSet: () => undefined }).tick();
    expect(t.answer).not.toHaveBeenCalled();
    expect(t.lockLines().map((l) => l.includes("LEFT OPEN"))).toEqual([true, true]);
    expect(t.lockLines()[0]).toContain("script (unreadable) method (unreadable)");
  });

  it("all: Yes to All on a program run and on an unreadable dialog", async () => {
    const t = setup();
    t.open(9005, RUNCMD);
    await t.watcher({ scriptAuth: "all" }).tick();
    t.sample.wins = [dialog(9006)]; // readAuth finds nothing: unreadable
    await t.watcher({ scriptAuth: "all" }).tick();
    expect(t.answer.mock.calls.map((c) => c[2])).toEqual([3, 3]);
    expect(t.lockLines().map((l) => l.includes("YES TO ALL") && l.includes("mode all"))).toEqual([true, true]);
  });

  it("off, and a scope that leaves the Workbench out, press nothing; owned scope presses an owned Workbench", async () => {
    const t = setup();
    t.open(9007, FIND);
    await t.watcher({ scriptAuth: "off" }).tick();
    await t.watcher({ scriptAuth: "rules", authScope: "never" }).tick();
    await t.watcher({ scriptAuth: "all", authScope: "owned", owned: false }).tick();
    expect(t.answer).not.toHaveBeenCalled();
    expect(t.lockLines()).toHaveLength(3);
    expect(t.lockLines().every((l) => l.includes("LEFT OPEN"))).toBe(true);
    await t.watcher({ scriptAuth: "all", authScope: "owned", owned: true }).tick();
    expect(t.answer.mock.calls.map((c) => c[2])).toEqual([3]);
  });
  it("an automatic, not-owned watcher answers exactly as an explicit watch (authorizeScripts watched): rules gives Yes to a loaded addon, off reports", async () => {
    const t = setup();
    t.open(9001, FIND);
    const s = await t.watcher({ auto: true, scriptAuth: "rules" }).tick();
    expect(t.answer).toHaveBeenCalledExactlyOnceWith(19524, 9001, 1, textHash(FIND));
    expect(s.actions.some((a) => a.startsWith("AUTH 06:13:30 PID 19524 YES "))).toBe(true);

    const u = setup();
    u.open(9001, FIND);
    await u.watcher({ auto: true, scriptAuth: "off" }).tick();
    expect(u.answer).not.toHaveBeenCalled();
    expect(u.lockLines()[0]).toContain("LEFT OPEN");
  });

  it("looks once per dialog window, and stops after 3 automatic answers for one call in 60 s", async () => {
    const t = setup();
    const w = t.watcher();
    t.open(9001, FIND);
    await w.tick();
    await w.tick();
    expect(t.answer).toHaveBeenCalledTimes(1);
    for (const hwnd of [9002, 9003, 9004]) {
      t.open(hwnd, FIND);
      t.clock.now += 2000;
      await w.tick();
    }
    expect(t.answer).toHaveBeenCalledTimes(3);
    expect(t.lockLines().map((l) => l.split(" ")[4])).toEqual(["YES", "YES", "YES", "LEFT"]);
    expect(t.lockLines()[3]).toContain("loop limit");
    t.open(9005, FIND);
    t.clock.now += 70_000;
    await w.tick();
    expect(t.answer).toHaveBeenCalledTimes(4);
  });

  it("a refused press is reported as left open with the script's reason", async () => {
    const t = setup();
    t.open(9001, FIND);
    t.answer.mockResolvedValueOnce("refused: the dialog text changed");
    await t.watcher().tick();
    expect(t.lockLines()[0]).toContain("LEFT OPEN");
    expect(t.lockLines()[0]).toContain("the answer was refused: refused: the dialog text changed");
  });

  it("the lock file is written only when one is configured; the next tool result reads the event once", async () => {
    const t = setup();
    t.open(9001, FIND);
    await t.watcher({ lock: undefined }).tick();
    expect(t.lockLines()).toEqual([]);
    expect(t.events().some((e) => e.kind === "auth")).toBe(true);
    const first = eventLines(t.stateDir, 0);
    expect(first.lines).toHaveLength(1);
    expect(first.lines[0]).toMatch(/^AUTH 06:13:30 PID 19524 YES /);
    expect(eventLines(t.stateDir, first.last).lines).toEqual([]);
    expect(eventLines(join(t.root, "none"), 0)).toEqual({ lines: [], last: 0 });
  });

  it("without the auth deps (a test or an older caller) the dialog is only reported, as before", async () => {
    const t = setup();
    t.open(9001, FIND);
    const s = await createWatcher(t.opts(), { sample: () => t.sample, alive: () => true, now: () => t.clock.now, dismiss: vi.fn(), recover: vi.fn() }).tick();
    expect(t.answer).not.toHaveBeenCalled();
    expect(s.actions).toEqual([]);
  });

  it("after an answer in a Workbench that loaded CRF or Lobby, the log has the git status and the diff stat of the gear list, and nothing is restored", async () => {
    const t = setup();
    const clone = join(t.root, "COALITION-Lobby");
    const gear = join(clone, "Configs", "Gearscripts", "GearScriptsConfigList.json");
    mkdirSync(join(clone, "Configs", "Gearscripts"), { recursive: true });
    writeFileSync(gear, '{"files": ["a.conf"]}\n');
    const git = (...a: string[]) => execFileSync("git", ["-C", clone, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdio: "ignore" });
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "one");
    writeFileSync(gear, '{"files": []}\n'); // what a No on the gear-list hook leaves behind, or a Yes rewrites
    const before = readFileSync(gear, "utf-8");
    t.open(9001, FIND);
    await t.watcher({}, { loadSet: () => loaded({ "Scripts/Game/MCPAuthProbe/MCPAuthProbe_GameCalls.c": ["COALITION-Lobby", ""] }, { clones: [{ name: "COALITION-Lobby", root: clone }], looseRoots: [clone] }) }).tick();
    const line = t.lockLines()[0];
    expect(line).toMatch(/\[git: COALITION-Lobby: 1 changed files, GearScriptsConfigList\.json .*1 file changed, 1 insertion\(\+\), 1 deletion\(-\)\]/);
    expect(line).toContain("[edds changed in mounted folders, last 5 min: 0]");
    expect(readFileSync(gear, "utf-8")).toBe(before);
    expect(execFileSync("git", ["-C", clone, "status", "--porcelain"], { encoding: "utf-8" })).toContain("GearScriptsConfigList.json");
  });

  it("the press is still logged in the report, events.jsonl and the lock file when git is not on PATH", async () => {
    const t = setup();
    const clone = join(t.root, "COALITION-Lobby");
    mkdirSync(clone);
    t.open(9001, FIND);
    const path = process.env.PATH;
    process.env.PATH = join(t.root, "no-git-here"); // git then fails with ENOENT, which gitOrNull turns into a throw
    try {
      await t.watcher({}, { loadSet: () => loaded({ "Scripts/Game/MCPAuthProbe/MCPAuthProbe_GameCalls.c": ["COALITION-Lobby", ""] }, { clones: [{ name: "COALITION-Lobby", root: clone }] }) }).tick();
    } finally {
      process.env.PATH = path;
    }
    expect(t.answer).toHaveBeenCalledOnce();
    const line = t.lockLines()[0];
    expect(line).toContain("YES");
    expect(line).toContain("[git: COALITION-Lobby: git not available]");
    expect(t.events().map((e) => [e.kind, e.action])).toEqual([["auth", line]]);
    expect(eventLines(t.stateDir, 0).lines).toHaveLength(1);
  });

  it("counts .edds files changed in the mounted folders in the last 5 minutes", async () => {
    const t = setup();
    const proj = join(t.root, "proj");
    mkdirSync(join(proj, "Textures"), { recursive: true });
    writeFileSync(join(proj, "Textures", "a.edds"), "x");
    writeFileSync(join(proj, "Textures", "old.edds"), "x");
    writeFileSync(join(proj, "Textures", "b.txt"), "x");
    utimesSync(join(proj, "Textures", "old.edds"), Date.now() / 1000 - 3600, Date.now() / 1000 - 3600);
    t.open(9001, FIND);
    t.clock.now = Date.now();
    await t.watcher({}, { loadSet: () => loaded({ "Scripts/Game/MCPAuthProbe/MCPAuthProbe_GameCalls.c": ["P", ""] }, { looseRoots: [proj] }) }).tick();
    expect(t.lockLines()[0]).toContain("[edds changed in mounted folders, last 5 min: 1]");
  });
});

describe("a crash of a watched Workbench", () => {
  /** A Workbench that is gone with a fresh crash.log, a dump and its log files in the run's logs folder. */
  function crashed(files: string[]) {
    const t = setup();
    for (const f of files) writeFileSync(join(t.logDir, f), `content of ${f}\n`.repeat(3));
    writeFileSync(join(t.logDir, "crash.log"), CRASH);
    appendFileSync(join(t.logDir, "console.log"), "09:32:55.739  RESOURCES    : last line\r\n");
    utimesSync(join(t.logDir, "crash.log"), at("09:32:55.800") / 1000, at("09:32:55.800") / 1000);
    t.clock.now = at("09:33:00.000");
    return t;
  }
  const crashDirOf = (t: ReturnType<typeof setup>) => join(t.root, "Workbench Crash Logs");

  it("reports at once, copies crash.log, the dump and the log files, ends only its own CrashReporter, and logs each step", async () => {
    const t = crashed(["a.mdmp", "script.log", "error.log"]);
    const originals = readdirSync(t.logDir).map((n) => [n, readFileSync(join(t.logDir, n), "utf-8")]);
    const kill = vi.fn();
    const reporters = [
      { pid: 88, ppid: 19524, cmd: "CrashReporter.exe", created: at("09:32:56.000") }, // this Workbench's
      { pid: 89, ppid: 555, cmd: "CrashReporter.exe", created: at("09:32:56.000") }, // another Workbench's
      { pid: 19524, ppid: 19524, cmd: "ArmaReforgerWorkbenchSteamDiag.exe", created: START }, // the Workbench itself, listed by mistake
    ];
    const w = t.watcher({ crashDir: crashDirOf(t) }, { alive: () => false, crashReporters: () => reporters, killProcess: kill });
    const s = await w.tick();

    expect([s.state, s.kind]).toEqual(["crashed", "Resources are leaking! Check log!"]);
    const dest = join(crashDirOf(t), `${stamp(t.clock.now)}_19524`);
    expect(readdirSync(dest).sort()).toEqual(["a.mdmp", "console.log", "crash.log", "error.log", "script.log"]);
    for (const [n, text] of originals) expect(readFileSync(join(t.logDir, n as string), "utf-8")).toBe(text); // originals untouched
    for (const n of readdirSync(dest)) expect(readFileSync(join(dest, n), "utf-8")).toBe(readFileSync(join(t.logDir, n), "utf-8"));
    expect(kill.mock.calls).toEqual([[88]]);

    const line = t.lockLines()[0];
    expect(line).toMatch(/^CRASH 09:33:00 PID 19524 reason Resources are leaking! Check log! copied 5 files to .*Workbench Crash Logs.* \(crash\.log \d+ bytes, console\.log \d+ bytes, error\.log \d+ bytes, script\.log \d+ bytes, a\.mdmp \d+ bytes\) CrashReporter 88 ended/);
    expect(t.events().filter((e) => e.kind === "crash")).toHaveLength(1);
    expect(s.actions.some((a) => a.startsWith("CRASH "))).toBe(true);
    expect(JSON.parse(readFileSync(join(t.stateDir, "19524.json"), "utf-8")).state).toBe("crashed");
  });

  it("an automatic, not-owned watcher handles a crash as an explicit watch does: logs copied, only its own CrashReporter ended", async () => {
    const t = crashed(["script.log", "error.log"]);
    const kill = vi.fn();
    const reporters = [
      { pid: 88, ppid: 19524, cmd: "CrashReporter.exe", created: at("09:32:56.000") },
      { pid: 89, ppid: 555, cmd: "CrashReporter.exe", created: at("09:32:56.000") },
    ];
    await t.watcher({ auto: true, owned: false, crashDir: crashDirOf(t) }, { alive: () => false, crashReporters: () => reporters, killProcess: kill }).tick();
    expect(kill.mock.calls).toEqual([[88]]);
    expect(readdirSync(join(crashDirOf(t), `${stamp(t.clock.now)}_19524`)).sort()).toEqual(["console.log", "crash.log", "error.log", "script.log"]);
    expect(t.lockLines()[0]).toContain("CrashReporter 88 ended");
  });

  it("says what is missing: no error.log, no dump", async () => {
    const t = crashed(["script.log"]);
    await t.watcher({ crashDir: crashDirOf(t) }, { alive: () => false, crashReporters: () => [], killProcess: vi.fn() }).tick();
    const line = t.lockLines()[0];
    expect(line).toContain("copied 3 files");
    expect(line).toContain("missing error.log, *.mdmp CrashReporter none");
  });

  it("a copy already in the crash folder is kept, and the run is handled once", async () => {
    const t = crashed(["script.log", "error.log"]);
    const kill = vi.fn();
    const w = t.watcher({ crashDir: crashDirOf(t) }, { alive: () => false, crashReporters: () => [], killProcess: kill });
    await w.tick();
    const dest = join(crashDirOf(t), `${stamp(t.clock.now)}_19524`);
    const size = statSync(join(dest, "crash.log")).size;
    await w.tick();
    expect(statSync(join(dest, "crash.log")).size).toBe(size);
    expect(t.lockLines()).toHaveLength(1);
  });

  it("with no crash folder set nothing is copied, and a Workbench that exited normally is not a crash", async () => {
    const t = crashed([]);
    await t.watcher({}, { alive: () => false, crashReporters: () => [], killProcess: vi.fn() }).tick();
    expect(t.lockLines()[0]).toContain("copied 0 files to (no folder) missing no crash logs folder is set");
    expect(existsSync(crashDirOf(t))).toBe(false);

    const n = setup();
    appendFileSync(join(n.logDir, "console.log"), "09:32:55.739  RESOURCES    : ResourceDB: saving cache\r\n");
    n.clock.now = at("09:33:00.000");
    const s = await n.watcher({ crashDir: crashDirOf(n) }, { alive: () => false, crashReporters: () => [], killProcess: vi.fn() }).tick();
    expect(s.state).toBe("exited");
    expect(n.lockLines()).toEqual([]);
  });
});
