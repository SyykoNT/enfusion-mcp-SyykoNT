import { describe, it, expect, vi } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerAction, watchAction, type AnswerDeps, type WatchToolDeps } from "../../src/tools/wb-watch-tool.js";
import { endCrashReporters, gitReport, loadSetOf } from "../../src/watchdog/auth.js";
import { textHash, type WinInfo } from "../../src/watchdog/signals.js";
import { formatConnectionStatus, watchEvents } from "../../src/workbench/status.js";
import type { Config } from "../../src/config.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";

// Temp state dir and lock file; the dialog, the press, the processes and the watcher spawn are stubs.
const RUNCMD = "Allow script 'Scripts/WorkbenchGame/MCPAuthProbe/MCPAuthProbe_Plugins.c:43'\nto access potentially dangerous\nmethod 'Workbench.RunCmd'?";
const dialog = (text: string): WinInfo => ({
  hwnd: 5001, cls: "Qt683QWindowIcon", text: "Script Authorization Required", visible: true, owner: 0, enabled: true,
  children: [{ hwnd: 0, cls: "Text", text }],
});

function answerDeps(over: Partial<AnswerDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "emcp-ans-"));
  writeFileSync(join(dir, "19524.lock"), "600"); // a live watcher
  const lock = join(dir, "WORKBENCH_LOCK.txt");
  writeFileSync(lock, "owner: someone\r\n");
  const press = vi.fn(async (_pid: number, _hwnd: number, _choice: 1 | 2, _hash: number) => "answered Yes");
  const d: AnswerDeps = {
    stateDir: dir, alive: (pid) => pid === 600, dialogs: async () => [dialog(RUNCMD)], press, loadSet: () => undefined, mode: "rules", lock, now: () => new Date("2026-11-03T10:30:00").getTime(),
    ...over,
  };
  return { d, press, dir, lock };
}
const args = { action: "answer" as const, pid: 19524, choice: "no" as const, reason: "command not readable from source" };

describe("wb_watch answer", () => {
  it("refuses with no open Script Authorization dialog, and presses nothing", async () => {
    const { d, press } = answerDeps({ dialogs: async () => [] });
    expect(await answerAction(args, d)).toEqual({ text: "No Script Authorization dialog is open in Workbench PID 19524; nothing was pressed.", isError: true });
    const other: WinInfo = { hwnd: 1, cls: "Qt683QWindowIcon", text: "Opening world", visible: true, owner: 0, enabled: true };
    expect((await answerAction(args, answerDeps({ dialogs: async () => [other] }).d)).isError).toBe(true);
    expect(press).not.toHaveBeenCalled();
  });

  it("presses the chosen button on the open dialog and logs it as explicit, with the reason, in events.jsonl and the lock file", async () => {
    const { d, press, dir, lock } = answerDeps();
    const r = await answerAction(args, d);
    expect(r.isError).toBeUndefined();
    expect(press).toHaveBeenCalledWith(19524, 5001, 2, textHash(RUNCMD));
    const line = r.text;
    expect(line).toMatch(/^AUTH 10:30:00 PID 19524 NO explicit script 'Scripts\/WorkbenchGame\/MCPAuthProbe\/MCPAuthProbe_Plugins\.c:43' \(not in a loaded addon\) method 'Workbench\.RunCmd' command not readable from source mode rules reason command not readable from source/);
    const events = readFileSync(join(dir, "events.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events).toEqual([{ t: new Date("2026-11-03T10:30:00").getTime(), pid: 19524, action: line, kind: "auth" }]);
    expect(readFileSync(lock, "utf-8")).toContain(`${line}\r\n`);
  });

  it("yes presses Yes; Yes to All and No to All cannot be chosen; the reason is required", async () => {
    const { d, press } = answerDeps();
    await answerAction({ ...args, choice: "yes" }, d);
    expect(press.mock.calls[0][2]).toBe(1);
    for (const choice of ["yes_to_all", "No to All", undefined]) {
      expect((await answerAction({ ...args, choice: choice as "yes" }, d)).isError).toBe(true);
    }
    expect((await answerAction({ ...args, reason: "  " }, d)).text).toMatch(/reason is required/);
    expect((await answerAction({ ...args, pid: undefined }, d)).text).toMatch(/pid is required/);
    expect(press).toHaveBeenCalledTimes(1);
  });

  it("refuses a Workbench that is not watched, and a press the script refused", async () => {
    const { d } = answerDeps({ alive: () => false });
    expect((await answerAction(args, d)).text).toMatch(/not watched/);
    const refused = answerDeps({ press: async () => "refused: the dialog text changed" });
    expect(await answerAction(args, refused.d)).toEqual({ text: "Not answered: refused: the dialog text changed", isError: true });
    expect(existsSync(join(refused.dir, "events.jsonl"))).toBe(false);
  });
});

describe("wb_watch start with authorizeScripts", () => {
  const WB = '"C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arma Reforger Tools\\Workbench\\ArmaReforgerWorkbenchSteamDiag.exe" -gproj x';
  const deps = () => {
    const d: WatchToolDeps = {
      stateDir: mkdtempSync(join(tmpdir(), "emcp-wt2-")), proc: (pid) => (pid === 19524 ? { pid, ppid: 1, cmd: WB, created: 1 } : undefined),
      owned: () => false, alive: () => false, start: vi.fn(() => 700), kill: vi.fn(), base: { host: "127.0.0.1", port: 5775, scriptAuth: "all", crashDir: "C:\\crash" },
    };
    return d;
  };

  it("passes the scope and the base settings to the watcher; the scope defaults to watched", () => {
    const d = deps();
    expect(watchAction({ action: "start", pid: 19524 }, d).text).toContain("authorizeScripts = watched");
    expect(d.start).toHaveBeenLastCalledWith(expect.objectContaining({ authScope: "watched", scriptAuth: "all", crashDir: "C:\\crash" }));
    watchAction({ action: "start", pid: 19524, authorizeScripts: "never" }, d);
    expect(d.start).toHaveBeenLastCalledWith(expect.objectContaining({ authScope: "never" }));
  });
});

describe("the next live tool result", () => {
  const client = { state: { connected: true, mode: "edit" } } as unknown as WorkbenchClient;

  it("carries one line per new auth or crash event, once", () => {
    const dir = mkdtempSync(join(tmpdir(), "emcp-ev-"));
    const t = Date.now() + 5000;
    const ev = (kind: string | undefined, action: string, dt: number) => JSON.stringify({ t: t + dt, pid: 1, action, ...(kind ? { kind } : {}) }) + "\n";
    writeFileSync(join(dir, "events.jsonl"), ev(undefined, "Ignore clicked 10:00:00", 0) + ev("auth", "AUTH 10:00:01 PID 1 YES script 'a.c:1' (A) method 'M.N' mode rules reason r", 1) + ev("crash", "CRASH 10:01:00 PID 1 reason x copied 0 files to (no folder) CrashReporter none", 2));
    const status = formatConnectionStatus(client, dir);
    expect(status).toBe(
      "\n\n---\n`Workbench: edit mode`" +
        "\n`Watchdog: AUTH 10:00:01 PID 1 YES script 'a.c:1' (A) method 'M.N' mode rules reason r`" +
        "\n`Watchdog: CRASH 10:01:00 PID 1 reason x copied 0 files to (no folder) CrashReporter none`"
    );
    expect(formatConnectionStatus(client, dir)).toBe("\n\n---\n`Workbench: edit mode`");
    appendFileSync(join(dir, "events.jsonl"), ev("auth", "AUTH 10:02:00 PID 1 NO script 'b.c:2' (B) method 'M.N' mode rules reason r", 3));
    expect(watchEvents(dir)).toBe("\n`Watchdog: AUTH 10:02:00 PID 1 NO script 'b.c:2' (B) method 'M.N' mode rules reason r`");
  });
});

describe("endCrashReporters", () => {
  const cr = (pid: number, ppid: number, created: number) => ({ pid, ppid, cmd: "CrashReporter.exe", created });

  it("ends only a CrashReporter whose parent is the crashed Workbench and that started after it", () => {
    const kill = vi.fn();
    const out = endCrashReporters(100, 1_000_000, [cr(1, 100, 1_500_000), cr(2, 101, 1_500_000), cr(3, 100, 1000), cr(100, 100, 1_500_000)], kill, () => false);
    expect(out).toEqual([{ pid: 1, ended: true }]);
    expect(kill.mock.calls).toEqual([[1]]);
  });

  it("says so when the process is still there after the request", () => {
    expect(endCrashReporters(100, undefined, [cr(1, 100, 6000)], vi.fn(), () => true)).toEqual([{ pid: 1, ended: false, why: "still running after the end request" }]);
  });
});

describe("the load set of a Workbench", () => {
  function project() {
    const root = mkdtempSync(join(tmpdir(), "emcp-ls-"));
    const addon = (name: string, guid: string, deps: string[], files: Record<string, string> = {}) => {
      const dir = join(root, "projects", name);
      mkdirSync(join(dir, "Scripts", "Game"), { recursive: true });
      writeFileSync(join(dir, "addon.gproj"), `GameProject {\n ID "${name}"\n GUID "${guid}"\n Dependencies {\n  ${deps.map((d) => `"${d}"`).join(" ")}\n }\n}\n`);
      for (const [p, text] of Object.entries(files)) writeFileSync(join(dir, p), text);
      return dir;
    };
    const lobby = addon("COALITION-Lobby", "1111111111111111", [], { "Scripts/Game/Hook.c": "// lobby\n" });
    addon("MyMission", "2222222222222222", ["1111111111111111"], { "Scripts/Game/Hook.c": "// mission copy\n", "Scripts/Game/Own.c": "// own\n" });
    addon("NotLoaded", "3333333333333333", [], { "Scripts/Game/Other.c": "// not loaded\n" });
    const config = { projectPath: join(root, "projects"), workshopPath: join(root, "workshop"), gamePath: join(root, "game") } as Config;
    return { root, lobby, config, cmd: `"C:\\Tools\\Workbench.exe" -gproj "${join(root, "projects", "MyMission", "addon.gproj")}" -addonsDir "${join(root, "projects")}"` };
  }

  it("finds a script in the top addon that holds it, names that addon, and lists the clones", () => {
    const p = project();
    const set = loadSetOf(p.config, p.cmd)!;
    expect(set.find("Scripts/Game/Hook.c")?.addon).toBe("MyMission");
    expect(set.find("Scripts/Game/Hook.c")?.source()).toBe("// mission copy\n");
    expect(set.find("Scripts\\Game\\Own.c")?.addon).toBe("MyMission");
    expect(set.find("Scripts/Game/Other.c")).toBeUndefined(); // an addon in the folder that this Workbench did not load
    expect(set.clones.map((c) => c.name)).toEqual(["COALITION-Lobby"]);
    expect(set.looseRoots).toHaveLength(2);
  });

  it("is undefined when the command line has no -gproj or the project cannot be read", () => {
    const p = project();
    expect(loadSetOf(p.config, '"C:\\Tools\\Workbench.exe"')).toBeUndefined();
    expect(loadSetOf(p.config, '"C:\\Tools\\Workbench.exe" -gproj "C:\\nowhere\\addon.gproj"')).toBeUndefined();
  });

  it("the git report says when a folder is not a clone of its own, and runs read-only", () => {
    const p = project();
    expect(gitReport([{ name: "COALITION-Lobby", root: p.lobby }])).toBe("COALITION-Lobby: not a git clone of its own");
  });
});
