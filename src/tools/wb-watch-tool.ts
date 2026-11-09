import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuthMode, Config } from "../config.js";
import { crashLogsDir, workbenchProfileDir } from "../workbench/cli.js";
import { isOwned } from "../utils/instances.js";
import { isAlive, killPids, processInfo, sleep, type ProcInfo } from "../utils/process.js";
import { UNREADABLE, WATCH_DIR, formatReport, hms, noautoFile, olderLine, readStates, recentStates, startWatcher, watcherOf, type StartWatcher } from "../watchdog/wb-watch.js";
import { answerDialog, probeDialogs } from "../watchdog/probe.js";
import { appendLockLine, authDetails, loadSetOf, type LoadSet } from "../watchdog/auth.js";
import { authLine, authText, dialogKind, parseAuthWindow, textHash, type AuthLog, type WinInfo } from "../watchdog/signals.js";

export interface WatchArgs {
  action: "status" | "start" | "stop" | "answer";
  pid?: number;
  dismissLeakAssert?: "owned" | "watched" | "never";
  authorizeScripts?: "owned" | "watched" | "never";
  autoRecover?: boolean;
  choice?: "yes" | "no";
  reason?: string;
}

export interface WatchToolDeps {
  stateDir: string;
  proc(pid: number): ProcInfo | undefined;
  owned(pid: number): boolean;
  alive(pid: number): boolean;
  start(w: StartWatcher): number;
  kill(pid: number): void;
  base: Omit<StartWatcher, "pid" | "owned">;
  /** How long a replacing start waits for its watcher to take the lock (default 2000 ms). */
  settleMs?: number;
}

export const WB_EXE = /ArmaReforgerWorkbenchSteamDiag\.exe/i;

/** A command line of the watcher of Workbench `pid`: wb-watch with `--pid <pid>` as a whole argument. */
export const isWatcherCmd = (cmd: string | undefined, pid: number) => !!cmd?.includes("wb-watch") && new RegExp(`--pid\\s+${pid}(\\s|$)`).test(cmd);

/** Before a kill: the lock holder is this PID's watcher by its command line, and the state file names it (a reused PID does neither). */
const isOurWatcher = (d: WatchToolDeps, pid: number, watcher: number) =>
  readStates(d.stateDir).states.some((s) => s.pid === pid && s.watcherPid === watcher) && isWatcherCmd(d.proc(watcher)?.cmd, pid);

/** Kill the watcher (its tree: the watcher's finally never runs under taskkill /F) and remove its files. */
function endWatcher(d: WatchToolDeps, pid: number, watcher: number): void {
  d.kill(watcher);
  // A remove that fails (EBUSY/EPERM) leaves a stale file the next claim takes over; the watcher is stopped either way.
  const drop = (file: string) => {
    try {
      rmSync(file, { force: true });
    } catch {
      // see above
    }
  };
  // Another watcher may have taken the state file or the lock while this one was killed: remove each only if it still names the killed one.
  const json = join(d.stateDir, `${pid}.json`);
  let rival = false;
  try {
    rival = (JSON.parse(readFileSync(json, "utf-8")) as { watcherPid?: number }).watcherPid !== watcher;
  } catch {
    // gone or unreadable: remove it
  }
  if (!rival) drop(json);
  const lock = join(d.stateDir, `${pid}.lock`);
  let by = 0;
  try {
    by = Number(readFileSync(lock, "utf-8"));
  } catch {
    // gone, or unreadable: leave it
  }
  if (by === watcher) drop(lock);
}

/**
 * wb_watch without the MCP wrapper. Returns the text and whether it is an error.
 * `o` is internal, never in the tool schema: the automatic attach passes `auto` and the Workbench's process info it already read.
 */
export async function watchAction(a: WatchArgs, d: WatchToolDeps, o: { auto?: boolean; proc?: ProcInfo } = {}): Promise<{ text: string; isError?: boolean }> {
  const fail = (text: string) => ({ text, isError: true });
  if (a.action === "status") {
    const { states, errors } = readStates(d.stateDir);
    if (!states.length && !errors.length) {
      return {
        text:
          "No Workbench is watched. wb_launch watches what it starts, and the next live call attaches a watcher to the Workbench on the NET API port " +
          "(unless ENFUSION_WB_AUTOWATCH is off); wb_watch start pid=<n> attaches one now.",
      };
    }
    const now = Date.now();
    const { shown, hidden } = recentStates(states);
    const reports = shown.map((s) => {
      const gone = s.state !== "exited" && s.state !== "crashed" && !d.alive(s.watcherPid);
      return formatReport(s, now) + (gone ? `\n  (watcher not running; last report ${hms(s.updated)})` : "");
    });
    return { text: [...reports, ...(hidden ? [olderLine(hidden)] : []), ...errors].join("\n\n") };
  }
  if (!a.pid) return fail(`pid is required for ${a.action}.`);
  const pid = a.pid;
  const watcher = watcherOf(d.stateDir, pid, d.alive);
  // The automatic attach shows this text as its own "Workbench not watched: ..." footer, so it carries no advice for a wb_watch caller.
  if (watcher === UNREADABLE) return fail(o.auto ? `the watch lock for PID ${pid} cannot be read right now.` : `Nothing changed: the watch lock for PID ${pid} cannot be read right now. Try again; wb_watch status shows what runs.`);

  if (a.action === "stop") {
    if (!watcher) return fail(`No watcher runs for Workbench PID ${pid}.`);
    if (!isOurWatcher(d, pid, watcher)) return fail(`PID ${watcher} holds the watch lock for ${pid} but is not its watcher. Not stopped; check wb_watch status.`);
    // Written before the kill: the stopped Workbench run is not watched again automatically (a new run has another start time).
    const created = d.proc(pid)?.created;
    if (created) writeFileSync(noautoFile(d.stateDir, pid), String(created));
    endWatcher(d, pid, watcher);
    return { text: `Stopped watcher PID ${watcher} for Workbench PID ${pid}.` };
  }

  const proc = o.proc ?? d.proc(pid);
  if (!proc || !WB_EXE.test(proc.cmd)) return fail(`PID ${pid} is not a Workbench process.`);
  // An explicit start replaces an automatic watcher (only one that really is a watcher); any other watcher is kept.
  const replace = !!watcher && !o.auto && readStates(d.stateDir).states.some((s) => s.pid === pid && s.auto) && isOurWatcher(d, pid, watcher);
  // The automatic attach shows this as its own footer ("Workbench not watched: ..."), so it reads as a fact, not as a refusal of a call.
  if (watcher && !replace) return fail(o.auto ? `another watcher (PID ${watcher}) holds Workbench PID ${pid}.` : `already watched by watcher PID ${watcher}`);
  if (replace) endWatcher(d, pid, watcher!);
  // A marker that cannot be removed (EBUSY/EPERM) must not abort a start whose old watcher is already killed; the reply says so.
  let markerNote = "";
  if (!o.auto) {
    try {
      rmSync(noautoFile(d.stateDir, pid), { force: true });
    } catch (e) {
      markerNote = ` The stop marker could not be removed (${(e as NodeJS.ErrnoException).code ?? "error"}), so the automatic attach stays off for this Workbench run if the marker names it.`;
    }
  }
  // Ownership only from the instance registry (D-026): nothing a caller passes can make a Workbench owned.
  const owned = d.owned(pid);
  const w = d.start({
    ...d.base, pid, owned, startTime: proc.created, dismiss: a.dismissLeakAssert ?? "watched", authScope: a.authorizeScripts ?? "watched", autoRecover: !!a.autoRecover && owned,
    ...(o.auto && !owned ? { auto: true } : {}),
  });
  const text =
    `Watching Workbench PID ${pid} (${owned ? "owned" : "not owned: never closed or killed"}) with watcher PID ${w}. ` +
    `dismissLeakAssert = ${a.dismissLeakAssert ?? "watched"}, authorizeScripts = ${a.authorizeScripts ?? "watched"}, autoRecover = ${!!a.autoRecover && owned}. Check it with wb_watch status.${markerNote}`;
  if (!replace) return { text };
  // Another MCP may start its own automatic watcher in the same moment; the lock says who got the PID.
  const until = Date.now() + (d.settleMs ?? 2000);
  let holder = watcherOf(d.stateDir, pid, d.alive);
  while (holder !== w && Date.now() < until) {
    await sleep(100);
    holder = watcherOf(d.stateDir, pid, d.alive);
  }
  if (holder === UNREADABLE) return fail(`Stopped the automatic watcher PID ${watcher}, but the watch lock for PID ${pid} cannot be read right now; check wb_watch status.${markerNote}`);
  if (holder === w) return { text: `Replaced the automatic watcher PID ${watcher} with watcher PID ${w}. ${text}` };
  return fail(
    holder
      ? `Stopped the automatic watcher PID ${watcher}, but another watcher (PID ${holder}) took Workbench PID ${pid} first; check wb_watch status.${markerNote}`
      : `Stopped the automatic watcher PID ${watcher}, but the new watcher PID ${w} did not take Workbench PID ${pid} within ${(d.settleMs ?? 2000) / 1000} s. Check wb_watch status.${markerNote}`
  );
}

export interface AnswerDeps {
  stateDir: string;
  alive(pid: number): boolean;
  /** The Script Authorization dialogs open in that Workbench, with their text. */
  dialogs(pid: number): Promise<WinInfo[]>;
  press(pid: number, hwnd: number, choice: 1 | 2, hash: number): Promise<string>;
  loadSet(pid: number): LoadSet | undefined;
  mode: AuthMode;
  lock?: string;
  now(): number;
}

/** wb_watch answer: an explicit Yes or No on the Script Authorization dialog open in a watched Workbench, logged with the reason. */
export async function answerAction(a: WatchArgs, d: AnswerDeps): Promise<{ text: string; isError?: boolean }> {
  const fail = (text: string) => ({ text, isError: true });
  if (!a.pid) return fail("pid is required for answer.");
  if (a.choice !== "yes" && a.choice !== "no") return fail("choice must be yes or no (Yes to All and No to All are never pressed here).");
  if (!a.reason?.trim()) return fail("reason is required: name the rule that decided the answer.");
  const held = watcherOf(d.stateDir, a.pid, d.alive);
  if (held === UNREADABLE) return fail(`Nothing was pressed: the watch lock for PID ${a.pid} cannot be read right now. Try again.`);
  if (!held) return fail(`Workbench PID ${a.pid} is not watched. Start a watcher first: wb_watch start pid=${a.pid}.`);
  const w = (await d.dialogs(a.pid)).find((x) => dialogKind(x) === "script_authorization");
  if (!w) return fail(`No Script Authorization dialog is open in Workbench PID ${a.pid}; nothing was pressed.`);
  const parsed = parseAuthWindow(w);
  const r = await d.press(a.pid, w.hwnd, a.choice === "yes" ? 1 : 2, textHash(authText(w)));
  if (!r.startsWith("answered")) return fail(`Not answered: ${r}`);
  const now = d.now();
  const entry: AuthLog = {
    time: hms(now), pid: a.pid, choice: a.choice, parsed, mode: d.mode, explicit: true, reason: a.reason.trim(),
    ...authDetails(d.loadSet(a.pid), parsed, true, now),
  };
  const line = authLine(entry);
  appendFileSync(join(d.stateDir, "events.jsonl"), JSON.stringify({ t: now, pid: a.pid, action: line, kind: "auth" }) + "\n");
  const why = appendLockLine(d.lock, line);
  return { text: `${line}${why ? `\n(lock line not written: ${why})` : ""}` };
}

const RULES =
  "A Workbench script that asks to run a program (\"Script Authorization Required\", method Workbench.RunCmd or Workbench.RunProcess) is left open in the default mode, " +
  "and Workbench waits until someone answers. Answer yes only when all of these hold: the script is one the current task wrote or deliberately ran " +
  "(your own test script or plugin, in an addon you are working on); and the command line (shown from the script's source) is one the task needs, " +
  "such as starting the game or the Arma Reforger Server executable, or a known build or conversion tool that ships with the game or the Tools. " +
  "Answer no when any of these holds: the command line is not readable from the source, or is built at run time from values you cannot see; " +
  "the program is not one you recognise, or runs from a mod, Workshop or temp folder; it is a shell or script host running a script file " +
  "(cmd /c <file>.bat, powershell -File, wscript, cscript, mshta), or a network or download tool (curl, wget, bitsadmin, certutil -urlcache, Invoke-WebRequest); " +
  "the script is in a Workshop mod, or in an addon the task did not open on purpose; you are unsure. " +
  "Answer with action answer (yes or no only) and give the rule that decided it as reason. The answer, the dialog text, the command line and the reason are logged.";

export function registerWbWatch(server: McpServer, config: Config): void {
  server.registerTool(
    "wb_watch",
    {
      description:
        "Watch a Workbench between calls: notices a blocking dialog (such as the diag build's \"Resources are leaking!\" assert), " +
        "a hang, a script reload that never finishes, or a crash, names the likely trigger, and reports it here, in every live tool's footer " +
        "and in wb_diagnose. wb_launch watches each Workbench it starts, and any live call attaches a watcher by itself to the Workbench " +
        "on the NET API port, whoever started it (ENFUSION_WB_AUTOWATCH=off turns that off). A watcher never closes, kills or focuses a Workbench " +
        "this MCP did not start. status lists watched Workbench copies; start attaches a watcher (it replaces an automatic one); " +
        "stop ends one, and that Workbench run is not watched again automatically. " +
        "Automatic clicks: Ignore on the \"Resources are leaking!\" assert, and answers to \"Script Authorization Required\" by the setting ENFUSION_SCRIPT_AUTH " +
        "(rules, the default: Yes to a script call from an addon the Workbench loaded, No to a script that is not in one, a program run or an unreadable dialog left open; " +
        "all: Yes to All on every request; off: report only), in any Workbench it watches, scoped per watch by authorizeScripts; every answer is reported and logged. " +
        "When a Workbench crashes, its log files are copied to the crash logs folder and that Workbench's own CrashReporter is ended without sending a report. " +
        `answer presses Yes or No on an open Script Authorization dialog of a watched Workbench. ${RULES}`,
      inputSchema: {
        action: z.enum(["status", "start", "stop", "answer"]).describe("status: list watched Workbench copies; start: attach a watcher; stop: end one; answer: press Yes or No on an open Script Authorization dialog"),
        pid: z.number().int().positive().optional().describe("Workbench PID (start, stop and answer)"),
        dismissLeakAssert: z.enum(["owned", "watched", "never"]).optional().describe("Who gets the automatic Ignore on the leak assert: watched (default, any watched Workbench), owned, or never"),
        authorizeScripts: z.enum(["owned", "watched", "never"]).optional().describe("Who gets the automatic answer to Script Authorization Required (the mode is ENFUSION_SCRIPT_AUTH): watched (default, any watched Workbench), owned, or never"),
        autoRecover: z.boolean().optional().describe("Only for a Workbench this MCP process started: after 5 min not responding or stalled, and only while the lock names this session, exit and then kill that one Workbench"),
        choice: z.enum(["yes", "no"]).optional().describe("answer: the button to press"),
        reason: z.string().optional().describe("answer: the rule that decided it (required)"),
      },
    },
    async (a) => {
      const stateDir = WATCH_DIR;
      const r =
        a.action === "answer"
          ? await answerAction(a, {
              stateDir,
              alive: isAlive,
              dialogs: async (pid) => {
                const p = (await probeDialogs([pid]))[0];
                return "dialogs" in p ? p.dialogs : [];
              },
              press: (pid, hwnd, choice, hash) => answerDialog(pid, hwnd, choice, hash),
              loadSet: (pid) => loadSetOf(config, processInfo(pid)?.cmd ?? ""),
              mode: config.scriptAuth ?? "rules",
              lock: process.env.ENFUSION_WORKBENCH_LOCK,
              now: Date.now,
            })
          : await watchAction(a, {
              stateDir,
              proc: processInfo,
              owned: (pid) => isOwned(pid),
              alive: isAlive,
              start: startWatcher,
              // Tree kill: the watcher's finally never runs under taskkill /F, so its probe PowerShell must go with it.
              kill: (pid) => killPids([pid], true, true),
              base: {
                logsRoot: join(workbenchProfileDir(config), "logs"), host: config.workbenchHost, port: config.workbenchPort,
                scriptAuth: config.scriptAuth ?? "rules", crashDir: crashLogsDir(config),
              },
            });
      return { content: [{ type: "text" as const, text: r.text }], ...(r.isError ? { isError: true as const } : {}) };
    }
  );
}
