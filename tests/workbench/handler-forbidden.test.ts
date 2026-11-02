import { describe, it, expect, vi, afterEach } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";

// No Workbench counts as running; the temp Tools folder has no exe, so nothing is ever spawned.
vi.mock("../../src/utils/process.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/utils/process.js")>()),
  findPids: vi.fn(() => []),
}));
const { WorkbenchClient } = await import("../../src/workbench/client.js");
const { registerWbLaunch } = await import("../../src/tools/wb-launch.js");

const H = join("Scripts", "WorkbenchGame", "EnfusionMCP");
const bundled = fileURLToPath(new URL("../../mod/Scripts/WorkbenchGame/EnfusionMCP", import.meta.url));
type Result = { content: { text: string }[]; isError?: boolean };

afterEach(() => { delete process.env.ENFUSION_FORBIDDEN_DIRS; });

function setup(projects = join(mkdtempSync(join(tmpdir(), "emcp-hf-")), "projects")) {
  const addon = join(projects, "MyAddon");
  mkdirSync(addon, { recursive: true });
  writeFileSync(join(addon, "addon.gproj"), `GameProject {\n ID "MyAddon"\n GUID "3333333333333333"\n}\n`);
  const config = { projectPath: projects, workbenchPath: join(projects, "..", "tools"), protectedAddons: [] as string[] } as Config;
  const client = new WorkbenchClient("127.0.0.1", 1, config);
  const tools: Record<string, (a: Record<string, unknown>) => Promise<Result>> = {};
  registerWbLaunch({ registerTool: (n: string, _d: unknown, h: (a: Record<string, unknown>) => Promise<Result>) => { tools[n] = h; } } as unknown as McpServer, config, client);
  return { addon, client, tools };
}
// A forbidden folder (ENFUSION_FORBIDDEN_DIRS) holding the target of a junction made at the addon's handler folder.
function junctionIntoForbidden(addon: string, withHandlers: boolean) {
  const denied = mkdtempSync(join(tmpdir(), "emcp-hf-denied-"));
  const target = join(denied, "handlers");
  mkdirSync(target);
  if (withHandlers) cpSync(bundled, target, { recursive: true });
  mkdirSync(join(addon, "Scripts", "WorkbenchGame"), { recursive: true });
  symlinkSync(target, join(addon, H), "junction");
  process.env.ENFUSION_FORBIDDEN_DIRS = denied;
  return target;
}

describe("B-027: a junction at the handler folder into a forbidden root", () => {
  it("wb_launch's installer refuses and writes nothing there", async () => {
    const { addon, client } = setup();
    const target = junctionIntoForbidden(addon, false);
    await expect(client.ensureRunning(join(addon, "addon.gproj"))).rejects.toThrow(/is inside .*wb_launch would copy handler scripts/);
    expect(readdirSync(target)).toEqual([]);
  });

  it("wb_cleanup modDir and all=true refuse and delete nothing there", async () => {
    const { addon, tools } = setup();
    const target = junctionIntoForbidden(addon, true);
    const one = await tools.wb_cleanup({ modDir: addon });
    expect(one.isError).toBe(true);
    expect(one.content[0].text).toMatch(/is inside/);
    const all = await tools.wb_cleanup({ all: true });
    expect(all.isError).toBe(true);
    expect(all.content[0].text).toMatch(/Failed \(1\)[\s\S]*is inside/);
    expect(readdirSync(target)).toHaveLength(22);
  });
});

describe("B-028: wb_cleanup on an unprotected addon inside a forbidden root", () => {
  it("refuses and keeps the handler files", async () => {
    const denied = mkdtempSync(join(tmpdir(), "emcp-hf-denied-"));
    const { addon, tools } = setup(join(denied, "projects"));
    cpSync(bundled, join(addon, H), { recursive: true });
    process.env.ENFUSION_FORBIDDEN_DIRS = denied;
    const r = await tools.wb_cleanup({ modDir: addon });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/is inside/);
    expect(readdirSync(join(addon, H))).toHaveLength(22);
  });
});

describe("normal paths are unchanged", () => {
  it("wb_launch installs into an ordinary addon, and wb_cleanup removes them again", async () => {
    const { addon, client, tools } = setup();
    await expect(client.ensureRunning(join(addon, "addon.gproj"))).rejects.toThrow(/Cannot find/); // handlers copied, then no exe
    expect(readdirSync(join(addon, H)).filter((f) => f.startsWith("EMCP_"))).toHaveLength(22);
    const r = await tools.wb_cleanup({ modDir: addon });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/Cleanup Complete/);
    expect(existsSync(join(addon, H))).toBe(false);
  });

  it("wb_cleanup on an addon without handlers still says nothing to do", async () => {
    const { addon, tools } = setup();
    rmSync(join(addon, "Scripts"), { recursive: true, force: true });
    const r = await tools.wb_cleanup({ modDir: addon });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/No Cleanup Needed/);
  });
});
