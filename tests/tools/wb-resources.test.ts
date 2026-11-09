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

  it("register reports a false return from RegisterResourceFile as a failure, not as registered", async () => {
    const r = await setup("RegisterResourceFile returned false for: Prefabs/A.et")({ action: "register", path: "Prefabs/A.et" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("**Not registered: Prefabs/A.et**");
    expect(r.content[0].text).not.toMatch(/Registered resource/);
  });

  it("open reports a false return from SetOpenedResource as a failure, not as opened", async () => {
    const r = await setup("SetOpenedResource returned false for: Prefabs/A.et")({ action: "open", path: "Prefabs/A.et" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("**Not opened: Prefabs/A.et**");
    expect(r.content[0].text).not.toMatch(/Opened resource/);
  });

  it("a success whose path contains 'returned false' stays a success for register and open", async () => {
    const reg = await setup("Resource registered: Prefabs/returned false.et")({ action: "register", path: "Prefabs/returned false.et" });
    expect(reg.isError).toBeUndefined();
    expect(reg.content[0].text).toContain("**Registered resource: Prefabs/returned false.et**");
    const open = await setup("Opened resource: Prefabs/returned false.et")({ action: "open", path: "Prefabs/returned false.et" });
    expect(open.isError).toBeUndefined();
    expect(open.content[0].text).toContain("**Opened resource: Prefabs/returned false.et**");
  });
});
