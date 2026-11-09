import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Socket } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WorkbenchClient, WorkbenchError } from "../../src/workbench/client.js";
import { formatDialogs, type DialogProbe, type WinInfo } from "../../src/watchdog/signals.js";
import { registerWbEditorTools } from "../../src/tools/wb-editor.js";
import { decodeInt32LE, decodePascalString, encodePascalString } from "../../src/workbench/protocol.js";

type Result = { content: { text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

/** Fake Workbench NET API (same as in wb-save.test.ts): answers with handler(apiFunc, params); undefined means never answer. */
function mockWorkbench(handler: (apiFunc: string, params: Record<string, unknown>) => unknown) {
  const open = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket: Socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    const chunks: Buffer[] = [];
    socket.on("data", (c) => chunks.push(c));
    socket.on("end", () => {
      const buf = Buffer.concat(chunks);
      let offset = decodeInt32LE(buf, 0).bytesRead;
      offset += decodePascalString(buf, offset).bytesRead;
      offset += decodePascalString(buf, offset).bytesRead;
      const { APIFunc, ...params } = JSON.parse(decodePascalString(buf, offset).value);
      const answer = handler(APIFunc, params);
      if (answer !== undefined) socket.end(Buffer.concat([encodePascalString("Ok"), encodePascalString(JSON.stringify(answer))]));
    });
  });
  server.listen(0);
  const addr = server.address();
  return {
    port: addr && typeof addr !== "string" ? addr.port : 0,
    close: () => new Promise<void>((res) => {
      server.close(() => res());
      for (const s of open) s.destroy();
    }),
  };
}

let mock: ReturnType<typeof mockWorkbench> | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

function setup(handler: (apiFunc: string, params: Record<string, unknown>) => unknown) {
  mock = mockWorkbench(handler);
  const client = new WorkbenchClient("127.0.0.1", mock.port);
  const tools: Record<string, { description: string; run: Handler }> = {};
  registerWbEditorTools(
    { registerTool: (n: string, d: { description: string }, h: Handler) => (tools[n] = { description: d.description, run: h }) } as unknown as McpServer,
    client
  );
  return { client, tool: tools.wb_open_resource };
}

describe("wb_open_resource", () => {
  it("the description warns about the Loading world dialog and says to wb_save first", () => {
    const { description } = setup(() => undefined).tool;
    expect(description).toContain("\"Loading world\"");
    expect(description).toContain("Run wb_save first");
  });

  it("a timeout tells the user the Loading world dialog is probably waiting", async () => {
    const t = setup(() => undefined);
    // Shorten the default 10 s timeout for the test.
    const call = t.client.call.bind(t.client);
    vi.spyOn(t.client, "call").mockImplementation((f, p, o) => call(f, p, { ...o, timeout: 300 }));
    const r = await t.tool.run({ path: "Worlds/Other.ent" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Error opening resource:");
    expect(r.content[0].text).toContain("A timeout here usually means Workbench is showing the \"Loading world\" dialog");
    expect(r.content[0].text).toContain("use wb_save before opening another world");
  });

  it("the Loading world hint is only for .ent paths and only when no other dialog was named", async () => {
    const t = setup(() => undefined);
    // Built the way client.ts builds a TIMEOUT: probe result, its formatted text, the structured probe
    const timeout = (dialogs: DialogProbe[]) =>
      vi.spyOn(t.client, "call").mockRejectedValue(new WorkbenchError(["timed out", formatDialogs(dialogs)].join("\n"), "TIMEOUT", dialogs));
    const win = (text: string, cls: string): WinInfo => ({ hwnd: 1, cls, text });
    const hinted = async (path: string) => (await t.tool.run({ path })).content[0].text.includes("usually means");

    timeout([{ pid: 1, dialogs: [] }]);
    expect(await hinted("Prefabs/X.et")).toBe(false);
    expect(await hinted("Worlds/Other.ent")).toBe(true);
    timeout([{ pid: 1, dialogs: [win("Script Authorization Required", "#32770")] }]);
    expect(await hinted("Worlds/Other.ent")).toBe(false);
    timeout([{ pid: 1, dialogs: [win("Loading world", "Qt683QWindowIcon")] }]);
    expect(await hinted("Worlds/Other.ent")).toBe(true);
    expect(await hinted("Prefabs/X.et")).toBe(false);
  });

  it("another error carries no dialog hint", async () => {
    const t = setup(() => ({ status: "error", message: "Workbench could not open: X.ent" }));
    const r = await t.tool.run({ path: "X.ent" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).not.toContain("Loading world");
  });
});
