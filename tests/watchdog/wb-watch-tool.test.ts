import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchAction, type WatchToolDeps } from "../../src/tools/wb-watch-tool.js";
import { formatConnectionStatus, watchAlerts } from "../../src/workbench/status.js";
import { alertLine, formatReport, type WatchState } from "../../src/watchdog/wb-watch.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";

// Temp state dir and lock file; processes, ownership and the watcher spawn are stubs.
const at = (hms: string) => new Date(`2026-10-31T${hms}`).getTime();
const WB = "\"C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arma Reforger Tools\\Workbench\\ArmaReforgerWorkbenchSteamDiag.exe\" -gproj x";

function deps(over: Partial<WatchToolDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "emcp-wt-"));
  const lockPath = join(dir, "WORKBENCH_LOCK.txt");
  writeFileSync(lockPath, "owner: broker (AM test)\r\npid: 19524\r\nsince: 2026-10-31 06:12\r\n");
  const procs: Record<number, string> = { 19524: WB, 600: "node.exe C:\\x\\dist\\watchdog\\wb-watch.js --pid 19524", 4242: "notepad.exe" };
  const d: WatchToolDeps = {
    stateDir: dir,
    lockPath,
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
  it("attaches a watcher to a Workbench this MCP did not start: Ignore on the leak assert by default, no recovery", () => {
    const d = deps();
    const r = watchAction({ action: "start", pid: 19524, autoRecover: true }, d);
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("not owned: never closed or killed");
    expect(d.start).toHaveBeenCalledWith(expect.objectContaining({ pid: 19524, owned: false, autoRecover: false, dismiss: "watched", startTime: at("06:12:43.000") }));
  });

  it("refuses a PID that is not Workbench, and a second watcher", () => {
    const d = deps();
    expect(watchAction({ action: "start", pid: 4242 }, d)).toEqual({ text: "PID 4242 is not a Workbench process.", isError: true });
    writeFileSync(join(d.stateDir, "19524.lock"), "600");
    expect(watchAction({ action: "start", pid: 19524 }, d)).toEqual({ text: "already watched by watcher PID 600", isError: true });
    expect(d.start).not.toHaveBeenCalled();
  });

  it("refuses adopt when the lock pid or owner differs, accepts it when both match", () => {
    const d = deps();
    writeFileSync(d.lockPath!, "owner: broker (AM test)\r\npid: 22172\r\n");
    expect(watchAction({ action: "start", pid: 19524, adopt: true, owner: "broker (AM test)" }, d)).toEqual({ text: "adopt refused: lock pid is 22172, not 19524", isError: true });
    writeFileSync(d.lockPath!, "owner: broker (AM test)\r\npid: 19524\r\n");
    expect(watchAction({ action: "start", pid: 19524, adopt: true, owner: "someone else" }, d).isError).toBe(true);
    expect(watchAction({ action: "start", pid: 19524, adopt: true }, deps({ lockPath: undefined })).text).toMatch(/^adopt refused: no lock file/);
    expect(d.start).not.toHaveBeenCalled();
    expect(watchAction({ action: "start", pid: 19524, adopt: true, owner: "broker (AM test)", autoRecover: true }, d).text).toContain("(owned)");
    expect(d.start).toHaveBeenCalledWith(expect.objectContaining({ owned: true, autoRecover: true, owner: "broker (AM test)" }));
  });

  it("passes dismissLeakAssert never through", () => {
    const d = deps();
    expect(watchAction({ action: "start", pid: 19524, dismissLeakAssert: "never" }, d).text).toContain("dismissLeakAssert = never");
    expect(d.start).toHaveBeenCalledWith(expect.objectContaining({ dismiss: "never" }));
  });
});

describe("wb_watch stop", () => {
  it("ends only a real watcher and clears its files", () => {
    const d = deps();
    writeFileSync(join(d.stateDir, "19524.lock"), "600");
    writeFileSync(join(d.stateDir, "19524.json"), "{}");
    expect(watchAction({ action: "stop", pid: 19524 }, d).text).toBe("Stopped watcher PID 600 for Workbench PID 19524.");
    expect(d.kill).toHaveBeenCalledWith(600);
    expect(existsSync(join(d.stateDir, "19524.json"))).toBe(false);
    // The lock names a live process that is not a watcher (the Workbench itself): never killed.
    writeFileSync(join(d.stateDir, "19524.lock"), "19524");
    expect(watchAction({ action: "stop", pid: 19524 }, d).isError).toBe(true);
    expect(d.kill).toHaveBeenCalledTimes(1);
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

  it("status lists the reports and says when a watcher is gone", () => {
    const d = deps();
    expect(watchAction({ action: "status" }, d).text).toMatch(/^No Workbench is watched/);
    writeFileSync(join(d.stateDir, "19524.json"), JSON.stringify(st("busy", { watcherPid: 999999 })));
    writeFileSync(join(d.stateDir, "1.json"), "{broken");
    const text = watchAction({ action: "status" }, d).text;
    expect(text).toContain("watcher not running; last report 09:32:58");
    expect(text).toMatch(/watch state unreadable: .*1\.json/);
  });
});
