import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { workbenchProfileDir } from "../workbench/cli.js";
import { myGamesDir } from "../utils/game-paths.js";
import { dstProfileDirs } from "./server-params.js";
import { DEFAULT_FAIL_PATTERNS, isUnderRoots, resolveLogFile, scan, waitFor, type LogSpec } from "../utils/logwatch.js";

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });

const regex = (s: string) => {
  try {
    return new RegExp(s);
  } catch (e) {
    throw new Error(`Invalid regex "${s}": ${(e as Error).message}`);
  }
};

/** Folders log_watch may read: the MCP's own log locations, the Dedicated Server Tool's profiles, plus ENFUSION_LOG_ROOTS. */
export function logRoots(config: Config): string[] {
  const dst = dstProfileDirs(config);
  return [
    // Only each profile's logs folder: the profile names come from a settings file, not from the user (review GI-14 B1).
    ...(dst.server ? [join(dst.server, "logs")] : []),
    ...dst.peers.map((p) => join(p, "logs")),
    config.serverProfilePath,
    join(workbenchProfileDir(config), "logs"),
    join(myGamesDir(), "ArmaReforger", "logs"),
    config.clientProfilesRoot,
    ...(config.logRoots ?? []),
  ];
}

export function registerLogWatch(server: McpServer, config: Config): void {
  server.registerTool(
    "log_watch",
    {
      description:
        "Wait for patterns in a dedicated server, game client or Workbench log, or scan one: 'wait' blocks until a pattern " +
        "(or all) matches, a fail pattern matches, the process exits or the timeout; 'scan' reads what is there now, extracts " +
        "named groups or [TAG] VERB k=v harness rows and checks assertions. Read only; returns a cursor to resume from.",
      inputSchema: {
        action: z.enum(["wait", "scan"]),
        source: z.enum(["server", "client", "workbench", "path", "dstServer", "dstPeers"]),
        instance: z.string().default("default").describe("(server/client) Instance name; (dstPeers) peer number, default 1"),
        path: z.string().optional().describe("(path) A .log file, a logs_* folder, or a folder with logs\\logs_* below it, under an allowed log root"),
        file: z.enum(["console", "script", "error"]).default("console").describe("File inside the log folder"),
        newerThan: z.union([z.string(), z.number()]).optional().describe("ISO time or epoch ms: use the newest log folder from then on; wait also waits for it to appear"),
        from: z.union([z.enum(["end", "start"]), z.number().int().min(0)]).optional().describe("Where to start: end (wait default), start (scan default) or a cursor from a previous result"),
        patterns: z.array(z.object({ name: z.string(), regex: z.string() })).optional().describe("(wait) What to wait for"),
        match: z.enum(["any", "all"]).default("any").describe("(wait) all = every pattern must match, in any order"),
        failPatterns: z.array(z.string()).optional().describe("(wait) Stop with 'failed' on the first match. Default: (F):, Can't compile, Unable to start replication, Out of memory, Application hangs. [] disables"),
        extract: z.array(z.string()).optional().describe("(scan) Regexes with named groups; each match becomes a row"),
        harnessTag: z.string().optional().describe("(scan) Rows from [TAG] VERB k=v ... lines"),
        assert: z
          .object({ mustMatch: z.array(z.string()).optional(), mustNotMatch: z.array(z.string()).optional(), noScriptErrorsIn: z.array(z.string()).optional() })
          .optional()
          .describe("(scan) Pass or fail per check with the first offending line; noScriptErrorsIn takes addon folders"),
        pid: z.number().int().optional().describe("(wait) Return 'exited' when this process ends"),
        timeoutSec: z.number().min(1).default(60).describe("(wait) Upper bound, at most 600"),
        maxRows: z.number().int().min(1).max(2000).default(200).describe("(scan) Cap on rows"),
      },
    },
    async (a) => {
      try {
        if (a.timeoutSec > 600) return text("timeoutSec over 600: use test_run (TS-N1) for long runs", true);
        // shortcut: one server profile and one client log root today; named instances come with parallel servers (TS-I2).
        if ((a.source === "server" || a.source === "client") && a.instance !== "default") {
          return text(`Instance "${a.instance}" not found. Known instances: default`, true);
        }
        const roots = logRoots(config);
        let dir: string;
        if (a.source === "path") {
          if (!a.path) return text("source=path needs path", true);
          if (!isUnderRoots(a.path, roots)) return text(`Path is not under an allowed log root: ${a.path}`, true);
          if (existsSync(a.path) && statSync(a.path).isFile() && !a.path.toLowerCase().endsWith(".log")) return text(`Not a .log file: ${a.path}`, true);
          dir = a.path;
        } else if (a.source === "dstServer" || a.source === "dstPeers") {
          // Dedicated Server Tool runs (GI-14): profile folders from its saved settings.
          const dst = dstProfileDirs(config);
          const n = a.instance === "default" ? 1 : Number(a.instance);
          const found = a.source === "dstServer" ? dst.server : dst.peers[n - 1];
          if (!found) {
            return text(a.source === "dstServer"
              ? `The Dedicated Server Tool has no Profile set in ${dst.settings}; set Profile in the tool (the guide uses "server").`
              : `No Dedicated Server Tool peer ${a.instance === "default" ? 1 : a.instance} with a profile folder; peers found: ${dst.peers.length} (${dst.settings})`, true);
          }
          dir = found;
        } else {
          dir = a.source === "server" ? config.serverProfilePath : a.source === "client" ? join(myGamesDir(), "ArmaReforger", "logs") : join(workbenchProfileDir(config), "logs");
        }
        const newerThan = typeof a.newerThan === "string" ? Date.parse(a.newerThan) : a.newerThan;
        if (Number.isNaN(newerThan)) return text(`newerThan is not a time: ${a.newerThan}`, true);
        const spec: LogSpec = { dir, file: a.file, newerThan };
        // Re-checked on the resolved file: a junction inside a root could lead out of it.
        const resolve = () => {
          const f = resolveLogFile(spec);
          return f && isUnderRoots(f, roots) ? f : null;
        };

        if (a.action === "scan") {
          const opts = {
            from: a.from,
            extract: a.extract?.map(regex),
            harnessTag: a.harnessTag,
            maxRows: a.maxRows,
            assert: a.assert && {
              mustMatch: a.assert.mustMatch?.map(regex),
              mustNotMatch: a.assert.mustNotMatch?.map(regex),
              noScriptErrorsIn: a.assert.noScriptErrorsIn,
            },
          };
          const file = resolve();
          if (!file) return text(`No ${a.file}.log found under ${dir}`, true);
          const r = scan({ file, ...opts });
          const passed = r.assertions.filter((x) => x.pass).length;
          const summary = `scan: ${r.linesRead} lines, ${r.rowsTotal} rows${r.rowsTotal > r.rows.length ? ` (${r.rows.length} shown)` : ""}, E ${r.counts.E} W ${r.counts.W} F ${r.counts.F}` +
            (r.assertions.length ? `, assertions ${passed}/${r.assertions.length} pass` : "");
          return text(`${summary}\n\n\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\``);
        }

        if (!a.patterns?.length) return text("wait needs patterns", true);
        const r = await waitFor({
          log: resolve,
          patterns: a.patterns.map((p) => ({ name: p.name, regex: regex(p.regex) })),
          match: a.match,
          failPatterns: a.failPatterns ? a.failPatterns.map(regex) : DEFAULT_FAIL_PATTERNS,
          from: a.from,
          pid: a.pid,
          timeoutMs: a.timeoutSec * 1000,
        });
        const summary = `${r.status}${r.matched.length ? `: ${r.matched.map((m) => m.name).join(", ")}` : ""} after ${r.elapsedSec.toFixed(1)} s, ${r.linesRead} lines read`;
        return text(`${summary}\n\n\`\`\`json\n${JSON.stringify(r, null, 2)}\n\`\`\``);
      } catch (e) {
        return text(`log_watch failed: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
  );
}
