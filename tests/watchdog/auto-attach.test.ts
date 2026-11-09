import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The watcher spawn is a stub: no watcher process starts. netstat and process queries are injected.
// Like a real watcher it claims `<pid>.lock` in the state dir it was given.
const spawnDetached = vi.hoisted(() =>
  vi.fn((_exe: string, args: string[], _cwd: string, _log?: string) => {
    writeFileSync(join(args[args.indexOf("--state-dir") + 1], `${args[args.indexOf("--pid") + 1]}.lock`), "700");
    return 700;
  })
);
vi.mock("../../src/utils/process.js", async (orig) => ({ ...(await orig<typeof import("../../src/utils/process.js")>()), spawnDetached }));

import { ensureWatched, type AttachDeps } from "../../src/watchdog/auto-attach.js";
import { startWatcher } from "../../src/watchdog/wb-watch.js";

const T0 = new Date("2026-11-08T17:50:00").getTime();
const WB = "\"C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arma Reforger Tools\\Workbench\\ArmaReforgerWorkbenchSteamDiag.exe\" -gproj x";
const listening = (pid: number) => `  TCP    0.0.0.0:5775           0.0.0.0:0              LISTENING       ${pid}\r\n`;

function deps(over: Partial<AttachDeps> = {}, procs: Record<number, string> = {}) {
  const all: Record<number, string> = { 19524: WB, 600: "node.exe C:\\x\\dist\\watchdog\\wb-watch.js --pid 19524 --state-dir y", 4242: "notepad.exe", 700: "node.exe wb-watch.js --pid 19524", 800: "node.exe wb-watch.js --pid 19524", ...procs };
  const d: AttachDeps = {
    stateDir: mkdtempSync(join(tmpdir(), "emcp-aa-")),
    platform: "win32",
    netstat: vi.fn(async () => listening(19524)),
    proc: async (pid) => (all[pid] !== undefined ? { pid, ppid: 1, cmd: all[pid], created: T0 } : undefined),
    owned: () => false,
    alive: (pid) => pid in all,
    start: vi.fn((w) => spawnDetached("node", ["--pid", String(w.pid), "--state-dir", w.stateDir], "")),
    base: { scriptAuth: "rules", logsRoot: "L:\\logs", crashDir: "C:\\crash" },
    settleMs: 50,
    ...over,
  };
  return d;
}
const check = (d: AttachDeps, host = "127.0.0.1") => ensureWatched(5775, host, d);

describe("ensureWatched", () => {
  it("not local: never runs netstat for a Workbench on another PC", async () => {
    const d = deps();
    expect(await check(d, "192.168.1.20")).toEqual({ ok: false, text: "Workbench not watched: the NET API host 192.168.1.20 is not this PC." });
    expect(d.netstat).not.toHaveBeenCalled();
    for (const h of ["localhost", "::1"]) expect((await check(deps(), h)).ok).toBe(true);
  });

  it("not Windows", async () => {
    const d = deps({ platform: "linux" });
    expect(await check(d)).toEqual({ ok: false, text: "Workbench not watched: the watcher runs only on Windows." });
    expect(d.netstat).not.toHaveBeenCalled();
  });

  it("step 1: no listener on the port", async () => {
    const d = deps({ netstat: async () => "" });
    expect(await check(d)).toEqual({ ok: false, text: "Workbench not watched: no process listens on port 5775." });
  });

  it("step 2: the port owner is not a Workbench, or its command line cannot be read", async () => {
    const d = deps({ netstat: async () => listening(4242) });
    // A non-Workbench holder is a stable result (quiet 60 s); a process that could not be read at all is checked again.
    expect(await check(d)).toEqual({ ok: true, text: "Workbench not watched: port 5775 held by PID 4242, not a Workbench this MCP can watch." });
    const gone = await check(deps({ netstat: async () => listening(31337) }));
    expect(gone.text).toContain("port 5775 held by PID 31337");
    expect(gone.ok).toBe(false);
    expect(d.start).not.toHaveBeenCalled();
  });

  it("step 3: already watched by a live watcher of this PID: no second watcher", async () => {
    const d = deps();
    writeFileSync(join(d.stateDir, "19524.lock"), "600");
    writeFileSync(join(d.stateDir, "19524.json"), JSON.stringify({ pid: 19524, watcherPid: 600, owned: false, auto: true, dismiss: "watched" }));
    expect(await check(d)).toEqual({
      ok: true,
      text: 'Workbench PID 19524 is watched by watcher PID 600 (attached automatically): it presses Ignore on the "Resources are leaking!" assert about 5 s after it shows.',
    });
    expect(d.start).not.toHaveBeenCalled();
  });

  it("step 3: a stale lock held by a live process that is not this PID's watcher is deleted, and a watcher is started", async () => {
    for (const holder of [4242, 601]) {
      // 601 is a watcher of another Workbench (--pid 195240): not a watcher of 19524.
      const d = deps({}, { 601: "node.exe wb-watch.js --pid 195240" });
      writeFileSync(join(d.stateDir, "19524.lock"), String(holder));
      const r = await check(d);
      expect(r.ok, String(holder)).toBe(true);
      expect(r.text).toMatch(/^Attached watcher PID 700 to Workbench PID 19524/);
      // The stale lock is gone: the lock now names the new watcher
      expect(readFileSync(join(d.stateDir, "19524.lock"), "utf8")).toBe("700");
      expect(d.start).toHaveBeenCalledOnce();
    }
  });

  it.each([
    ["an empty command line (a process CIM may not read: another user, an elevated MCP's watcher)", { 555: "" }, true],
    ["a failed process query (checked again on the next call)", {}, false],
  ] as const)("step 3: a live lock holder with %s is left alone", async (_name, procs, ok) => {
    const d = deps({ alive: () => true }, procs);
    writeFileSync(join(d.stateDir, "19524.lock"), "555");
    expect(await check(d)).toEqual({ ok, text: "Workbench not watched: the watch lock of Workbench PID 19524 names PID 555, whose command line could not be read." });
    expect(existsSync(join(d.stateDir, "19524.lock"))).toBe(true);
    expect(d.start).not.toHaveBeenCalled();
  });

  it("step 3: the lock changes between the holder read and the delete: it is not deleted and no watcher starts", async () => {
    const d = deps();
    const lock = join(d.stateDir, "19524.lock");
    writeFileSync(lock, "4242");
    const proc = d.proc;
    // Another MCP attached while the command line of the stale holder was read
    d.proc = async (pid) => (pid === 4242 && writeFileSync(lock, "800"), proc(pid));
    const r = await check(d);
    expect(r.ok).toBe(false);
    expect(r.text).toContain("changed while it was checked");
    expect(readFileSync(lock, "utf8")).toBe("800");
    expect(d.start).not.toHaveBeenCalled();
  });

  it("step 3: the lock becomes unreadable between the holder read and the delete: it says so, deletes nothing and starts nothing (R4)", async () => {
    const d = deps();
    const lock = join(d.stateDir, "19524.lock");
    writeFileSync(lock, "4242");
    const proc = d.proc;
    // A directory in place of the lock stands in for EBUSY/EPERM from a scanner while the command line was read.
    d.proc = async (pid) => (pid === 4242 && (rmSync(lock), mkdirSync(lock)), proc(pid));
    expect(await check(d)).toEqual({ ok: false, text: "Workbench not watched: the watch lock for PID 19524 cannot be read right now." });
    expect(existsSync(lock)).toBe(true);
    expect(d.start).not.toHaveBeenCalled();
  });

  it("step 5: another MCP's watcher took the PID first: no 'Attached', the lock holder is named", async () => {
    const d = deps();
    d.start = vi.fn(() => (writeFileSync(join(d.stateDir, "19524.lock"), "800"), 700));
    // ok:true = no recheck for 60 s, so the loser does not start another watcher on its next call
    expect(await check(d)).toEqual({ ok: true, text: "Workbench not watched: another watcher (PID 800) holds Workbench PID 19524; wb_watch status shows it." });
  });

  it("step 5: a watcher that claims the lock only after the first poll read is still reported attached", async () => {
    const d = deps({ settleMs: 500 });
    d.start = vi.fn(() => (setTimeout(() => writeFileSync(join(d.stateDir, "19524.lock"), "700"), 30), 700));
    expect((await check(d)).text).toMatch(/^Attached watcher PID 700 to Workbench PID 19524/);
  });

  it("step 5: the new watcher never appears in the lock: no 'Attached'", async () => {
    const d = deps();
    d.start = vi.fn(() => 700);
    expect(await check(d)).toEqual({ ok: true, text: "Workbench not watched: watcher PID 700 did not take Workbench PID 19524; wb_watch status shows what runs." });
  });

  it("step 4: the user stopped the watch of this Workbench run", async () => {
    const d = deps();
    writeFileSync(join(d.stateDir, "19524.noauto"), String(T0 + 3_000));
    expect(await check(d)).toEqual({ ok: true, text: "Workbench not watched: watch stopped by the user for Workbench PID 19524 (wb_watch start pid=19524 attaches one)." });
    expect(d.start).not.toHaveBeenCalled();
    // A new run of a reused PID has another start time
    writeFileSync(join(d.stateDir, "19524.noauto"), String(T0 - 60_000));
    expect((await check(d)).ok).toBe(true);
  });

  it("step 5, not owned: --auto, --dismiss watched, --auth-scope watched and no --auto-recover (Q1 B)", async () => {
    const d = deps({ start: startWatcher });
    const r = await check(d);
    expect(r).toEqual({
      ok: true,
      text:
        'Attached watcher PID 700 to Workbench PID 19524 (not started by this MCP): it presses Ignore on the "Resources are leaking!" assert within about 10 s ' +
        "and answers Script Authorization by ENFUSION_SCRIPT_AUTH=rules. A call that timed out may still finish: check the state before repeating it.",
    });
    const args = spawnDetached.mock.calls.at(-1)![1];
    const val = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args).toContain("--auto");
    expect(val("--dismiss")).toBe("watched");
    expect(val("--auth-scope")).toBe("watched");
    expect(val("--pid")).toBe("19524");
    expect(val("--port")).toBe("5775");
    expect(val("--state-dir")).toBe(d.stateDir);
    expect(args).not.toContain("--auto-recover");
    expect(args).not.toContain("--owned");
  });

  it("step 5, owned: the watcher wb_launch starts, without --auto", async () => {
    const owned = vi.fn(() => true);
    const d = deps({ start: startWatcher, owned });
    expect((await check(d)).text).toContain("(started by this MCP)");
    expect(owned).toHaveBeenCalledWith(19524, expect.objectContaining({ pid: 19524, created: T0 }));
    const args = spawnDetached.mock.calls.at(-1)![1];
    const val = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args).toContain("--owned");
    expect(args).not.toContain("--auto");
    expect(args).not.toContain("--auto-recover");
    expect([val("--start-time"), val("--logs-root"), val("--auth"), val("--crash-dir")]).toEqual([String(T0), "L:\\logs", "rules", "C:\\crash"]);
  });
});

describe("an unreadable watch lock (B-099 item 1)", () => {
  // A directory in place of the lock makes the read fail with EISDIR, standing in for EBUSY/EPERM from a scanner.
  it("the check names it, replies not ok and starts nothing", async () => {
    const d = deps();
    mkdirSync(join(d.stateDir, "19524.lock"));
    expect(await check(d)).toEqual({ ok: false, text: "Workbench not watched: the watch lock for PID 19524 cannot be read right now." });
    expect(d.start).not.toHaveBeenCalled();
  });

  it("a lock that turns unreadable just before the start reads as a timeout footer, without advice for a wb_watch caller (R4)", async () => {
    const d = deps();
    const lock = join(d.stateDir, "19524.lock");
    writeFileSync(lock, "4242");
    let swapped = false;
    // The stale holder (dead) is read free by the first check; the lock then becomes unreadable before the start reads it again.
    d.alive = (pid) => (pid === 4242 && !swapped && ((swapped = true), rmSync(lock), mkdirSync(lock)), false);
    expect(await check(d)).toEqual({ ok: false, text: "Workbench not watched: the watch lock for PID 19524 cannot be read right now." });
    expect(d.start).not.toHaveBeenCalled();
  });

  it("a lock that cannot be read after the watcher started is named, with ok so the next call is not a respawn", async () => {
    const d = deps();
    d.start = vi.fn(() => (mkdirSync(join(d.stateDir, "19524.lock")), 700));
    expect(await check(d)).toEqual({ ok: true, text: "Workbench not watched: the watch lock for PID 19524 cannot be read right now; wb_watch status shows what runs." });
  });
});

describe("start refusals that reach the footer carry no wb_watch caller wording (WATCH-TIDY2 change 4)", () => {
  it("another MCP's watcher took the PID between the first read and the start: the footer names it as a fact", async () => {
    const d = deps();
    writeFileSync(join(d.stateDir, "19524.lock"), "800");
    let n = 0;
    // The first read sees a dead holder (free); the start reads the same lock again and finds it alive.
    d.alive = (pid) => (pid === 800 ? ++n > 1 : pid in { 19524: 1 });
    expect(await check(d)).toEqual({ ok: false, text: "Workbench not watched: another watcher (PID 800) holds Workbench PID 19524." });
    expect(d.start).not.toHaveBeenCalled();
  });
});
