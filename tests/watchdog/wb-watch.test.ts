import { describe, it, expect, vi } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventLines, watchAlerts } from "../../src/workbench/status.js";
import { alerts, claimWatch, createWatcher, findLogDir, runWatcher, type WatchOpts, type WatchState } from "../../src/watchdog/wb-watch.js";
import type { ProbeSample } from "../../src/watchdog/probe.js";

// Temp folders only: a fake log root, fake projects and a fake state dir. No probe, PowerShell or Workbench runs.
const at = (hms: string) => new Date(`2026-10-31T${hms}`).getTime();
const START = at("06:12:43.000");
const CRASH = "------------------------------------\r\n31.10 2026 09:32:55\r\nAssertion failed\r\n\r\nLine: 1287\r\n\r\nReason: Resources are leaking! Check log!\r\n";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "emcp-watch-"));
  const logDir = join(root, "logs", "logs_2026-10-31_06-12-43");
  const stateDir = join(root, "watch");
  mkdirSync(logDir, { recursive: true });
  mkdirSync(stateDir);
  const addon = (name: string, guid: string, deps: string[]) => {
    mkdirSync(join(root, "projects", name, "Scripts", "Game"), { recursive: true });
    writeFileSync(join(root, "projects", name, "addon.gproj"), `GameProject {\n GUID "${guid}"\n Dependencies {\n  ${deps.map((d) => `"${d}"`).join(" ")}\n }\n}`);
    return join(root, "projects", name);
  };
  const test = addon("SYK_AMTest", "4833511065131B41", ["58D0FB3206B6F859", "761C2D648D80BA76"]);
  const nav = addon("Navmesh", "761C2D648D80BA76", []);
  const other = addon("NotLoaded", "A08A4D2609C9E981", []);
  const trigger = join(nav, "Scripts", "Game", "SYK_VDD_BoatRouteData.c");
  for (const f of [trigger, join(other, "Scripts", "Game", "Same.c")]) {
    writeFileSync(f, "class X {}");
    utimesSync(f, at("09:32:52.635") / 1000, at("09:32:52.635") / 1000);
  }
  const fwd = (p: string) => p.replace(/\\/g, "/");
  writeFileSync(join(logDir, "console.log"), [
    `06:12:44.479   ENGINE       : CLI Params: -gproj ${join(test, "addon.gproj")} -addonsDir ${join(root, "projects")} -wbModule WorldEditor`,
    `06:12:44.794    ENGINE       : gproj: '${fwd(join(test, "addon.gproj"))}' guid: '4833511065131B41'`,
    `06:12:44.794    ENGINE       : gproj: '${fwd(join(nav, "addon.gproj"))}' guid: '761C2D648D80BA76'`,
    `06:12:44.794    ENGINE       : gproj: '${fwd(join(other, "addon.gproj"))}' guid: 'A08A4D2609C9E981'`,
    "06:13:27.050 DEFAULT      : Pending workshop invites request done (1)",
    "",
  ].join("\r\n"));
  const log = (line: string) => appendFileSync(join(logDir, "console.log"), line + "\r\n");
  const clock = { now: at("06:13:30.000") };
  const sample: ProbeSample = { t: 0, alive: true, start: START, ws: 4e9, cpu: 100, wins: [], crs: [], port: null };
  const dismiss = vi.fn(async () => "clicked");
  const opts = (over: Partial<WatchOpts> = {}): WatchOpts => ({
    pid: 19524, owned: false, stateDir, logsRoot: join(root, "logs"), dismiss: "watched", autoRecover: false, recoverAfterMin: 5,
    host: "127.0.0.1", port: 5775, ...over,
  });
  const watcher = (over: Partial<WatchOpts> = {}) =>
    createWatcher(opts(over), { sample: () => sample, alive: () => true, now: () => clock.now, dismiss, recover: vi.fn(async () => "") });
  return { root, logDir, stateDir, trigger, log, clock, sample, dismiss, opts, watcher };
}
const leakBox = { hwnd: 7001, cls: "#32770", text: "Assertion Failed", visible: true, hung: false, children: [
  { hwnd: 7002, cls: "Static", text: "Reason: Resources are leaking! Check log!" }, { hwnd: 7003, cls: "Button", text: "&Ignore" },
] };

describe("watcher main loop", () => {
  it("replays 2026-10-31: busy, blocked by the leak assert with the trigger named, then back to ok; with dismiss owned it never clicks a Workbench it does not own", async () => {
    const t = setup();
    const w = t.watcher({ dismiss: "owned" });
    expect((await w.tick()).state).toBe("ok");

    t.log("09:32:52.901  SCRIPT       : SCRIPT       : Reloading game scripts");
    t.clock.now = at("09:32:53.500");
    let s = await w.tick();
    expect(s.state).toBe("busy");
    expect(s.trigger).toEqual([t.trigger]);

    writeFileSync(join(t.logDir, "crash.log"), CRASH);
    utimesSync(join(t.logDir, "crash.log"), at("09:32:55.800") / 1000, at("09:32:55.800") / 1000);
    t.log("09:32:55.739  RESOURCES    : ThermalProfile system/thermal/thermalProfileTerrainDefault.conf 65 bytes 160");
    t.sample.wins = [leakBox];
    t.clock.now = at("09:32:58.000");
    s = await w.tick();
    expect([s.state, s.kind]).toEqual(["blocked_dialog", "leak_assert"]);
    expect(s.since).toBe(at("09:32:58.000"));
    t.clock.now = at("12:01:00.000");
    s = await w.tick();
    expect(s.dialog?.text).toContain("Resources are leaking!");
    expect(t.dismiss).not.toHaveBeenCalled();

    t.sample.wins = [];
    t.log("12:01:28.636  ENGINE       : Game destroyed.");
    t.clock.now = at("12:01:30.000");
    expect((await w.tick()).state).toBe("busy");
    t.log("12:01:38.153 PROFILING    : Reloading game scripts took: 8925251.756100 ms");
    t.clock.now = at("12:01:40.000");
    s = await w.tick();
    expect(s.state).toBe("ok");
    expect(s.lastLines.at(-1)).toContain("Reloading game scripts took");

    const saved = JSON.parse(readFileSync(join(t.stateDir, "19524.json"), "utf-8")) as WatchState;
    expect(saved.state).toBe("ok");
    const events = readFileSync(join(t.stateDir, "events.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l).state);
    expect(events).toEqual(["busy", "blocked_dialog", "busy", "ok"]);
  });

  it("clicks Ignore after 5 s in a Workbench it did not start (D-031), logs it as a DIALOG event and reports the reload that follows", async () => {
    const t = setup();
    const w = t.watcher();
    t.log("02:14:08.000  SCRIPT       : SCRIPT       : Reloading game scripts");
    t.sample.wins = [leakBox];
    t.clock.now = at("02:14:09.000");
    await w.tick();
    t.clock.now = at("02:14:14.000");
    let s = await w.tick();
    expect(t.dismiss).toHaveBeenCalledExactlyOnceWith(19524, 7001);
    const press = 'DIALOG 02:14:14 PID 19524 Ignore pressed on "Reason: Resources are leaking! Check log! | &Ignore"';
    expect(s.actions).toEqual([press]);
    t.clock.now = at("02:14:19.000");
    await w.tick();
    expect(t.dismiss).toHaveBeenCalledTimes(1);
    t.sample.wins = [];
    t.log("02:14:20.000 PROFILING    : Reloading game scripts took: 12000.0 ms");
    t.clock.now = at("02:14:24.000");
    s = await w.tick();
    expect(s.actions).toEqual([press, "reload finished 02:14:20"]);
    expect(s.state).toBe("ok");
    const logged = readFileSync(join(t.stateDir, "events.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l).action).filter(Boolean);
    expect(logged).toEqual([press, "reload finished 02:14:20"]);
    const dialogs = readFileSync(join(t.stateDir, "events.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "dialog");
    expect(dialogs.map((e) => e.action)).toEqual([press]);
    expect(eventLines(t.stateDir, 0).lines.filter((l) => l.startsWith("DIALOG"))).toEqual([press]);
  });

  it("a refused Ignore press is a DIALOG event too, with the reason", async () => {
    const t = setup();
    t.dismiss.mockResolvedValueOnce("refused: the dialog text changed");
    const w = t.watcher();
    t.sample.wins = [leakBox];
    t.clock.now = at("02:14:09.000");
    await w.tick();
    t.clock.now = at("02:14:14.000");
    const s = await w.tick();
    expect(s.actions).toEqual(["DIALOG 02:14:14 PID 19524 Ignore not pressed: refused: the dialog text changed"]);
    expect(eventLines(t.stateDir, 0).lines).toEqual(s.actions);
  });

  it("reports a Qt modal (owner disabled, not a #32770 box) as blocked_dialog other with its title, and never clicks it", async () => {
    const t = setup();
    const w = t.watcher();
    const main = { hwnd: 7100, cls: "Qt683QWindowIcon", text: "World Editor", visible: true, hung: false, owner: 0, ownerEnabled: null, enabled: false };
    const tool = { hwnd: 7102, cls: "Qt683QWindowToolSaveBits", text: "Resource Browser", visible: true, hung: false, owner: 7100, ownerEnabled: false, enabled: false };
    t.sample.wins = [main, tool, { hwnd: 7101, cls: "Qt683QWindowIcon", text: "Validating $MCPParity:Worlds/ScnStub_V1.ent", visible: true, hung: false, owner: 7100, ownerEnabled: false, enabled: true }];
    await w.tick();
    t.clock.now += 12_000;
    const s = await w.tick();
    expect([s.state, s.kind]).toEqual(["blocked_dialog", "other"]);
    expect(s.dialog?.title).toBe("Validating $MCPParity:Worlds/ScnStub_V1.ent"); // not the disabled Resource Browser listed before it
    expect(t.dismiss).not.toHaveBeenCalled();
    t.sample.wins = [main];
    expect((await w.tick()).state).toBe("ok");
  });

  it("a second watcher on the same PID exits with already watched", async () => {
    const t = setup();
    writeFileSync(join(t.stateDir, "19524.lock"), String(process.ppid)); // another live process holds the lock
    const probe = vi.fn();
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await runWatcher(t.opts(), { probe })).toBe(3);
    expect(err).toHaveBeenCalledWith(`already watched by watcher PID ${process.ppid}\n`);
    expect(probe).not.toHaveBeenCalled();
    err.mockRestore();
    // A lock left by a dead watcher is taken over.
    writeFileSync(join(t.stateDir, "4242.lock"), "999999");
    expect(claimWatch(t.stateDir, 4242, () => false)).toEqual({ ok: true });
  });

  it("exits when the Workbench PID is gone, after a final report, and frees the lock", async () => {
    const t = setup();
    const stop = vi.fn();
    let alive = true;
    const code = await runWatcher(t.opts({ logsRoot: undefined }), {
      probe: () => ({ stop }),
      alive: () => alive,
      wait: async () => { alive = false; },
    });
    expect(code).toBe(0);
    expect(stop).toHaveBeenCalled();
    expect(existsSync(join(t.stateDir, "19524.lock"))).toBe(false);
    expect(JSON.parse(readFileSync(join(t.stateDir, "19524.json"), "utf-8")).state).toBe("exited");
  });

  it("finds the log folder named after the process start, within 3 s", () => {
    const t = setup();
    expect(findLogDir(join(t.root, "logs"), START + 2500)).toBe(t.logDir);
    expect(findLogDir(join(t.root, "logs"), START + 4000)).toBeUndefined();
  });
});

describe("alerts for hooks", () => {
  it("prints each alert once per session", () => {
    const t = setup();
    const st = (state: string, since: number) => ({ pid: 19524, watcherPid: process.pid, owned: false, state, kind: "leak_assert", since, lastLines: [], actions: [], dismiss: "owned", autoRecover: false, updated: since });
    writeFileSync(join(t.stateDir, "19524.json"), JSON.stringify(st("blocked_dialog", at("09:32:58.000"))));
    const out = alerts(t.stateDir, "session-a", "UserPromptSubmit", at("09:40:00.000"));
    expect(JSON.parse(out)).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit",
      additionalContext: "Workbench PID 19524 blocked by leak_assert since 09:32:58 (7 min). Run wb_watch status for details." } });
    expect(alerts(t.stateDir, "session-a", "PostToolUse", at("09:41:00.000"))).toBe("");
    expect(alerts(t.stateDir, "session-b", "PostToolUse", at("09:41:00.000"))).not.toBe("");
    writeFileSync(join(t.stateDir, "19524.json"), JSON.stringify(st("ok", at("12:01:40.000"))));
    expect(alerts(t.stateDir, "session-a", "PostToolUse", at("12:02:00.000"))).toBe("");
  });
});

describe("automatic watch", () => {
  const events = (dir: string) => readFileSync(join(dir, "events.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));

  it("init saves the first state at once with auto set, and announces the watch once in events.jsonl (not in the report)", () => {
    const t = setup();
    const w = t.watcher({ auto: true, scriptAuth: "all" });
    expect(existsSync(join(t.stateDir, "19524.json"))).toBe(false);
    w.init();
    const saved = JSON.parse(readFileSync(join(t.stateDir, "19524.json"), "utf-8")) as WatchState;
    expect([saved.auto, saved.owned, saved.state, saved.actions]).toEqual([true, false, "ok", []]);
    expect(events(t.stateDir)).toEqual([{
      t: t.clock.now, pid: 19524, kind: "watch",
      action: "WATCH 06:13:30 PID 19524 attached automatically (not started by this MCP): Ignore on the leak assert, Script Authorization by ENFUSION_SCRIPT_AUTH=all",
    }]);
    expect(eventLines(t.stateDir, 0).lines).toHaveLength(1);
    expect(eventLines(t.stateDir, t.clock.now).lines).toEqual([]);
  });

  it("an explicit watch has no auto flag and no WATCH event; the mode text defaults to rules", () => {
    const t = setup();
    t.watcher().init();
    expect(JSON.parse(readFileSync(join(t.stateDir, "19524.json"), "utf-8"))).not.toHaveProperty("auto");
    expect(existsSync(join(t.stateDir, "events.jsonl"))).toBe(false);
    const u = setup();
    u.watcher({ auto: true }).init();
    expect(events(u.stateDir)[0].action).toContain("ENFUSION_SCRIPT_AUTH=rules");
  });

  it("runWatcher writes the WATCH event after the claim: one event for a claim, none when another watcher holds the PID (exit 3)", async () => {
    const t = setup();
    const stop = vi.fn();
    let alive = true;
    expect(await runWatcher(t.opts({ auto: true, logsRoot: undefined }), { probe: () => ({ stop }), alive: () => alive, wait: async () => { alive = false; } })).toBe(0);
    expect(events(t.stateDir).filter((e) => e.kind === "watch")).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(t.stateDir, "19524.json"), "utf-8")).auto).toBe(true);

    const held = setup();
    writeFileSync(join(held.stateDir, "19524.lock"), String(process.ppid)); // another live process holds the lock
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await runWatcher(held.opts({ auto: true }), { probe: vi.fn() })).toBe(3);
    err.mockRestore();
    expect(existsSync(join(held.stateDir, "events.jsonl"))).toBe(false);
    expect(existsSync(join(held.stateDir, "19524.json"))).toBe(false);
  });
});

describe("watcher keeps its own lock honest (B-097) and the state after Ignore (B-098)", () => {
  const run = (t: ReturnType<typeof setup>, over: Parameters<typeof runWatcher>[1]) => runWatcher(t.opts({ logsRoot: undefined }), { probe: () => ({ stop: vi.fn() }), ...over });

  it("a lock rewritten to another PID mid-run: the watcher exits 3 and leaves that lock in place", async () => {
    const t = setup();
    const lock = join(t.stateDir, "19524.lock");
    const stop = vi.fn();
    // The wait yields a macrotask: if the per-tick check regresses, the loop never ends but the vitest timeout still fires.
    const code = await runWatcher(t.opts({ logsRoot: undefined }), {
      probe: () => ({ stop }), alive: () => true, wait: () => new Promise((r) => setImmediate(() => { writeFileSync(lock, String(process.ppid)); r(undefined); })),
    });
    expect(code).toBe(3);
    expect(stop).toHaveBeenCalled();
    expect(readFileSync(lock, "utf-8")).toBe(String(process.ppid));
  });

  it("a lock that cannot be read for one tick (not ENOENT) keeps the watcher running; a deleted lock ends it with 3", async () => {
    const t = setup();
    const lock = join(t.stateDir, "19524.lock");
    let n = 0;
    const alive = () => n < 3;
    // A directory in place of the lock makes the read fail with EISDIR, standing in for EBUSY/EPERM from a scanner.
    const wait = () => new Promise((r) => setImmediate(() => {
      n++;
      if (n === 1) { rmSync(lock); mkdirSync(lock); }
      if (n === 2) { rmSync(lock, { recursive: true }); writeFileSync(lock, String(process.pid)); }
      r(undefined);
    }));
    expect(await run(t, { alive, wait })).toBe(0);
    expect(n).toBe(3);

    const u = setup();
    const gone = join(u.stateDir, "19524.lock");
    expect(await run(u, { alive: () => true, wait: () => new Promise((r) => setImmediate(() => { rmSync(gone); r(undefined); })) })).toBe(3);
  });

  it("a lock that cannot be read at exit is left in place and does not change the return code", async () => {
    const t = setup();
    const lock = join(t.stateDir, "19524.lock");
    let n = 0;
    // The Workbench is gone at the second check; the lock becomes unreadable (a directory stands in for EBUSY/EPERM) just before the exit-time read.
    const alive = () => { if (++n === 2) { rmSync(lock); mkdirSync(lock); } return n < 2; };
    expect(await run(t, { alive, wait: () => new Promise((r) => setImmediate(() => r(undefined))) })).toBe(0);
    expect(existsSync(lock)).toBe(true);
  });

  it("exits with a foreign lock (taken during the last tick): the lock is left; a normal exit deletes its own", async () => {
    const t = setup();
    const lock = join(t.stateDir, "19524.lock");
    expect(await run(t, { alive: () => { writeFileSync(lock, String(process.ppid)); return false; } })).toBe(0);
    expect(readFileSync(lock, "utf-8")).toBe(String(process.ppid));
    const u = setup();
    expect(await run(u, { alive: () => false })).toBe(0);
    expect(existsSync(join(u.stateDir, "19524.lock"))).toBe(false);
  });

  it("claimWatch: a lock that cannot be read is held whatever its age; an empty one older than 5 s is stale", () => {
    const t = setup();
    const lock = join(t.stateDir, "4242.lock");
    mkdirSync(lock); // EISDIR on read, standing in for EBUSY/EPERM
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    expect(claimWatch(t.stateDir, 4242, () => false)).toEqual({ ok: false, by: 0 });
    expect(existsSync(lock)).toBe(true);
    rmSync(lock, { recursive: true });
    writeFileSync(lock, "");
    utimesSync(lock, old, old);
    expect(claimWatch(t.stateDir, 4242, () => false)).toEqual({ ok: true });
  });

  it("an empty lock (a claim being written) logs 'already watched (lock being written)', not 'watcher PID 0'", async () => {
    const t = setup();
    writeFileSync(join(t.stateDir, "19524.lock"), "");
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await run(t, {})).toBe(3);
    expect(err).toHaveBeenCalledWith("already watched (lock being written)\n");
    err.mockRestore();
  });

  it("after a successful Ignore the state is ok at once and stays ok while crash.log still shows the assert: no blocked line", async () => {
    const t = setup();
    const w = t.watcher();
    t.log("02:14:08.000  SCRIPT       : SCRIPT       : Reloading game scripts");
    writeFileSync(join(t.logDir, "crash.log"), CRASH);
    utimesSync(join(t.logDir, "crash.log"), at("02:14:08.500") / 1000, at("02:14:08.500") / 1000);
    t.sample.wins = [leakBox];
    t.clock.now = at("02:14:09.000");
    expect((await w.tick()).state).toBe("blocked_dialog");
    expect(watchAlerts(t.stateDir, t.clock.now)).toContain("blocked by leak_assert");
    t.clock.now = at("02:14:14.000");
    expect((await w.tick()).state).toBe("ok");
    expect(t.dismiss).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(join(t.stateDir, "19524.json"), "utf-8")).state).toBe("ok");
    expect(watchAlerts(t.stateDir, t.clock.now)).toBe("");
    // The dialog is gone, the log has no new line yet: crash.log alone does not block again
    t.sample.wins = [];
    t.clock.now = at("02:14:19.000");
    expect((await w.tick()).state).not.toBe("blocked_dialog");
    expect(watchAlerts(t.stateDir, t.clock.now)).toBe("");
  });

  it("a refused Ignore leaves the state blocked", async () => {
    const t = setup();
    t.dismiss.mockResolvedValueOnce("refused: the dialog text changed");
    const w = t.watcher();
    t.log("02:14:08.000  SCRIPT       : SCRIPT       : Reloading game scripts");
    writeFileSync(join(t.logDir, "crash.log"), CRASH);
    utimesSync(join(t.logDir, "crash.log"), at("02:14:08.500") / 1000, at("02:14:08.500") / 1000);
    t.sample.wins = [leakBox];
    t.clock.now = at("02:14:09.000");
    await w.tick();
    t.clock.now = at("02:14:14.000");
    expect((await w.tick()).state).toBe("blocked_dialog");
  });
});
