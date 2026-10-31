/**
 * TCP client for the Workbench NET API.
 *
 * Each rawCall() opens a fresh TCP connection, sends one request, reads the
 * response, and closes the socket (protocol requirement).
 *
 * call() never starts Workbench: only wb_launch does, through ensureRunning().
 */

import { Socket } from "node:net";
import { existsSync, mkdirSync, copyFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { encodeRequest, decodeResponse } from "./protocol.js";
import { logger } from "../utils/logger.js";
import { findWorkbenchExe, isProtectedAddon } from "../utils/game-paths.js";
import { forbiddenRoot } from "../utils/safe-path.js";
import { findPids } from "../utils/process.js";
import { OWNER, WORKBENCH_INSTANCES, pidInstanceFile, writeInstance } from "../utils/instances.js";
import type { Config } from "../config.js";
import { generateGproj } from "../templates/gproj.js";

const DEFAULT_CLIENT_ID = "EnfusionMCP";
const DEFAULT_TIMEOUT_MS = 10_000;
/** Maximum response size (10 MB) to prevent memory exhaustion from malformed/unexpected data. */
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;
const WORKBENCH_EXE = "ArmaReforgerWorkbenchSteamDiag.exe";
const WORKBENCH_SUBDIR = "Workbench";
const HANDLER_FOLDER = "EnfusionMCP";
const LAUNCH_POLL_INTERVAL_MS = 3_000;
const LAUNCH_TIMEOUT_MS = 90_000;

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
   * Only for calls whose failure is genuinely optional — a secondary lookup the
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
      | "LAUNCH_FAILED" = "API_ERROR"
  ) {
    super(message);
    this.name = "WorkbenchError";
  }
}

/** Workbench answered, but the requested NET API handler is not registered. */
function isUndefinedHandler(err: unknown): boolean {
  return (
    err instanceof WorkbenchError &&
    err.code === "API_ERROR" &&
    (err.message.includes("Undefined API func") || err.message.includes("not existing Net API function"))
  );
}

export class WorkbenchClient {
  private launchPromise: Promise<void> | null = null;
  private _state: WorkbenchState = { connected: false, mode: "unknown", lastUpdated: 0 };

  /** Current cached connection state. Updated after every successful call. */
  get state(): Readonly<WorkbenchState> {
    return this._state;
  }

  constructor(
    private readonly host: string,
    private readonly port: number,
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
   * Record connection state from a successful transport round-trip, then surface an
   * in-band handler failure as a thrown error.
   *
   * The NET API returns transport-level "Ok" even when the handler itself failed —
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
   * and waits for NET API. Safe to call concurrently — deduplicates launches.
   * @param gprojPath Optional .gproj file path to open directly (skips launcher).
   */
  async ensureRunning(gprojPath?: string): Promise<void> {
    if (!this.config) {
      throw new WorkbenchError("No config provided — cannot auto-launch Workbench.", "LAUNCH_FAILED");
    }

    // Deduplicate concurrent calls — all callers await the same promise
    if (this.launchPromise) {
      return this.launchPromise;
    }

    const promise = this.launchWorkbench(gprojPath).finally(() => {
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
   * finished compiling — avoiding a race where the NET API socket is up but
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
   * sessions they accumulate across unrelated addons — and each copy ships with the
   * user's mod if they publish it. Enumerating them is what makes a bulk cleanup
   * possible; `diagnose()` reports the same list.
   *
   * Pure filesystem scan: no NET API call, safe to run with Workbench closed.
   */
  listInstalledHandlerMods(): Array<{ modDir: string; handlerDir: string; fileCount: number }> {
    const installed: Array<{ modDir: string; handlerDir: string; fileCount: number }> = [];
    if (!this.config?.projectPath || !existsSync(this.config.projectPath)) return installed;

    try {
      for (const entry of readdirSync(this.config.projectPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === HANDLER_FOLDER) continue; // standalone addon, reported separately
        const modDir = join(this.config.projectPath, entry.name);
        const handlerDir = join(modDir, "Scripts", "WorkbenchGame", HANDLER_FOLDER);
        if (existsSync(handlerDir)) {
          const fileCount = readdirSync(handlerDir).filter((f) => f.startsWith("EMCP_") && f.endsWith(".c")).length;
          if (fileCount) installed.push({ modDir, handlerDir, fileCount });
        }
      }
    } catch {
      /* unreadable project dir — report what we have */
    }
    return installed;
  }

  cleanupHandlerScripts(modDir: string): boolean {
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
   * Does NOT auto-launch Workbench or throw — always returns a report.
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

  private async launchWorkbench(gprojPath?: string): Promise<void> {
    // 1. Check if already running (maybe it came up between the failed call and now)
    if (await this.ping()) {
      logger.info("Workbench is already running.");
      return;
    }
    // A running Workbench whose NET API does not answer is loading, showing a dialog or hung.
    // Starting another copy would not help and piles up instances.
    const running = findPids(WORKBENCH_EXE);
    if (running.length) {
      throw new WorkbenchError(
        `Workbench is already running (PID ${running.join(", ")}) but its NET API does not answer. ` +
          `It may still be loading, showing a dialog, or hung. Not starting another copy; ` +
          `check the Workbench window (wb_close closes it only if this MCP session started it).`,
        "LAUNCH_FAILED"
      );
    }

    // 2. Resolve the target .gproj and inject handler scripts into that mod.
    //    Handler scripts must compile as part of the opened project — Workbench
    //    only compiles the active project and its declared dependencies, NOT every
    //    addon folder in the project directory.  A standalone sibling addon will
    //    never be compiled unless the user's project explicitly depends on it.
    if (gprojPath && isProtectedAddon(this.config!, gprojPath)) {
      throw new WorkbenchError(
        `Refused: ${gprojPath} is a protected addon (ENFUSION_PROTECTED_ADDONS) and wb_launch would copy handler scripts into it. ` +
          `Pass a test addon's .gproj, or open the protected addon in Workbench yourself.`,
        "LAUNCH_FAILED"
      );
    }
    let resolvedGproj = gprojPath || this.findFallbackGproj();
    if (resolvedGproj) {
      this.installHandlerScripts(dirname(resolvedGproj));
      // Remove any leftover standalone addon to prevent duplicate class errors.
      // If a previous session created {projectPath}/EnfusionMCP/ it would be
      // picked up as a sibling addon and cause compile-time class name conflicts.
      this.cleanupStandaloneAddon();
    } else {
      // No project found — fall back to standalone addon as last resort and open it
      // directly so its handlers at least compile (user's project won't be open).
      this.installHandlerScripts();
      const fallbackBase = this.config?.projectPath;
      if (fallbackBase) {
        const standaloneGproj = join(fallbackBase, HANDLER_FOLDER, `${HANDLER_FOLDER}.gproj`);
        if (existsSync(standaloneGproj)) {
          resolvedGproj = standaloneGproj;
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
    const args: string[] = [];
    if (resolvedGproj) {
      args.push("-gproj", resolvedGproj);
    }
    if (this.config?.addonsDir) args.push("-addonsDir", this.config.addonsDir);

    // Use the game install directory as CWD so Workbench finds base game addons
    // (data/ArmaReforger.gproj with GUID 58D0FB3206B6F859) via ./addons resolution.
    const cwd = this.findGameDir() || dirname(exePath);

    logger.info(`Launching Workbench: ${exePath}${args.length ? ` ${args.join(" ")}` : ""} (cwd: ${cwd})`);
    const launchedAt = Date.now();
    const proc = spawn(exePath, args, {
      detached: true,
      stdio: "ignore",
      cwd,
    });
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
    }

    // 5. Wait for NET API — track the last error type so the timeout message is actionable
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    let lastErrorCode: WorkbenchError["code"] | undefined;
    while (Date.now() < deadline) {
      try {
        await this.rawCall("EMCP_WB_Ping", {}, { timeout: 3000 });
        this._state.connected = true;
        this._state.lastUpdated = Date.now();
        logger.info("Workbench NET API is responding.");
        return;
      } catch (err) {
        if (err instanceof WorkbenchError) {
          lastErrorCode = err.code;
          logger.debug(`Workbench poll (${err.code}): ${err.message}`);
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

    throw new WorkbenchError(
      `Workbench launched but did not connect within ${LAUNCH_TIMEOUT_MS / 1000}s.\n\n${hint}`,
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
  private installHandlerScripts(modDir?: string): void {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const bundledDir = join(packageRoot, "mod", "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    if (!existsSync(bundledDir)) {
      logger.warn("Bundled handler scripts not found in package.");
      return;
    }

    const fallbackBase = this.config?.projectPath;
    if (!modDir && !fallbackBase) {
      logger.warn("No modDir or projectPath configured — cannot install handler scripts.");
      return;
    }
    const isFallback = !modDir;
    const targetBase = modDir || join(fallbackBase!, HANDLER_FOLDER);
    const targetScriptsDir = join(targetBase, "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    const root = this.config && forbiddenRoot(this.config, targetBase);
    if (root) {
      throw new WorkbenchError(
        `Refused: ${targetBase} is inside ${root} (game or Tools install, Workshop cache, or ENFUSION_FORBIDDEN_DIRS); ` +
          `wb_launch would copy handler scripts into it. Pass the .gproj of an addon of your own.`,
        "LAUNCH_FAILED"
      );
    }

    // Already installed? Skip (stale handlers stay until they are cleaned up)
    if (existsSync(join(targetScriptsDir, "EMCP_WB_Ping.c"))) {
      return;
    }


    logger.info(`Installing handler scripts to ${targetScriptsDir}`);
    mkdirSync(targetScriptsDir, { recursive: true });

    const files = readdirSync(bundledDir).filter((f) => f.endsWith(".c"));
    const copied: string[] = [];
    try {
      for (const file of files) {
        copyFileSync(join(bundledDir, file), join(targetScriptsDir, file));
        copied.push(file);
      }
    } catch (e) {
      // Partial installation: remove only what this attempt copied (the folder may hold user scripts)
      logger.error(`Failed to install handler scripts, rolling back: ${e}`);
      try {
        for (const file of copied) rmSync(join(targetScriptsDir, file), { force: true });
      } catch { /* best-effort cleanup */ }
      throw e;
    }

    logger.info(`Installed ${files.length} handler scripts.`);

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
  }

  /**
   * Raw TCP call — no auto-launch, no retry.
   */
  private rawCall<T = Record<string, unknown>>(
    apiFunc: string,
    params: Record<string, unknown> = {},
    options: WorkbenchCallOptions = {}
  ): Promise<T> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const requestBuf = encodeRequest(this.clientId, apiFunc, params);

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
                `Response for "${apiFunc}" exceeded ${MAX_RESPONSE_SIZE} bytes — possible malformed data`,
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
              `Empty response from Workbench for "${apiFunc}" — connection closed without data`,
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
        // close fired without end — connection dropped unexpectedly
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

