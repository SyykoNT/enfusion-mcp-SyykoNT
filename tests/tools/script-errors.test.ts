import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import { registerScriptErrors } from "../../src/tools/script-errors.js";

type Result = { content: { text: string }[]; isError?: boolean };
type Handler = (p: Record<string, unknown>) => Promise<Result>;

const block = (time: string, file: string, line: number, fn: string) =>
  [`${time} SCRIPT    (E): Virtual Machine Exception`, "", "Reason: NULL pointer to instance", "", `Function: '${fn}'`, "Stack trace:", `${file}:${line} Function ${fn}`, ""].join("\r\n");
const header = (d: string) => `---\r\nLog C:/TestKit/logs/x/console.log started at ${d}\r\n\r\n`;
const VANILLA = "Scripts/Game/Map/SCR_MapEntity.c";
const OWN = "Scripts/Game/TST_Own.c";

let root: string;
let handler: Handler;
const put = (rel: string, text: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const call = (p: Record<string, unknown>) => handler({ source: "server", sessions: 1, limit: 15, frames: 5, ...p });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "emcp-se-"));
  // Older session: one vanilla exception, console.log only. Newer: two own and one vanilla, error.log preferred.
  put("profile/logs/logs_2026-10-30_10-00-00/console.log", header("2026-10-30 10:00:00") + block("10:00:01.000", VANILLA, 1392, "Draw"));
  put("profile/logs/logs_2026-10-31_09-00-00/error.log", header("2026-10-31 09:00:00") + [block("09:00:01.000", VANILLA, 1392, "Draw"), block("09:00:02.000", OWN, 7, "Tick"), block("09:00:03.000", OWN, 7, "Tick")].join("\r\n"));
  put("profile/logs/logs_2026-10-31_09-00-00/console.log", "ignored when error.log exists\r\n");
  put("profile/logs/notes/readme.txt", "not a session");
  put("nohead.log", block("10:00:01.000", VANILLA, 1392, "Draw"));
  put("projects/TestAddon/TestAddon.gproj", "GameProject {}");
  put(`projects/TestAddon/${OWN}`, "class TST_Own {}");
  registerScriptErrors(
    { registerTool: (_n: string, _d: unknown, h: Handler) => void (handler = h) } as unknown as McpServer,
    { serverProfilePath: join(root, "profile"), projectPath: join(root, "projects") } as Config
  );
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("script_errors", () => {
  it("reads the newest session from error.log and attributes frames", async () => {
    const r = await call({});
    const t = r.content[0].text;
    expect(r.isError).toBeUndefined();
    expect(t).toContain("1 session (logs_2026-10-31_09-00-00, error.log");
    expect(t).toContain("3 VM exceptions in 2 groups; 0 other SCRIPT errors in 0 groups.");
    expect(t).toMatch(/1\. 2x  09:00:02\.000 to 09:00:03\.000  Tick\n/);
    expect(t).toContain(`Top frame: ${OWN}:7 (TestAddon, local: ${join(root, "projects", "TestAddon")})`);
    expect(t).toContain(`Top frame: ${VANILLA}:1392 (packed (vanilla or Workshop))`);
  });

  it("sorts own groups first and aggregates sessions", async () => {
    const t = (await call({ sessions: 5, addonName: "testaddon" })).content[0].text;
    expect(t).toContain("2 sessions (logs_2026-10-30_10-00-00 to logs_2026-10-31_09-00-00");
    const own = t.indexOf("Tick  [own]");
    const vanilla = t.indexOf("2x  2026-10-30 10:00:01.000 to 2026-10-31 09:00:01.000"); // one group over both sessions
    expect(own).toBeGreaterThan(0);
    expect(vanilla).toBeGreaterThan(own);
    expect(t).toContain("Sessions: 2 (logs_2026-10-31_09-00-00, logs_2026-10-30_10-00-00)");
  });

  it("takes a logPath file or folder and refuses bad input", async () => {
    const one = await call({ logPath: join(root, "profile/logs/logs_2026-10-30_10-00-00/console.log") });
    expect(one.content[0].text).toContain("1 VM exceptions in 1 group");
    expect((await call({ logPath: join(root, "projects/TestAddon/TestAddon.gproj") })).content[0].text).toMatch(/^Not a \.log file/);
    expect((await call({ logPath: join(root, "nope") })).isError).toBe(true);
    expect((await call({ logPath: join(root, "projects") })).content[0].text).toMatch(/^No logs in/);
    expect((await call({ since: "09:00", sessions: 2 })).content[0].text).toBe("since applies to one session; drop sessions or since");
    const from = (await call({ since: "09:00:02" })).content[0].text;
    expect(from).toContain("2 VM exceptions in 1 group");
    expect(from).toContain("Since: 2026-10-31 09:00:02.000 (log started 2026-10-31 09:00:00.000)");
  });

  it("prints the resolved since date when it falls on the next day", async () => {
    const t = (await call({ since: "07:00" })).content[0].text; // over an hour before the 09:00 start
    expect(t).toContain("0 VM exceptions in 0 groups");
    expect(t).toContain("Since: 2026-11-01 07:00:00.000 (log started 2026-10-31 09:00:00.000)");
    const bare = (await call({ logPath: join(root, "nohead.log"), since: "10:00" })).content[0].text;
    expect(bare).toContain("Since: 10:00 (no start time in the log header)");
  });
});
