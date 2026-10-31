import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkbenchClient } from "../../src/workbench/client.js";
import { formatConnectionStatus, ensureMode } from "../../src/workbench/status.js";
import type { Config } from "../../src/config.js";
import { encodePascalString, decodePascalString, decodeInt32LE } from "../../src/workbench/protocol.js";

function createMockWorkbench(
  handler: (apiFunc: string, params: Record<string, unknown>) => unknown
): { server: Server; port: number; close: () => Promise<void> } {
  const server = createServer((socket: Socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => {
      try {
        const buf = Buffer.concat(chunks);
        let offset = 0;
        const { bytesRead: b0 } = decodeInt32LE(buf, offset);
        offset += b0;
        const { bytesRead: b1 } = decodePascalString(buf, offset);
        offset += b1;
        const { bytesRead: b2 } = decodePascalString(buf, offset);
        offset += b2;
        const { value: payload } = decodePascalString(buf, offset);
        const parsed = JSON.parse(payload);
        const { APIFunc, ...params } = parsed;
        const response = handler(APIFunc, params);
        const statusBuf = encodePascalString("Ok");
        const payloadBuf = encodePascalString(JSON.stringify(response));
        socket.end(Buffer.concat([statusBuf, payloadBuf]));
      } catch (e) {
        const errBuf = encodePascalString(`Error: ${String(e)}`);
        socket.end(errBuf);
      }
    });
  });

  let resolvedPort = 0;
  server.listen(0);
  const addr = server.address();
  if (addr && typeof addr !== "string") {
    resolvedPort = addr.port;
  }

  return {
    server,
    port: resolvedPort,
    close: () => new Promise((res) => server.close(() => res())),
  };
}

describe("formatConnectionStatus", () => {
  // An empty temp watch dir: a real watcher reporting trouble on this PC must not change the footer text.
  const noWatch = mkdtempSync(join(tmpdir(), "emcp-status-watch-"));

  it("shows disconnected for fresh client", () => {
    const client = new WorkbenchClient("127.0.0.1", 1);
    const status = formatConnectionStatus(client, noWatch);
    expect(status).toContain("disconnected");
  });

  it("shows edit mode after call with mode=edit", async () => {
    const mock = createMockWorkbench(() => ({ mode: "edit" }));
    const client = new WorkbenchClient("127.0.0.1", mock.port);
    await client.call("EMCP_WB_Ping");
    const status = formatConnectionStatus(client, noWatch);
    expect(status).toContain("edit mode");
    await mock.close();
  });

  it("shows play mode after call with mode=play", async () => {
    const mock = createMockWorkbench(() => ({ mode: "play" }));
    const client = new WorkbenchClient("127.0.0.1", mock.port);
    await client.call("EMCP_WB_Ping");
    const status = formatConnectionStatus(client, noWatch);
    expect(status).toContain("play mode");
    await mock.close();
  });

  it("shows connected (mode unknown) when no mode in response", async () => {
    const mock = createMockWorkbench(() => ({ status: "ok" }));
    const client = new WorkbenchClient("127.0.0.1", mock.port);
    await client.call("ReloadScripts");
    const status = formatConnectionStatus(client, noWatch);
    expect(status).toContain("mode unknown");
    await mock.close();
  });
});

describe("ensureMode", () => {
  let mock: ReturnType<typeof createMockWorkbench> | undefined;
  afterEach(async () => {
    await mock?.close();
    mock = undefined;
  });

  function clientInMode(mode: string): WorkbenchClient {
    mock = createMockWorkbench((apiFunc) => (apiFunc === "EMCP_WB_GetState" ? { status: "ok", mode } : {}));
    return new WorkbenchClient("127.0.0.1", mock.port);
  }

  it("passes in edit mode without a prior wb_state", async () => {
    expect(await ensureMode(clientInMode("edit"), "edit", "create entity")).toBeNull();
  });

  it("refuses edit actions during play and names wb_stop", async () => {
    const result = await ensureMode(clientInMode("game"), "edit", "create entity");
    expect(result).toContain("play mode");
    expect(result).toContain("wb_stop");
  });

  it("refuses edit actions with no world open and names wb_open_resource", async () => {
    expect(await ensureMode(clientInMode("no_world"), "edit", "save")).toContain("wb_open_resource");
  });

  it("passes a play action during play", async () => {
    expect(await ensureMode(clientInMode("game"), "play", "stop play mode")).toBeNull();
  });

  it("refuses when Workbench is not running and never launches it", async () => {
    const client = new WorkbenchClient("127.0.0.1", 1, {} as Config);
    const launch = vi.spyOn(client, "ensureRunning").mockResolvedValue(undefined);
    const result = await ensureMode(client, "edit", "save");
    expect(result).toContain("not running on 127.0.0.1:1");
    expect(launch).not.toHaveBeenCalled();
  });
});
