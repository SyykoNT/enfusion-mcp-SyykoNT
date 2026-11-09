import { execFile, execFileSync, spawn } from "node:child_process";
import { openSync, closeSync, existsSync, readdirSync, statSync } from "node:fs";
import { constants, setPriority } from "node:os";
import { join } from "node:path";

const IS_WIN = process.platform === "win32";

/**
 * Documented startup flag (BI wiki "Arma Reforger:Startup_Parameters": "disables the Crash Reporter from appearing/sending reports
 * automatically"; the Server Config page says its disableCrashReporter option "has the same effect as -disableCrashReporter").
 * The Enfusion CLI table spells it -disableCrashReport. Not verified on a live crash, so check a crash.log after the first one.
 */
export const DISABLE_CRASH_REPORTER = "-disableCrashReporter";

/** BelowNormal priority and a CPU affinity mask for one process (Windows). False when the process is gone or PowerShell fails. */
export function limitProcess(pid: number, mask: number): boolean {
  if (!IS_WIN || !Number.isInteger(pid) || !Number.isInteger(mask) || mask < 1) return false;
  try {
    setPriority(pid, constants.priority.PRIORITY_BELOW_NORMAL);
    execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid}).ProcessorAffinity = ${mask}`], { windowsHide: true, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** PIDs of running processes whose executable name is `image` (e.g. "ArmaReforgerServer.exe"). */
export function findPids(image: string): number[] {
  try {
    if (IS_WIN) {
      const out = execFileSync("tasklist", ["/fo", "csv", "/nh", "/fi", `imagename eq ${image}`], {
        encoding: "utf-8",
        windowsHide: true,
      });
      // "image","pid",... or "INFO: No tasks..." when nothing matches
      return [...out.matchAll(/^"[^"]+","(\d+)"/gm)].map((m) => Number(m[1]));
    }
    const out = execFileSync("pgrep", ["-x", image.replace(/\.exe$/i, "")], { encoding: "utf-8" });
    return out.split(/\s+/).filter(Boolean).map(Number);
  } catch {
    return []; // pgrep exits 1 when nothing matches
  }
}

/**
 * Stop processes. Without `force`, ask them to close (WM_CLOSE / SIGTERM) so they can
 * save; with `force`, kill them. `tree` also ends their child processes (Windows only).
 */
export function killPids(pids: number[], force = false, tree = false): void {
  for (const pid of pids) {
    try {
      if (IS_WIN) {
        execFileSync("taskkill", ["/PID", String(pid), ...(tree ? ["/T"] : []), ...(force ? ["/F"] : [])], { windowsHide: true, stdio: "ignore" });
      } else {
        process.kill(pid, force ? "SIGKILL" : "SIGTERM");
      }
    } catch {
      // already gone
    }
  }
}

export interface ProcInfo {
  pid: number;
  ppid: number;
  cmd: string;
  /** Process creation time, epoch ms. */
  created: number;
}

/** Parse the ConvertTo-Json output of the Win32_Process query below: one object, an array, or nothing. */
export function parseProcJson(out: string): ProcInfo[] {
  const t = out.trim();
  if (!t) return [];
  const raw = JSON.parse(t);
  return (Array.isArray(raw) ? raw : [raw]).map((r) => ({
    pid: r.ProcessId,
    ppid: r.ParentProcessId,
    cmd: r.CommandLine ?? "",
    created: r.Created,
  }));
}

// Creation time converted to epoch ms in PowerShell; -EncodedCommand keeps the WQL quotes off the command line.
function cimArgs(filter: string): string[] {
  const ps =
    `Get-CimInstance Win32_Process -Filter "${filter}" | Select-Object ProcessId,ParentProcessId,CommandLine,` +
    `@{n='Created';e={([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}} | ConvertTo-Json -Compress`;
  return ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(ps, "utf16le").toString("base64")];
}

// shortcut: CIM is Windows only, so elsewhere no process is found and stop/status touch nothing; add a /proc reader if Linux servers matter.
function cimQuery(filter: string): ProcInfo[] {
  if (!IS_WIN) return [];
  try {
    const out = execFileSync("powershell", cimArgs(filter), {
      encoding: "utf-8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"], // PowerShell writes progress records to stderr
    });
    return parseProcJson(out);
  } catch {
    return []; // fails safe: a process that is not found is never stopped
  }
}

export const processInfo = (pid: number): ProcInfo | undefined => cimQuery(`ProcessId=${Math.trunc(pid)}`)[0];

/** processInfo without blocking: the automatic watch check runs beside live tool calls. Undefined when not found or the query fails. */
export function processInfoAsync(pid: number): Promise<ProcInfo | undefined> {
  if (!IS_WIN) return Promise.resolve(undefined);
  return new Promise((done) =>
    execFile("powershell", cimArgs(`ProcessId=${Math.trunc(pid)}`), { windowsHide: true, timeout: 10_000 }, (err, out) => {
      try {
        done(err ? undefined : parseProcJson(String(out))[0]);
      } catch {
        done(undefined);
      }
    })
  );
}

/** `netstat -ano -p TCP` output without blocking; "" when the query fails. */
export const netstat = () =>
  new Promise<string>((done) => execFile("netstat", ["-ano", "-p", "TCP"], { windowsHide: true, timeout: 10_000 }, (err, out) => done(err ? "" : String(out))));

export const serverProcesses = () => cimQuery("Name='ArmaReforgerServerDiag.exe' OR Name='ArmaReforgerServer.exe'");
export const clientProcesses = () => cimQuery("Name='ArmaReforgerSteamDiag.exe' OR Name='ArmaReforgerSteam.exe'");
export const crashReporters = () => cimQuery("Name='CrashReporter.exe'");
/** Running Workbench processes with the -gproj of each, for refusal messages. */
export const workbenchCommandLines = () =>
  cimQuery("Name='ArmaReforgerWorkbenchSteamDiag.exe'").map((p) => ({ pid: p.pid, gproj: argValue(p.cmd, "-gproj") ?? "" }));

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Startup flags that point the game or server at a folder or file it writes to (BI "Startup Parameters": -profile, -logsDir,
 * -addonDownloadDir, -addonTempDir, -saveDir; -cfg; Workbench pack and publish), so extraArgs could aim writes into CRF, Lobby,
 * a Workshop cache or an install folder.
 */
const WRITE_PATH_FLAGS = /^-(profile|logsdir|addondownloaddir|addontempdir|savedir|cfg|backendlocalstorage|createdb|scriptauthorizeall|diagmenu|packaddon\w*|publishaddon\w*)$/i;

/** The first extra argument a tool must refuse (write-path flag, one of `own` flags, a quote or line break), or undefined. */
export function refusedArg(args: string[], own?: RegExp): string | undefined {
  return args.find((a) => {
    // Invisible characters dropped, then any leading run of quotes, dashes (also Unicode ones), slashes, backslashes or plus signs,
    // then the name up to = : , space or a quote.
    const m = a.replace(/[\u00AD\u034F\u180E\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFE0F\uFEFF]/g, "").trim().match(/^['"\u2018\u2019]*[-/\\+\u2010-\u2015\u2212\u2E3A\u2E3B\uFE58\uFE63\uFF0D]+([^=:,\s'"\u2019]*)/);
    const flag = m ? `-${m[1]}` : "";
    return WRITE_PATH_FLAGS.test(flag) || !!own?.test(flag) || /["\r\n]/.test(a);
  });
}

/** Value of `flag` (e.g. "-profile") in a command line, quoted or bare. */
export function argValue(cmd: string, flag: string): string | undefined {
  const m = cmd.match(new RegExp(`(?:^|\\s)${flag}\\s+(?:"([^"]*)"|(\\S+))`, "i"));
  return m ? (m[1] ?? m[2]) : undefined;
}

/**
 * Start a long-running program detached from this process (it keeps running if the
 * MCP server exits). stdout/stderr go to `logFile` when given. Returns the PID.
 */
export function spawnDetached(exe: string, args: string[], cwd: string, logFile?: string): number {
  const fd = logFile ? openSync(logFile, "a") : "ignore";
  const child = spawn(exe, args, {
    cwd,
    detached: true,
    windowsHide: false,
    stdio: ["ignore", fd, fd],
  });
  // Without a listener a failed start (missing or blocked exe) is an uncaught 'error' that ends the MCP; the pid check reports it.
  child.on("error", () => {});
  child.unref();
  if (typeof fd === "number") closeSync(fd);
  if (!child.pid) throw new Error(`Failed to start ${exe}`);
  return child.pid;
}

/** Newest sub-directory of `dir` (by mtime), optionally only those modified after `since`. */
export function newestDir(dir: string, since = 0): string | null {
  if (!existsSync(dir)) return null;
  let best: { path: string; t: number } | null = null;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = join(dir, e.name);
    const t = statSync(p).mtimeMs;
    if (t >= since && (!best || t > best.t)) best = { path: p, t };
  }
  return best?.path ?? null;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
