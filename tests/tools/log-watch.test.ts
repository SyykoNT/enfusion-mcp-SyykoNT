import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import { registerLogWatch } from "../../src/tools/log-watch.js";

type Result = { content: { text: string }[]; isError?: boolean };
type Handler = (p: Record<string, unknown>) => Promise<Result>;

let root: string;
let handler: Handler;
const put = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
  return join(root, rel);
};
const call = (p: Record<string, unknown>) => handler({ instance: "default", file: "console", match: "any", timeoutSec: 60, maxRows: 200, ...p });
const json = (r: Result) => JSON.parse(r.content[0].text.split("```json\n")[1].split("\n```")[0]);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "emcp-lwt-"));
  put("runs/r1/logs/logs_2026-10-31_10-00-00/console.log", "10:00:00.000 SCRIPT       : [T] DONE n=3\n");
  put("outside/logs/logs_1/console.log", "x\n");
  put("runs/r1/notes.txt", "x\n");
  registerLogWatch(
    { registerTool: (_n: string, _d: unknown, h: Handler) => void (handler = h) } as unknown as McpServer,
    { serverProfilePath: join(root, "server"), clientProfilesRoot: join(root, "clients"), projectPath: join(root, "projects"), logRoots: [join(root, "runs")] } as Config
  );
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("log_watch", () => {
  it("scans a run folder under ENFUSION_LOG_ROOTS and waits on it", async () => {
    const r = await call({ action: "scan", source: "path", path: join(root, "runs", "r1"), harnessTag: "T" });
    expect(r.content[0].text).toMatch(/^scan: 1 lines, 1 rows/);
    expect(json(r).rows).toEqual([{ verb: "DONE", n: "3", text: "" }]);
    const w = await call({ action: "wait", source: "path", path: join(root, "runs", "r1"), from: "start", patterns: [{ name: "done", regex: "\\[T\\] DONE" }] });
    expect(json(w)).toMatchObject({ status: "matched", matched: [{ name: "done", lineNo: 1 }] });
  });

  it("refuses paths outside the roots, non-.log files, long timeouts, bad regexes and unknown instances", async () => {
    expect((await call({ action: "scan", source: "path", path: join(root, "outside", "logs") })).content[0].text).toBe(`Path is not under an allowed log root: ${join(root, "outside", "logs")}`);
    expect((await call({ action: "scan", source: "path", path: join(root, "runs", "..", "outside", "logs") })).isError).toBe(true);
    expect((await call({ action: "scan", source: "path", path: join(root, "runs", "r1", "notes.txt") })).content[0].text).toMatch(/^Not a \.log file/);
    expect((await call({ action: "wait", source: "server", timeoutSec: 601, patterns: [{ name: "x", regex: "x" }] })).content[0].text).toBe("timeoutSec over 600: use test_run (TS-N1) for long runs");
    expect((await call({ action: "scan", source: "path", path: join(root, "runs"), extract: ["(unclosed"] })).content[0].text).toMatch(/^log_watch failed: Invalid regex "\(unclosed"/);
    expect((await call({ action: "wait", source: "server", instance: "pbr50", patterns: [{ name: "x", regex: "x" }] })).content[0].text).toMatch(/^Instance "pbr50" not found/);
    expect((await call({ action: "wait", source: "server", timeoutSec: 1, patterns: [{ name: "x", regex: "x" }] }).then(json)).status).toBe("no-log");
  });
});
