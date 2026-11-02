import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";
import type { WorkbenchClient } from "../../src/workbench/client.js";

// The module reads build-info.json once at load; this stands in for that file (src/build-info.json).
const stamp = vi.hoisted(() => ({ text: "" }));
vi.mock("node:fs", async (importActual) => {
  const actual = await importActual<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: ((p: string, ...rest: unknown[]) =>
      /src[\\/]build-info\.json$/.test(String(p)) ? stamp.text : (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)) as typeof actual.readFileSync,
  };
});
stamp.text = JSON.stringify({ version: "9.9.9", commit: "load111", builtAt: "2026-11-02T10:00:00.000Z" });

// No real process query: one Diag server runs, nothing else.
vi.mock("../../src/utils/process.js", async (importActual) => ({
  ...(await importActual<typeof import("../../src/utils/process.js")>()),
  findPids: vi.fn(() => []),
  clientProcesses: vi.fn(() => []),
  serverProcesses: vi.fn(() => [{ pid: 7, ppid: 1, cmd: "ArmaReforgerServerDiag.exe -server x", created: 0 }]),
}));
const { registerEnvCheck, serverVersion, readBuildInfo, buildInfo } = await import("../../src/tools/env-check.js");

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

  it("reports version+commit from build-info.json, and the plain package version when it is missing or broken", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "..", "package.json"), "utf-8")).version;
    const dir = mkdtempSync(join(tmpdir(), "emcp-bi-"));
    const file = join(dir, "build-info.json");
    writeFileSync(file, JSON.stringify({ version: "0.14.0", commit: "abc1234", builtAt: "2026-11-02T10:00:00.000Z" }));
    expect(serverVersion(readBuildInfo(file))).toBe("0.14.0+abc1234");
    expect(serverVersion(readBuildInfo(join(dir, "missing.json")))).toBe(pkg);
    writeFileSync(file, "{ not json");
    expect(serverVersion(readBuildInfo(file))).toBe(pkg);
  });

  it("keeps the stamp read at load when build-info.json changes afterwards", async () => {
    const root = mkdtempSync(join(tmpdir(), "emcp-env-"));
    process.env.ENFUSION_WORKBENCH_PROFILE = join(root, "Workbench");
    const { h } = register({ gamePath: join(root, "game"), workbenchPath: join(root, "tools"), serverPath: join(root, "server"), steamcmdPath: join(root, "sc"), projectPath: join(root, "projects"), packedPath: join(root, "packed"), serverProfilePath: join(root, "sp"), workbenchHost: "127.0.0.1", workbenchPort: 5775 } as Config);
    stamp.text = JSON.stringify({ version: "9.9.9", commit: "later22", builtAt: "2099-01-01T00:00:00.000Z" });
    const text = (await h()).content[0].text;
    expect(serverVersion(buildInfo)).toBe("9.9.9+load111");
    expect(text).toContain("- MCP build: 9.9.9+load111, built 2026-11-02T10:00:00.000Z");
    expect(text).not.toContain("later22");
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
