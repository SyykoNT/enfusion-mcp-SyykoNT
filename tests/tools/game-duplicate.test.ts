import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";
import { registerGameDuplicate } from "../../src/tools/game-duplicate.js";

// One rdb record the way 1.8 stores it (same layout as tests/pak/rdb.test.ts).
function record(path: string, guidHex: string): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32LE(path.length + 1);
  return Buffer.concat([len, Buffer.from(path + "\0", "latin1"), Buffer.from([6, 0, 0, 0, 0, 0]), Buffer.from(guidHex, "hex").reverse(), Buffer.alloc(8)]);
}

const root = mkdtempSync(join(tmpdir(), "emcp-gd-"));
const data = join(root, "game", "addons", "data");
mkdirSync(join(data, "Configs"), { recursive: true });
writeFileSync(join(data, "Configs", "Base.conf"), "SCR_Foo {\n}\n");
writeFileSync(join(data, "resourceDatabase.rdb"), Buffer.concat([Buffer.from("FORM\0\0\0\0RDBC"), record("Configs/Base.conf", "E6FC4537B53EA00B")]));
const addon = join(root, "MyAddon");
mkdirSync(addon);
writeFileSync(join(addon, "addon.gproj"), "GameProject {\n ID \"MyAddon\"\n}\n");
const config = { projectPath: join(root, "projects"), gamePath: join(root, "game"), workbenchPath: join(root, "tools") } as Config;

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
let dup!: Handler;
registerGameDuplicate({ registerTool: (_n: string, _d: unknown, h: Handler) => { dup = h; } } as unknown as McpServer, config, {} as WorkbenchClient);

describe("game_duplicate", () => {
  it("refuses a destination at a base-game path", async () => {
    const r = await dup({ sourcePath: "Configs/Base.conf", destPath: "configs/base.conf", projectPath: addon, register: false });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/base-game path[\s\S]*config_override/);
    expect(existsSync(join(addon, "configs"))).toBe(false);
  });

  it("names the .meta from the resolved path, not the raw destPath", async () => {
    const r = await dup({ sourcePath: "Configs/Base.conf", destPath: "./Configs\\Mine.conf", projectPath: addon, register: false });
    expect(r.isError).toBeUndefined();
    expect(readFileSync(join(addon, "Configs", "Mine.conf.meta"), "utf-8")).toMatch(/Name "\{[0-9A-F]{16}\}Configs\/Mine\.conf"/);
    expect(r.content[0].text).toMatch(/Reference it as: `\{[0-9A-F]{16}\}Configs\/Mine\.conf`/);
  });
});
