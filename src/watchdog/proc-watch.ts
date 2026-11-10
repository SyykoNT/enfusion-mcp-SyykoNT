/**
 * Watcher for one dedicated server or game client the MCP started. It ends that one process, and only that one, when a
 * "Virtual machine exception" window stays open on it; any other dialog is reported and left alone. It never clicks,
 * answers, focuses or messages a window: its only action on a process is the force end of the PID it was started for.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { classify, isUnder, readInstance, type Instance } from "../utils/instances.js";
import { isAlive, killPids, newestDir, processInfo, sleep, spawnDetached } from "../utils/process.js";
import { copyCrashFiles } from "./auth.js";
import { startProbe, type ProbeSample } from "./probe.js";
import { dialogText, isDialog, parseCrashLog, type WinInfo } from "./signals.js";
import { claimWatch, hms, stamp, WATCH_DIR } from "./wb-watch.js";

export const PROC_WATCH_DIR = join(WATCH_DIR, "proc");
const SELF = fileURLToPath(import.meta.url);
const TICK_MS = 5000;
/** Class and exact title of the engine's script exception window (recorded from a live run, not read from the message). */
const VME_CLASS = "#32770";
const VME_TITLE = "Virtual machine exception";
const HOLD_MS = 10_000;
const FRESH_MS = 15_000;
const END_WAIT_MS = 5000;
const END_POLL_MS = 250;
const CRASH_LINES = 40;

export type ProcWatchStateName = "watching" | "blocked_dialog" | "ending_vme" | "ended_vme" | "end_failed" | "exited";

export interface ProcWatchOpts {
  pid: number;
  kind: "server" | "client";
  instance: string;
  /** The MCP process that wrote the instance file. */
  ownerPid: number;
  ownerStarted: number;
  logsRoot: string;
  crashDir?: string;
  stateDir: string;
}

export interface ProcWatchState {
  pid: number;
  kind: "server" | "client";
  instance: string;
  ownerPid: number;
  watcherPid: number;
  state: ProcWatchStateName;
  since: number;
  samples: number;
  lastSample?: number;
  dialog?: { title: string; text: string };
  /** blocked_dialog: why the process was not ended. */
  why?: string;
  reason?: string;
  /** First lines of the run's crash.log once the process is gone. */
  crashLog?: string[];
  /** The folder the run's logs were copied to, or why none was. */
  saved?: string;
  note?: string;
  updated: number;
}

export interface ProcWatchDeps {
  probe: typeof startProbe;
  alive(pid: number): boolean;
  now(): number;
  /** Between ticks. */
  wait(ms: number): Promise<unknown>;
  /** Between the checks that follow the end request. */
  settle(ms: number): Promise<unknown>;
  processInfo: typeof processInfo;
  kill: typeof killPids;
  readInstance(file: string): Instance | undefined;
}

const isVme = (w: WinInfo) => w.cls === VME_CLASS && w.text === VME_TITLE;
/** A server or client whose -addons names a mod it cannot find stops on this box until OK is pressed; it is reported, never answered or ended (D-067). */
const isMissingAddon = (w: WinInfo) => w.cls === VME_CLASS && w.text === "Missing Addon";
const norm = (p: string) => p.replace(/\//g, "\\").toLowerCase();
/** The command line starts with the instance's exe path, quoted or not, and the path ends there (end, space or quote). */
const sameImage = (cmd: string, exe: string) => {
  const c = norm(cmd).replace(/^"/, "");
  const e = norm(exe);
  return !!exe && c.startsWith(e) && (c.length === e.length || " \"".includes(c[e.length]));
};

type Checked = Pick<Instance, "pid" | "exe" | "startedAt" | "ownerPid" | "ownerStartedAt">;
/** The instance file comes from disk: every field the re-check reads is checked here, and a bad one is named in the refusal. */
function validInstance(raw: unknown, pid: number): { inst: Checked } | { why: string } {
  if (!raw || typeof raw !== "object") return { why: "the instance file is missing or unreadable" };
  const r = raw as Record<string, unknown>;
  const bad = (field: string) => ({ why: `the instance file field ${field} is missing or not valid` });
  const posInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
  if (!posInt(r.pid)) return bad("pid");
  if (r.pid !== pid) return { why: `the instance file is for PID ${r.pid}` };
  if (typeof r.exe !== "string" || !r.exe) return bad("exe");
  if (!Number.isSafeInteger(r.startedAt)) return bad("startedAt");
  if (!posInt(r.ownerPid)) return bad("ownerPid");
  if (!Number.isSafeInteger(r.ownerStartedAt)) return bad("ownerStartedAt");
  return { inst: { pid, exe: r.exe, startedAt: r.startedAt as number, ownerPid: r.ownerPid, ownerStartedAt: r.ownerStartedAt as number } };
}

/** Watch `o.pid` until it is gone. Returns the exit code: 0 done, 3 already watched. */
export async function runProcWatcher(o: ProcWatchOpts, over: Partial<ProcWatchDeps> = {}): Promise<number> {
  const d: ProcWatchDeps = {
    probe: startProbe, alive: isAlive, now: Date.now, wait: sleep, settle: sleep, processInfo,
    kill: (pids, force, tree) => killPids(pids, force, tree), readInstance, ...over,
  };
  mkdirSync(o.stateDir, { recursive: true });
  const claim = claimWatch(o.stateDir, o.pid, d.alive);
  if (!claim.ok) {
    process.stderr.write(claim.by ? `already watched by watcher PID ${claim.by}\n` : "already watched (lock being written)\n");
    return 3;
  }
  const lock = join(o.stateDir, `${o.pid}.lock`);
  // The name comes from a file the watcher does not own: only a whole number may reach the path.
  const started = d.readInstance(o.instance)?.startedAt;
  const file = join(o.stateDir, `${o.pid}_${Number.isSafeInteger(started) ? started : d.now()}.json`);
  let latest: ProbeSample | undefined;
  let samples = 0;
  let lastSample: number | undefined;
  let st: ProcWatchState | undefined;
  const save = (state: ProcWatchStateName, extra: Partial<ProcWatchState> = {}) => {
    const now = d.now();
    st = {
      pid: o.pid, kind: o.kind, instance: o.instance, ownerPid: o.ownerPid, watcherPid: process.pid, state,
      since: st?.state === state ? st.since : now, samples, lastSample, ...extra, updated: now,
    };
    writeFileSync(file + ".tmp", JSON.stringify(st, null, 2));
    renameSync(file + ".tmp", file);
  };

  /** Everything that must hold right before the end; any miss returns why, and nothing is ended. */
  const recheck = (s: ProbeSample): { why: string } | { start: number } => {
    const v = validInstance(d.readInstance(o.instance), o.pid);
    if ("why" in v) return v;
    const { inst } = v;
    const info = d.processInfo(o.pid);
    if (!info) return { why: "the process was not found" };
    if (!sameImage(info.cmd, inst.exe)) return { why: "the process image is not the one in the instance file" };
    const start = s.start ?? NaN;
    // Written as "not within" so a missing or NaN start refuses too.
    if (!(Math.abs(start - inst.startedAt) <= 10_000)) return { why: "the process start time does not match the instance file" };
    const owner = { pid: o.ownerPid, startedAt: o.ownerStarted };
    const mine = inst.ownerPid === owner.pid && inst.ownerStartedAt === owner.startedAt;
    // The live creation time (`info`) is checked too, so a reused PID is caught even when the sample is from the old process.
    // classify reads only the checked fields. Its stale test lets a NaN creation time through, so that is refused here.
    const cls = Number.isFinite(info.created) ? classify(inst as Instance, info, mine ? undefined : d.processInfo(inst.ownerPid)?.created, owner) : "stale";
    if (cls === "stale") return { why: "the running process was not created when the instance file says" };
    if (cls === "orphan") return { why: "it was started by an MCP session that has ended" };
    if (cls !== "own") return { why: "it was not started by this MCP session" };
    return { start };
  };

  /** Ends the process for an open VM exception window. Returns the final state's name, or undefined when nothing was ended. */
  const end = async (s: ProbeSample, win: WinInfo): Promise<ProcWatchStateName | undefined> => {
    const dialog = { title: win.text, text: dialogText(win) };
    let check: ReturnType<typeof recheck>;
    try {
      check = recheck(s);
    } catch (e) {
      // A throw refuses like any other miss: nothing is ended, and the next new sample runs the re-check again.
      check = { why: `the re-check failed: ${e instanceof Error ? e.message : String(e)}` };
    }
    if ("why" in check) {
      save("blocked_dialog", { dialog, why: `not ended: ${check.why}` });
      return undefined;
    }
    save("ending_vme", { dialog });
    d.kill([o.pid], true, false);
    const t0 = d.now();
    let gone = !d.alive(o.pid);
    while (!gone && d.now() - t0 < END_WAIT_MS) {
      await d.settle(END_POLL_MS);
      gone = !d.alive(o.pid);
    }
    // Copied after the end attempt: the engine writes crash.log only as the process ends. A failed copy never changes the result.
    let logDir: string | undefined;
    let saved: string | undefined;
    let note: string | undefined;
    try {
      logDir = newestDir(o.logsRoot, check.start - 5000) ?? undefined;
    } catch (e) {
      note = `the log folder lookup failed (${e instanceof Error ? e.message : String(e)})`;
    }
    if (!o.crashDir) note ??= "no crash logs folder is set, nothing was copied";
    else if (!note) {
      try {
        const when = stamp(d.now());
        const c = copyCrashFiles(logDir, o.crashDir, when, o.pid, `${o.kind}_${when}_${o.pid}`);
        if (c.copied.length) saved = c.dir;
        if (c.missing.length) note = `missing ${c.missing.join(", ")}`;
      } catch (e) {
        note = `the copy failed (${e instanceof Error ? e.message : String(e)})`;
      }
    }
    let crashText = "";
    try {
      crashText = logDir ? readFileSync(join(logDir, "crash.log"), "utf-8") : "";
    } catch {
      // no crash.log in that run
    }
    const state = gone ? "ended_vme" : "end_failed";
    save(state, { dialog, saved, note, reason: parseCrashLog(crashText).reason, crashLog: crashText ? crashText.split(/\r?\n/).slice(0, CRASH_LINES).map((l) => l.slice(0, 300)) : undefined });
    return state;
  };

  const probe = d.probe(o.pid, 0, (s) => (latest = s));
  try {
    save("watching");
    let vme: { hwnd: number; since: number } | undefined;
    let other: { hwnd: number; since: number } | undefined;
    for (;;) {
      if (!d.alive(o.pid)) {
        save("exited");
        return 0;
      }
      const s = latest;
      if (s && s.t !== lastSample && d.now() - s.t <= FRESH_MS) {
        samples++;
        lastSample = s.t;
        const dialogs = (s.wins ?? []).filter(isDialog);
        const vmeWin = dialogs.find(isVme);
        const otherWin = dialogs.find((w) => !isVme(w));
        vme = vmeWin ? (vme?.hwnd === vmeWin.hwnd ? vme : { hwnd: vmeWin.hwnd, since: s.t }) : undefined;
        other = otherWin ? (other?.hwnd === otherWin.hwnd ? other : { hwnd: otherWin.hwnd, since: s.t }) : undefined;
        if (vmeWin && vme && s.t - vme.since >= HOLD_MS) {
          const done = await end(s, vmeWin);
          if (done) return 0;
        } else if (otherWin && other && s.t - other.since >= HOLD_MS) {
          save("blocked_dialog", { dialog: { title: otherWin.text, text: dialogText(otherWin) }, ...(isMissingAddon(otherWin) ? { why: "the process waits for OK, it is not ended" } : {}) });
        } else save("watching");
      }
      await d.wait(TICK_MS);
    }
  } finally {
    probe.stop();
    try {
      if (Number(readFileSync(lock, "utf-8")) === process.pid) rmSync(lock, { force: true });
    } catch {
      // a lock that cannot be read or removed is taken over by the next claim
    }
  }
}

export interface StartProcWatcher {
  pid: number;
  kind: "server" | "client";
  instance: string;
  ownerPid: number;
  ownerStarted: number;
  logsRoot: string;
  crashDir?: string;
  stateDir?: string;
}

/** Start a detached watcher for one server or client PID. Returns the watcher PID; undefined on a platform it cannot watch. */
export function startProcWatcher(w: StartProcWatcher, spawn: typeof spawnDetached = spawnDetached, platform: string = process.platform): number | undefined {
  if (platform !== "win32") return undefined;
  const stateDir = w.stateDir ?? PROC_WATCH_DIR;
  mkdirSync(stateDir, { recursive: true });
  const args = [
    SELF, "--pid", String(w.pid), "--kind", w.kind, "--instance", w.instance, "--owner-pid", String(w.ownerPid),
    "--owner-started", String(w.ownerStarted), "--logs-root", w.logsRoot, "--state-dir", stateDir,
  ];
  if (w.crashDir) args.push("--crash-dir", w.crashDir);
  return spawn(process.execPath, args, dirname(SELF), join(stateDir, `${w.pid}.log`));
}

const DAY_MS = 24 * 3600_000;
const SHOWN = new Set<ProcWatchStateName>(["blocked_dialog", "ending_vme", "ended_vme", "end_failed"]);
const FINAL = new Set<ProcWatchStateName>(["ended_vme", "end_failed"]);

export interface ProcWatchQuery {
  /** Only states whose instance file lies under this folder (the tool's own root). */
  root: string;
  /** Only these PIDs, from states written at or after `since`. */
  pids?: number[];
  since?: number;
  /** Only ended_vme and end_failed. */
  final?: boolean;
  dir?: string;
  now?: number;
  alive?: (pid: number) => boolean;
}

const oneLine = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 200) : "");

/**
 * Report lines for the tools' status and exit replies: the watcher states of the last 24 h whose instance file lies under `root`.
 * A state written by an earlier MCP process counts. blocked_dialog and ending_vme are shown only while their watcher lives (a dead
 * watcher leaves its last word on disk), ended_vme and end_failed stay. The files are not ours to trust: a field of the wrong type drops the state.
 */
export function procWatchLines(q: ProcWatchQuery): string[] {
  const dir = q.dir ?? PROC_WATCH_DIR;
  const now = q.now ?? Date.now();
  const alive = q.alive ?? isAlive;
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => /^\d+_-?\d+\.json$/.test(n));
  } catch {
    // no watcher has run yet
  }
  const found: ProcWatchState[] = [];
  for (const n of names) {
    let s: ProcWatchState;
    try {
      s = JSON.parse(readFileSync(join(dir, n), "utf-8"));
    } catch {
      continue;
    }
    const ok = !!s && typeof s === "object" && SHOWN.has(s.state) && Number.isSafeInteger(s.pid) && s.pid > 0 && Number.isSafeInteger(s.watcherPid) && s.watcherPid > 0
      && (s.kind === "server" || s.kind === "client") && typeof s.instance === "string" && isAbsolute(s.instance) && Number.isFinite(s.updated);
    // Written as "not within" so a missing or NaN time drops the state too.
    if (!ok || !(now - s.updated <= DAY_MS) || !isUnder(s.instance, q.root)) continue;
    if (q.pids && !q.pids.includes(s.pid)) continue;
    if (q.since !== undefined && !(s.updated >= q.since)) continue;
    if (!FINAL.has(s.state) && (q.final || !alive(s.watcherPid))) continue;
    found.push(s);
  }
  return found.sort((a, b) => a.updated - b.updated).map((s) => {
    const title = oneLine(s.dialog?.title);
    const what = {
      blocked_dialog: `blocked by a dialog${title ? ` "${title}"` : ""}${s.why ? `, ${oneLine(s.why)}` : ", left open"}`,
      ending_vme: `ending it: a VM exception window${title ? ` "${title}"` : ""} stayed open`,
      ended_vme: `ended after a VM exception window${title ? ` "${title}"` : ""} stayed open${s.reason ? `; reason: ${oneLine(s.reason)}` : ""}`,
      end_failed: `could not be ended after a VM exception window stayed open`,
    }[s.state as "blocked_dialog" | "ending_vme" | "ended_vme" | "end_failed"];
    const kept = s.saved ? `; logs saved to ${oneLine(s.saved)}` : s.note ? `; ${oneLine(s.note)}` : "";
    return `- Process watcher, ${s.kind} PID ${s.pid}, ${hms(s.updated)}: ${what}${kept}`;
  });
}

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      pid: { type: "string" }, kind: { type: "string" }, instance: { type: "string" }, "owner-pid": { type: "string" },
      "owner-started": { type: "string" }, "logs-root": { type: "string" }, "crash-dir": { type: "string" }, "state-dir": { type: "string" },
    },
  });
  const pid = Number(values.pid);
  const ownerPid = Number(values["owner-pid"]);
  const ownerStarted = Number(values["owner-started"]);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("--pid <server or client pid> is required");
  if (values.kind !== "server" && values.kind !== "client") throw new Error("--kind must be server or client");
  if (!values.instance || !values["logs-root"]) throw new Error("--instance and --logs-root are required");
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || !Number.isSafeInteger(ownerStarted)) throw new Error("--owner-pid and --owner-started are required");
  return runProcWatcher({
    pid, kind: values.kind, instance: values.instance, ownerPid, ownerStarted, logsRoot: values["logs-root"],
    crashDir: values["crash-dir"], stateDir: values["state-dir"] ?? PROC_WATCH_DIR,
  });
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === SELF.toLowerCase()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`proc-watch: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }
  );
}
