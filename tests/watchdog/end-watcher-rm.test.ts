import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Only rmSync of the state, lock and stop-marker files is stubbed, to fail like a scanner holding them (EBUSY). No watcher, PowerShell or Workbench runs.
const rm = vi.hoisted(() => ({ fail: [] as string[] }));
vi.mock("node:fs", async (orig) => {
  const fs = await orig<typeof import("node:fs")>();
  return {
    ...fs,
    rmSync: (p: Parameters<typeof fs.rmSync>[0], o?: Parameters<typeof fs.rmSync>[1]) => {
      if (rm.fail.some((ext) => String(p).endsWith(ext))) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      return fs.rmSync(p, o);
    },
  };
});

import { watchAction, type WatchToolDeps } from "../../src/tools/wb-watch-tool.js";

describe("endWatcher's removes (R3)", () => {
  it("stop still replies that the watcher was stopped when the state file or the lock cannot be removed", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "emcp-ew-"));
    const d: WatchToolDeps = {
      stateDir,
      proc: (pid) => ({ pid, ppid: 1, cmd: pid === 19524 ? "ArmaReforgerWorkbenchSteamDiag.exe -gproj x" : "node.exe dist/watchdog/wb-watch.js --pid 19524", created: 1 }),
      owned: () => false,
      alive: (pid) => pid === 600 || pid === 19524,
      start: vi.fn(() => 700),
      kill: vi.fn(),
      base: { host: "127.0.0.1", port: 5775 },
    };
    writeFileSync(join(stateDir, "19524.lock"), "600");
    writeFileSync(join(stateDir, "19524.json"), JSON.stringify({ pid: 19524, watcherPid: 600, owned: false, state: "ok", auto: true }));
    rm.fail = [".json", ".lock"];
    try {
      expect(await watchAction({ action: "stop", pid: 19524 }, d)).toEqual({ text: "Stopped watcher PID 600 for Workbench PID 19524." });
    } finally {
      rm.fail = [];
    }
    expect(d.kill).toHaveBeenCalledExactlyOnceWith(600);
    expect(existsSync(join(stateDir, "19524.lock"))).toBe(true); // left behind; the next claim takes it over
  });

  it("a replacing start still starts the new watcher when the stop marker cannot be removed, and the reply says so (WATCH-TIDY2 change 1)", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "emcp-ew-"));
    const d: WatchToolDeps = {
      stateDir,
      proc: (pid) => ({ pid, ppid: 1, cmd: pid === 19524 ? "ArmaReforgerWorkbenchSteamDiag.exe -gproj x" : "node.exe dist/watchdog/wb-watch.js --pid 19524", created: 1 }),
      owned: () => false,
      alive: (pid) => [600, 700, 19524].includes(pid),
      start: vi.fn(() => (writeFileSync(join(stateDir, "19524.lock"), "700"), 700)),
      kill: vi.fn(),
      base: { host: "127.0.0.1", port: 5775 },
      settleMs: 50,
    };
    writeFileSync(join(stateDir, "19524.lock"), "600");
    writeFileSync(join(stateDir, "19524.json"), JSON.stringify({ pid: 19524, watcherPid: 600, owned: false, state: "ok", auto: true }));
    writeFileSync(join(stateDir, "19524.noauto"), "1");
    rm.fail = [".noauto"];
    let r;
    try {
      r = await watchAction({ action: "start", pid: 19524 }, d);
    } finally {
      rm.fail = [];
    }
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain("Replaced the automatic watcher PID 600 with watcher PID 700.");
    expect(r.text).toContain("The stop marker could not be removed (EBUSY), so the automatic attach stays off for this Workbench run if the marker names it.");
    expect(r.text).not.toContain("stays off for it.");
    expect(d.kill).toHaveBeenCalledExactlyOnceWith(600);
    expect(d.start).toHaveBeenCalledOnce();
    expect(existsSync(join(stateDir, "19524.noauto"))).toBe(true);
  });

  // The marker stays, so each replacing-start failure reply keeps the note (WATCH-TIDY2 review findings).
  const NOTE = " The stop marker could not be removed (EBUSY), so the automatic attach stays off for this Workbench run if the marker names it.";
  it.each([
    ["the new watcher did not take the PID", () => {}, "Stopped the automatic watcher PID 600, but the new watcher PID 700 did not take Workbench PID 19524 within 0.05 s. Check wb_watch status."],
    ["another watcher took the PID first", (dir: string) => writeFileSync(join(dir, "19524.lock"), "800"), "Stopped the automatic watcher PID 600, but another watcher (PID 800) took Workbench PID 19524 first; check wb_watch status."],
    ["the watch lock cannot be read", (dir: string) => mkdirSync(join(dir, "19524.lock")), "Stopped the automatic watcher PID 600, but the watch lock for PID 19524 cannot be read right now; check wb_watch status."],
  ])("a replacing start that fails because %s still tells that the stop marker stayed", async (_name, takeLock, expected) => {
    const stateDir = mkdtempSync(join(tmpdir(), "emcp-ew-"));
    const d: WatchToolDeps = {
      stateDir,
      proc: (pid) => ({ pid, ppid: 1, cmd: pid === 19524 ? "ArmaReforgerWorkbenchSteamDiag.exe -gproj x" : "node.exe dist/watchdog/wb-watch.js --pid 19524", created: 1 }),
      owned: () => false,
      alive: (pid) => [600, 700, 800, 19524].includes(pid),
      start: vi.fn(() => (takeLock(stateDir), 700)),
      kill: vi.fn(),
      base: { host: "127.0.0.1", port: 5775 },
      settleMs: 50,
    };
    writeFileSync(join(stateDir, "19524.lock"), "600");
    writeFileSync(join(stateDir, "19524.json"), JSON.stringify({ pid: 19524, watcherPid: 600, owned: false, state: "ok", auto: true }));
    writeFileSync(join(stateDir, "19524.noauto"), "1");
    rm.fail = [".noauto"];
    try {
      expect(await watchAction({ action: "start", pid: 19524 }, d)).toEqual({ text: expected + NOTE, isError: true });
    } finally {
      rm.fail = [];
    }
  });
});
