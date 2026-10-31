import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";
import { registerEnvCheck } from "../../src/tools/env-check.js";

describe("env_check", () => {
  it("has no action that rewrites the configured paths", () => {
    let def!: { description: string; inputSchema: Record<string, unknown> };
    registerEnvCheck({ registerTool: (_n: string, d: typeof def) => { def = d; } } as unknown as McpServer, {} as Config, {} as WorkbenchClient);
    expect(Object.keys(def.inputSchema)).toEqual([]);
    expect(def.description).not.toMatch(/'configure'/);
  });
});
