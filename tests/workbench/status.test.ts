import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkbenchClient } from "../../src/workbench/client.js";
import { formatConnectionStatus, ensureMode, portOwnerLines } from "../../src/workbench/status.js";
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

  // B-013: the gate reads the state itself (22e2bee, 489ed99); a refusal never says "mode unknown, run wb_state".
  it("reads the state itself: a fresh client knows no mode until the gate's own query, which records it", async () => {
    const client = clientInMode("edit");
    expect(client.state.mode).toBe("unknown");
    expect(await ensureMode(client, "edit", "create entity")).toBeNull();
    expect(client.state.mode).toBe("edit");
  });

  it("when the state query fails, the refusal says why", async () => {
    mock = createMockWorkbench(() => { throw new Error("Undefined API func"); });
    const noHandlers = await ensureMode(new WorkbenchClient("127.0.0.1", mock.port), "edit", "save");
    expect(noHandlers).toBe("Cannot save: the MCP handlers are not loaded in this Workbench; run wb_diagnose.");
    await mock.close();
    mock = createMockWorkbench((apiFunc) => (apiFunc === "EMCP_WB_GetState" ? { status: "error", message: "boom" } : {}));
    const failed = await ensureMode(new WorkbenchClient("127.0.0.1", mock.port), "edit", "save");
    expect(failed).toBe("Cannot save: could not read the Workbench mode; run wb_diagnose.");
    expect(failed).not.toContain("wb_state");
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

  it("on a timeout, adds the automatic watch check's line", async () => {
    const client = new WorkbenchClient("127.0.0.1", 1, { autoWatch: true } as Config);
    vi.spyOn(client, "probeMode").mockResolvedValue("timeout");
    client.watchCheck = async () => ({ ok: true, text: "Workbench PID 19524 is watched by watcher PID 600." });
    const result = await ensureMode(client, "edit", "save");
    expect(result).toContain("Cannot save: Workbench did not answer within 3 s");
    expect(result).toContain("\nWatchdog: Workbench PID 19524 is watched by watcher PID 600.\n");
    expect(result).toContain("ask the user to check Workbench");
  });

  it("on a timeout, a check that never settles is named and the refusal still arrives; with the watch off there is no line", async () => {
    const client = new WorkbenchClient("127.0.0.1", 1, { autoWatch: true } as Config);
    vi.spyOn(client, "probeMode").mockResolvedValue("timeout");
    client.watchCheck = () => new Promise(() => {});
    client.watchWaitMs = 50;
    expect(await ensureMode(client, "edit", "save")).toContain("Watchdog: the watch check did not finish in 0.05 s");
    const off = new WorkbenchClient("127.0.0.1", 1, { autoWatch: false } as Config);
    vi.spyOn(off, "probeMode").mockResolvedValue("timeout");
    expect(await ensureMode(off, "edit", "save")).not.toContain("Watchdog");
  });
});

describe("formatConnectionStatus: a Workbench that does not hold the NET API port", () => {
  const dir = mkdtempSync(join(tmpdir(), "emcp-status-owner-"));
  const state = (pid: number, extra: Record<string, unknown>) =>
    writeFileSync(join(dir, `${pid}.json`), JSON.stringify({ pid, watcherPid: process.pid, owned: false, state: "ok", since: 0, lastLines: [], actions: [], dismiss: "watched", autoRecover: false, updated: 0, ...extra }));
  const footer = () => formatConnectionStatus(new WorkbenchClient("127.0.0.1", 5775), dir);

  it("names the PID that answers, only for a live state whose owner differs", () => {
    state(100, { portOwner: 200 });
    expect(footer()).toContain("Workbench PID 100 does not hold NET API port 5775; PID 200 answers it.");
    for (const extra of [{ portOwner: 100 }, { portOwner: null }, {}, { state: "exited", portOwner: 200 }]) {
      state(100, extra);
      expect(footer()).not.toContain("does not hold");
    }
  });

  it("gives no line when the watcher of the state is dead", () => {
    state(100, { portOwner: 200 });
    expect(portOwnerLines(dir, 5775, () => true)).toContain("does not hold");
    expect(portOwnerLines(dir, 5775, () => false)).toBe("");
  });
});
