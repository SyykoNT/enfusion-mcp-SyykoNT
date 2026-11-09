import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import type { SearchEngine } from "../../src/index/search-engine.js";
import type { PatternLibrary } from "../../src/patterns/loader.js";
import { buildTestPak } from "../pak/test-pak.js";

// No real Workbench: compile and pack are stubbed, and no Workbench counts as running
vi.mock("../../src/workbench/cli.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/workbench/cli.js")>()),
  compileAddon: vi.fn(),
  packAddon: vi.fn(),
}));
vi.mock("../../src/utils/process.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/utils/process.js")>()),
  findPids: vi.fn(() => []),
  workbenchCommandLines: vi.fn(() => [{ pid: 123, gproj: "C:\\Other\\addon.gproj" }]),
}));
const cli = await import("../../src/workbench/cli.js");
const proc = await import("../../src/utils/process.js");
const { registerMod } = await import("../../src/tools/mod.js");

type Result = { content: { text: string }[]; isError?: boolean };
const root = mkdtempSync(join(tmpdir(), "emcp-mp-"));
const projects = join(root, "projects");
const gproj = `GameProject {\n ID "MyAddon"\n GUID "1111111111111111"\n}\n`;
const addon = (name: string) => {
  mkdirSync(join(projects, name), { recursive: true });
  writeFileSync(join(projects, name, "addon.gproj"), gproj);
  return join(projects, name);
};
const clean = addon("Clean");
const withHandlers = addon("WithHandlers");
mkdirSync(join(withHandlers, "Scripts", "WorkbenchGame", "EnfusionMCP"), { recursive: true });
writeFileSync(join(withHandlers, "Scripts", "WorkbenchGame", "EnfusionMCP", "EMCP_WB_Ping.c"), "");
const config = { projectPath: projects, defaultMod: "Clean", packedPath: join(root, "packed"), gamePath: join(root, "game"), workbenchPath: join(root, "tools") } as Config;

let mod!: (args: Record<string, unknown>) => Promise<Result>;
registerMod({ registerTool: (_n: string, _d: unknown, h: typeof mod) => { mod = h; } } as unknown as McpServer, config, {} as SearchEngine, {} as PatternLibrary);

beforeEach(() => {
  vi.mocked(cli.packAddon).mockReset();
});

describe("mod pack refusals", () => {
  it("build and pack need a named addon, even with a default mod set", async () => {
    for (const action of ["build", "pack"]) {
      const r = await mod({ action });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/^Addon not found/);
    }
    expect(cli.compileAddon).not.toHaveBeenCalled();
    expect(cli.packAddon).not.toHaveBeenCalled();
  });

  it("refuses handler files before any Workbench run", async () => {
    const r = await mod({ action: "build", addonName: "WithHandlers" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/1 MCP handler file\(s\).*EMCP_WB_Ping\.c.*allowHandlers=true/);
    expect(cli.compileAddon).not.toHaveBeenCalled();
  });

  it("refuses an output folder inside the addon or the projects folder and creates nothing", async () => {
    for (const outputPath of [join(clean, "out"), join(projects, "Clean_packed")]) {
      const r = await mod({ action: "pack", addonName: "Clean", outputPath });
      expect(r.isError).toBe(true);
      expect(existsSync(outputPath)).toBe(false);
    }
    expect(cli.packAddon).not.toHaveBeenCalled();
  });

  it("names the open Workbench and the lock owner instead of telling the caller to close it", async () => {
    const lock = join(root, "WORKBENCH_LOCK.txt");
    writeFileSync(lock, "\uFEFFowner: Session A (test)\npid: 123\n");
    vi.mocked(proc.findPids).mockReturnValueOnce([123]);
    process.env.ENFUSION_WORKBENCH_LOCK = lock;
    try {
      const r = await mod({ action: "compile", addonName: "Clean" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/PID 123 \(C:\\Other\\addon\.gproj\)\. Lock owner: Session A \(test\)\..*If this MCP session started it, close it with wb_close; otherwise ask the user or the lock owner, or wait/);
      expect(cli.compileAddon).not.toHaveBeenCalled();
    } finally {
      delete process.env.ENFUSION_WORKBENCH_LOCK;
    }
  });
});

describe("mod pack result", () => {
  it("adds a JSON block with files and the pak listing", async () => {
    vi.mocked(cli.packAddon).mockImplementation(async (_c, _g, outDir) => {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "data.pak"), buildTestPak([{ path: "Configs/X.conf", content: "abc", compress: false }]));
      writeFileSync(join(outDir, "addon.gproj"), gproj);
      return { ok: true, outDir, files: ["data.pak", "addon.gproj"], errors: [], run: { exitCode: 0, timedOut: false, seconds: 1, logDir: null, console: "" } };
    });
    const r = await mod({ action: "pack", addonName: "Clean" });
    expect(r.isError).toBeUndefined();
    const json = JSON.parse(/```json\n(.+)\n```/.exec(r.content[0].text)![1]);
    expect(json).toMatchObject({
      action: "pack",
      ok: true,
      addon: { id: "MyAddon", guid: "1111111111111111" },
      outDir: join(root, "packed", "MyAddon"),
      pak: { entries: 1, bytes: 3, byTopFolder: { Configs: 1 }, handlerEntries: 0 },
    });
    expect(json.files.map((f: { name: string }) => f.name)).toEqual(["data.pak", "addon.gproj"]);
  });
});

describe("crash folders saved before a headless run (B-044)", () => {
  const run = (savedCrashes?: string) => ({ exitCode: 0, timedOut: false, seconds: 1, logDir: null, console: "", ...(savedCrashes ? { savedCrashes } : {}) });
  const line = "Saved 2 crash folder(s) to C:\Crash Logs";

  it("compile and pack results carry the line once when something was saved, and nothing otherwise", async () => {
    vi.mocked(cli.compileAddon).mockResolvedValue({ ok: true, run: run(line), errors: [], warnings: [] });
    const compiled = (await mod({ action: "compile", addonName: "Clean" })).content[0].text;
    expect(compiled.split(line).length - 1).toBe(1);
    vi.mocked(cli.compileAddon).mockResolvedValue({ ok: true, run: run(), errors: [], warnings: [] });
    expect((await mod({ action: "compile", addonName: "Clean" })).content[0].text).not.toContain("crash folder");

    vi.mocked(cli.packAddon).mockImplementation(async (_c, _g, outDir) => ({ ok: true, outDir, files: [], errors: [], run: run(line) }));
    const packed = (await mod({ action: "pack", addonName: "Clean" })).content[0].text;
    expect(packed.split(line).length - 1).toBe(1);
    vi.mocked(cli.packAddon).mockImplementation(async (_c, _g, outDir) => ({ ok: true, outDir, files: [], errors: [], run: run() }));
    expect((await mod({ action: "pack", addonName: "Clean" })).content[0].text).not.toContain("crash folder");
  });
});
