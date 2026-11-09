import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { tmpdir } from "node:os";
import { isUnderRoots, LogCursor, parseHarnessLine, resolveLogFile, runErrors, scan, waitFor } from "../../src/utils/logwatch.js";

const FIX = join(__dirname, "..", "fixtures", "logs");
let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "emcp-lw-"))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));
const put = (rel: string, text: string | Buffer) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
  return join(dir, rel);
};

describe("LogCursor", () => {
  it("returns whole lines over appended chunks and reads only new bytes", () => {
    const f = put("a.log", "one\r\ntw");
    const c = new LogCursor(f);
    expect(c.read()).toEqual(["one"]);
    expect(c.cursor).toBe(5);
    appendFileSync(f, "o\r\nthree\r");
    expect(c.read()).toEqual(["two"]);
    appendFileSync(f, "\nfour\r\n");
    expect(c.read()).toEqual(["three", "four"]);
    expect(c.read()).toEqual([]);
    expect(new LogCursor(f, c.cursor).read()).toEqual([]); // resume from the cursor: nothing re-read
    expect(new LogCursor(f, "end").read()).toEqual([]);
  });

  it("keeps a UTF-8 character split across reads and restarts when the file shrinks", () => {
    const bytes = Buffer.from("caf\u00e9 ok\n", "utf8");
    const f = put("u.log", bytes.subarray(0, 4)); // ends inside the two-byte e-acute
    const c = new LogCursor(f);
    expect(c.read()).toEqual([]);
    appendFileSync(f, bytes.subarray(4));
    expect(c.read()).toEqual(["caf\u00e9 ok"]);
    writeFileSync(f, "new\n");
    expect(c.read()).toEqual(["new"]);
  });
});

describe("parseHarnessLine", () => {
  it("turns k=v pairs into fields, keeps <x,y,z> values and strips a variable-dump quote", () => {
    expect(parseHarnessLine("PBRCRASH", "00:51:02.000 SCRIPT       : [PBRCRASH] SUM rock_pbr_0 maxKmh=36 state=INTERMEDIARY | Hull=2347 Planks=1000")).toEqual({
      verb: "SUM", maxKmh: "36", state: "INTERMEDIARY", Hull: "2347", Planks: "1000", text: "rock_pbr_0 |",
    });
    expect(parseHarnessLine("BSP", "00:58:08.669 SCRIPT       : string row =  '[BSP] PHASE base_0 END secs=30.001'")).toEqual({ verb: "PHASE", secs: "30.001", text: "base_0 END" });
    expect(parseHarnessLine("PBRDT", "SCRIPT : [PBRDT] HIT hull impact=<0.78,2.47,5.53> dmg=12")).toMatchObject({ impact: "<0.78,2.47,5.53>", dmg: "12" });
    expect(parseHarnessLine("BSP", "SCRIPT : [BSPX] PHASE x")).toBeNull();
  });
});

describe("isUnderRoots", () => {
  it("refuses .., sibling prefixes and other drives", () => {
    const root = join(dir, "logs");
    mkdirSync(join(root, "logs_1"), { recursive: true });
    mkdirSync(join(dir, "logs2"));
    expect(isUnderRoots(join(root, "logs_1", "console.log"), [root])).toBe(true);
    expect(isUnderRoots(join(root, "..", "x.log"), [root])).toBe(false);
    expect(isUnderRoots(join(dir, "logs2", "x.log"), [root])).toBe(false);
    if (process.platform === "win32") {
      const other = parse(dir).root.toUpperCase().startsWith("Z") ? "Y:\\logs\\x.log" : "Z:\\logs\\x.log";
      expect(isUnderRoots(other, [root])).toBe(false);
    }
  });
});

describe("resolveLogFile", () => {
  it("finds the newest session in a profile, logs root or session folder, honoring newerThan", () => {
    const old = put("p/logs/logs_2026-10-30_10-00-00/console.log", "x\n");
    utimesSync(dirname(old), new Date(2026, 9, 30), new Date(2026, 9, 30));
    const now = put("p/logs/logs_2026-10-31_10-00-00/script.log", "x\n");
    expect(resolveLogFile({ dir: join(dir, "p"), file: "script" })).toBe(now);
    expect(resolveLogFile({ dir: join(dir, "p", "logs"), file: "script" })).toBe(now);
    expect(resolveLogFile({ dir: dirname(old) })).toBe(old);
    expect(resolveLogFile({ dir: join(dir, "p"), newerThan: Date.now() + 60_000 })).toBeNull();
  });
});

describe("waitFor", () => {
  const patterns = [
    { name: "listening", regex: /listening on address/ },
    { name: "game", regex: /OnGameStateChanged = GAME/ },
  ];

  it("matches any or all patterns, with line numbers and dated times from the start", async () => {
    const f = join(FIX, "server_console.log");
    const any = await waitFor({ log: () => f, patterns, from: "start", timeoutMs: 1000, pollMs: 10 });
    expect(any.status).toBe("matched");
    expect(any.matched).toEqual([expect.objectContaining({ name: "listening", lineNo: 6, time: "2026-10-26T11:35:26.447" })]);
    const all = await waitFor({ log: () => f, patterns, match: "all", from: "start", timeoutMs: 1000, pollMs: 10 });
    expect(all.matched.map((h) => h.name)).toEqual(["listening", "game"]);
  });

  it("stops on a fail pattern before a later match, and times out from the end", async () => {
    const crash = join(FIX, "crash_console.log");
    const r = await waitFor({ log: () => crash, patterns: [{ name: "p", regex: /Sending Request/ }], from: "start", timeoutMs: 1000, pollMs: 10 });
    expect(r.status).toBe("failed");
    expect(r.fatal[0]).toMatchObject({ lineNo: 2, time: "13:56:52.286" });
    const t = await waitFor({ log: () => crash, patterns, timeoutMs: 50, pollMs: 10 });
    expect(t.status).toBe("timeout");
    expect(t.linesRead).toBe(0);
  });

  it("waits for a log that appears late, reads it from its start, and reports no-log or exit", async () => {
    let f: string | null = null;
    setTimeout(() => (f = put("late/logs/logs_1/console.log", "10:00:00.000 x\n10:00:01.000 SCRIPT : OnGameStateChanged = GAME\n")), 60);
    const late = await waitFor({ log: () => f, patterns, timeoutMs: 2000, pollMs: 10 });
    expect(late.status).toBe("matched");
    expect(late.matched[0]).toMatchObject({ name: "game", lineNo: 2 });
    expect((await waitFor({ log: () => null, patterns, timeoutMs: 30, pollMs: 10 })).status).toBe("no-log");
    const exited = await waitFor({ log: () => null, patterns, pid: 42, isAlive: () => false, timeoutMs: 1000, pollMs: 10 });
    expect(exited.status).toBe("exited");
  });
});

describe("scan", () => {
  it("extracts rows, counts severities and checks assertions against an addon", () => {
    const addon = join(dir, "TestAddon");
    put("TestAddon/Scripts/Game/PBRZExit.c", "class PBRExit_Run {}");
    const f = put(
      "run/console.log",
      [
        "---",
        "Log C:/TestKit/run/console.log started at 2026-10-30 10:32:16 (2026-10-30 14:32:16 UTC)",
        "10:32:31.249      RESOURCES (E): Trying to create RigidBodyComponent without geometry",
        "10:32:31.278 SCRIPT    (E): Virtual Machine Exception",
        "",
        "Reason: Wrong parameter value",
        "",
        "Class:      'PBRExit_Run'",
        "Function: 'Spot'",
        "Stack trace:",
        "Scripts/Game/PBRZExit.c:84 Function Spot",
        "Scripts/Game/PBRZExit.c:106 Function AddCell",
        "",
        "10:32:32.000 SCRIPT       : [BSP] PHASE base_0 END secs=30.001",
        "10:32:33.000 SCRIPT       : speed kmh=41",
        "10:32:34.000 DEFAULT   (W): something",
      ].join("\r\n") + "\r\n"
    );
    const r = scan({
      file: f,
      harnessTag: "BSP",
      extract: [/speed kmh=(?<kmh>\d+)/],
      assert: { mustMatch: [/PHASE base_0 END/, /never there/], mustNotMatch: [/RigidBodyComponent/], noScriptErrorsIn: [addon, join(dir, "Other")] },
    });
    expect(r.rows).toEqual([{ verb: "PHASE", secs: "30.001", text: "base_0 END" }, { kmh: "41" }]);
    expect(r.counts).toEqual({ E: 2, W: 1, F: 0 });
    expect(r.assertions.map((a) => a.pass)).toEqual([true, false, false, false, true]);
    expect(r.assertions[2].firstLine).toMatchObject({ lineNo: 3, time: "2026-10-30T10:32:31.249" });
    expect(r.assertions[3].firstLine!.line).toBe("Scripts/Game/PBRZExit.c:84 Spot: Wrong parameter value (1x)");
    expect(scan({ file: f, from: r.cursor }).linesRead).toBe(0);
  });

  it("scans a log of more than 200,000 lines and more than one 8 MB read", () => {
    const line = "10:00:00.000 DEFAULT   (W): x\n"; // 29 bytes
    const f = put("big.log", line.repeat(400_000)); // 11.6 MB
    const r = scan({ file: f });
    expect(r.linesRead).toBe(400_000);
    expect(r.counts.W).toBe(400_000);
  });

  it("caps rows and fails noScriptErrorsIn on a compile error in the addon", () => {
    put("A/Scripts/Game/Foo.c", "");
    const f = put("c.log", `10:00:00.000 SCRIPT    (E): @"Scripts/Game/Foo.c,3": Undefined variable 'x'\n` + "SCRIPT : [T] V a=1\n".repeat(5));
    const r = scan({ file: f, harnessTag: "T", maxRows: 2, assert: { noScriptErrorsIn: [join(dir, "A")] } });
    expect(r.rows).toHaveLength(2);
    expect(r.rowsTotal).toBe(5);
    expect(r.assertions[0]).toMatchObject({ pass: false, firstLine: { line: "Scripts/Game/Foo.c:3: Undefined variable 'x'" } });
  });
});


describe("runErrors", () => {
  // Lines 337-347 of a real ConflictGen19 server console.log, then a second block in the server form (no blank lines, the stack ends at the next timestamped line).
  const log = [
    "Log C:/x/logs_2026-11-09_12-14-01/console.log started at 2026-11-09 12:14:01 (2026-11-09 17:14:01 UTC)",
    "12:14:03.000 DEFAULT      : Entered online game state.",
    "12:14:18.032 SCRIPT    (E): Virtual Machine Exception",
    "",
    "Reason: NULL pointer to instance",
    "",
    "Class:      'SCR_CampaignMilitaryBaseComponent'",
    "Function: 'OnAllBasesInitialized'",
    "Stack trace:",
    "Scripts/Game/Components/Locations/SCR_CampaignMilitaryBaseComponent.c:2357 Function OnAllBasesInitialized",
    "Scripts/Game/Campaign/SCR_CampaignMilitaryBaseManager.c:274 Function OnAllBasesInitialized",
    "Scripts/Game/GameMode/SCR_GameModeCampaign.c:610 Function Start",
    "Scripts/Game/GameMode/SCR_GameModeCampaign.c:946 Function OnGameStart",
    "12:14:19.000 ENGINE       : after the first block",
    "12:14:40.500 SCRIPT    (E): Virtual Machine Exception",
    "Reason: Division by zero",
    "Class:      'SCR_Other'",
    "Function: 'Tick'",
    "Stack trace:",
    "Scripts/Game/SCR_Other.c:12 Function Tick",
    "12:14:41.000 ENGINE       : after the second block",
  ].join("\r\n");
  const crash = ["crash-line-1", "", "-".repeat(40), "Assertion failed", "Reason: Access violation", ...Array.from({ length: 55 }, (_, i) => `crash-line-${i + 6}`)].join("\n");

  it("reports the count, the first group and the crash.log head (40 of 60 lines)", () => {
    put("run/console.log", log);
    put("run/crash.log", crash);
    const r = runErrors(join(dir, "run"));
    expect(r).toContain("**Script exceptions in this run: 2**");
    expect(r).toContain("Reason: NULL pointer to instance\nClass: SCR_CampaignMilitaryBaseComponent\nFunction: OnAllBasesInitialized\nScripts/Game/Components/Locations/SCR_CampaignMilitaryBaseComponent.c:2357 Function OnAllBasesInitialized");
    expect(r).not.toContain("Division by zero"); // only the first group is shown
    expect(r).toContain(`**crash.log** ${join(dir, "run", "crash.log")}\n\`\`\`\ncrash-line-1\n`);
    expect(r).toContain("Reason: Access violation\n");
    expect(r).toContain("crash-line-1\n");
    expect(r).toContain("crash-line-40\n");
    expect(r).not.toContain("crash-line-41");
  });

  it("a fence inside log text cannot close the code block", () => {
    put("f/crash.log", "a ``` b\n");
    expect(runErrors(join(dir, "f"))).toContain("a ''' b");
  });

  it("markdown in a crash.log reason is shown only inside the code block", () => {
    put("m/crash.log", "Reason: **x** [link](y)\n");
    const [head, inside, tail] = runErrors(join(dir, "m")).split("```");
    expect(head).toBe(`**crash.log** ${join(dir, "m", "crash.log")}\n`);
    expect(inside).toContain("**x** [link](y)");
    expect(tail).toBe("");
  });

  it("gives nothing for a clean folder, an empty folder and a missing folder, and does not throw", () => {
    put("clean/console.log", "12:00:00.000 DEFAULT      : Entered online game state.\r\n12:00:01.000 SCRIPT    (E): Some other error\r\n");
    mkdirSync(join(dir, "empty"));
    expect(runErrors(join(dir, "clean"))).toBe("");
    expect(runErrors(join(dir, "empty"))).toBe("");
    expect(runErrors(join(dir, "missing"))).toBe("");
  });
});
