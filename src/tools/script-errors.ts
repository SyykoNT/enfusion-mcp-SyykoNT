import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { closeSync, createReadStream, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { basename, dirname, join } from "node:path";
import type { Config } from "../config.js";
import { workbenchProfileDir } from "../workbench/cli.js";
import { formatLogTime, mergeSummaries, parseLogHeader, parseLogTime, parseScriptErrors, type ScriptErrorGroup, type ScriptErrorSummary } from "../workbench/script-errors.js";
import { findGproj, myGamesDir } from "../utils/game-paths.js";
import { serverLogsDir } from "./server.js";
import { dstProfileDirs } from "./server-params.js";

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) });

interface Session {
  name: string;
  file: string;
}

function logRoot(config: Config, source: "workbench" | "game" | "server"): string {
  if (source === "game") return join(myGamesDir(), "ArmaReforger", "logs");
  if (source === "server") return serverLogsDir(config);
  return join(workbenchProfileDir(config), "logs");
}

/** error.log holds the same SCRIPT (E) lines and blocks as console.log and is smaller. */
function logFileIn(dir: string): string | null {
  return ["error.log", "console.log"].map((f) => join(dir, f)).find((f) => existsSync(f)) ?? null;
}

/** Newest `count` sessions of a logs root; folder names are logs_YYYY-MM-DD_HH-MM-SS, so name order is time order. */
function newestSessions(root: string, count: number): Session[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith("logs_"))
    .map((e) => e.name)
    .sort()
    .reverse()
    .map((name) => ({ name, file: logFileIn(join(root, name)) }))
    .filter((s): s is Session => !!s.file)
    .slice(0, count);
}

/** A .log file, a log folder, or a logs root (a folder of logs_* folders). */
function sessionsAt(path: string, count: number): Session[] | string {
  if (!existsSync(path)) return `Not found: ${path}`;
  if (statSync(path).isFile()) return path.toLowerCase().endsWith(".log") ? [{ name: basename(dirname(path)), file: path }] : `Not a .log file: ${path}`;
  const own = logFileIn(path);
  return own ? [{ name: basename(path), file: own }] : newestSessions(path, count);
}

/** Addon folders (with a .gproj) under the project path, for frame attribution. */
function projectAddons(config: Config): { name: string; dir: string }[] {
  try {
    return readdirSync(config.projectPath, { withFileTypes: true })
      .filter((e) => e.isDirectory() && findGproj(join(config.projectPath, e.name)))
      .map((e) => ({ name: e.name, dir: join(config.projectPath, e.name) }));
  } catch {
    return [];
  }
}

/** Start time from the header in the first lines of a log, if it has one. */
function logStart(file: string): number | undefined {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(1024);
    return buf.toString("utf8", 0, readSync(fd, buf, 0, 1024, 0)).split(/\r?\n/).slice(0, 4).map(parseLogHeader).find((t) => t !== undefined);
  } finally {
    closeSync(fd);
  }
}

const n = (x: number) => x.toLocaleString("en-US");
const groupsOf = (x: number) => `${n(x)} group${x === 1 ? "" : "s"}`;

export function registerScriptErrors(server: McpServer, config: Config): void {
  server.registerTool(
    "script_errors",
    {
      description:
        "Summarize script runtime errors in Workbench, game client or dedicated server logs: Virtual Machine Exception blocks " +
        "(reason, class, function, stack) and other SCRIPT (E) lines, grouped with counts, first and last time and the addon " +
        "that owns each top frame. Reads log files only. Compile errors are left to `mod compile`. " +
        "dstServer and dstPeers read the logs of Workbench's Dedicated Server Tool runs, from the Profile names in its saved settings.",
      inputSchema: {
        source: z
          .enum(["workbench", "game", "server", "dstServer", "dstPeers"])
          .default("workbench")
          .describe("Which log root to read; dstPeers merges the newest sessions of every peer of the Dedicated Server Tool"),
        logPath: z.string().optional().describe("A .log file, a log folder or a logs root (folder of logs_* folders) instead of source"),
        sessions: z.number().int().min(1).max(50).default(1).describe("Newest N log folders, aggregated"),
        since: z.string().regex(/^\d\d:\d\d(:\d\d)?$/).optional().describe("HH:MM[:SS] local time: only entries from then on (one session only)"),
        addonName: z.string().optional().describe("Addon folder name under the project path: groups whose stack touches its files are listed first"),
        kinds: z.array(z.enum(["vme", "error"])).optional().describe("vme = VM exceptions, error = other SCRIPT (E) lines; default both"),
        limit: z.number().int().min(1).max(100).default(15).describe("Groups listed"),
        frames: z.number().int().min(1).max(20).default(5).describe("Stack frames shown per group"),
      },
    },
    async (a) => {
      try {
        if (a.since && a.sessions > 1) return text("since applies to one session; drop sessions or since", true);
        let root: string;
        let found: Session[] | string;
        if (!a.logPath && (a.source === "dstServer" || a.source === "dstPeers")) {
          const dst = dstProfileDirs(config);
          if (a.source === "dstServer" && !dst.server) {
            return text(`The Dedicated Server Tool has no Profile set in ${dst.settings}, so its server writes to a default profile (location unverified). Set Profile in the tool (the guide uses "server"), or pass logPath.`, true);
          }
          const dirs = a.source === "dstServer" ? [dst.server!] : dst.peers;
          if (!dirs.length) return text(`No peer profile folders ${dst.peerName}<n> found: no Dedicated Server Tool peer has run yet.`, true);
          root = dirs.join(", ");
          // One run = the newest sessions of each peer, labelled with the peer's profile folder.
          found = dirs.flatMap((d) => newestSessions(join(d, "logs"), a.sessions).map((s) => ({ ...s, name: `${basename(d)}/${s.name}` })));
        } else {
          root = a.logPath ?? logRoot(config, a.source as "workbench" | "game" | "server");
          found = sessionsAt(root, a.sessions);
        }
        if (typeof found === "string") return text(found, true);
        if (!found.length) return text(`No logs in ${root}`, true);

        const t0 = Date.now();
        let bytes = 0;
        const parts: ScriptErrorSummary[] = [];
        for (const s of found) {
          bytes += statSync(s.file).size;
          const input = createReadStream(s.file, { flags: "r", encoding: "utf-8" });
          parts.push(await parseScriptErrors(createInterface({ input, crlfDelay: Infinity }), { kinds: a.kinds, frames: a.frames, since: a.since, session: s.name }));
        }
        const sum = mergeSummaries(parts);
        const secs = ((Date.now() - t0) / 1000).toFixed(1);

        const addons = projectAddons(config);
        const owners = new Map<string, string[]>();
        const ownersOf = (file: string) => {
          const k = file.toLowerCase();
          if (!owners.has(k)) owners.set(k, addons.filter((ad) => existsSync(join(ad.dir, file))).map((ad) => ad.name));
          return owners.get(k)!;
        };
        const isOwn = (g: ScriptErrorGroup) => !!a.addonName && g.frames.some((f) => ownersOf(f.file).some((o) => o.toLowerCase() === a.addonName!.toLowerCase()));
        const groups = sum.groups.map((g) => ({ g, own: isOwn(g) })).sort((x, y) => Number(y.own) - Number(x.own) || y.g.count - x.g.count);

        const vmeGroups = sum.groups.filter((g) => g.kind === "vme").length;
        const sessionLabel = found.length === 1 ? `${found[0].name}, ${basename(found[0].file)}` : `${found[found.length - 1].name} to ${found[0].name}`;
        const out = [
          `## Script runtime errors: ${a.logPath ? root : a.source}, ${found.length} session${found.length > 1 ? "s" : ""} (${sessionLabel}, ${(bytes / 1e6).toFixed(1)} MB, ${secs} s)`,
          `${n(sum.vme)} VM exceptions in ${groupsOf(vmeGroups)}; ${n(sum.errors)} other SCRIPT errors in ${groupsOf(sum.groups.length - vmeGroups)}.`,
        ];
        if (a.since) {
          // Same rule as the parser, which does not return it: since is on the start day unless it is over an hour before the start.
          const start = logStart(found[0].file);
          const at = start === undefined ? undefined : parseLogTime(undefined, `${a.since.length === 5 ? a.since + ":00" : a.since}.000`, start);
          out.push(at === undefined ? `Since: ${a.since} (no start time in the log header)` : `Since: ${formatLogTime(at, true)} (log started ${formatLogTime(start!, true)})`);
        }
        if (a.addonName && !addons.some((ad) => ad.name.toLowerCase() === a.addonName!.toLowerCase())) {
          out.push(`Note: no addon "${a.addonName}" with a .gproj under ${config.projectPath}, so no group is marked own.`);
        }
        groups.slice(0, a.limit).forEach(({ g, own }, i) => {
          const days = new Date(g.first).toDateString() !== new Date(g.last).toDateString();
          const head = `${i + 1}. ${n(g.count)}x  ${formatLogTime(g.first, days)} to ${formatLogTime(g.last, days)}  `;
          out.push("");
          if (g.kind === "error") {
            out.push(head + g.message);
            if (g.examples.length > 1) for (const x of g.examples) out.push(`   e.g. ${x}`);
          } else {
            out.push(head + [g.className, g.func].filter(Boolean).join(".") + (own ? "  [own]" : ""));
            out.push(`   Reason: ${g.reason}`);
            const top = g.frames[0];
            if (top) {
              const [first, ...also] = ownersOf(top.file);
              const where = first
                ? `${first}, local: ${join(config.projectPath, first)}${also.length ? `; also in ${also.join(", ")}` : ""}`
                : "packed (vanilla or Workshop)";
              out.push(`   Top frame: ${top.file}:${top.line} (${where})`);
              out.push(`   Stack: ${g.frames.map((f) => `${basename(f.file)}:${f.line} ${f.func}`).join(" < ")}`);
            }
          }
          if (found.length > 1) out.push(`   Sessions: ${g.sessions.length} (${g.sessions.slice(0, 5).join(", ")}${g.sessions.length > 5 ? ", ..." : ""})`);
        });
        if (groups.length > a.limit) out.push("", `${groups.length - a.limit} more groups not listed (raise limit).`);
        return text(out.join("\n"));
      } catch (e) {
        return text(`script_errors failed: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
  );
}
