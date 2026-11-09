/**
 * TCP client for the Workbench NET API.
 *
 * Each rawCall() opens a fresh TCP connection, sends one request, reads the
 * response, and closes the socket (protocol requirement).
 *
 * call() never starts Workbench: only wb_launch does, through ensureRunning().
 */

import { Socket } from "node:net";
import { appendFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { encodeRequest, decodeResponse } from "./protocol.js";
import { logger } from "../utils/logger.js";
import { findGproj, findWorkbenchExe, isProtectedAddon } from "../utils/game-paths.js";
import { forbiddenRoot, sameRealPath } from "../utils/safe-path.js";
import { argValue, findPids, isAlive, netstat, processInfoAsync, type ProcInfo } from "../utils/process.js";
import { OWNER, WORKBENCH_INSTANCES, isOwned, pidInstanceFile, writeInstance } from "../utils/instances.js";
import { DIALOG_CHECK_AFTER_MS, DIALOG_CHECK_EVERY_MS, workbenchEnv, workbenchProfileDir } from "./cli.js";
import { duplicateAddonError } from "../pak/stack.js";
import { startWatcher, sweepForStart, watcherBase } from "../watchdog/wb-watch.js";
import { LOCAL_HOSTS, attachDeps, ensureWatched, type AttachResult } from "../watchdog/auto-attach.js";
import { probeDialogs, probeTitles, type TitleProbe } from "../watchdog/probe.js";
import { dialogKind, formatDialogs, portOwner, unsavedWorld, type DialogProbe } from "../watchdog/signals.js";
import type { Config } from "../config.js";
import { generateGproj } from "../templates/gproj.js";
import { git, gitOrNull } from "../release/git.js";

const DEFAULT_CLIENT_ID = "EnfusionMCP";
const DEFAULT_TIMEOUT_MS = 10_000;
/** Maximum response size (10 MB) to prevent memory exhaustion from malformed/unexpected data. */
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;
const WORKBENCH_EXE = "ArmaReforgerWorkbenchSteamDiag.exe";
const WORKBENCH_SUBDIR = "Workbench";
const HANDLER_FOLDER = "EnfusionMCP";
const HANDLER_PATH = `Scripts/WorkbenchGame/${HANDLER_FOLDER}/`;
const LAUNCH_POLL_INTERVAL_MS = 3_000;
const LAUNCH_TIMEOUT_MS = 90_000;
const WORLD_LAUNCH_TIMEOUT_MS = 300_000;

/**
 * Workbench command line. worldPath (a .ent of the opened project) adds the World Editor flags
 * verified with the COALITION launcher: -wbModule=WorldEditor -run -load <world>.
 */
export function buildLaunchArgs(opts: { gproj?: string | null; addonsDir?: string; unattended?: boolean; worldPath?: string }): string[] {
  const { gproj, addonsDir, unattended, worldPath } = opts;
  if (worldPath && !gproj) {
    throw new WorkbenchError(`Refused: worldPath needs a project to open it in; pass gprojPath (or set ENFUSION_DEFAULT_MOD).`, "LAUNCH_FAILED");
  }
  // A quote could end the argument early if Workbench splits its command line differently from Node's quoting.
  if (worldPath && (worldPath.includes('"') || !worldPath.toLowerCase().endsWith(".ent"))) {
    throw new WorkbenchError(`Refused: worldPath must be a world (.ent) file with no quote characters: ${worldPath}`, "LAUNCH_FAILED");
  }
  const args: string[] = [];
  if (gproj) args.push("-gproj", gproj);
  if (addonsDir) args.push("-addonsDir", addonsDir);
  // Bohemia's CLI docs: "Disable all kinds of error message dialogs. (VME's, asserts, crashes, ...)"
  if (unattended) args.push("-noThrow");
  // shortcut: -load with a {GUID}path is unprobed, so the GUID is dropped; keep it once a live run shows -load takes it.
  if (worldPath) args.push("-wbModule=WorldEditor", "-run", "-load", worldPath.replace(/^\{[0-9A-Fa-f]{16}\}/, ""));
  return args;
}

/**
 * Keep the handler folder out of the commits of the git repo that holds addonDir (PRD F1.21): adds it to the
 * repo's local exclude file (never .gitignore) when it is not ignored yet. Throws, before anything is copied,
 * when handler files are already tracked or the exclude file cannot be written. Returns a note for the reply.
 * git gets addonDir only as the -C value.
 */
export function excludeHandlersFromGit(addonDir: string): string | undefined {
  let state: ReturnType<typeof handlerGitState>;
  try {
    state = handlerGitState(addonDir);
  } catch {
    return `git was not found on PATH, so the MCP could not check whether ${addonDir} is a git repo; if it is, keep ${HANDLER_PATH} out of your commits.`;
  }
  if (!state) return undefined;
  const handlerPath = HANDLER_PATH;
  if (state.tracked.length) {
    throw new WorkbenchError(
      `Refused: handler files are committed in this repo (${state.tracked.length}, e.g. ${state.tracked[0]}); an exclude cannot hide tracked files. ` +
        `Remove them from git first (git rm -r --cached ${handlerPath}, then commit), then try again. Nothing was copied.`,
      "LAUNCH_FAILED"
    );
  }
  if (state.ignored) return undefined;
  const probe = `${handlerPath}EMCP_WB_Ping.c`;
  // Relative to the repo root, so an addon in a subfolder of the repo is covered too.
  const line = `${gitOrNull(addonDir, ["rev-parse", "--show-prefix"]) ?? ""}${handlerPath}`;
  const exclude = resolve(addonDir, git(addonDir, ["rev-parse", "--git-path", "info/exclude"]).trim());
  try {
    mkdirSync(dirname(exclude), { recursive: true });
    const old = existsSync(exclude) ? readFileSync(exclude, "utf-8") : "";
    // Already there from a refused earlier try: append once only.
    if (!old.split(/\r?\n/).includes(line)) {
      appendFileSync(exclude, `${old && !old.endsWith("\n") ? "\n" : ""}# enfusion-mcp: keep the MCP Workbench handler scripts out of commits\n${line}\n`);
    }
  } catch (e) {
    throw new WorkbenchError(
      `Refused: could not write ${exclude} (${e instanceof Error ? e.message : e}), so the MCP handlers would show up in your commits. ` +
        `Add the line ${line} to that file (or to the repo's .gitignore) by hand, then try again. Nothing was copied.`,
      "LAUNCH_FAILED"
    );
  }
  if (gitOrNull(addonDir, ["check-ignore", "-q", probe]) === null) {
    throw new WorkbenchError(
      `Refused: added ${line} to ${exclude}, but git still does not ignore ${probe} (a .gitignore rule may re-include it). ` +
        `Fix the ignore rules so that folder is ignored, then try again. Nothing was copied.`,
      "LAUNCH_FAILED"
    );
  }
  return `Added ${line} to ${exclude} (local, not committed) so the MCP handlers stay out of your commits.`;
}

/** True when dir or a parent holds .git (a folder, or a file in a worktree); needs no git binary. */
function inGitRepo(dir: string): boolean {
  for (let d = resolve(dir); ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return true;
    if (dirname(d) === d) return false;
  }
}

/** Read-only git view of the handler folder; null when addonDir is not in a git work tree. Throws when git is not on PATH. */
export function handlerGitState(addonDir: string): { ignored: boolean; tracked: string[] } | null {
  if (gitOrNull(addonDir, ["rev-parse", "--is-inside-work-tree"]) !== "true") return null;
  return {
    ignored: gitOrNull(addonDir, ["check-ignore", "-q", `${HANDLER_PATH}EMCP_WB_Ping.c`]) !== null,
    tracked: (gitOrNull(addonDir, ["ls-files", "-z", "--", HANDLER_PATH]) ?? "").split("\0").filter((f) => /(^|\/)EMCP_[^/]*$/.test(f)),
  };
}

export type WorkbenchMode = "edit" | "play" | "no_world" | "unknown";

export interface DiagnosticReport {
  host: string;
  port: number;
  workbenchExe: { path: string; exists: boolean } | null;
  projectPath: { path: string; exists: boolean } | null;
  defaultMod: string | null;
  bundledScripts: { path: string; exists: boolean };
  standaloneAddon: { path: string; exists: boolean; fileCount: number };
  installedMods: Array<{ modDir: string; handlerDir: string; fileCount: number }>;
  /** Result of the NET API probe. */
  netApi: "up_with_handlers" | "up_no_handlers" | "refused" | "timeout" | "error";
  netApiError?: string;
  /** Dialogs found in each Workbench process when the NET API timed out. */
  dialogs?: DialogProbe[];
}

export interface WorkbenchState {
  connected: boolean;
  mode: WorkbenchMode;
  lastUpdated: number;
}

export interface WorkbenchCallOptions {
  /** Timeout in milliseconds (default 10 000). */
  timeout?: number;
  /**
   * Return a `status: "error"` response instead of throwing.
   *
   * Only for calls whose failure is genuinely optional: a secondary lookup the
   * caller degrades gracefully around (e.g. reading a position to enrich a result
   * that is still useful without it). Never use it for the primary action of a
   * tool: that is exactly how a failed mutation gets reported as success.
   */
  tolerateErrorStatus?: boolean;
}

export class WorkbenchError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "CONNECTION_REFUSED"
      | "TIMEOUT"
      | "PROTOCOL_ERROR"
      | "API_ERROR"
      | "LAUNCH_FAILED" = "API_ERROR",
    /** Set when a dialog check ran for this failure. */
    public readonly dialogs?: DialogProbe[]
  ) {
    super(message);
    this.name = "WorkbenchError";
  }
}

/** A world file path. Opening one while the open world has unsaved changes raises Workbench's blocking "Loading world" prompt. */
export const isWorldPath = (path: string) => /\.ent$/i.test(path);

/** Workbench answered, but the requested NET API handler is not registered. */
function isUndefinedHandler(err: unknown): boolean {
  return (
    err instanceof WorkbenchError &&
    err.code === "API_ERROR" &&
    (err.message.includes("Undefined API func") || err.message.includes("not existing Net API function"))
  );
}

export class WorkbenchClient {
  private launchPromise: Promise<string | undefined> | null = null;
  private _state: WorkbenchState = { connected: false, mode: "unknown", lastUpdated: 0 };
  /** Public so tests can stub it: the real one starts PowerShell. */
  dialogProbe: (pids: number[]) => Promise<DialogProbe[]> = (pids) => probeDialogs(pids);
  /** What checkWorldOpen reads. Public so tests can stub it: the real ones run netstat and PowerShell, and only on Windows. */
  worldProbe = {
    netstat: (): Promise<string> => (process.platform === "win32" ? netstat() : Promise.reject(new Error("only Windows can be checked"))),
    titles: (pid: number): Promise<TitleProbe> => probeTitles(pid),
  };
  /** What portOwnerInfo reads besides worldProbe.netstat. Public so tests can stub it: the real ones run PowerShell, and only on Windows. */
  ownerProbe = {
    platform: process.platform as NodeJS.Platform,
    proc: (pid: number): Promise<ProcInfo | undefined> => processInfoAsync(pid),
    owned: (pid: number, proc: ProcInfo): boolean => isOwned(pid, WORKBENCH_INSTANCES, proc),
  };
  /** The automatic watch check (B-093). Public so tests can stub it: the real one runs netstat and PowerShell. */
  watchCheck: () => Promise<AttachResult> = () => ensureWatched(this.port, this.host, attachDeps(this.config!));
  /** How long a timeout reply waits for the watch check. Public so tests can shorten it. */
  watchWaitMs = 5_000;
  private watchRun: Promise<AttachResult> | null = null;
  private watchQuietUntil = 0;
  /** Bumped when a refusal ends the pause: a check that started before it must not set a new pause for the old Workbench. */
  private watchGen = 0;
  /** The line of the result that set the pause, repeated in timeout replies during it. */
  private watchLast = "";

  /** Current cached connection state. Updated after every successful call. */
  get state(): Readonly<WorkbenchState> {
    return this._state;
  }

  constructor(
    private readonly host: string,
    readonly port: number,
    private readonly config?: Config,
    private readonly clientId: string = DEFAULT_CLIENT_ID
  ) {}

  /**
   * Call a Workbench NET API function.
   * Never starts Workbench; a refused connection says to run wb_launch.
   */
  async call<T = Record<string, unknown>>(
    apiFunc: string,
    params: Record<string, unknown> = {},
    options: WorkbenchCallOptions = {}
  ): Promise<T> {
    try {
      return this.finishCall(await this.rawCall<T>(apiFunc, params, options), options);
    } catch (err) {
      if (err instanceof WorkbenchError) {
        if (err.code === "CONNECTION_REFUSED" || err.code === "TIMEOUT" || err.code === "PROTOCOL_ERROR") {
          this._state = { connected: false, mode: "unknown", lastUpdated: Date.now() };
        }
        // Handlers register only at Workbench start, so copying files into a running one cannot help.
        if (isUndefinedHandler(err)) {
          throw new WorkbenchError(
            `Workbench is running but does not expose "${apiFunc}": the MCP handlers are not loaded. ` +
              `Workbench registers NET API handlers only when it starts, so nothing is installed into a ` +
              `running Workbench. Restart Workbench (ask whoever uses it first); wb_launch installs the ` +
              `handlers before it starts Workbench.`,
            "API_ERROR"
          );
        }
        // A modal in any Workbench copy makes every call time out; name it so the caller does not blame the network.
        if (err.code === "TIMEOUT") {
          const [r, w] = await Promise.all([this.dialogReport(findPids(WORKBENCH_EXE)), this.watchNote()]);
          throw new WorkbenchError([err.message, r.text, w].filter(Boolean).join("\n"), "TIMEOUT", r.dialogs);
        }
        // Only wb_launch starts Workbench (D-025): a shared PC may have someone else's session waiting on it.
        if (err.code === "CONNECTION_REFUSED") {
          throw new WorkbenchError(
            `Workbench is not running on ${this.endpoint}. Tools do not start Workbench; start it with ` +
              `wb_launch after checking that nobody else is using Workbench.`,
            "CONNECTION_REFUSED"
          );
        }
      }
      throw err;
    }
  }

  /**
   * Who answers this client's NET API port: the listening PID, its -gproj and whether this MCP started it.
   * A field is missing when it is unknown: a non-local host or a non-Windows PC (no netstat runs), a failed netstat or process
   * read, an owner without -gproj. Never throws.
   */
  async portOwnerInfo(): Promise<{ pid?: number; gproj?: string; owned?: boolean }> {
    if (!LOCAL_HOSTS.includes(this.host.toLowerCase()) || this.ownerProbe.platform !== "win32") return {};
    try {
      const pid = portOwner(await this.worldProbe.netstat(), this.port);
      if (!pid) return {};
      const proc = await this.ownerProbe.proc(pid);
      return proc ? { pid, gproj: argValue(proc.cmd, "-gproj"), owned: this.ownerProbe.owned(pid, proc) } : { pid };
    } catch {
      return {};
    }
  }

  /**
   * A Workbench already answers the port: its identity line, and `refuse` when gprojPath names a different project (real paths,
   * so a junction to the same file is the same). An owner whose project cannot be told is shared, never refused. Starts and kills nothing.
   */
  async answeringWorkbench(gprojPath?: string): Promise<{ line: string; refuse?: string }> {
    const o = await this.portOwnerInfo();
    const by = o.owned === undefined ? "" : o.owned ? ", started by this MCP" : ", not started by this MCP";
    const line = `${o.pid ? `Workbench PID ${o.pid}` : "A Workbench"} answers NET API port ${this.port}: project ${o.gproj ?? "unknown"}${by}.`;
    // shortcut: a relative -gproj cannot be resolved from here, so it counts as unknown; upgrade if Workbench is ever started that way.
    if (!gprojPath || !o.gproj || !isAbsolute(o.gproj) || sameRealPath(gprojPath, o.gproj, true)) return { line };
    return {
      line,
      refuse:
        `Refused: ${line} You asked for ${gprojPath}. Nothing was started or written and that Workbench is left running: ` +
        `close it or ask whoever uses it, then call wb_launch again.`,
    };
  }

  /**
   * Before a world (.ent) open (B-089): read the window titles of the local Workbench that owns this client's port.
   * refuse: its World Editor title ends in * (unsaved changes), so the open would raise the blocking "Loading world" prompt; send nothing.
   * warn: the check could not run, send the open and add the line. undefined: clean, or nothing listens (the open then reports the connection error).
   * Never throws.
   */
  async checkWorldOpen(path: string): Promise<{ refuse: string } | { warn: string } | undefined> {
    const cannot = (why: string) => ({
      warn: `Could not check for unsaved changes (${why}); if the current world has unsaved edits, Workbench will show a blocking "Loading world" prompt.`,
    });
    if (!LOCAL_HOSTS.includes(this.host.toLowerCase())) return cannot(`the NET API host ${this.host} is not this PC`);
    try {
      const out = await this.worldProbe.netstat();
      if (!out) return cannot("the netstat query failed");
      const pid = portOwner(out, this.port);
      if (!pid) return undefined;
      const probe = await this.worldProbe.titles(pid);
      if ("unavailable" in probe) return cannot(probe.unavailable);
      const w = unsavedWorld(probe.wins);
      if (w.state === "unknown") return cannot(`no window of Workbench PID ${pid} is visible to this MCP, for example because it runs in another Windows session`);
      if (w.state === "clean") return undefined;
      return {
        refuse:
          `Refused: the world open in Workbench (${w.world}) has unsaved changes (its World Editor title ends in *). ` +
          `Opening ${path} now would show Workbench's "Loading world" save prompt, which blocks every MCP call until a person answers it. ` +
          "Run wb_save first, or save or discard the changes in Workbench, then try again.",
      };
    } catch (e) {
      return cannot(e instanceof Error ? e.message : String(e));
    }
  }

  /** The running watch check, or a new one. Never rejects: a failure is logged at debug level and becomes the result line. */
  private runWatchCheck(): Promise<AttachResult> {
    const gen = this.watchGen;
    return (this.watchRun ??= Promise.resolve()
      .then(() => this.watchCheck())
      .then((r) => {
        // ok (attached, already watched, or a result that will not change): no new check for 60 s; no listener or a failed check is checked again on the next request.
        if (r.ok && gen === this.watchGen) {
          this.watchQuietUntil = Date.now() + 60_000;
          this.watchLast = r.text;
        }
        return r;
      })
      .catch((e) => {
        logger.debug(`Automatic watch check failed: ${e instanceof Error ? e.message : e}`);
        return { ok: false, text: `Workbench not watched: the watch check failed (${e instanceof Error ? e.message : e}).` };
      })
      .finally(() => {
        this.watchRun = null;
      }));
  }

  /**
   * The watch line for a timeout reply, or "" when the automatic watch is off. During the 60 s pause it repeats the line that set it
   * (no new check); otherwise it waits at most watchWaitMs for the check. Never throws.
   */
  async watchNote(): Promise<string> {
    if (this.config?.autoWatch !== true) return "";
    if (!this.watchRun && Date.now() < this.watchQuietUntil) return `Watchdog: ${this.watchLast}`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<string>((done) => {
      timer = setTimeout(() => done(`the watch check did not finish in ${this.watchWaitMs / 1000} s`), this.watchWaitMs);
    });
    const line = await Promise.race([this.runWatchCheck().then((r) => r.text), late]);
    clearTimeout(timer);
    return `Watchdog: ${line}`;
  }

  /** Dialog text for these Workbench PIDs, or the reason the check could not run. Never throws. */
  private async dialogReport(pids: number[]): Promise<{ text: string; dialogs?: DialogProbe[] }> {
    try {
      const dialogs = await this.dialogProbe(pids);
      return { text: formatDialogs(dialogs), dialogs };
    } catch (e) {
      return { text: `(dialog check unavailable: ${e instanceof Error ? e.message : e})` };
    }
  }

  /**
   * Record connection state from a successful transport round-trip, then surface an
   * in-band handler failure as a thrown error.
   *
   * The NET API returns transport-level "Ok" even when the handler itself failed:
   * 18 of the Enforce handlers report failure in-band by setting `status: "error"`
   * and a human-readable `message`. Without this check that response was returned
   * as if it had succeeded, so a tool would render "**Entity Modified**" over the
   * top of "Entity not found". Throwing here routes it into each tool's existing
   * catch block, which already reports it properly with `isError`.
   *
   * Every return path in call() goes through here so a retry path cannot skip it.
   */
  private finishCall<T>(result: T, options: WorkbenchCallOptions): T {
    this._state.connected = true;
    this._state.lastUpdated = Date.now();
    this.extractMode(result);

    if (!options.tolerateErrorStatus) {
      const record = result as unknown as Record<string, unknown> | null;
      if (record && record.status === "error") {
        const message =
          typeof record.message === "string" && record.message.trim() !== ""
            ? record.message
            : "Workbench handler reported an error without a message.";
        throw new WorkbenchError(message, "API_ERROR");
      }
    }

    return result;
  }

  /**
   * Explicitly refresh cached state by calling EMCP_WB_GetState.
   */
  async refreshState(): Promise<WorkbenchState> {
    try {
      await this.call<Record<string, unknown>>("EMCP_WB_GetState");
      return { ...this._state };
    } catch {
      this._state = { connected: false, mode: "unknown", lastUpdated: Date.now() };
      return { ...this._state };
    }
  }

  /**
   * Read the live mode for a mode gate. Never launches Workbench.
   * Reads EMCP_WB_GetState, not Ping: every installed Ping still answers "edit" during Play.
   */
  async probeMode(): Promise<WorkbenchMode | "not_running" | "no_handlers" | "timeout"> {
    try {
      const result = await this.rawCall<Record<string, unknown>>("EMCP_WB_GetState", {}, { timeout: 3000 });
      // Reset first: extractMode keeps the old value on a reply it does not recognise.
      this._state = { connected: true, mode: "unknown", lastUpdated: Date.now() };
      this.extractMode(result?.mode === "no_world_editor" ? { mode: "no_world" } : result);
      return this._state.mode;
    } catch (err) {
      const code = err instanceof WorkbenchError ? err.code : undefined;
      this._state = { connected: code === "API_ERROR", mode: "unknown", lastUpdated: Date.now() };
      if (isUndefinedHandler(err)) return "no_handlers";
      if (code === "CONNECTION_REFUSED") return "not_running";
      if (code === "TIMEOUT") return "timeout";
      return "unknown";
    }
  }

  /** Record a mode change this server just made (wb_play, wb_stop). */
  setMode(mode: WorkbenchMode): void {
    this._state.mode = mode;
  }

  /**
   * Ensure Workbench is running. Installs handler scripts, launches exe,
   * and waits for NET API. Safe to call concurrently: deduplicates launches.
   * @param gprojPath Optional .gproj file path to open directly (skips launcher).
   * @param unattended Launch with -noThrow (no error dialogs).
   * @param worldPath Optional .ent to open in the World Editor at start.
   * @returns Notes for the reply (the repo's git exclude changed, handler scripts refreshed, crash folders saved before the start), else undefined.
   */
  async ensureRunning(gprojPath?: string, unattended = false, worldPath?: string): Promise<string | undefined> {
    if (!this.config) {
      throw new WorkbenchError("No config provided: cannot auto-launch Workbench.", "LAUNCH_FAILED");
    }

    // Deduplicate concurrent calls: all callers await the same promise
    if (this.launchPromise) {
      return this.launchPromise;
    }

    const promise = this.launchWorkbench(gprojPath, unattended, worldPath).finally(() => {
      // Only clear if this is still the active promise (guards against re-entrant calls)
      if (this.launchPromise === promise) {
        this.launchPromise = null;
      }
    });

    this.launchPromise = promise;
    return promise;
  }

  /**
   * Quick health check. Returns true if Workbench responds, false otherwise.
   * Does NOT auto-launch.
   *
   * Uses our custom EMCP_WB_Ping handler (not the built-in GetLoadedProjects)
   * so the launch poller only succeeds once the mod's handler scripts have
   * finished compiling: avoiding a race where the NET API socket is up but
   * custom handlers aren't loaded yet.
   */
  async ping(): Promise<boolean> {
    try {
      await this.rawCall("EMCP_WB_Ping", {}, { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Remove injected handler scripts from a mod's directory.
   * Call this after Workbench work is done, before publishing the mod.
   * Deletes Scripts/WorkbenchGame/EnfusionMCP/ from the mod.
   * Safe to call even if scripts were never injected.
   */
  /**
   * Every addon under the project path that currently has handler scripts installed.
   *
   * Handlers get injected into whichever mod is open at the time, so over many
   * sessions they accumulate across unrelated addons, and each copy ships with the
   * user's mod if they publish it. Enumerating them is what makes a bulk cleanup
   * possible; `diagnose()` reports the same list.
   *
   * Pure filesystem scan: no NET API call, safe to run with Workbench closed.
   */
  listInstalledHandlerMods(): Array<{ modDir: string; handlerDir: string; fileCount: number; protected: boolean }> {
    const installed: Array<{ modDir: string; handlerDir: string; fileCount: number; protected: boolean }> = [];
    if (!this.config?.projectPath || !existsSync(this.config.projectPath)) return installed;

    try {
      for (const entry of readdirSync(this.config.projectPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === HANDLER_FOLDER) continue; // standalone addon, reported separately
        const modDir = join(this.config.projectPath, entry.name);
        const handlerDir = join(modDir, "Scripts", "WorkbenchGame", HANDLER_FOLDER);
        if (existsSync(handlerDir)) {
          const fileCount = readdirSync(handlerDir).filter((f) => f.startsWith("EMCP_") && f.endsWith(".c")).length;
          if (fileCount) installed.push({ modDir, handlerDir, fileCount, protected: this.isProtectedMod(modDir) });
        }
      }
    } catch {
      /* unreadable project dir: report what we have */
    }
    return installed;
  }

  /** True when modDir's .gproj is in ENFUSION_PROTECTED_ADDONS. */
  isProtectedMod(modDir: string): boolean {
    const gproj = this.config ? findGproj(modDir) : null;
    return !!gproj && isProtectedAddon(this.config!, gproj);
  }

  /** Bundled handler files that are missing or differ (bytes) in modDir. Reads only. */
  staleHandlers(modDir: string): string[] {
    const { missing, stale } = this.handlerFiles(modDir);
    return [...missing, ...stale];
  }

  /** Installed handlers against the bundled ones: missing, stale (bytes differ), current, and extra EMCP_* files not in the bundle. Reads only. */
  handlerFiles(modDir: string): { bundledDir: string; handlerDir: string; missing: string[]; stale: string[]; current: string[]; extra: string[] } {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const bundledDir = join(packageRoot, "mod", "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    const handlerDir = join(modDir, "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    const bundled = existsSync(bundledDir) ? readdirSync(bundledDir).filter((f) => f.endsWith(".c")) : [];
    const installed = existsSync(handlerDir) ? readdirSync(handlerDir).filter((f) => f.startsWith("EMCP_")) : [];
    const r = { bundledDir, handlerDir, missing: [] as string[], stale: [] as string[], current: [] as string[], extra: installed.filter((f) => !bundled.includes(f)) };
    for (const f of bundled) {
      if (!installed.includes(f)) r.missing.push(f);
      else (readFileSync(join(handlerDir, f)).equals(readFileSync(join(bundledDir, f))) ? r.current : r.stale).push(f);
    }
    return r;
  }

  /**
   * wb_handlers install (D-040): the one path that may write handlers into a protected addon. Refuses a forbidden
   * root, then runs the git exclude step (refuses tracked handlers), then copies missing and stale bundled files.
   * Only EMCP_* files are written; other files in the folder are left alone.
   */
  writeHandlers(modDir: string): { written: string[]; replaced: string[]; current: string[]; extra: string[]; gitNote?: string } {
    this.refuseForbidden(modDir);
    const files = this.handlerFiles(modDir);
    if (!existsSync(files.bundledDir)) throw new WorkbenchError("Bundled handler scripts not found in the MCP package.", "LAUNCH_FAILED");
    // D-040 allows writing into a protected repo only with the exclude line and the tracked-file check, which need git.
    if (this.isProtectedMod(modDir) && inGitRepo(modDir)) {
      try {
        handlerGitState(modDir);
      } catch {
        throw new WorkbenchError(
          `Refused: ${modDir} is a protected git repo, but git was not found on PATH, so the MCP cannot keep the handlers out of its commits. ` +
            `Install git or put it on PATH, then try again; or add ${HANDLER_PATH} to the repo's .git/info/exclude by hand first. Nothing was copied.`,
          "LAUNCH_FAILED"
        );
      }
    }
    const gitNote = excludeHandlersFromGit(modDir);
    mkdirSync(files.handlerDir, { recursive: true });
    const written: string[] = [];
    try {
      for (const f of [...files.missing, ...files.stale]) {
        copyFileSync(join(files.bundledDir, f), join(files.handlerDir, f));
        written.push(f);
      }
    } catch (e) {
      throw new WorkbenchError(`Handler install stopped after ${written.length} file(s) (${written.join(", ") || "none"}): ${e instanceof Error ? e.message : e}`, "LAUNCH_FAILED");
    }
    return { written, replaced: files.stale, current: files.current, extra: files.extra, gitNote };
  }

  /** No handler write or delete in a forbidden root, checked for the addon and, by real path, its handler folder (a junction). */
  private refuseForbidden(modDir: string, why = "."): void {
    const handlerDir = join(modDir, "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    for (const p of existsSync(handlerDir) ? [modDir, handlerDir] : [modDir]) {
      const root = this.config && forbiddenRoot(this.config, p);
      if (root) throw new WorkbenchError(`Refused: ${p} is inside ${root} (game or Tools install, Workshop cache, or ENFUSION_FORBIDDEN_DIRS)${why}`, "LAUNCH_FAILED");
    }
  }

  /** allowProtected: only wb_handlers remove (D-040); wb_cleanup keeps protected handlers (D-036). */
  cleanupHandlerScripts(modDir: string, allowProtected = false): boolean {
    this.refuseForbidden(modDir);
    // A protected addon (CRF) keeps its handlers: putting them back needs the owner's OK (D-024, D-036).
    if (!allowProtected && this.isProtectedMod(modDir)) {
      throw new WorkbenchError(`Refused: ${modDir} is a protected addon (ENFUSION_PROTECTED_ADDONS); its handler scripts are kept.`);
    }
    const handlerDir = resolve(modDir, "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    logger.info(`Checking for handler scripts at: ${handlerDir}`);
    if (!existsSync(handlerDir)) {
      logger.info(`Handler scripts not found at ${handlerDir}`);
      return false;
    }
    try {
      // Only the server's own EMCP_* files: the folder can also hold the user's scripts.
      const ours = readdirSync(handlerDir).filter((f) => f.startsWith("EMCP_"));
      for (const f of ours) rmSync(join(handlerDir, f), { force: true });
      if (readdirSync(handlerDir).length === 0) rmSync(handlerDir, { recursive: true });
      if (!ours.length) return false;
      logger.info(`Removed ${ours.length} handler scripts from ${handlerDir}`);
      // Clean up empty parent dirs
      const wbGameDir = join(modDir, "Scripts", "WorkbenchGame");
      if (existsSync(wbGameDir) && readdirSync(wbGameDir).length === 0) {
        rmSync(wbGameDir, { recursive: true });
      }
      return true;
    } catch (e) {
      logger.warn(`Failed to clean up handler scripts: ${e}`);
      return false;
    }
  }

  /**
   * Collect a diagnostic snapshot: config, file system, and NET API state.
   * Does NOT auto-launch Workbench or throw: always returns a report.
   */
  async diagnose(): Promise<DiagnosticReport> {
    // --- Config info ---
    const host = this.host;
    const port = this.port;
    const defaultMod = this.config?.defaultMod ?? null;

    // Workbench exe
    let workbenchExe: DiagnosticReport["workbenchExe"] = null;
    if (this.config) {
      const exePath = findWorkbenchExe(this.config!.workbenchPath);
      const candidate =
        exePath ??
        join(this.config.workbenchPath, WORKBENCH_SUBDIR, WORKBENCH_EXE);
      workbenchExe = { path: candidate, exists: existsSync(candidate) };
    }

    // Project path
    let projectPathInfo: DiagnosticReport["projectPath"] = null;
    if (this.config?.projectPath) {
      projectPathInfo = {
        path: this.config.projectPath,
        exists: existsSync(this.config.projectPath),
      };
    }

    // Bundled handler scripts (inside this package)
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const bundledDir = join(packageRoot, "mod", "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    const bundledScripts = { path: bundledDir, exists: existsSync(bundledDir) };

    // Standalone addon
    const standaloneBase = this.config?.projectPath
      ? join(this.config.projectPath, HANDLER_FOLDER)
      : join("<unknown>", HANDLER_FOLDER);
    const standaloneScriptsDir = join(standaloneBase, "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    const standaloneFileCount = existsSync(standaloneScriptsDir)
      ? readdirSync(standaloneScriptsDir).filter((f) => f.endsWith(".c")).length
      : 0;
    const standaloneAddon = {
      path: standaloneBase,
      exists: existsSync(standaloneBase),
      fileCount: standaloneFileCount,
    };

    // Scan project path for mods that have handler scripts installed
    const installedMods: DiagnosticReport["installedMods"] = this.listInstalledHandlerMods();

    // --- NET API probe ---
    let netApi: DiagnosticReport["netApi"] = "refused";
    let netApiError: string | undefined;
    try {
      await this.rawCall("EMCP_WB_Ping", {}, { timeout: 3000 });
      netApi = "up_with_handlers";
    } catch (err) {
      if (err instanceof WorkbenchError) {
        netApiError = err.message;
        if (err.code === "CONNECTION_REFUSED") {
          netApi = "refused";
        } else if (err.code === "TIMEOUT") {
          netApi = "timeout";
        } else if (err.code === "API_ERROR" && err.message.includes("not existing Net API function")) {
          netApi = "up_no_handlers";
        } else {
          netApi = "error";
        }
      } else {
        netApi = "error";
        netApiError = String(err);
      }
    }

    const dialogs = netApi === "timeout" ? (await this.dialogReport(findPids(WORKBENCH_EXE))).dialogs : undefined;

    return {
      host,
      port,
      workbenchExe,
      projectPath: projectPathInfo,
      defaultMod,
      bundledScripts,
      standaloneAddon,
      installedMods,
      netApi,
      netApiError,
      dialogs,
    };
  }

  /**
   * Remove the standalone EnfusionMCP addon directory if it exists.
   * This prevents duplicate class name errors when handler scripts are injected
   * into a user's mod and the standalone folder is also present in the addons dir.
   */
  private cleanupStandaloneAddon(): void {
    const fallbackBase = this.config?.projectPath;
    if (!fallbackBase) return;
    const standaloneDir = join(fallbackBase, HANDLER_FOLDER);
    if (!existsSync(standaloneDir)) return;
    try {
      rmSync(standaloneDir, { recursive: true, force: true });
      logger.info(`Removed leftover standalone addon: ${standaloneDir}`);
    } catch (e) {
      logger.warn(`Failed to remove standalone addon: ${e}`);
    }
  }

  toString(): string {
    return `WorkbenchClient(${this.host}:${this.port})`;
  }

  get endpoint(): string {
    return `${this.host}:${this.port}`;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /** Extract mode from a response object if it contains a `mode` field. */
  private extractMode(result: unknown): void {
    if (result && typeof result === "object" && "mode" in result) {
      const mode = (result as Record<string, unknown>).mode;
      if (mode === "edit") {
        this._state.mode = "edit";
      } else if (mode === "play" || mode === "game") {
        // Scripts return "game" when in play mode (WorldEditorAPI unavailable)
        this._state.mode = "play";
      } else if (mode === "no_world") {
        this._state.mode = "no_world";
      }
      // "no_world_editor" and unrecognised values leave mode as-is (stays "unknown")
    }
  }

  private async launchWorkbench(gprojPath?: string, unattended = false, worldPath?: string): Promise<string | undefined> {
    // 1. Check if already running (maybe it came up between the failed call and now)
    if (await this.ping()) {
      const who = await this.answeringWorkbench(gprojPath);
      if (who.refuse) throw new WorkbenchError(who.refuse, "LAUNCH_FAILED");
      logger.info(`Workbench is already running. ${who.line}`);
      return;
    }
    // A running Workbench whose NET API does not answer is loading, showing a dialog or hung.
    // Starting another copy would not help and piles up instances.
    const running = findPids(WORKBENCH_EXE);
    if (running.length) {
      const r = await this.dialogReport(running);
      throw new WorkbenchError(
        `Workbench is already running (PID ${running.join(", ")}) but its NET API does not answer. ` +
          `It may still be loading, showing a dialog, or hung. Not starting another copy; ` +
          `check the Workbench window (wb_close closes it only if this MCP session started it).` +
          (r.text ? `\n${r.text}` : ""),
        "LAUNCH_FAILED",
        r.dialogs
      );
    }

    // 2. Resolve the target .gproj and inject handler scripts into that mod.
    //    Handler scripts must compile as part of the opened project: Workbench
    //    only compiles the active project and its declared dependencies, NOT every
    //    addon folder in the project directory.  A standalone sibling addon will
    //    never be compiled unless the user's project explicitly depends on it.
    if (gprojPath && !existsSync(gprojPath)) {
      throw new WorkbenchError(`Not found: ${gprojPath}. Pass the path of an addon's .gproj file.`, "LAUNCH_FAILED");
    }
    // A protected addon is opened only when it already holds the handlers: nothing is ever written into it.
    const isProtected = !!gprojPath && isProtectedAddon(this.config!, gprojPath);
    if (isProtected && !existsSync(join(dirname(gprojPath!), "Scripts", "WorkbenchGame", HANDLER_FOLDER, "EMCP_WB_Ping.c"))) {
      throw new WorkbenchError(
        `Refused: ${gprojPath} is a protected addon (ENFUSION_PROTECTED_ADDONS) without the MCP handler scripts, and wb_launch never writes into it. ` +
          `Copy the handlers into its Scripts/WorkbenchGame/EnfusionMCP/ by hand with the owner's OK, or pass a test addon's .gproj.`,
        "LAUNCH_FAILED"
      );
    }
    let resolvedGproj = gprojPath || this.findFallbackGproj();
    // Before any handler copy: a second copy of the addon or a dependency in -addonsDir makes Workbench load both.
    const dup = resolvedGproj ? duplicateAddonError([resolvedGproj], (this.config?.addonsDir ?? "").split(",")) : null;
    if (dup) throw new WorkbenchError(dup, "LAUNCH_FAILED");
    // Built before any handler copy, so a bad worldPath is refused with nothing written.
    let args = buildLaunchArgs({ gproj: resolvedGproj, addonsDir: this.config?.addonsDir, unattended, worldPath });
    let gitNote: string | undefined;
    if (resolvedGproj && !isProtected) {
      gitNote = this.installHandlerScripts(dirname(resolvedGproj));
      // Remove any leftover standalone addon to prevent duplicate class errors.
      // If a previous session created {projectPath}/EnfusionMCP/ it would be
      // picked up as a sibling addon and cause compile-time class name conflicts.
      this.cleanupStandaloneAddon();
    } else if (!resolvedGproj) {
      // No project found: fall back to standalone addon as last resort and open it
      // directly so its handlers at least compile (user's project won't be open).
      gitNote = this.installHandlerScripts();
      const fallbackBase = this.config?.projectPath;
      if (fallbackBase) {
        const standaloneGproj = join(fallbackBase, HANDLER_FOLDER, `${HANDLER_FOLDER}.gproj`);
        if (existsSync(standaloneGproj)) {
          resolvedGproj = standaloneGproj;
          args = buildLaunchArgs({ gproj: resolvedGproj, addonsDir: this.config?.addonsDir, unattended });
        }
      }
    }

    // 3. Find executable
    const exePath = findWorkbenchExe(this.config!.workbenchPath);
    if (!exePath) {
      const wbPath = this.config?.workbenchPath ?? "(not configured)";
      throw new WorkbenchError(
        `Cannot find ${WORKBENCH_EXE}. Install Arma Reforger Tools from Steam, ` +
          `or set ENFUSION_WORKBENCH_PATH. Searched:\n` +
          `  - ${join(wbPath, WORKBENCH_SUBDIR, WORKBENCH_EXE)}\n` +
          `  - ${join(wbPath, WORKBENCH_EXE)}`,
        "LAUNCH_FAILED"
      );
    }

    // 4. Spawn with -gproj to skip the launcher
    // Use the game install directory as CWD so Workbench finds base game addons
    // (data/ArmaReforger.gproj with GUID 58D0FB3206B6F859) via ./addons resolution.
    const cwd = this.findGameDir() || dirname(exePath);

    // Last step before the start, so a refused launch saves nothing: the start prunes older log folders (B-044).
    const swept = sweepForStart(this.config!);
    const failed = (msg: string) => (swept ? `${msg}\n\n${swept}` : msg); // a start that fails still saved the folders: say so

    logger.info(`Launching Workbench: ${exePath}${args.length ? ` ${args.join(" ")}` : ""} (cwd: ${cwd})`);
    const launchedAt = Date.now();
    const proc = spawn(exePath, args, {
      detached: true,
      stdio: "ignore",
      cwd,
      env: workbenchEnv(),
    });
    // Without a listener a failed start is an uncaught 'error' that ends the MCP; the NET API wait below reports it.
    proc.on("error", (e) => logger.warn(`Workbench did not start: ${e.message}`));
    proc.unref();
    // wb_close acts only on Workbench processes recorded here.
    if (proc.pid) {
      try {
        writeInstance(pidInstanceFile(WORKBENCH_INSTANCES, proc.pid), {
          kind: "workbench", name: resolvedGproj ?? "workbench", pid: proc.pid,
          ownerPid: OWNER.pid, ownerStartedAt: OWNER.startedAt, startedAt: launchedAt, exe: exePath,
        });
      } catch (e) {
        logger.warn(`Could not record Workbench PID ${proc.pid}; wb_close will not close it: ${e}`);
      }
      try {
        startWatcher({
          pid: proc.pid, startTime: launchedAt, owned: true, ...watcherBase(this.config!), host: this.host, port: this.port,
        });
      } catch (e) {
        logger.warn(`Could not start the watchdog for Workbench PID ${proc.pid}: ${e}`);
      }
    }

    // 5. Wait for NET API: track the last error type so the timeout message is actionable
    const timeoutMs = worldPath ? WORLD_LAUNCH_TIMEOUT_MS : LAUNCH_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let lastErrorCode: WorkbenchError["code"] | undefined;
    let lastDialogCheck = 0;
    let lastDialogs = new Set<number>();
    while (Date.now() < deadline) {
      try {
        await this.rawCall("EMCP_WB_Ping", {}, { timeout: 3000 });
        this._state.connected = true;
        this._state.lastUpdated = Date.now();
        logger.info("Workbench NET API is responding.");
        return [gitNote, swept].filter(Boolean).join("\n\n") || undefined;
      } catch (err) {
        if (err instanceof WorkbenchError) {
          lastErrorCode = err.code;
          logger.debug(`Workbench poll (${err.code}): ${err.message}`);
        }
      }
      // The spawned PID is the Workbench itself (workbenchEnv() sets the Steam app id, so Steam does not relaunch it under another PID).
      if (proc.pid && !isAlive(proc.pid)) {
        throw new WorkbenchError(
          failed(
            `Workbench (PID ${proc.pid}) exited ${Math.round((Date.now() - launchedAt) / 1000)}s after launch, before its NET API answered. ` +
            `Check its log folder (${join(workbenchProfileDir(this.config!), "logs")}) and, if it crashed, CrashReporter.`
          ),
          "LAUNCH_FAILED"
        );
      }
      // A modal while the world loads never closes by itself; stop waiting out the full timeout once one is open.
      // It must stay open across two checks, and a leak assert never counts: the watchdog clicks Ignore on that one.
      if (proc.pid && Date.now() - launchedAt >= DIALOG_CHECK_AFTER_MS && Date.now() - lastDialogCheck >= DIALOG_CHECK_EVERY_MS) {
        lastDialogCheck = Date.now();
        const r = await this.dialogReport([proc.pid]);
        const open = (r.dialogs ?? []).flatMap((p) => ("dialogs" in p ? p.dialogs : [])).filter((w) => dialogKind(w) !== "leak_assert");
        const persisted = open.some((w) => lastDialogs.has(w.hwnd));
        lastDialogs = new Set(open.map((w) => w.hwnd));
        if (persisted) {
          throw new WorkbenchError(
            failed(
              `Workbench (PID ${proc.pid}) has not connected ${Math.round((Date.now() - launchedAt) / 1000)}s after launch and is showing a dialog. ` +
                `It is still running; nothing was answered.\n${r.text}`
            ),
            "LAUNCH_FAILED",
            r.dialogs
          );
        }
      }
      await new Promise((r) => setTimeout(r, LAUNCH_POLL_INTERVAL_MS));
    }

    // Build a specific diagnostic based on what was failing at timeout.
    // CONNECTION_REFUSED = NET API port never opened → NET API likely disabled.
    // API_ERROR = NET API is up but EMCP_WB_Ping isn't registered → handler scripts
    //             didn't compile (project has script errors, or wrong mod directory).
    let hint: string;
    if (lastErrorCode === "API_ERROR") {
      hint =
        `Workbench NET API responded but handler scripts did not load. ` +
        `Check for script compilation errors in Workbench (Script Editor). ` +
        `Fix any errors in the project's scripts so the EnfusionMCP handlers can compile, ` +
        `then try again.`;
    } else {
      hint =
        `NET API port never responded. Ensure NET API is enabled in Workbench: ` +
        `File > Options > General > Net API (checkbox must be on).`;
    }
    // A modal while the world loads (for example "world data structure is obsolete") blocks every ping.
    if (worldPath) hint += ` A dialog may be open in Workbench while the world loads; check the Workbench window.`;

    throw new WorkbenchError(
      failed(`Workbench launched but did not connect within ${timeoutMs / 1000}s.\n\n${hint}`),
      "LAUNCH_FAILED"
    );
  }

  /**
   * Find a .gproj to pass via -gproj so Workbench skips the launcher.
   * Prefers config.defaultMod if set; otherwise picks first addon found. Protected addons are skipped.
   * Scans for any .gproj in each addon folder (name need not match folder).
   */
  private findFallbackGproj(): string | null {
    const findGprojInDir = (dir: string): string | null => {
      try {
        for (const f of readdirSync(dir, { withFileTypes: true })) {
          if (!f.isDirectory() && f.name.endsWith(".gproj")) {
            // Never a protected addon or one in an install or Workshop cache: the handler scripts would be copied into it.
            const g = join(dir, f.name);
            return isProtectedAddon(this.config!, g) || forbiddenRoot(this.config!, dir) ? null : g;
          }
        }
      } catch { /* ignore */ }
      return null;
    };

    try {
      const addonsDir = this.config?.projectPath;
      if (!addonsDir || !existsSync(addonsDir)) return null;

      // Prefer the configured default mod over alphabetical first-pick
      const preferred = this.config?.defaultMod;
      if (preferred) {
        const gprojPath = findGprojInDir(join(addonsDir, preferred));
        if (gprojPath) {
          logger.info(`Using defaultMod gproj to skip launcher: ${gprojPath}`);
          return gprojPath;
        }
      }

      for (const entry of readdirSync(addonsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const gprojPath = findGprojInDir(join(addonsDir, entry.name));
        if (gprojPath) {
          logger.info(`Using fallback gproj to skip launcher: ${gprojPath}`);
          return gprojPath;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Derive the Arma Reforger game install directory.
   * Checks ENFUSION_GAME_PATH env var first, then walks up from workbenchPath.
   * workbenchPath may point to the Tools root OR the Workbench subdirectory,
   * so we try both one and two levels up.
   */
  private findGameDir(): string | null {
    // Explicit env var takes priority
    const envGamePath = process.env.ENFUSION_GAME_PATH;
    if (envGamePath && existsSync(join(envGamePath, "addons"))) {
      logger.info(`Using game directory from ENFUSION_GAME_PATH: ${envGamePath}`);
      return envGamePath;
    }

    if (!this.config) return null;
    const toolsDir = this.config.workbenchPath;
    // workbenchPath may be "Arma Reforger Tools" or "Arma Reforger Tools\Workbench"
    const candidates = [
      resolve(toolsDir, "..", "Arma Reforger"),
      resolve(toolsDir, "..", "ArmaReforger"),
      resolve(toolsDir, "..", "..", "Arma Reforger"),
      resolve(toolsDir, "..", "..", "ArmaReforger"),
    ];
    for (const candidate of candidates) {
      if (existsSync(join(candidate, "addons"))) {
        logger.info(`Using game directory as CWD: ${candidate}`);
        return candidate;
      }
    }
    logger.warn("Could not find Arma Reforger game directory. Workbench may fail to resolve base game addon.");
    return null;
  }

  /**
   * Copy handler scripts into a mod directory so they compile as part of that mod.
   * If no modDir given, installs to default project path (standalone, less useful).
   */
  private installHandlerScripts(modDir?: string): string | undefined {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const bundledDir = join(packageRoot, "mod", "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    if (!existsSync(bundledDir)) {
      logger.warn("Bundled handler scripts not found in package.");
      return;
    }

    const fallbackBase = this.config?.projectPath;
    if (!modDir && !fallbackBase) {
      logger.warn("No modDir or projectPath configured: cannot install handler scripts.");
      return;
    }
    const isFallback = !modDir;
    const targetBase = modDir || join(fallbackBase!, HANDLER_FOLDER);
    const targetScriptsDir = join(targetBase, "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    this.refuseForbidden(targetBase, "; wb_launch would copy handler scripts into it. Pass the .gproj of an addon of your own.");

    // Before the skip below: handlers already on disk need the exclude as much as new ones.
    const gitNote = existsSync(targetBase) ? excludeHandlersFromGit(targetBase) : undefined;

    // Copy what is missing or differs from the bundle; current files, extra EMCP_* files and other scripts stay untouched.
    const { missing, stale, current } = this.handlerFiles(targetBase);
    const files = [...missing, ...stale];
    if (!files.length) return gitNote;

    logger.info(`Installing handler scripts to ${targetScriptsDir}`);
    mkdirSync(targetScriptsDir, { recursive: true });

    const before = new Map(stale.map((f) => [f, readFileSync(join(targetScriptsDir, f))]));
    const copied: string[] = [];
    try {
      for (const file of files) {
        copied.push(file); // before the copy: a copy that fails halfway is undone too
        copyFileSync(join(bundledDir, file), join(targetScriptsDir, file));
      }
    } catch (e) {
      // Partial installation: undo only what this attempt touched (new files removed, replaced ones put back; the folder may hold user scripts)
      logger.error(`Failed to install handler scripts, rolling back: ${e}`);
      try {
        for (const file of copied) {
          const old = before.get(file);
          if (old) writeFileSync(join(targetScriptsDir, file), old);
          else rmSync(join(targetScriptsDir, file), { force: true });
        }
      } catch { /* best-effort cleanup */ }
      throw e;
    }

    logger.info(`Installed ${files.length} handler scripts.`);
    // A fresh install needs no list; refreshing handlers that were already there is named, because their edits are overwritten.
    const refreshed =
      current.length + stale.length > 0
        ? `Handler scripts in ${targetScriptsDir} refreshed from this MCP version: ` +
          [stale.length ? `replaced ${stale.join(", ")}` : "", missing.length ? `added ${missing.join(", ")}` : ""].filter(Boolean).join("; ") + "."
        : undefined;

    // When using the standalone fallback path, also write a .gproj so Workbench
    // treats the directory as a loadable addon and compiles the handler scripts.
    if (isFallback) {
      const gprojPath = join(targetBase, `${HANDLER_FOLDER}.gproj`);
      if (!existsSync(gprojPath)) {
        const gprojContent = generateGproj({ name: HANDLER_FOLDER, title: "EnfusionMCP Handlers" });
        writeFileSync(gprojPath, gprojContent, "utf-8");
        logger.info(`Created standalone addon .gproj at ${gprojPath}`);
      }
    }
    return [gitNote, refreshed].filter(Boolean).join("\n\n") || undefined;
  }

  /**
   * Raw TCP call: no auto-launch, no retry.
   */
  private rawCall<T = Record<string, unknown>>(
    apiFunc: string,
    params: Record<string, unknown> = {},
    options: WorkbenchCallOptions = {}
  ): Promise<T> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const requestBuf = encodeRequest(this.clientId, apiFunc, params);
    // Not awaited: the call never waits for the automatic watch check (config.autoWatch is true only from loadConfig).
    if (this.config?.autoWatch === true && Date.now() >= this.watchQuietUntil) void this.runWatchCheck();

    return new Promise<T>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;

      const socket = new Socket();

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          socket.destroy();
          reject(
            new WorkbenchError(
              `Workbench call "${apiFunc}" timed out after ${timeout}ms`,
              "TIMEOUT"
            )
          );
        }
      }, timeout);

      const cleanup = () => {
        clearTimeout(timer);
        socket.removeAllListeners();
      };

      socket.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ECONNREFUSED") {
          // Workbench is gone (on every path, not only call): a restarted one must be checked at once, not after the pause set for the old one.
          this.watchQuietUntil = 0;
          this.watchLast = "";
          this.watchGen++;
          reject(
            new WorkbenchError(
              `Cannot connect to Workbench at ${this.host}:${this.port}.`,
              "CONNECTION_REFUSED"
            )
          );
        } else {
          reject(
            new WorkbenchError(
              `Connection error: ${err.message}`,
              "PROTOCOL_ERROR"
            )
          );
        }
      });

      socket.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_SIZE) {
          if (!settled) {
            settled = true;
            cleanup();
            socket.destroy();
            reject(
              new WorkbenchError(
                `Response for "${apiFunc}" exceeded ${MAX_RESPONSE_SIZE} bytes: possible malformed data`,
                "PROTOCOL_ERROR"
              )
            );
          }
          return;
        }
        chunks.push(chunk);
      });

      socket.on("end", () => {
        if (settled) return;
        settled = true;
        cleanup();

        const responseBuf = Buffer.concat(chunks);
        if (responseBuf.length === 0) {
          reject(
            new WorkbenchError(
              `Empty response from Workbench for "${apiFunc}": connection closed without data`,
              "PROTOCOL_ERROR"
            )
          );
          return;
        }

        try {
          const result = decodeResponse<T>(responseBuf);
          logger.debug(`Workbench response for "${apiFunc}":`, result);
          resolve(result);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const isApiError = errMsg.startsWith("Workbench error:");
          reject(
            new WorkbenchError(
              isApiError ? errMsg : `Failed to decode response for "${apiFunc}": ${errMsg}`,
              isApiError ? "API_ERROR" : "PROTOCOL_ERROR"
            )
          );
        }
      });

      socket.on("close", (hadError) => {
        if (settled) return;
        // close fired without end: connection dropped unexpectedly
        settled = true;
        cleanup();

        if (hadError) {
          reject(
            new WorkbenchError(
              `Connection to Workbench closed with error for "${apiFunc}"`,
              "PROTOCOL_ERROR"
            )
          );
          return;
        }

        // No end event + no error = unusual. Try to decode what we have.
        const responseBuf = Buffer.concat(chunks);
        if (responseBuf.length === 0) {
          reject(
            new WorkbenchError(
              `Connection closed without response for "${apiFunc}"`,
              "PROTOCOL_ERROR"
            )
          );
          return;
        }

        try {
          const result = decodeResponse<T>(responseBuf);
          resolve(result);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const isApiError = errMsg.startsWith("Workbench error:");
          reject(
            new WorkbenchError(
              isApiError ? errMsg : `Failed to decode response for "${apiFunc}": ${errMsg}`,
              isApiError ? "API_ERROR" : "PROTOCOL_ERROR"
            )
          );
        }
      });

      socket.connect(this.port, this.host, () => {
        logger.debug(
          `Connected to Workbench at ${this.host}:${this.port}, calling "${apiFunc}"`
        );
        socket.end(requestBuf);
      });
    });
  }
}

