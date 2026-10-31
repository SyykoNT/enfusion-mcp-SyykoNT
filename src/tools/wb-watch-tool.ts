import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { workbenchProfileDir } from "../workbench/cli.js";
import { isOwned } from "../utils/instances.js";
import { isAlive, killPids, processInfo, type ProcInfo } from "../utils/process.js";
import { WATCH_DIR, formatReport, hms, readStates, startWatcher, watcherOf, type StartWatcher } from "../watchdog/wb-watch.js";

export interface WatchArgs {
  action: "status" | "start" | "stop";
  pid?: number;
  dismissLeakAssert?: "owned" | "watched" | "never";
  autoRecover?: boolean;
}

export interface WatchToolDeps {
  stateDir: string;
  proc(pid: number): ProcInfo | undefined;
  owned(pid: number): boolean;
  alive(pid: number): boolean;
  start(w: StartWatcher): number;
  kill(pid: number): void;
  base: Omit<StartWatcher, "pid" | "owned">;
}

/** wb_watch without the MCP wrapper. Returns the text and whether it is an error. */
export function watchAction(a: WatchArgs, d: WatchToolDeps): { text: string; isError?: boolean } {
  const fail = (text: string) => ({ text, isError: true });
  if (a.action === "status") {
    const { states, errors } = readStates(d.stateDir);
    if (!states.length && !errors.length) return { text: "No Workbench is watched. wb_launch watches what it starts; wb_watch start pid=<n> attaches a watcher to another one." };
    const now = Date.now();
    const reports = states.map((s) => {
      const gone = s.state !== "exited" && s.state !== "crashed" && !d.alive(s.watcherPid);
      return formatReport(s, now) + (gone ? `\n  (watcher not running; last report ${hms(s.updated)})` : "");
    });
    return { text: [...reports, ...errors].join("\n\n") };
  }
  if (!a.pid) return fail(`pid is required for ${a.action}.`);
  const pid = a.pid;
  const watcher = watcherOf(d.stateDir, pid, d.alive);

  if (a.action === "stop") {
    if (!watcher) return fail(`No watcher runs for Workbench PID ${pid}.`);
    if (!d.proc(watcher)?.cmd.includes("wb-watch")) return fail(`PID ${watcher} holds the watch lock for ${pid} but is not a watcher. Not stopped.`);
    d.kill(watcher);
    for (const f of [`${pid}.lock`, `${pid}.json`]) rmSync(join(d.stateDir, f), { force: true });
    return { text: `Stopped watcher PID ${watcher} for Workbench PID ${pid}.` };
  }

  const proc = d.proc(pid);
  if (!proc || !/ArmaReforgerWorkbenchSteamDiag\.exe/i.test(proc.cmd)) return fail(`PID ${pid} is not a Workbench process.`);
  if (watcher) return fail(`already watched by watcher PID ${watcher}`);
  // Ownership only from the instance registry (D-026): nothing a caller passes can make a Workbench owned.
  const owned = d.owned(pid);
  const w = d.start({
    ...d.base, pid, owned, startTime: proc.created, dismiss: a.dismissLeakAssert ?? "watched", autoRecover: !!a.autoRecover && owned,
  });
  return {
    text: `Watching Workbench PID ${pid} (${owned ? "owned" : "not owned: never closed or killed"}) with watcher PID ${w}. ` +
      `dismissLeakAssert = ${a.dismissLeakAssert ?? "watched"}, autoRecover = ${!!a.autoRecover && owned}. Check it with wb_watch status.`,
  };
}

export function registerWbWatch(server: McpServer, config: Config): void {
  server.registerTool(
    "wb_watch",
    {
      description:
        "Watch a Workbench between calls: notices a blocking dialog (such as the diag build's \"Resources are leaking!\" assert), " +
        "a hang, a script reload that never finishes, or a crash, names the likely trigger, and reports it here, in every live tool's footer " +
        "and in wb_diagnose. wb_launch already watches each Workbench it starts. status lists watched Workbench copies; start attaches a " +
        "watcher to another Workbench (it never closes, kills or focuses a Workbench this MCP did not start); stop ends one. " +
        "The only automatic click is Ignore on the \"Resources are leaking!\" assert, in any Workbench it watches; every click is reported.",
      inputSchema: {
        action: z.enum(["status", "start", "stop"]).describe("status: list watched Workbench copies; start: attach a watcher; stop: end one"),
        pid: z.number().int().positive().optional().describe("Workbench PID (start and stop)"),
        dismissLeakAssert: z.enum(["owned", "watched", "never"]).optional().describe("Who gets the automatic Ignore on the leak assert: watched (default, any watched Workbench), owned, or never"),
        autoRecover: z.boolean().optional().describe("Only for a Workbench this MCP process started: after 5 min not responding or stalled, and only while the lock names this session, exit and then kill that one Workbench"),
      },
    },
    async (a) => {
      const r = watchAction(a, {
        stateDir: WATCH_DIR,
        proc: processInfo,
        owned: (pid) => isOwned(pid),
        alive: isAlive,
        start: startWatcher,
        // Tree kill: the watcher's finally never runs under taskkill /F, so its probe PowerShell must go with it.
        kill: (pid) => killPids([pid], true, true),
        base: { logsRoot: join(workbenchProfileDir(config), "logs"), host: config.workbenchHost, port: config.workbenchPort },
      });
      return { content: [{ type: "text" as const, text: r.text }], ...(r.isError ? { isError: true as const } : {}) };
    }
  );
}
