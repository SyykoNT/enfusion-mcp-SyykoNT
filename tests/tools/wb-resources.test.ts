import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWbResources } from "../../src/tools/wb-resources.js";

type Reply = { content: { text: string }[]; isError?: boolean };

function setup(message: string) {
  const call = vi.fn(async () => ({ status: "ok", message }));
  const client = { state: { connected: true, mode: "edit" }, probeMode: vi.fn(async () => "edit"), call };
  let h!: (a: Record<string, unknown>) => Promise<Reply>;
  registerWbResources({ registerTool: (_n: string, _d: unknown, f: typeof h) => { h = f; } } as unknown as McpServer, client as never);
  return h;
}

describe("wb_resources rebuild", () => {
  it("says the rebuild was requested and that the result is only in console.log, once", async () => {
    const msg = "Rebuild requested for: Prefabs/A.et. Workbench reports the result only in console.log.";
    const text = (await setup(msg)({ action: "rebuild", path: "Prefabs/A.et" })).content[0].text;
    expect(text).toContain("**Rebuild requested for: Prefabs/A.et. Workbench reports the result only in console.log.**");
    expect(text).not.toMatch(/Rebuilt/);
    expect(text.split("only in console.log").length).toBe(2);
  });

  it("register still shows the handler message", async () => {
    const r = await setup("done")({ action: "register", path: "Prefabs/A.et" });
    expect(r.content[0].text).toContain("**Registered resource: Prefabs/A.et**\n\ndone");
  });
});
