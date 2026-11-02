import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import { WorkbenchClient } from "../../src/workbench/client.js";
import { registerWbLaunch } from "../../src/tools/wb-launch.js";

// A fake home: the "Workshop cache" below is a temp folder, never the real one.
const home = mkdtempSync(join(tmpdir(), "emcp-wh-home-"));
process.env.USERPROFILE = process.env.HOME = home;

const H = join("Scripts", "WorkbenchGame", "EnfusionMCP");
const bundled = fileURLToPath(new URL("../../mod/Scripts/WorkbenchGame/EnfusionMCP", import.meta.url));
const BUNDLED = readdirSync(bundled).filter((f) => f.endsWith(".c"));
const g = (dir: string, ...a: string[]) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.hooksPath=", ...a], { encoding: "utf-8" });

type Result = { content: { text: string }[]; isError?: boolean };
function setup(opts: { git?: boolean; base?: string } = {}) {
  const projects = opts.base ?? join(mkdtempSync(join(tmpdir(), "emcp-wh-")), "projects");
  const addon = join(projects, "Coalition-Reforger-Framework");
  mkdirSync(join(addon, H), { recursive: true });
  writeFileSync(join(addon, "addon.gproj"), `GameProject {\n ID "CRF"\n GUID "5EB3564A02CE294F"\n}\n`);
  writeFileSync(join(addon, H, "SYK_Own.c"), "// the owner's script\n");
  writeFileSync(join(addon, "Mission.conf"), "mission work\n");
  if (opts.git) {
    g(addon, "init", "-q");
    g(addon, "add", "addon.gproj", "Mission.conf");
    g(addon, "commit", "-q", "--no-verify", "-m", "init");
  }
  const config = { projectPath: projects, protectedAddons: ["5EB3564A02CE294F"] } as Config;
  const tools: Record<string, (a: Record<string, unknown>) => Promise<Result>> = {};
  const fake = { registerTool: (n: string, _d: unknown, h: (a: Record<string, unknown>) => Promise<Result>) => { tools[n] = h; } };
  registerWbLaunch(fake as unknown as McpServer, config, new WorkbenchClient("127.0.0.1", 1, config));
  const run = (action: string) => tools.wb_handlers({ action, gprojPath: join(addon, "addon.gproj") });
  const emcp = () => readdirSync(join(addon, H)).filter((f) => f.startsWith("EMCP_"));
  return { addon, run, emcp, tools };
}
// Every file outside .git with its bytes, to prove what changed.
function snap(dir: string, skip = ""): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (f === ".git" || (skip && p.startsWith(skip))) continue;
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p).toString("base64");
    }
  };
  walk(dir);
  return out;
}

describe("wb_handlers on a protected addon", () => {
  it("install writes only the EMCP_* files and the exclude line; other files are untouched; git status stays clean", async () => {
    const s = setup({ git: true });
    const others = snap(s.addon, join(s.addon, H));
    const own = readFileSync(join(s.addon, H, "SYK_Own.c"), "utf-8");
    const r = await s.run("install");
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/Handlers installed.*\(protected\): 22 file\(s\) written/);
    expect(r.content[0].text).toMatch(/Added Scripts\/WorkbenchGame\/EnfusionMCP\/ to .*exclude/);
    expect(r.content[0].text).toMatch(/Restart Workbench/);
    expect(s.emcp().sort()).toEqual(BUNDLED.sort());
    expect(readFileSync(join(s.addon, H, "SYK_Own.c"), "utf-8")).toBe(own);
    expect(snap(s.addon, join(s.addon, H))).toEqual(others);
    expect(readFileSync(join(s.addon, ".git", "info", "exclude"), "utf-8")).toMatch(/^Scripts\/WorkbenchGame\/EnfusionMCP\/$/m);
    expect(g(s.addon, "status", "--short")).toBe("");
  });

  it("install replaces stale handlers, leaves unknown EMCP_* files, and a second install writes nothing", async () => {
    const s = setup();
    cpSync(bundled, join(s.addon, H), { recursive: true });
    writeFileSync(join(s.addon, H, "EMCP_WB_Ping.c"), "// old\n");
    writeFileSync(join(s.addon, H, "EMCP_WB_Retired.c"), "// from an older MCP\n");
    const r = await s.run("install");
    expect(r.content[0].text).toMatch(/1 file\(s\) written, 1 stale replaced \(EMCP_WB_Ping\.c\), 21 already current/);
    expect(r.content[0].text).toMatch(/Not touched: .*EMCP_WB_Retired\.c/);
    expect(readFileSync(join(s.addon, H, "EMCP_WB_Ping.c")).equals(readFileSync(join(bundled, "EMCP_WB_Ping.c")))).toBe(true);
    expect(readFileSync(join(s.addon, H, "EMCP_WB_Retired.c"), "utf-8")).toBe("// from an older MCP\n");
    const again = await s.run("install");
    expect(again.content[0].text).toMatch(/0 file\(s\) written, 22 already current/);
    expect(again.content[0].text).not.toMatch(/Restart Workbench/);
  });

  it("install refuses when handler files are committed, and writes nothing", async () => {
    const s = setup({ git: true });
    writeFileSync(join(s.addon, H, "EMCP_WB_Ping.c"), "// committed by mistake\n");
    g(s.addon, "add", "-f", join(H, "EMCP_WB_Ping.c"));
    g(s.addon, "commit", "-q", "--no-verify", "-m", "oops");
    const before = snap(s.addon);
    const exclude = readFileSync(join(s.addon, ".git", "info", "exclude"), "utf-8");
    const r = await s.run("install");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/committed in this repo.*git rm -r --cached/);
    expect(snap(s.addon)).toEqual(before);
    expect(readFileSync(join(s.addon, ".git", "info", "exclude"), "utf-8")).toBe(exclude);
  });

  it("install refuses an addon in a forbidden root (install, Workshop cache or ENFUSION_FORBIDDEN_DIRS)", async () => {
    const denied = mkdtempSync(join(home, "denied-"));
    process.env.ENFUSION_FORBIDDEN_DIRS = denied;
    try {
      const s = setup({ base: join(denied, "projects") });
      const r = await s.run("install");
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/is inside/);
      expect(s.emcp()).toEqual([]);
    } finally {
      delete process.env.ENFUSION_FORBIDDEN_DIRS;
    }
  });

  it("remove deletes only EMCP_* files, keeps other files and the exclude line", async () => {
    const s = setup({ git: true });
    await s.run("install");
    const exclude = readFileSync(join(s.addon, ".git", "info", "exclude"), "utf-8");
    const r = await s.run("remove");
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/22 EMCP_\* file\(s\) deleted/);
    expect(s.emcp()).toEqual([]);
    expect(existsSync(join(s.addon, H, "SYK_Own.c"))).toBe(true);
    expect(readFileSync(join(s.addon, ".git", "info", "exclude"), "utf-8")).toBe(exclude);
  });

  it("status reports current, stale and missing without writing", async () => {
    const s = setup({ git: true });
    cpSync(bundled, join(s.addon, H), { recursive: true });
    writeFileSync(join(s.addon, H, "EMCP_WB_Ping.c"), "// old\n");
    const { rmSync } = await import("node:fs");
    rmSync(join(s.addon, H, "EMCP_WB_Clipboard.c"));
    const before = snap(s.addon);
    const r = await s.run("status");
    expect(r.content[0].text).toMatch(/- current: 20/);
    expect(r.content[0].text).toMatch(/- stale .*: EMCP_WB_Ping\.c/);
    expect(r.content[0].text).toMatch(/- missing: EMCP_WB_Clipboard\.c/);
    expect(r.content[0].text).toMatch(/ignored by git: no; tracked handler files: none/);
    expect(snap(s.addon)).toEqual(before);
  });

  it("refuses a path that is not an existing .gproj", async () => {
    const s = setup();
    const r = await s.tools.wb_handlers({ action: "install", gprojPath: join(s.addon, "Mission.conf") });
    expect(r.isError).toBe(true);
    expect(s.emcp()).toEqual([]);
  });

  it("wb_cleanup still keeps a protected addon's handlers", async () => {
    const s = setup();
    await s.run("install");
    const r = await s.tools.wb_cleanup({ modDir: s.addon });
    expect(r.isError).toBe(true);
    expect(s.emcp()).toHaveLength(22);
  });
});
