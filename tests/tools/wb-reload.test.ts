import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WorkbenchClient, WorkbenchError } from "../../src/workbench/client.js";
import { registerWbReload } from "../../src/tools/wb-reload.js";

type Reply = { content: { text: string }[]; isError?: boolean };

/** wb_reload with client.call mocked; answer(apiFunc, params) returns the reply or throws. */
function setup(answer: (apiFunc: string, params: Record<string, unknown>) => unknown) {
  const client = new WorkbenchClient("127.0.0.1", 1);
  const call = vi.fn(async (f: string, p: Record<string, unknown> = {}, _o?: unknown) => answer(f, p));
  client.call = call as unknown as WorkbenchClient["call"];
  let h!: (a: Record<string, unknown>) => Promise<Reply>;
  registerWbReload({ registerTool: (_n: string, _d: unknown, f: typeof h) => { h = f; } } as unknown as McpServer, client);
  return { call, run: (target: string) => h({ target }) };
}
// What the decoder throws for the documented "Ok, no body" answer of ReloadScripts.
const okNoBody = () => { throw new WorkbenchError("Workbench error: Ok status with empty payload", "API_ERROR"); };

describe("wb_reload", () => {
  it("scripts sends the built-in ReloadScripts, not the menu handler, and does not claim the reload happened", async () => {
    const t = setup(okNoBody);
    const r = await t.run("scripts");
    expect(t.call).toHaveBeenCalledTimes(1);
    expect(t.call.mock.calls[0][0]).toBe("ReloadScripts");
    expect(t.call.mock.calls[0][2]).toMatchObject({ timeout: 180_000 });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("**ReloadScripts answered Ok**");
    expect(r.content[0].text).toMatch(/"Reloading game scripts took" line in Workbench's console\.log confirms/);
    expect(r.content[0].text).not.toMatch(/Reload Complete|EMCP_WB_Reload/);
  });

  it("a reply with a body is also success", async () => {
    const r = await setup(() => ({})).run("scripts");
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("ReloadScripts answered Ok");
  });

  it("Compilation failed is an error and says nothing about a reload", async () => {
    const r = await setup(() => { throw new WorkbenchError("Workbench error: Compilation failed", "API_ERROR"); }).run("scripts");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Error reloading: Workbench error: Compilation failed");
    expect(r.content[0].text).not.toContain("answered Ok");
  });

  it("a timeout says the reload may still be running", async () => {
    const r = await setup(() => { throw new WorkbenchError('Workbench call "ReloadScripts" timed out after 180000ms', "TIMEOUT"); }).run("scripts");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("The reload may still be running; check console.log.");
  });

  it("plugins uses only the menu handler and keeps its not-confirmed reply", async () => {
    const t = setup(() => ({ status: "ok", message: "Plugins: reload triggered (ExecuteAction=false)" }));
    const r = await t.run("plugins");
    expect(t.call.mock.calls.map((c) => c[0])).toEqual(["EMCP_WB_Reload"]);
    expect(t.call.mock.calls[0][1]).toEqual({ target: "plugins" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("**Plugin reload not confirmed**");
    expect(r.content[0].text).not.toContain("ReloadScripts");
  });

  it("both sends ReloadScripts, then the plugins handler", async () => {
    const t = setup((f) => (f === "ReloadScripts" ? okNoBody() : { status: "ok", message: "Plugins: reload triggered (ExecuteAction=true)" }));
    const r = await t.run("both");
    expect(t.call.mock.calls.map((c) => c[0])).toEqual(["ReloadScripts", "EMCP_WB_Reload"]);
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("**ReloadScripts answered Ok**");
    expect(r.content[0].text).toContain("**Plugin reload triggered**");
  });
});
