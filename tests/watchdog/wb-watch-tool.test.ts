import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchAction, type WatchArgs, type WatchToolDeps } from "../../src/tools/wb-watch-tool.js";
import { formatConnectionStatus, watchAlerts } from "../../src/workbench/status.js";
import { alertLine, autoBlocked, createWatcher, formatReport, type WatchState } from "../../src/watchdog/wb-watch.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";

// Temp state dir and lock file; processes, ownership and the watcher spawn are stubs.
const lockPath = join(mkdtempSync(join(tmpdir(), "emcp-wt-lock-")), "WORKBENCH_LOCK.txt");
const at = (hms: string) => new Date(`2026-10-31T${hms}`).getTime();
const WB = "\"C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arma Reforger Tools\\Workbench\\ArmaReforgerWorkbenchSteamDiag.exe\" -gproj x";

function deps(over: Partial<WatchToolDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "emcp-wt-"));
  const procs: Record<number, string> = { 19524: WB, 600: "node.exe C:\\x\\dist\\watchdog\\wb-watch.js --pid 19524", 4242: "notepad.exe" };
  const d: WatchToolDeps = {
    stateDir: dir,
    proc: (pid) => (procs[pid] ? { pid, ppid: 1, cmd: procs[pid], created: at("06:12:43.000") } : undefined),
    owned: () => false,
    alive: (pid) => pid === 600 || pid === 19524,
    start: vi.fn(() => 700),
    kill: vi.fn(),
    base: { host: "127.0.0.1", port: 5775 },
    ...over,
  };
  return d;
}

describe("wb_watch start", () => {
  it("attaches a watcher to a Workbench this MCP did not start: Ignore on the leak assert by default, no recovery", async () => {
    const d = deps();
    const r = await watchAction({ action: "start", pid: 19524, autoRecover: true }, d);
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("not owned: never closed or killed");
    expect(d.start).toHaveBeenCalledWith(expect.objectContaining({ pid: 19524, owned: false, autoRecover: false, dismiss: "watched", startTime: at("06:12:43.000") }));
  });

  it("refuses a PID that is not Workbench, and a second watcher", async () => {
    const d = deps();
    expect(await watchAction({ action: "start", pid: 4242 }, d)).toEqual({ text: "PID 4242 is not a Workbench process.", isError: true });
    writeFileSync(join(d.stateDir, "19524.lock"), "600");
    expect(await watchAction({ action: "start", pid: 19524 }, d)).toEqual({ text: "already watched by watcher PID 600", isError: true });
    expect(d.start).not.toHaveBeenCalled();
  });

  it("review B1: a person's lock text never makes a Workbench owned; hung for 5 min with autoRecover, no Exit and no kill", async () => {
    const d = deps();
    writeFileSync(lockPath, "owner: Alex (AM test)\r\npid: 19524\r\nsince: 2026-10-31 06:12\r\n");
    // The old adopt arguments are ignored: ownership comes only from isOwned (stubbed false here).
    await watchAction({ action: "start", pid: 19524, adopt: true, owner: "Alex (AM test)", autoRecover: true } as WatchArgs, d);
    const started = vi.mocked(d.start).mock.calls[0][0];
    expect(started).toMatchObject({ owned: false, autoRecover: false });
    expect(started).not.toHaveProperty("owner");

    // Run those options, and also an owned watcher (as if started with --owned), against a person's lock and a window hung for 6 min.
    const run = async (opts: { owned: boolean; autoRecover: boolean; session?: string }) => {
      let now = at("10:00:00.000");
      const recover = vi.fn(async () => "");
      const hung = { hwnd: 1, cls: "Qt5QWindowIcon", text: "Workbench", visible: true, hung: true, children: [] };
      const w = createWatcher(
        { pid: 19524, stateDir: d.stateDir, lock: lockPath, dismiss: "watched", recoverAfterMin: 5, host: "127.0.0.1", port: 5775, ...opts },
        { sample: () => ({ t: 0, alive: true, start: at("06:12:43.000"), ws: 4e9, cpu: 1, wins: [hung], crs: [], port: 19524 }),
          alive: () => true, now: () => now, dismiss: vi.fn(async () => ""), recover }
      );
      let s;
      for (let i = 0; i <= 72; i++, now += 5000) s = await w.tick();
      expect(s!.state).toBe("not_responding");
      return recover.mock.calls.length;
    };
    expect(await run({ owned: started.owned, autoRecover: !!started.autoRecover })).toBe(0);
    expect(await run({ owned: true, autoRecover: true })).toBe(0);
    // Control: an owned Workbench whose lock names this session is recovered once.
    writeFileSync(lockPath, "owner: overnight-boats\r\nsession: s1\r\npid: 19524\r\n");
    expect(await run({ owned: true, autoRecover: true, session: "s1" })).toBe(1);
  });

  it("passes dismissLeakAssert never through", async () => {
    const d = deps();
    expect((await watchAction({ action: "start", pid: 19524, dismissLeakAssert: "never" }, d)).text).toContain("dismissLeakAssert = never");
    expect(d.start).toHaveBeenCalledWith(expect.objectContaining({ dismiss: "never" }));
  });
});

describe("wb_watch stop", () => {
  it("ends only a real watcher and clears its files", async () => {
    const d = deps();
    writeFileSync(join(d.stateDir, "19524.lock"), "600");
    writeFileSync(join(d.stateDir, "19524.json"), JSON.stringify({ pid: 19524, watcherPid: 600 }));
    expect((await watchAction({ action: "stop", pid: 19524 }, d)).text).toBe("Stopped watcher PID 600 for Workbench PID 19524.");
    expect(d.kill).toHaveBeenCalledWith(600);
    expect(existsSync(join(d.stateDir, "19524.json"))).toBe(false);
    // The lock names a live process that is not a watcher (the Workbench itself): never killed.
    writeFileSync(join(d.stateDir, "19524.lock"), "19524");
    expect((await watchAction({ action: "stop", pid: 19524 }, d)).isError).toBe(true);
    expect(d.kill).toHaveBeenCalledTimes(1);
  });

  it("T1 finding 1: a live wb-watch lock holder is not killed when the state names another watcher or its --pid is another Workbench", async () => {
    const procs: Record<number, string> = {
      19524: WB, 600: "node.exe C:\\x\\dist\\watchdog\\wb-watch.js --pid 19524", 601: "node.exe C:\\x\\dist\\watchdog\\wb-watch.js --pid 195240",
    };
    const d = deps({ alive: (pid) => pid in procs, proc: (pid) => (procs[pid] ? { pid, ppid: 1, cmd: procs[pid], created: 1 } : undefined) });
    // Holder 600 runs wb-watch for this PID, but the state names watcher 650 (600 is a reused PID).
    writeFileSync(join(d.stateDir, "19524.lock"), "600");
    writeFileSync(join(d.stateDir, "19524.json"), JSON.stringify({ pid: 19524, watcherPid: 650, auto: true }));
    expect(await watchAction({ action: "stop", pid: 19524 }, d)).toEqual({ text: "PID 600 holds the watch lock for 19524 but is not its watcher. Not stopped.", isError: true });
    expect(await watchAction({ action: "start", pid: 19524 }, d)).toEqual({ text: "already watched by watcher PID 600", isError: true });
    // Holder 601 is named by the state, but watches Workbench 195240: --pid must match as a whole argument.
    writeFileSync(join(d.stateDir, "19524.lock"), "601");
    writeFileSync(join(d.stateDir, "19524.json"), JSON.stringify({ pid: 19524, watcherPid: 601, auto: true }));
    expect((await watchAction({ action: "stop", pid: 19524 }, d)).isError).toBe(true);
    expect((await watchAction({ action: "start", pid: 19524 }, d)).text).toBe("already watched by watcher PID 601");
    expect(d.kill).not.toHaveBeenCalled();
    expect(d.start).not.toHaveBeenCalled();
  });
});

describe("status line and reports", () => {
  const st = (state: WatchState["state"], over: Partial<WatchState> = {}): WatchState => ({
    pid: 19524, watcherPid: process.pid, owned: false, state, since: at("09:32:58.000"), lastLines: [], actions: [],
    dismiss: "owned", autoRecover: false, updated: at("09:32:58.000"), ...over,
  });
  const now = at("12:01:00.000");

  it.each([
    ["blocked_dialog", { kind: "leak_assert" }, "Workbench PID 19524 blocked by leak_assert since 09:32:58 (2 h 28 min)"],
    ["not_responding", {}, "Workbench PID 19524 not responding since 09:32:58 (2 h 28 min)"],
    ["stalled", {}, "Workbench PID 19524 stalled (script reload not finished, no log line for 10 min) since 09:32:58 (2 h 28 min)"],
    ["crashed", { crash: { reason: "Resources are leaking! Check log!" } }, "Workbench PID 19524 crashed at 09:32:58: Resources are leaking! Check log!"],
  ] as const)("%s", (state, over, line) => {
    expect(alertLine(st(state, over), now)).toBe(line);
  });

  it("the footer adds one line only while a watcher reports trouble", () => {
    const d = deps();
    const client = { state: { connected: true, mode: "edit" } } as unknown as WorkbenchClient;
    expect(formatConnectionStatus(client, d.stateDir)).toBe("\n\n---\n`Workbench: edit mode`");
    writeFileSync(join(d.stateDir, "19524.json"), JSON.stringify(st("ok")));
    expect(watchAlerts(d.stateDir, now)).toBe("");
    writeFileSync(join(d.stateDir, "19524.json"), JSON.stringify(st("blocked_dialog", { kind: "leak_assert" })));
    expect(watchAlerts(d.stateDir, now)).toBe("\n`Watchdog: Workbench PID 19524 blocked by leak_assert since 09:32:58 (2 h 28 min). Run wb_watch status.`");
    // A watcher that died says nothing in the footer (wb_watch status still shows its last report).
    writeFileSync(join(d.stateDir, "19524.json"), JSON.stringify(st("blocked_dialog", { watcherPid: 999999 })));
    expect(watchAlerts(d.stateDir, now)).toBe("");
  });

  it("the report names the dialog, the open reload, the trigger and what was done", () => {
    const r = formatReport(st("blocked_dialog", {
      kind: "leak_assert", dialog: { title: "Assertion Failed", text: "Reason: Resources are leaking! Check log! | &Ignore" },
      reloadOpenSince: at("09:32:52.901"), trigger: ["C:\\p\\SYK_VDD_BoatRouteData.c"],
    }), now);
    expect(r).toContain("Workbench PID 19524 (not owned): BLOCKED by dialog (leak_assert) since 09:32:58 (2 h 28 min)");
    expect(r).toContain("open operation: script reload started 09:32:52, not finished");
    expect(r).toContain("likely trigger: C:\\p\\SYK_VDD_BoatRouteData.c");
    expect(r).toContain("actions: none (dismissLeakAssert = owned; this PID is not owned)");
    expect(r).toContain("never Abort or Retry");
  });

  it("the report says an automatic watch was attached automatically; an explicit one says nothing extra", () => {
    expect(formatReport(st("ok", { auto: true }), now)).toContain("Workbench PID 19524 (not owned, attached automatically): OK since");
    expect(formatReport(st("ok"), now)).toContain("Workbench PID 19524 (not owned): OK since");
  });

  it("status lists the reports and says when a watcher is gone", async () => {
    const d = deps();
    expect((await watchAction({ action: "status" }, d)).text).toMatch(/^No Workbench is watched/);
    writeFileSync(join(d.stateDir, "19524.json"), JSON.stringify(st("busy", { watcherPid: 999999 })));
    writeFileSync(join(d.stateDir, "1.json"), "{broken");
    const text = (await watchAction({ action: "status" }, d)).text;
    expect(text).toContain("watcher not running; last report 09:32:58");
    expect(text).toMatch(/watch state unreadable: .*1\.json/);
  });
});

describe("automatic watchers: replace, refuse, stop and noauto", () => {
  const autoState = (d: WatchToolDeps, auto: boolean) => {
    writeFileSync(join(d.stateDir, "19524.lock"), "600");
    writeFileSync(join(d.stateDir, "19524.json"), JSON.stringify({ pid: 19524, watcherPid: 600, owned: false, state: "ok", ...(auto ? { auto: true } : {}) }));
  };
  const alive = (pid: number) => [600, 700, 800, 19524].includes(pid);

  it("an explicit start replaces an automatic watcher: kills it, starts the new one, sees the new lock, writes no noauto", async () => {
    const d = deps({ alive, settleMs: 50 });
    d.start = vi.fn(() => {
      writeFileSync(join(d.stateDir, "19524.lock"), "700");
      return 700;
    });
    autoState(d, true);
    const r = await watchAction({ action: "start", pid: 19524 }, d);
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("Replaced the automatic watcher PID 600 with watcher PID 700.");
    expect(d.kill).toHaveBeenCalledExactlyOnceWith(600);
    expect(d.start).toHaveBeenCalledOnce();
    expect(vi.mocked(d.start).mock.calls[0][0]).not.toHaveProperty("auto");
    expect(existsSync(join(d.stateDir, "19524.json"))).toBe(false);
    expect(existsSync(join(d.stateDir, "19524.noauto"))).toBe(false);
  });

  it("a watcher that is not automatic is still refused and left alone", async () => {
    const d = deps({ alive });
    autoState(d, false);
    expect(await watchAction({ action: "start", pid: 19524 }, d)).toEqual({ text: "already watched by watcher PID 600", isError: true });
    expect(d.kill).not.toHaveBeenCalled();
    expect(d.start).not.toHaveBeenCalled();
  });

  it("another watcher took the PID first: the reply names it neutrally (T1 finding 2)", async () => {
    const d = deps({ alive, settleMs: 50 });
    d.start = vi.fn(() => {
      writeFileSync(join(d.stateDir, "19524.lock"), "800"); // the other MCP's watcher won the claim; ours would exit with code 3
      return 700;
    });
    autoState(d, true);
    const r = await watchAction({ action: "start", pid: 19524 }, d);
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Stopped the automatic watcher PID 600, but another watcher (PID 800) took Workbench PID 19524 first; check wb_watch status.");
  });

  it("the automatic attach (internal flag) starts a not-owned watcher with --auto, an owned one without, and never replaces a watcher", async () => {
    const d = deps();
    await watchAction({ action: "start", pid: 19524 }, d, { auto: true });
    expect(d.start).toHaveBeenLastCalledWith(expect.objectContaining({ owned: false, auto: true, dismiss: "watched", authScope: "watched", autoRecover: false }));
    const o = deps({ owned: () => true });
    await watchAction({ action: "start", pid: 19524 }, o, { auto: true });
    expect(vi.mocked(o.start).mock.calls[0][0]).not.toHaveProperty("auto");
    // A prefetched ProcInfo replaces the lookup
    const p = deps({ proc: () => undefined });
    const proc = { pid: 19524, ppid: 1, cmd: WB, created: at("06:12:43.000") };
    expect((await watchAction({ action: "start", pid: 19524 }, p, { auto: true, proc })).isError).toBeUndefined();
    // An automatic attach finds a live automatic watcher: refused, not replaced
    const r = deps({ alive });
    autoState(r, true);
    expect((await watchAction({ action: "start", pid: 19524 }, r, { auto: true })).isError).toBe(true);
    expect(r.kill).not.toHaveBeenCalled();
  });

  it("stop writes the Workbench start time to <pid>.noauto before it kills the watcher; a later start removes it", async () => {
    const d = deps();
    const file = join(d.stateDir, "19524.noauto");
    const seen: string[] = [];
    d.kill = vi.fn(() => {
      seen.push(existsSync(file) ? readFileSync(file, "utf-8") : "no file at kill time");
    });
    writeFileSync(join(d.stateDir, "19524.lock"), "600");
    writeFileSync(join(d.stateDir, "19524.json"), JSON.stringify({ pid: 19524, watcherPid: 600 }));
    await watchAction({ action: "stop", pid: 19524 }, d);
    expect(seen).toEqual([String(at("06:12:43.000"))]);
    expect(autoBlocked(d.stateDir, 19524, at("06:12:43.000") + 9_000)).toBe(true);
    await watchAction({ action: "start", pid: 19524 }, d);
    expect(existsSync(file)).toBe(false);
  });

  it("autoBlocked is true only for the same Workbench run", () => {
    const d = deps();
    expect(autoBlocked(d.stateDir, 19524, at("06:12:43.000"))).toBe(false); // no file
    writeFileSync(join(d.stateDir, "19524.noauto"), String(at("06:12:43.000")));
    expect(autoBlocked(d.stateDir, 19524, at("06:12:43.000"))).toBe(true);
    expect(autoBlocked(d.stateDir, 19524, at("06:12:43.000") - 10_000)).toBe(true);
    expect(autoBlocked(d.stateDir, 19524, at("06:12:43.000") + 10_001)).toBe(false); // a reused PID
    expect(autoBlocked(d.stateDir, 4242, at("06:12:43.000"))).toBe(false); // another PID
  });

  it("a stop does not write noauto when the Workbench process is already gone", async () => {
    const d = deps({ proc: (pid) => (pid === 600 ? { pid, ppid: 1, cmd: "node wb-watch.js --pid 19524", created: 1 } : undefined) });
    writeFileSync(join(d.stateDir, "19524.lock"), "600");
    writeFileSync(join(d.stateDir, "19524.json"), JSON.stringify({ pid: 19524, watcherPid: 600 }));
    await watchAction({ action: "stop", pid: 19524 }, d);
    expect(d.kill).toHaveBeenCalledExactlyOnceWith(600);
    expect(existsSync(join(d.stateDir, "19524.noauto"))).toBe(false);
  });
});
