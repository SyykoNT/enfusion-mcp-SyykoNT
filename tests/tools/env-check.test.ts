import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";

// No real process query: one Diag server runs, nothing else.
vi.mock("../../src/utils/process.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/utils/process.js")>()),
  findPids: vi.fn(() => []),
  clientProcesses: vi.fn(() => []),
  serverProcesses: vi.fn(() => [{ pid: 7, ppid: 1, cmd: "ArmaReforgerServerDiag.exe -server x", created: 0 }]),
}));
const { registerEnvCheck } = await import("../../src/tools/env-check.js");

type Def = { description: string; inputSchema: Record<string, unknown> };
type Handler = () => Promise<{ content: { text: string }[] }>;
function register(config: Config) {
  let def!: Def;
  let h!: Handler;
  const client = { ping: async () => false } as unknown as WorkbenchClient;
  registerEnvCheck({ registerTool: (_n: string, d: Def, f: Handler) => { def = d; h = f; } } as unknown as McpServer, config, client);
  return { def, h };
}

afterEach(() => { delete process.env.ENFUSION_WORKBENCH_PROFILE; });

describe("env_check", () => {
  it("has no action that rewrites the configured paths", () => {
    const { def } = register({} as Config);
    expect(Object.keys(def.inputSchema)).toEqual([]);
    expect(def.description).not.toMatch(/'configure'/);
  });

  it("reads the version from the Workbench profile logs and sees the Diag server", async () => {
    const root = mkdtempSync(join(tmpdir(), "emcp-env-"));
    const log = join(root, "Workbench", "logs", "logs_2026-10-31_12-05-39");
    mkdirSync(log, { recursive: true });
    writeFileSync(join(log, "console.log"), "12:06:16.372   INIT         : Creating game instance(ArmaReforgerScripted), version 1.8.0.13 built 2026-08-21 14:30:18 UTC.\n");
    process.env.ENFUSION_WORKBENCH_PROFILE = join(root, "Workbench");
    const p = join(root, "projects");
    const { h } = register({ gamePath: join(root, "game"), workbenchPath: join(root, "tools"), serverPath: join(root, "server"), steamcmdPath: join(root, "sc"), projectPath: p, packedPath: join(root, "packed"), serverProfilePath: join(root, "sp"), workbenchHost: "127.0.0.1", workbenchPort: 5775 } as Config);
    const text = (await h()).content[0].text;
    expect(text).toContain("(v1.8.0.13)");
    expect(text).toContain("- Dedicated server: yes");
  });
});
