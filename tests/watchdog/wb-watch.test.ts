import { describe, it, expect, vi } from "vitest";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("clicks Ignore after 5 s in a Workbench it did not start (D-031), logs it and reports the reload that follows", async () => {
    const t = setup();
    const w = t.watcher();
    t.log("02:14:08.000  SCRIPT       : SCRIPT       : Reloading game scripts");
    t.sample.wins = [leakBox];
    t.clock.now = at("02:14:09.000");
    await w.tick();
    t.clock.now = at("02:14:14.000");
    let s = await w.tick();
    expect(t.dismiss).toHaveBeenCalledExactlyOnceWith(19524, 7001);
    expect(s.actions).toEqual(["Ignore clicked 02:14:14"]);
    t.clock.now = at("02:14:19.000");
    await w.tick();
    expect(t.dismiss).toHaveBeenCalledTimes(1);
    t.sample.wins = [];
    t.log("02:14:20.000 PROFILING    : Reloading game scripts took: 12000.0 ms");
    t.clock.now = at("02:14:24.000");
    s = await w.tick();
    expect(s.actions).toEqual(["Ignore clicked 02:14:14", "reload finished 02:14:20"]);
    expect(s.state).toBe("ok");
    const logged = readFileSync(join(t.stateDir, "events.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l).action).filter(Boolean);
    expect(logged).toEqual(["Ignore clicked 02:14:14", "reload finished 02:14:20"]);
  });

  it("reports a Qt modal (owner disabled, not a #32770 box) as blocked_dialog other with its title, and never clicks it", async () => {
    const t = setup();
    const w = t.watcher();
    const main = { hwnd: 7100, cls: "Qt683QWindowIcon", text: "World Editor", visible: true, hung: false, owner: 0, ownerEnabled: null };
    t.sample.wins = [main, { hwnd: 7101, cls: "Qt683QWindowIcon", text: "Validating $MCPParity:Worlds/ScnStub_V1.ent", visible: true, hung: false, owner: 7100, ownerEnabled: false }];
    await w.tick();
    t.clock.now += 12_000;
    const s = await w.tick();
    expect([s.state, s.kind]).toEqual(["blocked_dialog", "other"]);
    expect(s.dialog?.title).toBe("Validating $MCPParity:Worlds/ScnStub_V1.ent");
    expect(t.dismiss).not.toHaveBeenCalled();
    t.sample.wins = [main];
    expect((await w.tick()).state).toBe("ok");
  });

  it("a second watcher on the same PID exits with already watched", async () => {
    const t = setup();
    expect(claimWatch(t.stateDir, 19524)).toEqual({ ok: true });
    const probe = vi.fn();
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await runWatcher(t.opts(), { probe })).toBe(3);
    expect(err).toHaveBeenCalledWith(`already watched by watcher PID ${process.pid}\n`);
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
