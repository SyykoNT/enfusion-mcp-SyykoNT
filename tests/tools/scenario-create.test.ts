import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../../src/config.js";
import { registerScenarioCreate } from "../../src/tools/scenario-create.js";

// Lets one test fail a late write to check the rollback; every other write goes through.
const failOn = vi.hoisted(() => ({ suffix: "" }));
vi.mock("node:fs", async (orig) => {
  const fs = await orig<typeof import("node:fs")>();
  return {
    ...fs,
    writeFileSync: ((p: string, ...rest: unknown[]) => {
      if (failOn.suffix && String(p).endsWith(failOn.suffix)) throw new Error("disk full");
      return (fs.writeFileSync as (...a: unknown[]) => void)(p, ...rest);
    }) as typeof fs.writeFileSync,
  };
});

type Result = { content: { text: string }[]; isError?: boolean };
const root = mkdtempSync(join(tmpdir(), "emcp-sc-"));
const config = { ...loadConfig(), projectPath: join(root, "projects"), addonsDir: undefined, protectedAddons: [] };
let create!: (args: Record<string, unknown>) => Promise<Result>;
registerScenarioCreate({ registerTool: (_n: string, _d: unknown, h: typeof create) => { create = h; } } as unknown as McpServer, config);

function addon(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir);
  writeFileSync(join(dir, "addon.gproj"), `GameProject {\n ID "${name}"\n GUID "1234567890ABCDEF"\n}\n`);
  return dir;
}
const args = (projectPath: string) => ({
  scenarioName: "ScnT", worldName: "Arland", projectPath,
  bases: [{ name: "BaseAlpha", position: "1000 0 2000", faction: "US", type: "MOB" }],
});

describe("scenario_create_conflict world files", () => {
  it("writes the .ent in Workbench's shape and a .ent.meta with a 16-hex GUID and its own path", async () => {
    const dir = addon("A1");
    const r = await create(args(dir));
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("Worlds/ScnT.ent.meta");
    expect(readFileSync(join(dir, "Worlds", "ScnT.ent"), "utf-8")).toContain("Layer default {");
    const meta = readFileSync(join(dir, "Worlds", "ScnT.ent.meta"), "utf-8");
    expect(meta).toMatch(/^MetaFileClass \{\n Name "\{[0-9A-F]{16}\}Worlds\/ScnT\.ent"\n/);
    expect(meta).toContain("ENTResourceClass HEADLESS : PC");
  });

  it("refuses when the .ent.meta already exists and writes nothing else", async () => {
    const dir = addon("A2");
    mkdirSync(join(dir, "Worlds"));
    writeFileSync(join(dir, "Worlds", "ScnT.ent.meta"), "keep");
    const r = await create(args(dir));
    expect(r.content[0].text).toMatch(/^Files already exist: Worlds\/ScnT\.ent\.meta/);
    expect(readFileSync(join(dir, "Worlds", "ScnT.ent.meta"), "utf-8")).toBe("keep");
    expect(existsSync(join(dir, "Worlds", "ScnT.ent"))).toBe(false);
    expect(existsSync(join(dir, "Missions", "ScnT.conf"))).toBe(false);
    expect(readdirSync(join(dir, "Worlds", "ScnT_Layers"))).toEqual([]);
  });

  it("rolls the .ent.meta back when a later write fails", async () => {
    const dir = addon("A3");
    failOn.suffix = "Defenders.layer";
    const r = await create(args(dir));
    failOn.suffix = "";
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("disk full");
    expect(existsSync(join(dir, "Worlds", "ScnT.ent.meta"))).toBe(false);
    expect(existsSync(join(dir, "Worlds", "ScnT.ent"))).toBe(false);
  });

  it("cleans up", () => {
    rmSync(root, { recursive: true, force: true });
  });
});
