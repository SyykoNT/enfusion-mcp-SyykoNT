import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WorkbenchClient } from "../../src/workbench/client.js";
import { registerWbReload } from "../../src/tools/wb-reload.js";

describe("wb_reload", () => {
  it("points to ReloadScripts, not to mod compile (which refuses while Workbench is open)", async () => {
    const client = new WorkbenchClient("127.0.0.1", 1);
    client.call = (async () => ({ message: "ok (ExecuteAction=false)" })) as WorkbenchClient["call"];
    let h!: (a: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
    registerWbReload({ registerTool: (_n: string, _d: unknown, f: typeof h) => { h = f; } } as unknown as McpServer, client);
    const r = await h({ target: "scripts" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/ReloadScripts[\s\S]*Reloading game scripts took/);
    expect(r.content[0].text).not.toMatch(/action "compile"/);
  });
});
