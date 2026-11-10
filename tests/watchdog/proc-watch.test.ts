import { afterAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Instance } from "../../src/utils/instances.js";
import type { ProcInfo } from "../../src/utils/process.js";
import type { ProbeSample } from "../../src/watchdog/probe.js";
import type { WinInfo } from "../../src/watchdog/signals.js";
import { PROC_WATCH_DIR, procWatchLines, runProcWatcher, startProcWatcher, type ProcWatchState } from "../../src/watchdog/proc-watch.js";

// A fake home before any module loads, so the watch dir is a temp folder (MCP-0095). Nothing here runs a real PowerShell,
// taskkill, probe or watcher process: the probe, the kill, the process list and the clock are stubs, the folders are temp.
const home = await vi.hoisted(async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "emcp-pw-home-"));
  process.env.USERPROFILE = process.env.HOME = h;
  return h;
});
const temps: string[] = [home];
afterAll(() => temps.forEach((t) => rmSync(t, { recursive: true, force: true })));

const PID = 31820;
const OWNER = 111;
const OWNER_STARTED = 5000;
const EXE = "C:\\Servers\\ArmaReforgerServerDiag.exe";
const NOW = Date.now();
const START = NOW - 60_000; // the log folder's real mtime is "now", so it counts as this run's folder
const CRASH_TEXT = Array.from({ length: 60 }, (_, i) => (i === 3 ? "Reason: NULL pointer to instance" : `crash line ${i + 1}`)).join("\r\n");

const vmeWin = (text = "NULL pointer to instance. Function: OnAllBasesInitialized", hwnd = 100): WinInfo => ({
  hwnd, cls: "#32770", text: "Virtual machine exception", visible: true, hung: false, owner: 0, enabled: true,
  children: [{ hwnd: 101, cls: "Static", text }, { hwnd: 102, cls: "Button", text: "&Abort" }, { hwnd: 103, cls: "Button", text: "&Retry" }, { hwnd: 104, cls: "Button", text: "&Ignore" }],
});
const otherWin = (title = "Script Authorization Required"): WinInfo => ({
  hwnd: 200, cls: "#32770", text: title, visible: true, hung: false, owner: 0, enabled: true, children: [{ hwnd: 201, cls: "Static", text: "Allow this?" }],
});
/** Samples 5 s apart carrying the same windows. */
const run5s = (n: number, wins: WinInfo[], start = START + 1000): ProbeSample[] =>
  Array.from({ length: n }, (_, i) => ({ t: NOW + i * 5000, alive: true, start, wins }));

interface Rig { script: ProbeSample[]; inst?: Partial<Instance> | "missing" | "garbage"; info?: Partial<ProcInfo>; ownerInfo?: ProcInfo; killWorks?: boolean; crashDir?: "ok" | "none" | "blocked"; lag?: number; lookupThrows?: boolean; infoThrows?: number }

function rig(r: Rig) {
  const root = mkdtempSync(join(tmpdir(), "emcp-pw-"));
  temps.push(root);
  const logsRoot = join(root, "logs");
  const logDir = join(logsRoot, "logs_run");
  const stateDir = join(root, "state");
  const crashRoot = join(root, "crashes");
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, "console.log"), "console text");
  const instance = join(root, "emcp-instance.json");
  const inst: Instance = { kind: "server", name: "default", pid: PID, ownerPid: OWNER, ownerStartedAt: OWNER_STARTED, startedAt: START, exe: EXE };
  if (r.inst === "garbage") writeFileSync(instance, "{ not json");
  else if (r.inst !== "missing") writeFileSync(instance, JSON.stringify({ ...inst, ...r.inst }));
  const crashDir = r.crashDir === "none" ? undefined : r.crashDir === "blocked" ? join(logsRoot, "logs_run", "console.log", "x") : crashRoot;
  const clock = { now: NOW };
  let dead = false;
  let i = -1;
  let cb: (s: ProbeSample) => void = () => {};
  const emit = (n: number) => {
    clock.now = r.script[n].t + (r.lag ?? 0);
    cb(r.script[n]);
  };
  const stateFile = () => readdirSync(stateDir).filter((f) => f.endsWith(".json"))[0];
  const state = () => JSON.parse(readFileSync(join(stateDir, stateFile()), "utf-8")) as ProcWatchState;
  const states: ProcWatchState[] = []; // the state after each tick
  const seen: { atKill?: ProcWatchState["state"]; savedAtKill?: number; statesAtKill?: ProcWatchState["state"][] } = {};
  const kill = vi.fn((_pids: number[], _force?: boolean, _tree?: boolean) => {
    seen.atKill = state().state;
    seen.statesAtKill = states.map((s) => s.state);
    seen.savedAtKill = existsSync(crashRoot) ? readdirSync(crashRoot).length : 0;
    writeFileSync(join(logDir, "crash.log"), CRASH_TEXT); // the engine writes it as the process ends
    if (r.killWorks !== false) dead = true;
    if (r.lookupThrows) {
      rmSync(logsRoot, { recursive: true, force: true }); // the logs root becomes a file: reading it as a folder throws
      writeFileSync(logsRoot, "not a folder");
    }
  });
  const probeStop = vi.fn();
  const probe = vi.fn((_pid: number, _port: number, onSample: (s: ProbeSample) => void) => {
    cb = onSample;
    if (r.script.length) emit(++i);
    return { stop: probeStop };
  });
  const info: ProcInfo = { pid: PID, ppid: 1, cmd: `"${EXE}" -server x -profile y`, created: START, ...r.info };
  let infoThrows = r.infoThrows ?? 0;
  const processInfo = vi.fn((pid: number) => {
    if (infoThrows-- > 0) throw new Error("the process query failed");
    return pid === PID ? info : pid === 222 ? r.ownerInfo : undefined;
  });
  const tick = () => new Promise((done) => setImmediate(done));
  const run = () =>
    runProcWatcher(
      { pid: PID, kind: "server", instance, ownerPid: OWNER, ownerStarted: OWNER_STARTED, logsRoot, crashDir, stateDir },
      {
        probe: probe as never, alive: () => !dead, now: () => clock.now, kill, processInfo: processInfo as never,
        wait: async () => {
          await tick();
          try {
            states.push(state());
          } catch {
            // no state file yet
          }
          if (++i < r.script.length) emit(i);
          else dead = true;
        },
        settle: async (ms) => {
          clock.now += ms;
          await tick();
        },
      }
    );
  return { run, kill, probe, probeStop, state, states, root, stateDir, crashRoot, logDir, seen };
}

describe("proc-watch ends a process only for a VM exception window", () => {
  it("re-checks, writes ending_vme before the kill, ends that PID only, then copies the log folder", async () => {
    const t = rig({ script: run5s(3, [vmeWin()]) });
    expect(await t.run()).toBe(0);
    expect(t.kill).toHaveBeenCalledTimes(1);
    expect(t.kill).toHaveBeenCalledWith([PID], true, false);
    expect(t.seen.atKill).toBe("ending_vme");
    expect(t.seen.savedAtKill).toBe(0); // the copy comes after the end attempt
    const s = t.state();
    expect(s.state).toBe("ended_vme");
    expect(s.dialog?.title).toBe("Virtual machine exception");
    expect(s.dialog?.text).toBe("NULL pointer to instance. Function: OnAllBasesInitialized | &Abort | &Retry | &Ignore");
    expect(s.crashLog).toHaveLength(40);
    expect(s.crashLog![0]).toBe("crash line 1");
    expect(s.reason).toBe("NULL pointer to instance");
    expect(s.saved).toMatch(/server_\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d_31820$/);
    expect(readFileSync(join(s.saved!, "crash.log"), "utf-8")).toBe(CRASH_TEXT);
    expect(readFileSync(join(s.saved!, "console.log"), "utf-8")).toBe("console text");
    expect(t.probeStop).toHaveBeenCalled();
  });

  it("ends for a different message text too: the match is class and title", async () => {
    const t = rig({ script: run5s(3, [vmeWin("Some other message")]) });
    await t.run();
    expect(t.kill).toHaveBeenCalledTimes(1);
    expect(t.state().state).toBe("ended_vme");
    expect(t.state().dialog?.text).toContain("Some other message");
  });

  it("ends nothing for one sample, for under 10 s, for a stale sample, or for a different window each sample", async () => {
    for (const script of [run5s(1, [vmeWin()]), run5s(2, [vmeWin()])]) {
      const t = rig({ script });
      await t.run();
      expect(t.kill).not.toHaveBeenCalled();
      expect(t.state().state).toBe("exited");
    }
    const stale = rig({ script: run5s(4, [vmeWin()]), lag: 30_000 });
    await stale.run();
    expect(stale.kill).not.toHaveBeenCalled();
    const script = run5s(4, []).map((s, i) => ({ ...s, wins: [vmeWin("m", 100 + i)] }));
    const moving = rig({ script });
    await moving.run();
    expect(moving.kill).not.toHaveBeenCalled();
  });

  it("reports a Missing Addon box as one line that says the process waits for OK, and never ends, clicks or closes it", async () => {
    const t = rig({ script: run5s(6, [otherWin("Missing Addon")]) });
    await t.run();
    expect(t.kill).not.toHaveBeenCalled();
    const blocked = t.states.filter((s) => s.state === "blocked_dialog");
    expect(blocked.length).toBeGreaterThan(0);
    expect(blocked[0].why).toBe("the process waits for OK, it is not ended");
    // The state file the status replies read: one line for this PID, with the title and the wait.
    mkdirSync(PROC_WATCH_DIR, { recursive: true });
    writeFileSync(join(PROC_WATCH_DIR, `${PID}_${START}.json`), JSON.stringify(blocked.at(-1)));
    const lines = procWatchLines({ root: t.root, alive: () => true });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"Missing Addon"');
    expect(lines[0]).toContain("waits for OK");
  });

  it("a VM exception box still ends the process when a Missing Addon box is open beside it", async () => {
    const t = rig({ script: run5s(3, [otherWin("Missing Addon"), vmeWin()]) });
    expect(await t.run()).toBe(0);
    expect(t.kill).toHaveBeenCalledTimes(1);
    expect(t.state().state).toBe("ended_vme");
  });

  it("reports another dialog open 10 s as blocked_dialog and never ends it", async () => {
    const t = rig({ script: run5s(4, [otherWin()]) });
    await t.run();
    expect(t.kill).not.toHaveBeenCalled();
    const blocked = t.states.find((s) => s.state === "blocked_dialog");
    expect(blocked?.dialog).toEqual({ title: "Script Authorization Required", text: "Allow this?" });
    expect(t.states.filter((s) => s.state === "blocked_dialog").length).toBeGreaterThan(0);
  });

  it("does not take a similar title or a non-dialog window for the VM exception", async () => {
    const wrongCase = { ...vmeWin(), text: "Virtual Machine Exception" };
    const wrongClass = { ...vmeWin(), cls: "Static", owner: 5, ownerEnabled: false }; // still a dialog by the owner rule, but not the dialog box class
    for (const w of [wrongCase, wrongClass]) {
      const t = rig({ script: run5s(4, [w]) });
      await t.run();
      expect(t.kill).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["the instance file is missing", { inst: "missing" as const }, "missing or unreadable"],
    ["the instance file is unreadable", { inst: "garbage" as const }, "missing or unreadable"],
    ["the instance file is for another PID", { inst: { pid: 999 } }, "for PID 999"],
    ["the start time is off by over 10 s", { inst: { startedAt: START - 11_000 } }, "start time does not match"],
    ["the probe sample has no start time", { script: run5s(4, [vmeWin()]).map((s) => ({ ...s, start: undefined })) }, "start time does not match"],
    ["the running process was created an hour off the instance file (a reused PID)", { info: { created: START + 3_600_000 } }, "not created when"],
    ["the running process has no creation time", { info: { created: undefined } }, "not created when"],
    ["the command line only starts like the instance exe", { info: { cmd: `"${EXE}.x" -server x` } }, "not the one in the instance file"],
    ["another owner whose MCP process is dead", { inst: { ownerPid: 222 } }, "session that has ended"],
    ["another live owner", { inst: { ownerPid: 222 }, ownerInfo: { pid: 222, ppid: 1, cmd: "node", created: 4000 } }, "not started by this MCP session"],
    ["the process image is another program", { info: { cmd: '"C:\\Windows\\notepad.exe" -server x' } }, "not the one in the instance file"],
  ])("ends nothing when %s", async (_name, extra, why) => {
    const t = rig({ script: run5s(4, [vmeWin()]), ...extra });
    await t.run();
    expect(t.kill).not.toHaveBeenCalled();
    expect(existsSync(t.crashRoot)).toBe(false);
    const refused = t.states.find((s) => s.state === "blocked_dialog");
    expect(refused?.why).toContain(why);
    expect(refused?.dialog?.title).toBe("Virtual machine exception");
  });

  it("writes no state outside the state folder for a crafted start time in the instance file", async () => {
    const t = rig({ script: run5s(4, [vmeWin()]), inst: { startedAt: "/../../escaped" as never } });
    await t.run();
    expect(t.kill).not.toHaveBeenCalled();
    expect(readdirSync(t.root).sort()).toEqual(["emcp-instance.json", "logs", "state"]);
    expect(t.states.find((s) => s.state === "blocked_dialog")?.why).toContain("field startedAt");
  });

  // Every instance file field the re-check reads, damaged each way a hand edit could: a refusal that names it, never a throw.
  const fieldCases: [string, string, unknown][] = [
    ...Object.entries({ pid: PID, startedAt: START, ownerPid: OWNER, ownerStartedAt: OWNER_STARTED }).flatMap(([f, good]): [string, string, unknown][] => [[f, "missing", undefined], [f, "null", null], [f, "the right number as a string", String(good)]]),
    ["exe", "missing", undefined], ["exe", "null", null], ["exe", "a number", 5], ["exe", "an empty string", ""],
  ];
  it.each(fieldCases)("refuses an instance file whose %s is %s, and keeps watching", async (field, _case, value) => {
    const t = rig({ script: run5s(4, [vmeWin()]), inst: { [field]: value } });
    await expect(t.run()).resolves.toBe(0);
    expect(t.kill).not.toHaveBeenCalled();
    expect(existsSync(t.crashRoot)).toBe(false);
    const refused = t.states.filter((s) => s.state === "blocked_dialog");
    expect(refused.length).toBe(2); // samples 3 and 4: the re-check ran again on the next sample
    expect(refused[0].why).toBe(`not ended: the instance file field ${field} is missing or not valid`);
    expect(t.state().state).toBe("exited");
  });

  it("refuses when a re-check step throws, keeps watching, and ends the PID once the step works again", async () => {
    const t = rig({ script: run5s(4, [vmeWin()]), infoThrows: 1 });
    expect(await t.run()).toBe(0);
    expect(t.states.find((s) => s.state === "blocked_dialog")?.why).toBe("not ended: the re-check failed: the process query failed");
    expect(t.seen.statesAtKill).toContain("blocked_dialog"); // refused on sample 3, ended on sample 4
    expect(t.kill).toHaveBeenCalledTimes(1);
    expect(t.kill).toHaveBeenCalledWith([PID], true, false);
    expect(t.state().state).toBe("ended_vme");
  });

  it("still writes ended_vme with a note when the log folder lookup fails after the end", async () => {
    const t = rig({ script: run5s(3, [vmeWin()]), lookupThrows: true });
    expect(await t.run()).toBe(0);
    expect(t.kill).toHaveBeenCalledTimes(1);
    const s = t.state();
    expect(s.state).toBe("ended_vme");
    expect(s.note).toContain("lookup failed");
    expect(s.saved).toBeUndefined();
  });

  it("states end_failed when the process stays alive after the end request", async () => {
    const t = rig({ script: run5s(3, [vmeWin()]), killWorks: false });
    expect(await t.run()).toBe(0);
    expect(t.kill).toHaveBeenCalledTimes(1);
    expect(t.state().state).toBe("end_failed");
    expect(t.state().saved).toBeDefined();
  });

  it("ends the PID even with no crash folder set or a crash folder that cannot be made", async () => {
    const none = rig({ script: run5s(3, [vmeWin()]), crashDir: "none" });
    await none.run();
    expect(none.kill).toHaveBeenCalledTimes(1);
    expect(none.state().state).toBe("ended_vme");
    expect(none.state().saved).toBeUndefined();
    expect(none.state().note).toContain("no crash logs folder");
    expect(existsSync(none.crashRoot)).toBe(false);
    const blocked = rig({ script: run5s(3, [vmeWin()]), crashDir: "blocked" });
    await blocked.run();
    expect(blocked.kill).toHaveBeenCalledTimes(1);
    expect(blocked.state().state).toBe("ended_vme");
    expect(blocked.state().saved).toBeUndefined();
    expect(blocked.state().note).toBeTruthy();
  });
});

describe("proc-watch loop and start", () => {
  it("writes exited and exits when the probe gives no samples and the process is gone", async () => {
    const t = rig({ script: [] });
    expect(await t.run()).toBe(0);
    expect(t.state().state).toBe("exited");
    expect(t.state().samples).toBe(0);
    expect(t.kill).not.toHaveBeenCalled();
    expect(t.probeStop).toHaveBeenCalled();
  });

  it("is watching with a rising sample count and last sample time while samples arrive", async () => {
    const t = rig({ script: run5s(4, []) });
    await t.run();
    expect(t.states.map((s) => [s.state, s.samples, s.lastSample])).toEqual([["watching", 1, NOW], ["watching", 2, NOW + 5000], ["watching", 3, NOW + 10_000], ["watching", 4, NOW + 15_000]]);
    expect(t.state().state).toBe("exited");
  });

  it("a second watcher on the same process exits and starts no probe", async () => {
    const t = rig({ script: run5s(3, [vmeWin()]) });
    mkdirSync(t.stateDir, { recursive: true });
    writeFileSync(join(t.stateDir, `${PID}.lock`), "4242");
    expect(await t.run()).toBe(3);
    expect(t.probe).not.toHaveBeenCalled();
    expect(t.kill).not.toHaveBeenCalled();
  });

  it("starts a detached watcher with the PID, instance, owner and folders; on another platform starts nothing", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "emcp-pw-start-"));
    temps.push(stateDir);
    const spawn = vi.fn((_exe: string, _args: string[], _cwd: string, _log?: string) => 777);
    const w = { pid: PID, kind: "client" as const, instance: "C:\\p\\31820.emcp-instance.json", ownerPid: OWNER, ownerStarted: OWNER_STARTED, logsRoot: "C:\\logs", crashDir: "C:\\crashes", stateDir };
    expect(startProcWatcher(w, spawn, "win32")).toBe(777);
    const args = spawn.mock.calls[0][1];
    for (const pair of [["--pid", "31820"], ["--kind", "client"], ["--instance", w.instance], ["--owner-pid", "111"], ["--owner-started", "5000"], ["--logs-root", "C:\\logs"], ["--crash-dir", "C:\\crashes"], ["--state-dir", stateDir]]) {
      expect(args[args.indexOf(pair[0]) + 1]).toBe(pair[1]);
    }
    expect(startProcWatcher(w, spawn, "linux")).toBeUndefined();
    expect(startProcWatcher(w, spawn, "darwin")).toBeUndefined();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("the source never posts, focuses, shows, sends keys or calls an automation action, and has one kill call", () => {
    const src = readFileSync(join(__dirname, "../../src/watchdog/proc-watch.ts"), "utf-8");
    for (const word of ["PostMessage", "SetForegroundWindow", "ShowWindow", "SendKeys", "Invoke"]) expect(src).not.toContain(word);
    expect(src.match(/killPids\(/g)).toHaveLength(1);
  });
});
