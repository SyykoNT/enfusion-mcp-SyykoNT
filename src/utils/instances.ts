/**
 * Which dedicated servers and game clients this MCP started.
 *
 * Every server or client the MCP starts gets an instance file naming its PID and the MCP
 * process that owns it. Stop and status read the file for each running process; a process
 * without one belongs to someone else (another session, the user's own game) and is never stopped.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { argValue, processInfo, type ProcInfo } from "./process.js";
import { MCP_HOME } from "../config.js";

export interface Instance {
  kind: "server" | "client" | "workbench";
  name: string;
  pid: number;
  ownerPid: number;
  ownerStartedAt: number;
  startedAt: number;
  exe: string;
  port?: number;
  profileDir?: string;
}

export type InstanceClass = "own" | "orphan" | "foreign" | "stale";

export interface Entry {
  proc: ProcInfo;
  cls: InstanceClass;
  inst?: Instance;
  file?: string;
}

export const INSTANCE_FILE = "emcp-instance.json";

/** This MCP process. The start time tells a reused owner PID from the real owner. */
export const OWNER = { pid: process.pid, startedAt: Math.round(Date.now() - process.uptime() * 1000) };

/** Processes without a profile dir of their own (clients, Workbench) keep their file in a root folder, by PID. */
export const pidInstanceFile = (root: string, pid: number) => join(root, `${pid}.${INSTANCE_FILE}`);

/** Where the Workbench processes this MCP spawns are recorded. */
export const WORKBENCH_INSTANCES = join(MCP_HOME, "instances");

/** True only for a Workbench this MCP process spawned: recorded PID, same process start time (within 10 s), same owner. */
export function isOwned(pid: number, root = WORKBENCH_INSTANCES, proc = processInfo(pid)): boolean {
  return !!proc && classify(readInstance(pidInstanceFile(root, pid)), proc) === "own";
}

export function writeInstance(file: string, inst: Instance): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(inst, null, 2), "utf-8");
}

export function readInstance(file: string): Instance | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf-8")) as Instance;
  } catch {
    return undefined;
  }
}

/**
 * own: started by this MCP process. orphan: its MCP process has ended. foreign: another live MCP,
 * or no instance file. stale: the file does not describe this process (PID reused).
 * `ownerCreated` is the creation time of the process now holding `ownerPid`, undefined when none runs.
 */
export function classify(inst: Instance | undefined, proc: ProcInfo, ownerCreated?: number, owner = OWNER): InstanceClass {
  if (!inst) return "foreign";
  if (!Number.isFinite(inst.startedAt)) return "stale"; // a NaN compare below would read as not stale
  if (inst.pid !== proc.pid || Math.abs(proc.created - inst.startedAt) > 10_000) return "stale";
  if (inst.ownerPid === owner.pid && inst.ownerStartedAt === owner.startedAt) return "own";
  if (ownerCreated === undefined || ownerCreated > inst.ownerStartedAt + 5_000) return "orphan";
  return "foreign";
}

/**
 * Classify running processes. Servers are found through their own `-profile` dir;
 * with `clientRoot`, clients through `<clientRoot>\<pid>.emcp-instance.json`.
 */
export function scan(
  procs: ProcInfo[],
  opts: { clientRoot?: string; ownerCreated?: (pid: number) => number | undefined } = {}
): Entry[] {
  const lookup = opts.ownerCreated ?? ((pid: number) => processInfo(pid)?.created);
  const owners = new Map<number, number | undefined>();
  return procs.map((proc) => {
    const profile = argValue(proc.cmd, "-profile");
    const file = opts.clientRoot ? pidInstanceFile(opts.clientRoot, proc.pid) : profile ? join(profile, INSTANCE_FILE) : undefined;
    const inst = file ? readInstance(file) : undefined;
    const isOwn = inst?.ownerPid === OWNER.pid && inst.ownerStartedAt === OWNER.startedAt;
    if (inst && !isOwn && !owners.has(inst.ownerPid)) owners.set(inst.ownerPid, lookup(inst.ownerPid));
    return { proc, cls: classify(inst, proc, inst ? owners.get(inst.ownerPid) : undefined), inst, file: inst ? file : undefined };
  });
}

/** True when `path` is `root` or lies inside it (case-insensitive on Windows). */
export function isUnder(path: string, root: string): boolean {
  const r = relative(resolve(root), resolve(path));
  return !r.startsWith("..") && !isAbsolute(r);
}

/**
 * Which entries a stop may end: own ones, plus orphans whose instance file lies under one of
 * `roots` when `adoptOrphans` is set. With `instance`, only that one, or an error saying why not.
 */
export function planStop(
  entries: Entry[],
  opts: { instance?: string; adoptOrphans?: boolean; roots: string[] }
): { stop: Entry[]; error?: string } {
  const adoptable = (e: Entry) => e.cls === "orphan" && !!opts.adoptOrphans && opts.roots.some((r) => isUnder(e.file!, r));
  if (opts.instance) {
    const e = entries.find((x) => x.inst?.name === opts.instance && x.cls !== "stale");
    if (!e) return { stop: [], error: `Instance "${opts.instance}" not found.` };
    if (e.cls === "foreign") return { stop: [], error: `Instance "${opts.instance}" belongs to another session (MCP pid ${e.inst!.ownerPid}). Not stopped.` };
    if (e.cls === "orphan" && !adoptable(e)) {
      return { stop: [], error: `Instance "${opts.instance}" was started by an MCP session that has ended. Pass adoptOrphans=true to stop it.` };
    }
    return { stop: [e] };
  }
  return { stop: entries.filter((e) => e.cls === "own" || adoptable(e)) };
}

/** Markdown table of classified processes for `status`. */
export function instanceTable(entries: Entry[], now = Date.now()): string {
  if (!entries.length) return "";
  const rows = entries.map((e) => {
    const port = argValue(e.proc.cmd, "-addr") ?? argValue(e.proc.cmd, "-bindPort") ?? argValue(e.proc.cmd, "-client") ?? "";
    const owner = e.cls === "own" ? "this MCP" : e.inst ? `MCP pid ${e.inst.ownerPid}` : "";
    const uptime = e.proc.created ? `${Math.round((now - e.proc.created) / 60_000)} min` : "";
    return `| ${e.inst?.name ?? ""} | ${e.proc.pid} | ${e.cls} | ${port} | ${argValue(e.proc.cmd, "-profile") ?? ""} | ${owner} | ${uptime} |`;
  });
  return ["| instance | pid | class | port | profile | owner | uptime |", "|---|---|---|---|---|---|---|", ...rows].join("\n");
}
