import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkbenchClient, WorkbenchError, buildLaunchArgs } from "../../src/workbench/client.js";
import type { Config } from "../../src/config.js";
import { ensureWatched } from "../../src/watchdog/auto-attach.js";
import { logger } from "../../src/utils/logger.js";
import {
  decodePascalString,
  decodeInt32LE,
  encodePascalString,
} from "../../src/workbench/protocol.js";

/**
 * Create a mock Workbench NET API server that:
 * 1. Reads the full request
 * 2. Parses the APIFunc from the payload
 * 3. Calls the handler to produce a response
 * 4. Sends the response as a Pascal string and closes
 */
function createMockWorkbench(
  handler: (apiFunc: string, params: Record<string, unknown>) => unknown
): { server: Server; port: number; close: () => Promise<void> } {
  const server = createServer((socket: Socket) => {
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("end", () => {
      try {
        const buf = Buffer.concat(chunks);

        // Parse: int32 protocolVer + pascal clientId + pascal contentType + pascal payload
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
        // Match real Workbench format: pascal("Ok") + pascal(JSON)
        const statusBuf = encodePascalString("Ok");
        const payloadBuf = encodePascalString(JSON.stringify(response));
        socket.end(Buffer.concat([statusBuf, payloadBuf]));
      } catch (e) {
        // Error: just send error status string (no payload)
        const errBuf = encodePascalString(`Error: ${String(e)}`);
        socket.end(errBuf);
      }
    });
  });

  let resolvedPort = 0;
  server.listen(0); // OS-assigned port
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

describe("WorkbenchClient", () => {
  let mockServer: ReturnType<typeof createMockWorkbench>;
  let client: WorkbenchClient;

  beforeEach(() => {
    mockServer = createMockWorkbench((apiFunc, params) => {
      if (apiFunc === "EMCP_WB_Ping") {
        return { status: "ok", mode: "edit", message: "EnfusionMCP Workbench bridge active" };
      }
      if (apiFunc === "GetLoadedProjects") {
        return { "Loaded Projects": ["ArmaReforger", "TestMod"] };
      }
      if (apiFunc === "ReloadScripts") {
        return { status: "ok" };
      }
      if (apiFunc === "EMCP_WB_ListEntities") {
        return {
          count: 2,
          entities: [
            { name: "Tree_01", className: "SCR_DestructibleEntity" },
            { name: "House_02", className: "BuildingEntity" },
          ],
        };
      }
      return { error: `Unknown function: ${apiFunc}` };
    });
    client = new WorkbenchClient("127.0.0.1", mockServer.port);
  });

  afterEach(async () => {
    await mockServer.close();
  });

  it("calls a built-in function", async () => {
    const result = await client.call<{ status: string }>("ReloadScripts");
    expect(result.status).toBe("ok");
  });

  it("calls a custom handler with params", async () => {
    const result = await client.call<{
      count: number;
      entities: Array<{ name: string; className: string }>;
    }>("EMCP_WB_ListEntities", { offset: 0, limit: 50 });
    expect(result.count).toBe(2);
    expect(result.entities).toHaveLength(2);
    expect(result.entities[0].name).toBe("Tree_01");
  });

  it("ping returns true when server is running", async () => {
    const ok = await client.ping();
    expect(ok).toBe(true);
  });

  it("ping returns false when server is down", async () => {
    await mockServer.close();
    const deadClient = new WorkbenchClient("127.0.0.1", 1); // port 1 should refuse
    const ok = await deadClient.ping();
    expect(ok).toBe(false);
  });

  it("throws CONNECTION_REFUSED on bad port", async () => {
    const badClient = new WorkbenchClient("127.0.0.1", 1);
    await expect(
      badClient.call("ReloadScripts", {})
    ).rejects.toThrow(WorkbenchError);
    try {
      await badClient.call("ReloadScripts", {});
    } catch (e) {
      expect(e).toBeInstanceOf(WorkbenchError);
      expect((e as WorkbenchError).code).toBe("CONNECTION_REFUSED");
    }
  });

  describe("on a slow response", () => {
    const openSockets: Socket[] = [];
    let slowServer: Server;
    let slowClient: WorkbenchClient;
    beforeEach(() => {
      // A server that never responds. allowHalfOpen prevents Node auto-ending when client sends FIN.
      slowServer = createServer({ allowHalfOpen: true }, (socket) => {
        openSockets.push(socket);
        socket.on("data", () => {});
      });
      slowServer.listen(0);
      const addr = slowServer.address();
      slowClient = new WorkbenchClient("127.0.0.1", addr && typeof addr !== "string" ? addr.port : 0);
      slowClient.dialogProbe = async () => []; // the real one would start PowerShell on the test PC
    });
    afterEach(async () => {
      // Destroy all held sockets so server.close() doesn't hang
      for (const s of openSockets.splice(0)) s.destroy();
      await new Promise<void>((res) => slowServer.close(() => res()));
    });

    it("throws TIMEOUT", async () => {
      await expect(slowClient.call("ReloadScripts", {}, { timeout: 200 })).rejects.toThrow("timed out");
    });

    it("names the open dialog, keeps TIMEOUT and carries the dialogs", async () => {
      const modal = { hwnd: 5, cls: "Qt683QWindowIcon", text: "Validating $A:Worlds/B.ent", visible: true, children: [{ hwnd: 0, cls: "Text", text: "File data structure of the world is obsolete" }], buttons: ["Yes", "No"] };
      slowClient.dialogProbe = async () => [{ pid: 7, dialogs: [modal] }];
      const err = await slowClient.call("ReloadScripts", {}, { timeout: 200 }).catch((e) => e);
      expect(err).toBeInstanceOf(WorkbenchError);
      expect(err.code).toBe("TIMEOUT");
      expect(err.message).toContain("timed out");
      expect(err.message).toContain("[obsolete_world]");
      expect(err.message).toContain("may still run");
      expect(err.dialogs).toHaveLength(1);
    });

    it("still throws TIMEOUT, saying the check is unavailable, when the dialog check throws", async () => {
      slowClient.dialogProbe = async () => { throw new Error("no powershell"); };
      const err = await slowClient.call("ReloadScripts", {}, { timeout: 200 }).catch((e) => e);
      expect(err.code).toBe("TIMEOUT");
      expect(err.message).toContain("dialog check unavailable: no powershell");
    });

    it("never runs the dialog check for ping()", async () => {
      const probe = vi.fn(async () => []);
      const c = new WorkbenchClient("127.0.0.1", 1);
      c.dialogProbe = probe;
      expect(await c.ping()).toBe(false);
      expect(probe).not.toHaveBeenCalled();
    });
  });

  it("toString shows host and port", () => {
    expect(client.toString()).toContain("127.0.0.1");
    expect(client.toString()).toContain(String(mockServer.port));
  });

  // -- State caching tests --

  it("state starts as disconnected/unknown", () => {
    const freshClient = new WorkbenchClient("127.0.0.1", 1);
    expect(freshClient.state.connected).toBe(false);
    expect(freshClient.state.mode).toBe("unknown");
    expect(freshClient.state.lastUpdated).toBe(0);
  });

  it("state.connected becomes true after successful call", async () => {
    expect(client.state.connected).toBe(false);
    await client.call("ReloadScripts");
    expect(client.state.connected).toBe(true);
    expect(client.state.lastUpdated).toBeGreaterThan(0);
  });

  it("state.mode is extracted from response with mode field", async () => {
    // EMCP_WB_Ping returns { mode: "edit" }
    await client.call("EMCP_WB_Ping");
    expect(client.state.mode).toBe("edit");
    expect(client.state.connected).toBe(true);
  });

  it("state.mode stays unknown for responses without mode field", async () => {
    // ReloadScripts returns { status: "ok" }: no mode field
    await client.call("ReloadScripts");
    expect(client.state.mode).toBe("unknown");
    expect(client.state.connected).toBe(true);
  });

  it("state.connected becomes false on connection refused", async () => {
    // First connect successfully
    await client.call("ReloadScripts");
    expect(client.state.connected).toBe(true);

    // Now try a dead client
    const badClient = new WorkbenchClient("127.0.0.1", 1);
    try {
      await badClient.call("ReloadScripts", {});
    } catch { /* expected */ }
    expect(badClient.state.connected).toBe(false);
    expect(badClient.state.mode).toBe("unknown");
  });

  it("state tracks mode changes across calls", async () => {
    // Set up a server that changes mode based on the API call
    await mockServer.close();
    mockServer = createMockWorkbench((apiFunc) => {
      if (apiFunc === "EMCP_WB_EditorControl") {
        return { status: "ok", mode: "play" };
      }
      if (apiFunc === "EMCP_WB_GetState") {
        return { mode: "edit", entityCount: 5 };
      }
      return { status: "ok" };
    });
    const stateClient = new WorkbenchClient("127.0.0.1", mockServer.port);

    // Start with "play" mode from EditorControl
    await stateClient.call("EMCP_WB_EditorControl", { action: "play" });
    expect(stateClient.state.mode).toBe("play");

    // Then "edit" mode from GetState
    await stateClient.call("EMCP_WB_GetState");
    expect(stateClient.state.mode).toBe("edit");
  });

  it("refreshState updates cached state", async () => {
    await mockServer.close();
    mockServer = createMockWorkbench((apiFunc) => {
      if (apiFunc === "EMCP_WB_GetState") {
        return { mode: "play", entityCount: 10 };
      }
      return { status: "ok" };
    });
    const stateClient = new WorkbenchClient("127.0.0.1", mockServer.port);

    expect(stateClient.state.mode).toBe("unknown");
    const state = await stateClient.refreshState();
    expect(state.mode).toBe("play");
    expect(state.connected).toBe(true);
    expect(stateClient.state.mode).toBe("play");
  });

  it("refreshState returns disconnected on failure", async () => {
    const badClient = new WorkbenchClient("127.0.0.1", 1);
    const state = await badClient.refreshState();
    expect(state.connected).toBe(false);
    expect(state.mode).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// In-band handler failures.
//
// The NET API returns transport-level "Ok" even when the handler itself failed:
// 18 of the Enforce handlers report failure by setting `status: "error"` plus a
// message. Before this was checked, a failed mutation came back looking like a
// success and tools rendered "**Entity Modified**" over "Entity not found".
// ---------------------------------------------------------------------------
describe("WorkbenchClient in-band error status", () => {
  let mock: ReturnType<typeof createMockWorkbench>;

  afterEach(async () => {
    if (mock) await mock.close();
  });

  it("throws WorkbenchError carrying the handler's message", async () => {
    mock = createMockWorkbench(() => ({ status: "error", message: "Entity not found: Foo" }));
    const client = new WorkbenchClient("127.0.0.1", mock.port);

    await expect(
      client.call("EMCP_WB_ModifyEntity", { name: "Foo" })
    ).rejects.toThrow("Entity not found: Foo");
  });

  it("throws a WorkbenchError specifically, so tool catch blocks handle it", async () => {
    mock = createMockWorkbench(() => ({ status: "error", message: "boom" }));
    const client = new WorkbenchClient("127.0.0.1", mock.port);

    await expect(
      client.call("EMCP_WB_Anything", {})
    ).rejects.toBeInstanceOf(WorkbenchError);
  });

  it("still throws when the handler omits a message", async () => {
    mock = createMockWorkbench(() => ({ status: "error" }));
    const client = new WorkbenchClient("127.0.0.1", mock.port);

    await expect(
      client.call("EMCP_WB_Anything", {})
    ).rejects.toThrow(/without a message/);
  });

  it("returns the response untouched when tolerateErrorStatus is set", async () => {
    mock = createMockWorkbench(() => ({ status: "error", message: "registration failed" }));
    const client = new WorkbenchClient("127.0.0.1", mock.port);

    const result = await client.call<{ status: string; message: string }>(
      "EMCP_WB_Resources",
      { action: "register" },
      { tolerateErrorStatus: true }
    );
    expect(result.status).toBe("error");
    expect(result.message).toBe("registration failed");
  });

  it("passes a successful response through unchanged", async () => {
    mock = createMockWorkbench(() => ({ status: "ok", mode: "edit", value: 42 }));
    const client = new WorkbenchClient("127.0.0.1", mock.port);

    const result = await client.call<{ status: string; value: number }>(
      "EMCP_WB_GetState",
      {}
    );
    expect(result.status).toBe("ok");
    expect(result.value).toBe(42);
    expect(client.state.mode).toBe("edit");
  });

  it("does not treat a response without a status field as an error", async () => {
    mock = createMockWorkbench(() => ({ entities: [], entityCount: 0 }));
    const client = new WorkbenchClient("127.0.0.1", mock.port);

    const result = await client.call<{ entityCount: number }>(
      "EMCP_WB_ListEntities",
      {}
    );
    expect(result.entityCount).toBe(0);
  });
});

describe("cleanupHandlerScripts", () => {
  it("removes the handler folder and the empty WorkbenchGame folder, and reports it", () => {
    const mod = mkdtempSync(join(tmpdir(), "emcp-"));
    const handlers = join(mod, "Scripts", "WorkbenchGame", "EnfusionMCP");
    mkdirSync(handlers, { recursive: true });
    writeFileSync(join(handlers, "EMCP_WB_Ping.c"), "");
    expect(new WorkbenchClient("127.0.0.1", 1).cleanupHandlerScripts(mod)).toBe(true);
    expect(existsSync(join(mod, "Scripts", "WorkbenchGame"))).toBe(false);
  });

  it("keeps other scripts in the handler folder", () => {
    const mod = mkdtempSync(join(tmpdir(), "emcp-"));
    const handlers = join(mod, "Scripts", "WorkbenchGame", "EnfusionMCP");
    mkdirSync(handlers, { recursive: true });
    writeFileSync(join(handlers, "EMCP_WB_Ping.c"), "");
    writeFileSync(join(handlers, "MY_Probe.c"), "");
    expect(new WorkbenchClient("127.0.0.1", 1).cleanupHandlerScripts(mod)).toBe(true);
    expect(existsSync(join(handlers, "EMCP_WB_Ping.c"))).toBe(false);
    expect(existsSync(join(handlers, "MY_Probe.c"))).toBe(true);
  });
});

describe("probeMode", () => {
  let mock: ReturnType<typeof createMockWorkbench> | undefined;
  afterEach(async () => {
    await mock?.close();
    mock = undefined;
  });

  it.each([
    ["edit", "edit"],
    ["game", "play"],
    ["no_world", "no_world"],
    ["no_world_editor", "no_world"],
  ])("maps GetState mode %s to %s", async (reply, want) => {
    mock = createMockWorkbench((apiFunc) => (apiFunc === "EMCP_WB_GetState" ? { status: "ok", mode: reply } : {}));
    const client = new WorkbenchClient("127.0.0.1", mock.port);
    expect(await client.probeMode()).toBe(want);
    expect(client.state.connected).toBe(true);
  });

  it("reports no_handlers when Workbench does not know the handler", async () => {
    mock = createMockWorkbench(() => { throw new Error("Undefined API func"); });
    expect(await new WorkbenchClient("127.0.0.1", mock.port).probeMode()).toBe("no_handlers");
  });

  it("reports not_running on a refused port and never launches", async () => {
    const client = new WorkbenchClient("127.0.0.1", 1, {} as Config);
    const launch = vi.spyOn(client, "ensureRunning").mockResolvedValue(undefined);
    expect(await client.probeMode()).toBe("not_running");
    expect(launch).not.toHaveBeenCalled();
    expect(client.state.connected).toBe(false);
  });

  it("reports timeout when Workbench does not answer within 3 s", async () => {
    const openSockets: Socket[] = [];
    const slow = createServer({ allowHalfOpen: true }, (socket) => {
      openSockets.push(socket);
      socket.on("data", () => {});
    });
    slow.listen(0);
    const addr = slow.address();
    const client = new WorkbenchClient("127.0.0.1", addr && typeof addr !== "string" ? addr.port : 0);
    expect(await client.probeMode()).toBe("timeout");
    for (const s of openSockets) s.destroy();
    await new Promise<void>((res) => slow.close(() => res()));
  }, 6000);
});

describe("missing handlers in a running Workbench", () => {
  it("fails at once and writes no handler files", async () => {
    const project = mkdtempSync(join(tmpdir(), "emcp-"));
    mkdirSync(join(project, "MCPParity"));
    writeFileSync(join(project, "MCPParity", "addon.gproj"), 'GameProject {\n ID "MCPParity"\n}\n');
    const mock = createMockWorkbench(() => { throw new Error("Undefined API func"); });
    const client = new WorkbenchClient("127.0.0.1", mock.port, { projectPath: project, defaultMod: "MCPParity" } as Config);
    const started = Date.now();
    await expect(client.call("EMCP_WB_ListEntities")).rejects.toThrow("registers NET API handlers only when it starts");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(existsSync(join(project, "MCPParity", "Scripts"))).toBe(false);
    expect(existsSync(join(project, "EnfusionMCP"))).toBe(false);
    await mock.close();
  });
});

describe("buildLaunchArgs", () => {
  it("keeps the old command line without worldPath", () => {
    expect(buildLaunchArgs({ gproj: "C:\p\A\addon.gproj", addonsDir: "C:\p", unattended: true })).toEqual([
      "-gproj", "C:\p\A\addon.gproj", "-addonsDir", "C:\p", "-noThrow",
    ]);
    expect(buildLaunchArgs({})).toEqual([]);
  });

  it("adds the World Editor flags after -gproj and -addonsDir, the world as one argument", () => {
    expect(buildLaunchArgs({ gproj: "C:\p\A\addon.gproj", addonsDir: "C:\p", worldPath: "worlds/My Map/Map.ent" })).toEqual([
      "-gproj", "C:\p\A\addon.gproj", "-addonsDir", "C:\p", "-wbModule=WorldEditor", "-run", "-load", "worlds/My Map/Map.ent",
    ]);
    expect(buildLaunchArgs({ gproj: "a.gproj", worldPath: "{0123456789ABCDEF}worlds/Map.ent" }).slice(-1)).toEqual(["worlds/Map.ent"]);
  });

  it("refuses worldPath without a project, that is not a .ent, or that holds a quote", () => {
    expect(() => buildLaunchArgs({ worldPath: "worlds/Map.ent" })).toThrow(/needs a project/);
    expect(() => buildLaunchArgs({ gproj: "a.gproj", worldPath: "worlds/Map.layer" })).toThrow(/\.ent/);
    expect(() => buildLaunchArgs({ gproj: "a.gproj", worldPath: 'x" -scriptAuthorizeAll "y.ent' })).toThrow(/quote/);
  });
});

describe("automatic watch check (B-093)", () => {
  const AUTO = { autoWatch: true } as Config;
  const T = new Date("2026-11-08T18:00:00").getTime();
  const flush = () => new Promise((r) => setImmediate(r));
  const attached = async () => ({ ok: true, text: "Attached watcher PID 700 to Workbench PID 19524." });
  let mock: ReturnType<typeof createMockWorkbench>;
  beforeEach(() => {
    mock = createMockWorkbench(() => ({ status: "ok", mode: "edit" }));
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await mock.close();
  });

  it("starts at the request and never delays it: a check whose deps never settle", async () => {
    const c = new WorkbenchClient("127.0.0.1", mock.port, AUTO);
    const never = () => new Promise<never>(() => {});
    const netstat = vi.fn(never);
    c.watchCheck = () =>
      ensureWatched(mock.port, "127.0.0.1", {
        stateDir: mkdtempSync(join(tmpdir(), "emcp-cw-")), platform: "win32", netstat, proc: never, owned: () => false, alive: () => false, start: vi.fn(() => 1), base: {},
      });
    const started = Date.now();
    expect(await c.call("EMCP_WB_Ping")).toMatchObject({ status: "ok" });
    expect(Date.now() - started).toBeLessThan(500);
    expect(netstat).toHaveBeenCalledOnce();
  });

  it("after attached or already watched, no new check for 60 s; 61 s later a new one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    const c = new WorkbenchClient("127.0.0.1", mock.port, AUTO);
    const check = vi.fn(attached);
    c.watchCheck = check;
    await c.call("EMCP_WB_Ping");
    await flush();
    vi.setSystemTime(T + 59_000);
    await c.call("EMCP_WB_Ping");
    await flush();
    expect(check).toHaveBeenCalledOnce();
    vi.setSystemTime(T + 61_000);
    await c.call("EMCP_WB_Ping");
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("after any other result (no listener) the next request checks again", async () => {
    const c = new WorkbenchClient("127.0.0.1", mock.port, AUTO);
    const check = vi.fn(async () => ({ ok: false, text: "Workbench not watched: no process listens on port 5775." }));
    c.watchCheck = check;
    await c.call("EMCP_WB_Ping");
    await flush();
    await c.call("EMCP_WB_Ping");
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("a call that ends in CONNECTION_REFUSED ends the pause: the next call after a Workbench restart checks at once", async () => {
    const c = new WorkbenchClient("127.0.0.1", 1, AUTO); // nothing listens on port 1
    const check = vi.fn(attached);
    c.watchCheck = check;
    await c.call("ReloadScripts", {}).catch(() => {}); // the request-start check is ok and sets the pause; the refusal then ends it
    await flush();
    expect(check).toHaveBeenCalledOnce();
    await c.call("ReloadScripts", {}).catch(() => {});
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("a refused path that does not go through call() (probeMode) also ends the pause", async () => {
    const c = new WorkbenchClient("127.0.0.1", 1, AUTO);
    const check = vi.fn(attached);
    c.watchCheck = check;
    await c.probeMode();
    await flush();
    expect(check).toHaveBeenCalledOnce();
    await c.probeMode();
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("a watcher that never claims the lock is started once, not on every call within 60 s", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T);
    const c = new WorkbenchClient("127.0.0.1", mock.port, AUTO);
    const wb = "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arma Reforger Tools\\Workbench\\ArmaReforgerWorkbenchSteamDiag.exe -gproj x";
    const start = vi.fn(() => 700); // never writes the lock
    c.watchCheck = () =>
      ensureWatched(mock.port, "127.0.0.1", {
        stateDir: mkdtempSync(join(tmpdir(), "emcp-cw-")), platform: "win32", settleMs: 0, owned: () => false, alive: () => false, start, base: {},
        netstat: async () => `  TCP    0.0.0.0:${mock.port}           0.0.0.0:0              LISTENING       19524\r\n`,
        proc: async (pid) => ({ pid, ppid: 1, cmd: wb, created: T }),
      });
    for (const s of [0, 5, 30, 59]) {
      vi.setSystemTime(T + s * 1000);
      await c.call("EMCP_WB_Ping");
      await flush();
    }
    expect(start).toHaveBeenCalledOnce();
  });

  it("runs only when config.autoWatch is true: none for {} as config or no config", async () => {
    for (const c of [new WorkbenchClient("127.0.0.1", mock.port, {} as Config), new WorkbenchClient("127.0.0.1", mock.port)]) {
      const check = vi.fn(attached);
      c.watchCheck = check;
      await c.call("EMCP_WB_Ping");
      await flush();
      expect(check).not.toHaveBeenCalled();
      expect(await c.watchNote()).toBe("");
    }
  });

  it("a throwing check never fails the call and is logged at debug level", async () => {
    const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
    const c = new WorkbenchClient("127.0.0.1", mock.port, AUTO);
    c.watchCheck = () => {
      throw new Error("boom");
    };
    expect(await c.call("EMCP_WB_Ping")).toMatchObject({ status: "ok" });
    c.watchCheck = async () => {
      throw new Error("late boom");
    };
    expect(await c.call("EMCP_WB_Ping")).toMatchObject({ status: "ok" });
    await flush();
    expect(debug.mock.calls.map((x) => x[0])).toEqual(
      expect.arrayContaining(["Automatic watch check failed: boom", "Automatic watch check failed: late boom"])
    );
  });

  it("three parallel requests while a check runs start no second check", async () => {
    const c = new WorkbenchClient("127.0.0.1", mock.port, AUTO);
    let release: (r: { ok: boolean; text: string }) => void = () => {};
    const check = vi.fn(() => new Promise<{ ok: boolean; text: string }>((r) => (release = r)));
    c.watchCheck = check;
    await Promise.all([c.call("EMCP_WB_Ping"), c.call("EMCP_WB_Ping"), c.call("EMCP_WB_Ping")]);
    expect(check).toHaveBeenCalledOnce();
    release({ ok: false, text: "x" });
    await flush();
    await c.call("EMCP_WB_Ping");
    expect(check).toHaveBeenCalledTimes(2);
  });

  describe("on a TIMEOUT", () => {
    const openSockets: Socket[] = [];
    let slow: Server;
    let c: WorkbenchClient;
    beforeEach(() => {
      slow = createServer({ allowHalfOpen: true }, (socket) => {
        openSockets.push(socket);
        socket.on("data", () => {});
      });
      slow.listen(0);
      const addr = slow.address();
      c = new WorkbenchClient("127.0.0.1", addr && typeof addr !== "string" ? addr.port : 0, AUTO);
      c.dialogProbe = async () => []; // the real one would start PowerShell on the test PC
    });
    afterEach(async () => {
      for (const s of openSockets.splice(0)) s.destroy();
      await new Promise<void>((res) => slow.close(() => res()));
    });

    it("the error carries the check's line; the 60 s pause set by the request-start check is honoured, not rerun", async () => {
      const check = vi.fn(async () => ({ ok: true, text: "Workbench PID 19524 is watched by watcher PID 600." }));
      c.watchCheck = check;
      const err = await c.call("ReloadScripts", {}, { timeout: 200 }).catch((e) => e);
      expect(err).toBeInstanceOf(WorkbenchError);
      expect(err.code).toBe("TIMEOUT");
      expect(err.message).toContain("timed out after 200ms");
      expect(err.message).toContain("Watchdog: Workbench PID 19524 is watched by watcher PID 600.");
      expect(check).toHaveBeenCalledTimes(1);
    });

    it("a result that is not ok is checked again for the reply", async () => {
      const check = vi.fn(async () => ({ ok: false, text: "Workbench not watched: no process listens on port 5775." }));
      c.watchCheck = check;
      const err = await c.call("ReloadScripts", {}, { timeout: 200 }).catch((e) => e);
      expect(err.message).toContain("Watchdog: Workbench not watched: no process listens on port 5775.");
      expect(check).toHaveBeenCalledTimes(2);
    });

    it("a watcher that never claims: five timed-out calls within 60 s start exactly one watcher (B-097 item 2)", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(T);
      const wb = "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arma Reforger Tools\\Workbench\\ArmaReforgerWorkbenchSteamDiag.exe -gproj x";
      const start = vi.fn(() => 700); // never writes the lock
      c.watchCheck = () =>
        ensureWatched(5775, "127.0.0.1", {
          stateDir: mkdtempSync(join(tmpdir(), "emcp-cw-")), platform: "win32", settleMs: 0, owned: () => false, alive: () => false, start, base: {},
          netstat: async () => "  TCP    0.0.0.0:5775           0.0.0.0:0              LISTENING       19524\r\n",
          proc: async (pid) => ({ pid, ppid: 1, cmd: wb, created: T }),
        });
      for (const s of [0, 5, 20, 40, 59]) {
        vi.setSystemTime(T + s * 1000);
        const err = await c.call("ReloadScripts", {}, { timeout: 100 }).catch((e) => e);
        expect(err.message).toContain("did not take Workbench PID 19524");
      }
      expect(start).toHaveBeenCalledOnce();
    });

    it("a check that never settles adds that line after the wait, and the error still arrives", async () => {
      expect(c.watchWaitMs).toBe(5_000);
      c.watchWaitMs = 50;
      c.watchCheck = () => new Promise(() => {});
      const err = await c.call("ReloadScripts", {}, { timeout: 200 }).catch((e) => e);
      expect(err.code).toBe("TIMEOUT");
      expect(err.message).toContain("Watchdog: the watch check did not finish in 0.05 s");
    });
  });
});
