/**
 * Automatic watch (B-093): attach a watcher to the Workbench that owns the NET API port this MCP calls, whoever started it.
 * Runs beside live calls, so every process query on this path is async.
 */

import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";
import { crashLogsDir, workbenchProfileDir } from "../workbench/cli.js";
import { WORKBENCH_INSTANCES, isOwned } from "../utils/instances.js";
import { isAlive, processInfoAsync, type ProcInfo } from "../utils/process.js";
import { WB_EXE, isWatcherCmd, watchAction } from "../tools/wb-watch-tool.js";
import { WATCH_DIR, autoBlocked, readStates, startWatcher, watcherOf, type StartWatcher } from "./wb-watch.js";
import { portOwner } from "./signals.js";

export interface AttachDeps {
  stateDir: string;
  platform: NodeJS.Platform;
  netstat(): Promise<string>;
  proc(pid: number): Promise<ProcInfo | undefined>;
  /** Ownership from the instance registry, given the process info already read. */
  owned(pid: number, proc: ProcInfo): boolean;
  alive(pid: number): boolean;
  start(w: StartWatcher): number;
  base: Omit<StartWatcher, "pid" | "owned" | "host" | "port">;
}

/** ok: attached or already watched (the client then skips checks for 60 s). text: one line for a timeout reply. */
export interface AttachResult {
  ok: boolean;
  text: string;
}

const LOCAL_HOSTS = ["127.0.0.1", "localhost", "::1"];

const netstat = () =>
  new Promise<string>((done) => execFile("netstat", ["-ano", "-p", "TCP"], { windowsHide: true, timeout: 10_000 }, (err, out) => done(err ? "" : String(out))));

export function attachDeps(config: Config): AttachDeps {
  return {
    stateDir: WATCH_DIR,
    platform: process.platform,
    netstat,
    proc: processInfoAsync,
    owned: (pid, proc) => isOwned(pid, WORKBENCH_INSTANCES, proc),
    alive: isAlive,
    start: startWatcher,
    base: { logsRoot: join(workbenchProfileDir(config), "logs"), scriptAuth: config.scriptAuth ?? "rules", crashDir: crashLogsDir(config) },
  };
}

function watchedText(dir: string, pid: number, watcher: number): string {
  const s = readStates(dir).states.find((x) => x.pid === pid);
  const presses = !s
    ? "wb_watch status shows what it presses"
    : s.dismiss === "watched" || (s.dismiss === "owned" && s.owned)
      ? 'it presses Ignore on the "Resources are leaking!" assert about 5 s after it shows'
      : `it does not press Ignore on the leak assert (dismissLeakAssert = ${s.dismiss})`;
  return `Workbench PID ${pid} is watched by watcher PID ${watcher}${s?.auto ? " (attached automatically)" : ""}: ${presses}.`;
}

/** The check of plan B-093 steps 1 to 5: one result line per outcome. Never kills; deletes only a watch lock a non-watcher holds. */
export async function ensureWatched(port: number, host: string, d: AttachDeps): Promise<AttachResult> {
  const no = (why: string): AttachResult => ({ ok: false, text: `Workbench not watched: ${why}.` });
  if (!LOCAL_HOSTS.includes(host.toLowerCase())) return no(`the NET API host ${host} is not this PC`);
  if (d.platform !== "win32") return no("the watcher runs only on Windows");
  const pid = portOwner(await d.netstat(), port);
  if (!pid) return no(`no process listens on port ${port}`);
  const proc = await d.proc(pid);
  if (!proc || !WB_EXE.test(proc.cmd)) return no(`port ${port} held by PID ${pid}, not a Workbench this MCP can watch`);

  const holder = watcherOf(d.stateDir, pid, d.alive);
  if (holder) {
    const h = await d.proc(holder);
    if (!h) return no(`the watch lock of Workbench PID ${pid} names PID ${holder}, whose command line could not be read`);
    if (isWatcherCmd(h.cmd, pid)) return { ok: true, text: watchedText(d.stateDir, pid, holder) };
    // A lock left by a watcher that died without cleanup, its PID now reused by another process: no watch.
    await rm(join(d.stateDir, `${pid}.lock`), { force: true });
  }
  if (autoBlocked(d.stateDir, pid, proc.created)) return no(`watch stopped by the user for Workbench PID ${pid} (wb_watch start pid=${pid} attaches one)`);

  let started: StartWatcher | undefined;
  let watcher = 0;
  const r = await watchAction(
    { action: "start", pid },
    {
      stateDir: d.stateDir,
      proc: (p) => (p === pid ? proc : undefined),
      owned: (p) => d.owned(p, proc),
      alive: d.alive,
      start: (w) => {
        started = w;
        return (watcher = d.start(w));
      },
      kill: () => {
        throw new Error("an automatic attach never stops a watcher");
      },
      base: { ...d.base, host, port, stateDir: d.stateDir },
    },
    { auto: true, proc }
  );
  if (r.isError || !started) return { ok: false, text: `Workbench not watched: ${r.text}` };
  return {
    ok: true,
    text:
      `Attached watcher PID ${watcher} to Workbench PID ${pid} (${started.owned ? "started by this MCP" : "not started by this MCP"}): ` +
      `it presses Ignore on the "Resources are leaking!" assert within about 10 s and answers Script Authorization by ENFUSION_SCRIPT_AUTH=${d.base.scriptAuth ?? "rules"}. ` +
      "A call that timed out may still finish: check the state before repeating it.",
  };
}
