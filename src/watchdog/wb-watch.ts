/**
 * Watchdog for one Workbench PID (PX-N5). Runs detached as `node wb-watch.js --pid N ...`, checks every 5 s,
 * writes `<stateDir>/<pid>.json` and `<stateDir>/events.jsonl`, and exits when that Workbench is gone.
 * `node wb-watch.js alerts --session <id>` prints alerts a session has not seen yet, for a Claude Code hook.
 * Reports on any Workbench; clicks (Ignore on the leak assert, D-031) or recovers (owned only) per decide() in signals.ts.
 */

import { execFileSync } from "node:child_process";
import {
  appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync,
  rmSync, statSync, writeFileSync, writeSync, fstatSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MCP_HOME } from "../config.js";
import { crashReporters, isAlive, killPids, processInfo, sleep, spawnDetached } from "../utils/process.js";
import {
  decide, likelyTrigger, leakAssertButton, loadedProjects, lockHeldBy, newCarry, parseCrashLog, parseLogChunk, portOwner,
  type Dismiss, type LogCarry, type Signals, type WatchStateName,
} from "./signals.js";
import { dismissLeakAssert, startProbe, type ProbeSample } from "./probe.js";

export const WATCH_DIR = join(MCP_HOME, "watch");
const SELF = fileURLToPath(import.meta.url);
const TICK_MS = 5000;
/** Qt prompts found by title (tools\reforger-test-kit assert_ignorer.ps1); report only. */
const DIALOG_TITLES = ["Opening world", "Script Authorization Required"];

export interface WatchOpts {
  pid: number;
  startTime?: number;
  owned: boolean;
  owner?: string;
  session?: string;
  lock?: string;
  stateDir: string;
  logsRoot?: string;
  dismiss: Dismiss;
  autoRecover: boolean;
  recoverAfterMin: number;
  host: string;
  port: number;
}

export interface WatchState {
  pid: number;
  watcherPid: number;
  owned: boolean;
  owner?: string;
  state: WatchStateName;
  since: number;
  kind?: string;
  dialog?: { title: string; text: string };
  reloadOpenSince?: number;
  trigger?: string[];
  crash?: { reason?: string; file?: string; line?: number };
  lastLines: string[];
  workingSet?: number;
  workingSetDelta5m?: number;
  cpuDelta5m?: number;
  portOwner?: number | null;
  crashReporters?: { pid: number; ppid: number }[];
  actions: string[];
  logDir?: string;
  dismiss: Dismiss;
  autoRecover: boolean;
  updated: number;
}

export interface WatchDeps {
  sample(): ProbeSample | undefined;
  alive(pid: number): boolean;
  now(): number;
  dismiss(pid: number, hwnd: number): Promise<string>;
  recover(o: WatchOpts, startTime: number | undefined): Promise<string>;
}

/** Workbench names its log folder after its process start: logs_yyyy-MM-dd_HH-mm-ss. Accept one within 3 s. */
export function findLogDir(logsRoot: string, startMs: number): string | undefined {
  let names: string[];
  try {
    names = readdirSync(logsRoot);
  } catch {
    return undefined;
  }
  for (const n of names) {
    const m = n.match(/^logs_(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)$/);
    if (m && Math.abs(new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() - startMs) <= 3000) return join(logsRoot, n);
  }
  return undefined;
}

/** `.c` files under each project's Scripts folder modified between `from` and `to`. */
export function cFilesBetween(dirs: string[], from: number, to: number): { path: string; mtimeMs: number }[] {
  const out: { path: string; mtimeMs: number }[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".c")) {
        const t = statSync(p).mtimeMs;
        if (t >= from && t <= to) out.push({ path: p, mtimeMs: t });
      }
    }
  };
  for (const d of dirs) walk(join(d, "Scripts"));
  return out;
}

const readText = (p: string) => {
  try {
    return readFileSync(p, "utf-8");
  } catch {
    return undefined;
  }
};

/** One watcher's memory between ticks. tick() reads, decides, writes state and acts. */
export function createWatcher(o: WatchOpts, deps: WatchDeps) {
  const statePath = join(o.stateDir, `${o.pid}.json`);
  let logDir: string | undefined;
  let offset = 0;
  let carry: LogCarry | undefined;
  let head = "";
  let crashMtime = 0;
  let triggerFor: number | undefined;
  let clickAt: number | undefined;
  let badSince: number | undefined;
  let recovered = false;
  let startTime = o.startTime;
  const sig: Omit<Signals, "now" | "alive"> = {};
  const mem: { t: number; ws: number; cpu: number }[] = [];
  /** Every action goes into the report and into events.jsonl. */
  const note = (t: number, action: string) => {
    st.actions.push(action);
    appendFileSync(join(o.stateDir, "events.jsonl"), JSON.stringify({ t, pid: o.pid, action }) + "\n");
  };
  const st: WatchState = {
    pid: o.pid, watcherPid: process.pid, owned: o.owned, owner: o.owner, state: "ok", since: deps.now(),
    lastLines: [], actions: [], dismiss: o.dismiss, autoRecover: o.autoRecover, updated: deps.now(),
  };

  const readLog = (now: number) => {
    const file = join(logDir!, "console.log");
    if (!existsSync(file)) return;
    // Workbench holds console.log open for writing; "r" opens it with read and write sharing.
    const fd = openSync(file, "r");
    try {
      const size = fstatSync(fd).size;
      if (size < offset) offset = 0;
      if (size === offset) return;
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      const text = buf.toString("utf-8");
      if (head.length < 65_536) head += text.slice(0, 65_536 - head.length);
      const r = parseLogChunk(text, carry ?? newCarry(startTime ?? now));
      carry = r.carry;
      if (r.lastAt) sig.lastLogAt = r.lastAt;
      st.lastLines = [...st.lastLines, ...r.lines].slice(-5);
      for (const e of r.events) {
        if (e.kind === "reloadStart") sig.reloadOpenSince = e.at;
        if (e.kind === "reloadEnd") {
          sig.reloadOpenSince = undefined;
          if (clickAt !== undefined) {
            note(e.at, `reload finished ${hms(e.at)}`);
            clickAt = undefined;
          }
        }
        if (e.kind === "appHangs") sig.hangAt = Math.max(sig.hangAt ?? 0, e.at);
        if (e.kind === "shutdown") sig.shutdownSeen = true;
      }
    } finally {
      closeSync(fd);
    }
  };

  const statFolder = () => {
    for (const n of readdirSync(logDir!)) {
      const t = statSync(join(logDir!, n)).mtimeMs;
      if (n === "crash.log" && t !== crashMtime) {
        crashMtime = t;
        const c = parseCrashLog(readText(join(logDir!, n)) ?? "");
        sig.crash = { at: t, reason: c.reason, assert: c.assert };
        st.crash = { reason: c.reason, file: c.file, line: c.line };
      }
      if (/\.mdmp$/i.test(n)) sig.dumpAt = Math.max(sig.dumpAt ?? 0, t);
      if (/^FREEZE_.*\.mdmp$/i.test(n)) sig.hangAt = Math.max(sig.hangAt ?? 0, t);
    }
  };

  return {
    async tick(): Promise<WatchState> {
      const now = deps.now();
      const s = deps.sample();
      startTime ??= s?.start;
      // The PID is ours only while its start time matches; a reused PID means our Workbench is gone.
      const alive = deps.alive(o.pid) && s?.alive !== false && !(startTime && s?.start && Math.abs(s.start - startTime) > 10_000);

      if (!logDir && startTime && o.logsRoot) logDir = findLogDir(o.logsRoot, startTime);
      if (logDir) {
        st.logDir = logDir;
        readLog(now);
        statFolder();
      }

      const win = s?.wins?.find((w) => w.cls === "#32770" || DIALOG_TITLES.includes(w.text));
      if (!win) sig.dialog = undefined;
      else if (sig.dialog?.hwnd !== win.hwnd) {
        const button = leakAssertButton(win);
        sig.dialog = { hwnd: win.hwnd, kind: button ? "leak_assert" : "other", since: now, button };
        st.dialog = { title: win.text, text: (win.children ?? []).map((c) => c.text).filter(Boolean).join(" | ").slice(0, 300) };
      }
      if (!win) st.dialog = undefined;
      sig.hungSince = s?.wins?.some((w) => w.hung && w !== win) ? (sig.hungSince ?? now) : undefined;

      if (s?.ws !== undefined && s.cpu !== undefined) {
        mem.push({ t: now, ws: s.ws, cpu: s.cpu });
        while (mem.length > 1 && now - mem[1].t >= 300_000) mem.shift();
        st.workingSet = s.ws;
        st.workingSetDelta5m = s.ws - mem[0].ws;
        st.cpuDelta5m = Math.round(s.cpu - mem[0].cpu);
      }
      if (s?.alive) {
        st.portOwner = s.port ?? null;
        st.crashReporters = s.crs;
      }

      const d = decide(
        { ...sig, now, alive },
        { owned: o.owned, dismiss: o.dismiss, autoRecover: o.autoRecover, recoverAfterMs: o.recoverAfterMin * 60_000,
          lockHeld: lockHeldBy(o.lock ? readText(o.lock) : undefined, o), badSince, recovered }
      );
      badSince = d.state === "not_responding" || d.state === "stalled" ? (badSince ?? now) : undefined;

      if (sig.reloadOpenSince !== undefined && triggerFor !== sig.reloadOpenSince && head) {
        triggerFor = sig.reloadOpenSince;
        const dirs = loadedProjects(head, readText);
        st.trigger = likelyTrigger(cFilesBetween(dirs, triggerFor - 5000, triggerFor + 1000), triggerFor);
      }
      st.reloadOpenSince = sig.reloadOpenSince;

      for (const a of d.actions) {
        if (a.type === "click") {
          sig.clicked = a.hwnd;
          const r = await deps.dismiss(o.pid, a.hwnd);
          note(now, r === "clicked" ? `Ignore clicked ${hms(now)}` : `Ignore not clicked: ${r}`);
          if (r === "clicked") clickAt = now;
        } else {
          recovered = true;
          note(now, `autoRecover ${hms(now)}: ${await deps.recover(o, startTime)}`);
        }
      }
      if (clickAt !== undefined && now - clickAt > 120_000) {
        note(now, `no "Reloading game scripts took" within 120 s of the click`);
        clickAt = undefined;
      }

      if (d.state !== st.state || d.kind !== st.kind) {
        st.state = d.state;
        st.kind = d.kind;
        st.since = now;
        appendFileSync(join(o.stateDir, "events.jsonl"), JSON.stringify({ t: now, pid: o.pid, state: d.state, kind: d.kind }) + "\n");
      }
      st.updated = now;
      writeFileSync(statePath + ".tmp", JSON.stringify(st, null, 2));
      renameSync(statePath + ".tmp", statePath);
      return st;
    },
  };
}

/** One watcher per PID: `<pid>.lock` holds the watcher's PID. A lock whose watcher is dead is taken over. */
export function claimWatch(dir: string, pid: number, alive = isAlive): { ok: true } | { ok: false; by: number } {
  const file = join(dir, `${pid}.lock`);
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return { ok: true };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const by = Number(readText(file));
      if (by && alive(by)) return { ok: false, by };
      rmSync(file, { force: true });
    }
  }
  return { ok: false, by: 0 };
}

/** The running watcher of `pid`, if any. */
export function watcherOf(dir: string, pid: number, alive = isAlive): number | undefined {
  const by = Number(readText(join(dir, `${pid}.lock`)));
  return by && alive(by) ? by : undefined;
}

const netstat = () => {
  try {
    return execFileSync("netstat", ["-ano", "-p", "TCP"], { encoding: "utf-8", windowsHide: true });
  } catch {
    return "";
  }
};

/** Owned only: Exit through the NET API (if this PID holds the port), then kill this PID alone, then its own CrashReporter. Never WM_CLOSE. */
async function recover(o: WatchOpts, startTime: number | undefined): Promise<string> {
  const notes: string[] = [];
  const holder = portOwner(netstat(), o.port);
  if (holder === o.pid) {
    try {
      const { WorkbenchClient } = await import("../workbench/client.js");
      await new WorkbenchClient(o.host, o.port).call("EMCP_WB_Exit", { save: false }, { timeout: 20_000 });
      notes.push("NET API exit sent");
    } catch (e) {
      notes.push(`NET API exit failed (${e instanceof Error ? e.message : String(e)})`);
    }
  } else {
    notes.push(`NET API exit skipped (port ${o.port} held by ${holder ? `PID ${holder}` : "nobody"})`);
  }
  for (let i = 0; i < 60 && isAlive(o.pid); i++) await sleep(1000);
  const proc = isAlive(o.pid) ? processInfo(o.pid) : undefined;
  if (proc && startTime && Math.abs(proc.created - startTime) <= 10_000) {
    killPids([o.pid], true);
    notes.push(`process ${o.pid} killed`);
  }
  for (const cr of crashReporters()) {
    if (cr.ppid === o.pid && portOwner(netstat(), o.port) === cr.pid) {
      killPids([cr.pid], true);
      notes.push(`its CrashReporter ${cr.pid} (held port ${o.port}) ended`);
    } else {
      notes.push(`CrashReporter ${cr.pid} (parent ${cr.ppid}) left alone`);
    }
  }
  notes.push("lock file not changed (lock note not built yet)");
  return notes.join("; ");
}

/** Watch until the Workbench is gone. Returns the exit code: 0 done, 3 already watched. */
export async function runWatcher(
  o: WatchOpts,
  over: Partial<WatchDeps> & { probe?: typeof startProbe; wait?: (ms: number) => Promise<unknown> } = {}
): Promise<number> {
  mkdirSync(o.stateDir, { recursive: true });
  const claim = claimWatch(o.stateDir, o.pid);
  if (!claim.ok) {
    process.stderr.write(`already watched by watcher PID ${claim.by}\n`);
    return 3;
  }
  let latest: ProbeSample | undefined;
  const probe = (over.probe ?? startProbe)(o.pid, o.port, (s) => (latest = s));
  const w = createWatcher(o, {
    sample: () => latest,
    alive: isAlive,
    now: Date.now,
    dismiss: (pid, hwnd) => dismissLeakAssert(pid, hwnd),
    recover,
    ...over,
  });
  try {
    for (;;) {
      const s = await w.tick();
      if (s.state === "exited" || s.state === "crashed") return 0;
      await (over.wait ?? sleep)(TICK_MS);
    }
  } finally {
    probe.stop();
    rmSync(join(o.stateDir, `${o.pid}.lock`), { force: true });
  }
}

export interface StartWatcher {
  pid: number;
  startTime?: number;
  owned: boolean;
  owner?: string;
  dismiss?: Dismiss;
  autoRecover?: boolean;
  logsRoot?: string;
  host: string;
  port: number;
  stateDir?: string;
}

/** Start a detached watcher for one Workbench. Returns the watcher PID. */
export function startWatcher(w: StartWatcher): number {
  const stateDir = w.stateDir ?? WATCH_DIR;
  mkdirSync(stateDir, { recursive: true });
  const args = [SELF, "--pid", String(w.pid), "--state-dir", stateDir, "--host", w.host, "--port", String(w.port), "--dismiss", w.dismiss ?? "watched"];
  if (w.startTime) args.push("--start-time", String(w.startTime));
  if (w.owned) args.push("--owned");
  if (w.owner) args.push("--owner", w.owner);
  if (w.autoRecover) args.push("--auto-recover");
  if (w.logsRoot) args.push("--logs-root", w.logsRoot);
  if (process.env.ENFUSION_WORKBENCH_LOCK) args.push("--lock", process.env.ENFUSION_WORKBENCH_LOCK);
  return spawnDetached(process.execPath, args, dirname(SELF), join(stateDir, `${w.pid}.log`));
}

/** Every `<pid>.json` in the state dir, and the files that could not be read. */
export function readStates(dir = WATCH_DIR): { states: WatchState[]; errors: string[] } {
  const states: WatchState[] = [];
  const errors: string[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => /^\d+\.json$/.test(n));
  } catch {
    // no watcher has run yet
  }
  for (const n of names) {
    try {
      states.push(JSON.parse(readFileSync(join(dir, n), "utf-8")) as WatchState);
    } catch (e) {
      errors.push(`watch state unreadable: ${join(dir, n)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { states, errors };
}

const BAD: WatchStateName[] = ["blocked_dialog", "not_responding", "stalled"];

/** Worth telling a session now: a live watcher sees trouble, or a crash in the last 30 min. */
export const isAlert = (s: WatchState, now = Date.now(), alive = isAlive) =>
  (BAD.includes(s.state) && alive(s.watcherPid)) || (s.state === "crashed" && now - s.updated < 1_800_000);

const pad = (n: number) => String(n).padStart(2, "0");
export const hms = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
export const dur = (ms: number) => {
  const m = Math.floor(ms / 60_000);
  return m < 1 ? `${Math.round(ms / 1000)} s` : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const gb = (b: number) => `${(b / 2 ** 30).toFixed(1)} GB`;

/** One line for tool footers and hook alerts. */
export function alertLine(s: WatchState, now = Date.now()): string {
  const since = `since ${hms(s.since)} (${dur(now - s.since)})`;
  switch (s.state) {
    case "blocked_dialog": return `Workbench PID ${s.pid} blocked by ${s.kind ?? "a dialog"} ${since}`;
    case "not_responding": return `Workbench PID ${s.pid} not responding ${since}`;
    case "stalled": return `Workbench PID ${s.pid} stalled (script reload not finished, no log line for 10 min) ${since}`;
    case "crashed": return `Workbench PID ${s.pid} crashed at ${hms(s.since)}${s.crash?.reason ? `: ${s.crash.reason}` : ""}`;
    default: return `Workbench PID ${s.pid} ${s.state} ${since}`;
  }
}

const LABEL: Record<WatchStateName, string> = {
  ok: "OK", busy: "BUSY", blocked_dialog: "BLOCKED by dialog", not_responding: "NOT RESPONDING", stalled: "STALLED", exited: "EXITED", crashed: "CRASHED",
};

/** Full report for wb_watch status and wb_diagnose. */
export function formatReport(s: WatchState, now = Date.now()): string {
  const who = s.owned ? "owned" : "not owned";
  const lines = [`Workbench PID ${s.pid} (${who}${s.owner ? `, owner "${s.owner}"` : ""}): ${LABEL[s.state]}${s.kind ? ` (${s.kind})` : ""} since ${hms(s.since)} (${dur(now - s.since)})`];
  if (s.dialog) lines.push(`  dialog: "${s.dialog.title}" ${s.dialog.text ? `"${s.dialog.text}"` : ""}`.trimEnd());
  if (s.crash?.reason) lines.push(`  crash.log: ${s.crash.reason}${s.crash.line ? ` (line ${s.crash.line})` : ""}`);
  if (s.reloadOpenSince) lines.push(`  open operation: script reload started ${hms(s.reloadOpenSince)}, not finished`);
  if (s.trigger?.length) lines.push(`  likely trigger: ${s.trigger.join(", ")}`);
  if (s.workingSet !== undefined) {
    lines.push(`  memory ${gb(s.workingSet)} (${(s.workingSetDelta5m ?? 0) >= 0 ? "+" : ""}${gb(s.workingSetDelta5m ?? 0)} in 5 min), CPU +${s.cpuDelta5m ?? 0} s`);
  }
  if (s.portOwner !== undefined) lines.push(`  NET API port owner: ${s.portOwner ? `PID ${s.portOwner}` : "none"}`);
  if (s.crashReporters?.length) lines.push(`  CrashReporter: ${s.crashReporters.map((c) => `PID ${c.pid} (parent ${c.ppid})`).join(", ")}`);
  if (s.lastLines.length) lines.push("  last log lines:", ...s.lastLines.map((l) => `    ${l}`));
  lines.push(`  actions: ${s.actions.length ? s.actions.join("; ") : `none (dismissLeakAssert = ${s.dismiss}${s.dismiss === "owned" && !s.owned ? "; this PID is not owned" : ""})`}`);
  if (s.state === "blocked_dialog") {
    lines.push("  advice: answer the dialog in Workbench (for the leak assert click Ignore, never Abort or Retry), or ask whoever uses it. Do not save .c files in its loaded projects.");
  }
  if (s.logDir) lines.push(`  logs: ${s.logDir}`);
  return lines.join("\n");
}

/** Hook output for alerts this session has not seen; "" when there is nothing new. */
export function alerts(dir: string, session: string, event = "PostToolUse", now = Date.now(), alive = isAlive): string {
  const active = readStates(dir).states.filter((s) => isAlert(s, now, alive));
  const seenFile = join(dir, `seen-${session.replace(/[^\w.-]/g, "_")}.json`);
  const seen = new Set<string>(JSON.parse(readText(seenFile) ?? "[]"));
  const key = (s: WatchState) => `${s.pid}:${s.state}:${s.since}`;
  const fresh = active.filter((s) => !seen.has(key(s)));
  writeFileSync(seenFile, JSON.stringify(active.map(key)));
  if (!fresh.length) return "";
  const text = fresh.map((s) => `${alertLine(s, now)}. Run wb_watch status for details.`).join("\n");
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      pid: { type: "string" }, "start-time": { type: "string" }, owned: { type: "boolean" }, owner: { type: "string" },
      session: { type: "string" }, lock: { type: "string" }, "state-dir": { type: "string" }, "logs-root": { type: "string" },
      dismiss: { type: "string" }, "auto-recover": { type: "boolean" }, "recover-after-min": { type: "string" },
      host: { type: "string" }, port: { type: "string" }, event: { type: "string" },
    },
  });
  const stateDir = values["state-dir"] ?? WATCH_DIR;
  if (positionals[0] === "alerts") {
    if (!values.session) throw new Error("alerts needs --session <id>");
    const out = alerts(stateDir, values.session, values.event);
    if (out) process.stdout.write(out + "\n");
    return 0;
  }
  const pid = Number(values.pid);
  const dismiss = (values.dismiss ?? "watched") as Dismiss;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("--pid <workbench pid> is required");
  if (!["owned", "watched", "never"].includes(dismiss)) throw new Error("--dismiss must be owned, watched or never");
  return runWatcher({
    pid, stateDir, dismiss,
    startTime: values["start-time"] ? Number(values["start-time"]) : undefined,
    owned: !!values.owned, owner: values.owner, session: values.session, lock: values.lock, logsRoot: values["logs-root"],
    autoRecover: !!values["auto-recover"], recoverAfterMin: Number(values["recover-after-min"] ?? 5),
    host: values.host ?? "127.0.0.1", port: Number(values.port ?? 5775),
  });
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === SELF.toLowerCase()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`wb-watch: ${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    }
  );
}
