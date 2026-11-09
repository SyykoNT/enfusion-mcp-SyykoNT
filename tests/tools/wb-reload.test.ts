import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WorkbenchClient, WorkbenchError } from "../../src/workbench/client.js";
import { decodeResponse, encodePascalString } from "../../src/workbench/protocol.js";
import { notifyFailure, registerWbReload, reloadScripts } from "../../src/tools/wb-reload.js";

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
// What the client throws for a bare Ok (ReloadScripts' documented answer): the real decoder's error, wrapped as client.ts wraps it.
const bareOk = (buf: Buffer) => () => {
  try { decodeResponse(buf); } catch (e) { throw new WorkbenchError((e as Error).message, "API_ERROR"); }
  throw new Error("decodeResponse accepted a bare Ok");
};
const okEmpty = bareOk(Buffer.concat([encodePascalString("Ok"), encodePascalString("")]));
const okNoPayload = bareOk(encodePascalString("Ok"));
const okNoBody = okEmpty;

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

  it.each([["empty payload", okEmpty], ["no payload", okNoPayload]])("a bare Ok with %s, as the real decoder reports it, is success", async (_n, bare) => {
    const r = await setup(bare).run("scripts");
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("**ReloadScripts answered Ok**");
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
    expect(r.content[0].text).toContain("Workbench did not confirm the menu action Plugins > Reload.");
    expect(r.content[0].text).not.toContain("ReloadScripts");
  });

  it("the description says the plugin reload tries one menu action, never several", () => {
    let description = "";
    registerWbReload({ registerTool: (_n: string, d: { description: string }) => { description = d.description; } } as unknown as McpServer, new WorkbenchClient("127.0.0.1", 1));
    expect(description).toContain("one menu action, Plugins > Reload,");
    expect(description).not.toMatch(/menu actions/);
  });

  it("both sends ReloadScripts, then the plugins handler", async () => {
    const t = setup((f) => (f === "ReloadScripts" ? okNoBody() : { status: "ok", message: "Plugins: reload triggered (ExecuteAction=true)" }));
    const r = await t.run("both");
    expect(t.call.mock.calls.map((c) => c[0])).toEqual(["ReloadScripts", "EMCP_WB_Reload"]);
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toContain("**ReloadScripts answered Ok**");
    expect(r.content[0].text).toContain("**Plugin reload triggered**");
  });

  it("both keeps the ReloadScripts part when the plugins step throws", async () => {
    const r = await setup((f) => { if (f === "ReloadScripts") return okNoBody(); throw new WorkbenchError("Workbench error: handler missing", "API_ERROR"); }).run("both");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("**ReloadScripts answered Ok**");
    expect(r.content[0].text).toContain("\n\nPlugin reload failed: Workbench error: handler missing");
    expect(r.content[0].text).not.toContain("Error reloading");
    expect(r.content[0].text).not.toContain("Plugins were not tried");
  });

  it("both says plugins were not tried when the scripts step fails", async () => {
    const t = setup(() => { throw new WorkbenchError("Workbench error: Compilation failed", "API_ERROR"); });
    const r = await t.run("both");
    expect(t.call.mock.calls.map((c) => c[0])).toEqual(["ReloadScripts"]);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Compilation failed");
    expect(r.content[0].text).toContain("Compilation failed\n\nPlugins were not tried.");
    expect(r.content[0].text).toContain("Error reloading: Workbench error: Compilation failed");
  });

  it("plugins alone does not claim a scripts step it never ran", async () => {
    const r = await setup(() => { throw new WorkbenchError("Workbench error: handler missing", "API_ERROR"); }).run("plugins");
    expect(r.content[0].text).not.toMatch(/Plugins were not tried|ReloadScripts answered|Plugin reload failed/);
    expect(r.content[0].text).toContain("Error reloading: Workbench error: handler missing");
  });
});

describe("notifyFailure (the tuning server's reply when its post-write call throws)", () => {
  // The page's own rule (the `reached` line in tuner.html's writeChanges), read from the file so the two cannot drift.
  const html = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../src/tuning-server/public/tuner.html"), "utf8");
  const reached = new Function("wb", `return ${html.match(/const reached = (.*);/)![1]}`) as (wb: string) => boolean;
  const warns = (s: string) => !reached(s);

  it("a Workbench API error says Workbench answered, not that it is unreachable, and still warns", () => {
    const s = notifyFailure(new WorkbenchError("Workbench error: Compilation failed", "API_ERROR"));
    expect(s).toContain("Workbench answered: Compilation failed.");
    expect(s).toContain("the tuner was not notified that Workbench loaded the change");
    expect(s).not.toContain("not reachable");
    expect(warns(s)).toBe(true);
  });

  it("an API error message that ends in a period does not get a second one", () => {
    const s = notifyFailure(new WorkbenchError("Workbench error: Compilation failed.", "API_ERROR"));
    expect(s).toContain("Workbench answered: Compilation failed. The file");
  });

  it("a timeout says Workbench may still be working and still warns", () => {
    const s = notifyFailure(new WorkbenchError('Workbench call "ReloadScripts" timed out after 180000ms', "TIMEOUT"));
    expect(s).toContain("Workbench may still be working on it; check console.log.");
    expect(s).toContain("the tuner was not notified that Workbench loaded the change");
    expect(s).not.toContain("not reachable");
    expect(s).not.toContain("reload it manually");
    expect(warns(s)).toBe(true);
  });

  it("a failed connection says not reachable and still warns", () => {
    const s = notifyFailure(new WorkbenchError("connect ECONNREFUSED 127.0.0.1:5775", "CONNECTION_REFUSED"));
    expect(s).toContain("Workbench not reachable (connect ECONNREFUSED 127.0.0.1:5775).");
    expect(warns(s)).toBe(true);
  });
});

describe("reloadScripts (shared with the tuning server's post-write reload)", () => {
  const stub = (answer: () => unknown) => {
    const call = vi.fn(async (_f: string, _p?: unknown, _o?: unknown) => answer());
    return { call, client: { call } as unknown as Pick<WorkbenchClient, "call"> };
  };

  it("calls the built-in ReloadScripts with the long timeout and returns the console.log confirmation note", async () => {
    const s = stub(okEmpty);
    const note = await reloadScripts(s.client);
    expect(s.call.mock.calls).toEqual([["ReloadScripts", {}, { timeout: 180_000 }]]);
    expect(note).toContain('"Reloading game scripts took" line in Workbench\'s console.log');
  });

  it("accepts the no-payload Ok and rethrows every other failure", async () => {
    await expect(reloadScripts(stub(okNoPayload).client)).resolves.toBeTypeOf("string");
    await expect(reloadScripts(stub(() => { throw new WorkbenchError("Workbench error: Compilation failed", "API_ERROR"); }).client)).rejects.toThrow("Compilation failed");
  });
});
