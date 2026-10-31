import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import { registerServer } from "../../src/tools/server.js";

const root = mkdtempSync(join(tmpdir(), "emcp-srv-"));
const config = {
  projectPath: join(root, "projects"),
  gamePath: join(root, "game"),
  workbenchPath: join(root, "tools"),
  serverPath: join(root, "server"),
  steamcmdPath: join(root, "steamcmd"),
  serverProfilePath: join(root, "profile"),
  packedPath: join(root, "packed"),
} as Config;
mkdirSync(config.gamePath, { recursive: true });

type Handler = (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
let tool!: Handler;
registerServer({ registerTool: (_n: string, _d: unknown, h: Handler) => { tool = h; } } as unknown as McpServer, config);

describe("server config", () => {
  it("writes the MCP's own server.json, also over an earlier one", async () => {
    expect((await tool({ action: "config", name: "A" })).isError).toBeFalsy();
    expect((await tool({ action: "config", name: "B" })).isError).toBeFalsy();
    expect(JSON.parse(readFileSync(join(config.serverProfilePath, "server.json"), "utf-8")).game.name).toBe("B");
  });

  it("writes a new file at configPath", async () => {
    const p = join(root, "new", "server.json");
    expect((await tool({ action: "config", configPath: p })).isError).toBeFalsy();
    expect(existsSync(p)).toBe(true);
  });

  it("never overwrites another existing server.json (config or start)", async () => {
    const p = join(root, "mine.json");
    writeFileSync(p, "{\"mine\":true}");
    for (const action of ["config", "start"]) {
      const r = await tool({ action, configPath: p, scenarioId: "{ECC61978EDCC2B5A}Missions/23_Campaign.conf" });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toMatch(/not written.*already exists/);
    }
    expect(readFileSync(p, "utf-8")).toBe("{\"mine\":true}");
  });

  it("refuses a new file inside the game install", async () => {
    const p = join(config.gamePath, "server.json");
    const r = await tool({ action: "config", configPath: p });
    expect(r.content[0].text).toMatch(/not written.*is inside/);
    expect(existsSync(p)).toBe(false);
  });
});
