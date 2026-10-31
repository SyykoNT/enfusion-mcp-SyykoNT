import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";

vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(() => {
    throw new Error("git not mocked");
  }),
}));
vi.mock("../../src/utils/python.js", () => ({
  findPython: () => ({ cmd: "python", args: [], version: "3.14.2" }),
}));

import { execFile } from "node:child_process";
import {
  parseQaReport,
  parseSynopsis,
  parseResources,
  registerMissionValidate,
} from "../../src/tools/mission-validate.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "../fixtures/mission", name), "utf-8");

describe("parseQaReport", () => {
  const report = parseQaReport(fixture("qa_fail.txt"));

  it("reads the totals line and counts failures", () => {
    expect(report.totals).toEqual({ failures: 3, warnings: 0, worlds: 1 });
    expect(report.items.filter((i) => i.kind === "fail")).toHaveLength(3);
    expect(report.items.filter((i) => i.kind === "warn")).toHaveLength(0);
  });

  it("attaches world and section names", () => {
    const fail = report.items.find((i) => i.kind === "fail")!;
    expect(fail).toEqual({
      world: "Worlds/Testland/Fixture_TVT_Hill.ent",
      section: "Settings",
      kind: "fail",
      text: "Setting Alpha is off while Beta is on",
    });
    expect(report.items.find((i) => i.kind === "info")!.section).toBe("Kit - Red");
  });

  it("keeps an unknown line as other", () => {
    expect(report.items.filter((i) => i.kind === "other").map((i) => i.text)).toEqual(["a line with no known prefix"]);
  });

  it("parses CRLF output the same way", () => {
    expect(parseQaReport(fixture("qa_fail.txt").replace(/\r?\n/g, "\r\n"))).toEqual(report);
  });
});

describe("parseSynopsis", () => {
  const text = fixture("synopsis.txt");
  const syn = parseSynopsis(text);

  it("reads the title and counts ticked checks", () => {
    expect(syn.title).toBe("New Mission | Tester TVT20 Fixture Hill");
    expect(syn.ticked).toBe(5);
    expect(syn.total).toBe(5);
  });

  it("returns the synopsis block verbatim, markers included", () => {
    const start = text.indexOf("<!-- CRF_SYNOPSIS_START -->");
    const end = text.indexOf("<!-- CRF_SYNOPSIS_END -->") + "<!-- CRF_SYNOPSIS_END -->".length;
    expect(syn.synopsis).toBe(text.slice(start, end));
  });

  it("counts an unticked box", () => {
    expect(parseSynopsis(text.replace("- [x] Third", "- [ ] Third"))).toMatchObject({ ticked: 4, total: 5 });
  });
});

describe("parseResources", () => {
  it("reads check headers, indented failures and the totals line", () => {
    const res = parseResources(fixture("resources_fail.txt"));
    expect(res.problems).toBe(3);
    expect(res.checks.map((c) => [c.name, c.ok, c.failures.length])).toEqual([
      ["fixture-dangling", false, 2],
      ["fixture-unattached", true, 0],
      ["fixture-duplicate", false, 1],
    ]);
    expect(parseResources("[  ok] a - b\n\nAll checks passed.\n").problems).toBe(0);
  });
});

// ── Tool handler with a mocked execFile ─────────────────────────────────────

type Result = { content: { text: string }[]; isError?: boolean };
type Handler = (p: Record<string, unknown>) => Promise<Result>;
type Reply = { code?: number | null; killed?: boolean; stdout?: string; stderr?: string };

let root: string;
let crf: string;
let lobby: string;
let handler: Handler;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "emcp-mv-"));
  crf = join(root, "CRF");
  lobby = join(root, "COALITION-Lobby");
  mkdirSync(join(crf, "Tools", "Validation"), { recursive: true });
  writeFileSync(join(crf, "Tools", "Validation", "validate_mission.py"), "");
  mkdirSync(join(crf, "Worlds", "Testland"), { recursive: true });
  writeFileSync(join(crf, "Worlds", "Testland", "Fixture.ent"), "");
  mkdirSync(join(root, "Other", "Worlds"), { recursive: true });
  writeFileSync(join(root, "Other", "Worlds", "Stray.ent"), "");
  mkdirSync(lobby);
  registerMissionValidate(
    { registerTool: (_n: string, _d: unknown, h: Handler) => void (handler = h) } as unknown as McpServer,
    { projectPath: root } as Config
  );
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Answer each script by file name; a non-zero code or killed builds the error execFile would pass. */
function reply(byScript: Record<string, Reply>) {
  vi.mocked(execFile).mockImplementation(((_cmd: string, args: string[], _opts: unknown, cb: Function) => {
    const r = byScript[args.find((a) => a.endsWith(".py"))!.split(/[\\/]/).pop()!];
    const err = r.code || r.killed ? Object.assign(new Error("Command failed"), { code: r.code ?? null, killed: !!r.killed }) : null;
    cb(err, r.stdout ?? "", r.stderr ?? "");
  }) as never);
}

const call = (p: Record<string, unknown>) =>
  handler({ checks: ["qa", "synopsis"], extraRoots: [], verbose: false, ...p });

beforeEach(() => {
  vi.mocked(execFile).mockReset();
});

describe("mission_validate", () => {
  it("runs both scripts like CI and reports the verdict, title and synopsis", async () => {
    reply({
      "validate_mission.py": { code: 1, stdout: fixture("qa_fail.txt") },
      "mission_synopsis.py": { stdout: fixture("synopsis.txt") },
    });
    const r = await call({ world: "Worlds/Testland/Fixture.ent" });
    const text = r.content[0].text;
    expect(r.isError).toBeUndefined();
    expect(text).toContain("**Mission check: Worlds/Testland/Fixture.ent**  FAIL (3 failures, 0 warnings)");
    expect(text).toContain("Title CI will set: New Mission | Tester TVT20 Fixture Hill");
    expect(text).toContain("PR automated checks: 5/5 ticked");
    expect(text).toContain("- [Settings] Briefing \"Red Notes\" is still empty");
    expect(text).toContain("### Not verifiable offline (1)");
    expect(text).toContain("<!-- CRF_SYNOPSIS_START -->");
    expect(text).not.toContain("Red has a leader slot");

    for (const [cmd, args, opts] of vi.mocked(execFile).mock.calls as unknown as [string, string[], { cwd: string }][]) {
      expect(cmd).toBe("python");
      expect(args.slice(0, 4)).toEqual(["-I", "-B", "-X", "utf8"]);
      expect(args.slice(5)).toEqual(["--project", lobby, "--world", join(crf, "Worlds", "Testland", "Fixture.ent")]);
      expect(args).not.toContain("--out-dir");
      expect(args).not.toContain("--pr-json");
      expect(opts.cwd).toBe(crf);
    }
  });

  it("reports exit 2 as an error with the stderr line", async () => {
    reply({
      "validate_mission.py": { code: 2, stderr: "error: project root does not exist: X\n" },
      "mission_synopsis.py": { stdout: fixture("synopsis.txt") },
    });
    const r = await call({ world: "Worlds/Testland/Fixture.ent" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("validate_mission.py exited with code 2: error: project root does not exist: X");
  });

  it("reports a Python crash as an error even though it exits 1", async () => {
    reply({
      "validate_mission.py": { code: 1, stderr: "Traceback (most recent call last):\n  File \"x\"\nKeyError: 'y'\n" },
    });
    const r = await call({ world: "Worlds/Testland/Fixture.ent", checks: ["qa"] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("exited with code 1: KeyError: 'y'");
  });

  it("reports a timeout", async () => {
    reply({ "validate_mission.py": { killed: true } });
    const r = await call({ world: "Worlds/Testland/Fixture.ent", checks: ["qa"] });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("validate_mission.py did not finish in 120 s.");
  });

  it("refuses a world outside the CRF clone without running anything", async () => {
    const r = await call({ world: join(root, "Other", "Worlds", "Stray.ent") });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("World must be inside the CRF clone");
    expect(execFile).not.toHaveBeenCalled();
  });
});
