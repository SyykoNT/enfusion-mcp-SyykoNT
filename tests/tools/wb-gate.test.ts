import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WorkbenchClient } from "../../src/workbench/client.js";
import { registerWbEditorTools } from "../../src/tools/wb-editor.js";
import type { Config } from "../../src/config.js";
import { decodeInt32LE, decodePascalString, encodePascalString } from "../../src/workbench/protocol.js";

type Result = { content: { text: string }[]; isError?: boolean };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

/** Fake Workbench NET API: answers each request with handler(apiFunc, params). */
function mockWorkbench(handler: (apiFunc: string, params: Record<string, unknown>) => unknown) {
  const server = createServer((socket: Socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (c) => chunks.push(c));
    socket.on("end", () => {
      const buf = Buffer.concat(chunks);
      let offset = decodeInt32LE(buf, 0).bytesRead;
      offset += decodePascalString(buf, offset).bytesRead;
      offset += decodePascalString(buf, offset).bytesRead;
      const { APIFunc, ...params } = JSON.parse(decodePascalString(buf, offset).value);
      socket.end(Buffer.concat([encodePascalString("Ok"), encodePascalString(JSON.stringify(handler(APIFunc, params)))]));
    });
  });
  server.listen(0);
  const addr = server.address();
  return {
    port: addr && typeof addr !== "string" ? addr.port : 0,
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

function editorTools(client: WorkbenchClient): Record<string, Handler> {
  const tools: Record<string, Handler> = {};
  const fake = { registerTool: (name: string, _def: unknown, handler: Handler) => { tools[name] = handler; } };
  registerWbEditorTools(fake as unknown as McpServer, client);
  return tools;
}

let mock: ReturnType<typeof mockWorkbench> | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

describe("mode gate on wb_* tools", () => {
  it("wb_save runs in edit mode on a client that never called wb_state", async () => {
    const world = join(mkdtempSync(join(tmpdir(), "emcp-gate-")), "W.ent");
    mock = mockWorkbench((f, p) => {
      if (f === "EMCP_WB_GetState") return { status: "ok", mode: "edit" };
      if (p.action === "worldInfo") return { status: "ok", worldPath: "$T:W.ent", absPath: world };
      writeFileSync(world, "saved");
      return { status: "ok", saved: true };
    });
    const result = await editorTools(new WorkbenchClient("127.0.0.1", mock.port)).wb_save({});
    expect(result.isError).toBeUndefined();
  });

  it("wb_save during play is an error that names wb_stop", async () => {
    mock = mockWorkbench((f) => (f === "EMCP_WB_GetState" ? { status: "ok", mode: "game" } : { status: "ok" }));
    const result = await editorTools(new WorkbenchClient("127.0.0.1", mock.port)).wb_save({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("wb_stop");
  });

  it("wb_stop works right after wb_play with no other call between", async () => {
    let mode = "edit";
    mock = mockWorkbench((f, p) => {
      if (f === "EMCP_WB_GetState") return { status: "ok", mode };
      if (f === "EMCP_WB_EditorControl") mode = p.action === "play" ? "game" : "edit";
      return { status: "ok" };
    });
    const tools = editorTools(new WorkbenchClient("127.0.0.1", mock.port));
    expect((await tools.wb_play({})).isError).toBeUndefined();
    expect((await tools.wb_stop({})).isError).toBeUndefined();
  });

  it("wb_save with Workbench down is an error and starts nothing", async () => {
    const client = new WorkbenchClient("127.0.0.1", 1, {} as Config);
    const launch = vi.spyOn(client, "ensureRunning").mockResolvedValue(undefined);
    const result = await editorTools(client).wb_save({});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not running");
    expect(launch).not.toHaveBeenCalled();
  });
});
