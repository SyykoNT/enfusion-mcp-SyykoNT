/**
 * Pure parts of the Workbench watchdog (PX-N5): read Workbench's own logs and decide the state.
 * No I/O here; wb-watch.ts feeds it what it reads.
 */

import { dirname, resolve } from "node:path";

export type LogEventKind = "reloadStart" | "reloadEnd" | "appHangs" | "shutdown";
export interface LogEvent {
  kind: LogEventKind;
  at: number;
  line: string;
}

/** Bytes of a line not yet ended, plus the clock: log lines carry only HH:MM:SS.mmm. */
export interface LogCarry {
  partial: string;
  day: number;
  last: number;
}

const DAY = 86_400_000;
const midnight = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

/** Carry for a log that starts at `startMs` (the Workbench process start time). */
export const newCarry = (startMs: number): LogCarry => ({ partial: "", day: midnight(startMs), last: startMs });

const PATTERNS: [LogEventKind, RegExp][] = [
  ["reloadEnd", /Reloading game scripts took:/],
  ["reloadStart", /Reloading game scripts\s*$/],
  ["appHangs", /Application hangs \(generated dump and waiting\)/],
  ["shutdown", /ResourceDB: saving cache/],
];

/** Parse new console.log text. Returns events, every complete line, the time of the last stamped line and the next carry. */
export function parseLogChunk(text: string, carry: LogCarry): { events: LogEvent[]; lines: string[]; lastAt?: number; carry: LogCarry } {
  const all = (carry.partial + text).split(/\r?\n/);
  const partial = all.pop() ?? "";
  let { day, last } = carry;
  let lastAt: number | undefined;
  const events: LogEvent[] = [];
  const lines = all.filter((l) => l.trim());
  for (const line of lines) {
    const m = line.match(/^(\d\d):(\d\d):(\d\d)\.(\d{3})/);
    if (!m) continue;
    let at = day + ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +m[4];
    // Past midnight the clock starts again; logs never go back in time otherwise.
    if (at < last - DAY / 2) {
      day += DAY;
      at += DAY;
    }
    last = lastAt = at;
    const hit = PATTERNS.find(([, re]) => re.test(line));
    if (hit) events.push({ kind: hit[0], at, line });
  }
  return { events, lines, lastAt, carry: { partial, day, last } };
}

/** The last entry of a Workbench crash.log: "Assertion failed", "File:", "Line:", "Reason:". */
export function parseCrashLog(text: string): { reason?: string; file?: string; line?: number; assert: boolean } {
  const block = text.split(/^-{20,}\s*$/m).pop() ?? "";
  const field = (k: string) => block.match(new RegExp(`^${k}:\\s*(.+?)\\s*$`, "m"))?.[1];
  const line = field("Line");
  return { reason: field("Reason"), file: field("File"), line: line ? Number(line) : undefined, assert: /Assertion failed/.test(block) };
}

/**
 * Folders of the projects a Workbench loads: the -gproj from "CLI Params" plus its Dependencies, recursively,
 * resolved through the "gproj: '<path>' guid: '<GUID>'" lines. Those lines alone list every addon in -addonsDir.
 */
export function loadedProjects(consoleHead: string, readGproj: (path: string) => string | undefined): string[] {
  const target = consoleHead.match(/CLI Params:.*?-gproj\s+"?(.+?\.gproj)"?(?=\s|$)/i)?.[1];
  if (!target) return [];
  const byGuid = new Map<string, string>();
  for (const m of consoleHead.matchAll(/gproj: '([^']+)' guid: '([0-9A-Fa-f]{16})'/g)) byGuid.set(m[2].toUpperCase(), resolve(m[1]));
  const seen = new Map<string, string>();
  const queue = [resolve(target)];
  while (queue.length) {
    const path = queue.shift()!;
    if (seen.has(path.toLowerCase())) continue;
    seen.set(path.toLowerCase(), path);
    const deps = readGproj(path)?.match(/Dependencies\s*\{([^}]*)\}/)?.[1] ?? "";
    for (const g of deps.matchAll(/"([0-9A-Fa-f]{16})"/g)) {
      const p = byGuid.get(g[1].toUpperCase());
      if (p) queue.push(p);
    }
  }
  return [...seen.values()].map((p) => dirname(p));
}

/** Files written from 5 s before to 1 s after a reload: what made Workbench reload by itself. */
export const likelyTrigger = (files: { path: string; mtimeMs: number }[], reloadAt: number) =>
  files.filter((f) => f.mtimeMs >= reloadAt - 5000 && f.mtimeMs <= reloadAt + 1000).map((f) => f.path);

export const LEAK_TEXT = "Resources are leaking! Check log!";

export interface WinInfo {
  hwnd: number;
  cls: string;
  text: string;
  visible?: boolean;
  hung?: boolean;
  children?: WinInfo[];
  /** Owner window (0 or absent: none) and whether it is enabled; null when the owner belongs to another process. */
  owner?: number;
  ownerEnabled?: boolean | null;
  buttons?: string[];
}

const DIALOG_TITLES = ["Opening world", "Script Authorization Required"];
const VALIDATING = "Validating ";

/** A blocking dialog (D3): its same-PID owner is disabled; fallback for owners we could not read: box class or known title. */
export function isDialog(w: WinInfo): boolean {
  return !!w.visible && ((!!w.owner && w.ownerEnabled === false) || w.cls === "#32770" || DIALOG_TITLES.includes(w.text) || w.text.startsWith(VALIDATING));
}

export type DialogKind = "leak_assert" | "script_authorization" | "open_world_prompt" | "obsolete_world" | "save_as" | "other";

/** Title and body text are data from the window, only compared here, never used to build a command. */
export function dialogKind(w: WinInfo): DialogKind {
  if (leakAssertButton(w)) return "leak_assert";
  if (w.text === "Script Authorization Required") return "script_authorization";
  if (w.text === "Opening world") return "open_world_prompt";
  if (/obsolete/i.test(dialogText(w))) return "obsolete_world";
  if (w.text.startsWith("Save world as")) return "save_as";
  return "other";
}

/** Body text of a dialog: its child texts, capped at 300 characters. */
export const dialogText = (w: WinInfo) => (w.children ?? []).map((c) => c.text).filter(Boolean).join(" | ").slice(0, 300);

/** Windows that blocked one Workbench PID, or why they could not be read. */
export type DialogProbe = { pid: number; dialogs: WinInfo[] } | { pid: number; unavailable: string };

/** The text appended to a timeout or launch failure. Empty when there is no Workbench PID to report on. */
export function formatDialogs(list: DialogProbe[]): string {
  const lines: string[] = [];
  let open = false;
  for (const p of list) {
    if ("unavailable" in p) lines.push(`Workbench PID ${p.pid} (dialog check unavailable: ${p.unavailable})`);
    else if (!p.dialogs.length) lines.push(`No dialog is open in Workbench PID ${p.pid}; it may be loading, compiling or hung.`);
    else {
      open = true;
      lines.push(`Workbench PID ${p.pid} has a dialog open, which blocks every NET API call:`);
      for (const w of p.dialogs) {
        const text = dialogText(w);
        lines.push(`- "${w.text}" (${w.cls})${text ? `: "${text}"` : ""}${w.buttons?.length ? ` buttons: ${w.buttons.join(", ")}` : ""} [${dialogKind(w)}]`);
      }
    }
  }
  if (open) lines.push("The call may still run once the dialog is closed. Check the state before repeating it.");
  return lines.join("\n");
}

/** Handle of the "&Ignore" button when `win` is the leak assert box, else undefined. Exact matches only. */
export function leakAssertButton(win: WinInfo): number | undefined {
  if (win.cls !== "#32770" || !win.visible) return undefined;
  const kids = win.children ?? [];
  if (!kids.some((c) => c.text.includes(LEAK_TEXT))) return undefined;
  return kids.find((c) => c.cls === "Button" && c.text === "&Ignore")?.hwnd;
}

/** `key: value` lines of WORKBENCH_LOCK.txt; the first of each key wins. */
export function parseLock(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/^([a-z]+):[ \t]*(.*?)[ \t]*$/gim)) out[m[1].toLowerCase()] ??= m[2];
  return out;
}

/** True only when the lock's `session:` line names this session; an `owner:` line alone is a person's hold, never ours (review B1). */
export function lockHeldBy(lockText: string | undefined, who: { session?: string }): boolean {
  const l = parseLock(lockText ?? "");
  return !!l.session && l.session === who.session;
}

/** PID listening on `port` in `netstat -ano` output. */
export function portOwner(netstat: string, port: number): number | undefined {
  const m = netstat.match(new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, "m"));
  return m ? Number(m[1]) : undefined;
}

export type WatchStateName = "ok" | "busy" | "blocked_dialog" | "not_responding" | "stalled" | "exited" | "crashed";
export type Dismiss = "owned" | "watched" | "never";

export interface Signals {
  now: number;
  alive: boolean;
  /** Visible dialog box of the PID and when it was first seen. */
  dialog?: { hwnd: number; kind: "leak_assert" | "other"; since: number; button?: number };
  /** Main window has reported IsHungAppWindow continuously since. */
  hungSince?: number;
  /** Last "Application hangs" line or FREEZE_*.mdmp. */
  hangAt?: number;
  /** crash.log mtime and its parsed entry. */
  crash?: { at: number; reason?: string; assert: boolean };
  dumpAt?: number;
  reloadOpenSince?: number;
  lastLogAt?: number;
  shutdownSeen?: boolean;
  /** hwnd already clicked, so a slow dialog is not clicked twice. */
  clicked?: number;
}

export interface Ctx {
  owned: boolean;
  dismiss: Dismiss;
  autoRecover: boolean;
  lockHeld: boolean;
  recoverAfterMs: number;
  /** When the current not_responding or stalled spell began. */
  badSince?: number;
  recovered?: boolean;
}

export type Action = { type: "click"; hwnd: number; button: number } | { type: "recover" };

/** State and actions per PX-N5 sections 3.3 and 3.4. Only one click (Ignore on the leak assert) and one recovery exist. */
export function decide(s: Signals, ctx: Ctx): { state: WatchStateName; kind?: string; actions: Action[] } {
  if (!s.alive) {
    const fresh = (t?: number) => t !== undefined && t >= (s.lastLogAt ?? 0) - 2000;
    const died = !s.shutdownSeen && (fresh(s.crash?.at) || fresh(s.dumpAt));
    return { state: died ? "crashed" : "exited", kind: died ? s.crash?.reason : undefined, actions: [] };
  }
  const actions: Action[] = [];
  const d = s.dialog;
  const mayClick = ctx.dismiss === "watched" || (ctx.dismiss === "owned" && ctx.owned);
  if (d?.kind === "leak_assert" && d.button && s.now - d.since >= 5000 && s.clicked !== d.hwnd && mayClick) {
    actions.push({ type: "click", hwnd: d.hwnd, button: d.button });
  }
  // An assert writes crash.log at once; it stays blocked until Workbench logs again.
  const crashBlocks = !!s.crash?.assert && s.crash.at >= (s.lastLogAt ?? 0) - 2000;
  if ((d && s.now - d.since >= 10_000) || crashBlocks) {
    const leak = d?.kind === "leak_assert" || (!d && !!s.crash?.reason?.includes("Resources are leaking"));
    return { state: "blocked_dialog", kind: leak ? "leak_assert" : "other", actions };
  }
  let state: WatchStateName = "ok";
  if ((s.hungSince !== undefined && s.now - s.hungSince >= 60_000) || (s.hangAt !== undefined && s.hangAt >= (s.lastLogAt ?? 0))) {
    state = "not_responding";
  } else if (s.reloadOpenSince !== undefined && !d && s.now - (s.lastLogAt ?? s.reloadOpenSince) >= 600_000) {
    state = "stalled";
  } else if (s.reloadOpenSince !== undefined) {
    state = "busy";
  }
  if (
    (state === "not_responding" || state === "stalled") &&
    ctx.owned && ctx.autoRecover && ctx.lockHeld && !ctx.recovered &&
    ctx.badSince !== undefined && s.now - ctx.badSince >= ctx.recoverAfterMs
  ) {
    actions.push({ type: "recover" });
  }
  return { state, actions };
}
