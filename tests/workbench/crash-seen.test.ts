import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server, type Socket } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkbenchClient, WorkbenchError } from "../../src/workbench/client.js";
import { findPids } from "../../src/utils/process.js";
import type { Config } from "../../src/config.js";

// The timeout path lists Workbench processes: keep these tests off the real process list.
vi.mock("../../src/utils/process.js", async (orig) => ({ ...(await orig<typeof import("../../src/utils/process.js")>()), findPids: vi.fn(() => [] as number[]) }));

const PORT = 5775;
const LISTEN = (pid: number) => `  TCP    0.0.0.0:${PORT}           0.0.0.0:0              LISTENING       ${pid}\r\n`;
const LOGS = "C:\\logs\\logs_2026-11-10_09-08-52";
const CRASHED = (who: string, logs = ` crash logs are in ${LOGS}`) =>
  `Workbench appears to have crashed: ${who};${logs}. Tell the user before starting Workbench again.`;

type Probes = { reporters?: () => Promise<number[]>; netstat?: () => Promise<string>; logs?: () => string | undefined; live?: number[] };

/** A client whose call fails with `fail` and whose every probe is stubbed. */
function setup(fail: WorkbenchError, p: Probes = {}, host = "127.0.0.1", config?: Config) {
  const c = new WorkbenchClient(host, PORT, config);
  (c as unknown as { rawCall: () => Promise<never> }).rawCall = () => Promise.reject(fail);
  c.dialogProbe = async () => [];
  c.worldProbe.netstat = p.netstat ?? (async () => "");
  c.crashProbe = { reporters: p.reporters ?? (async () => []), logs: p.logs ?? (() => undefined) };
  vi.mocked(findPids).mockReturnValue(p.live ?? []);
  return c;
}
const timeout = () => new WorkbenchError('Workbench call "EMCP_WB_GetState" timed out after 10000ms', "TIMEOUT");
const reset = () => new WorkbenchError("Connection error: read ECONNRESET", "PROTOCOL_ERROR");
const msg = (c: WorkbenchClient) => c.call("EMCP_WB_GetState").catch((e: WorkbenchError) => e);

describe("a failed call with no live Workbench says it appears to have crashed", () => {
  afterEach(() => vi.mocked(findPids).mockReset().mockReturnValue([]));

  it("names the CrashReporter, the port and the newest logs folder", async () => {
    const err = await msg(setup(timeout(), { reporters: async () => [49736], netstat: async () => LISTEN(19664), logs: () => LOGS }));
    expect(err.code).toBe("TIMEOUT");
    expect(err.message).toBe([timeout().message, CRASHED("CrashReporter PID 49736 holds port 5775")].join("\n"));
  });

  it("leaves out the part it could not find", async () => {
    expect((await msg(setup(timeout(), { reporters: async () => [49736] }))).message).toContain(
      "Workbench appears to have crashed: CrashReporter PID 49736 is running. Tell the user"
    );
    expect((await msg(setup(timeout(), { netstat: async () => LISTEN(19664), logs: () => LOGS }))).message).toContain(CRASHED("PID 19664 holds port 5775"));
  });

  it("adds nothing when no CrashReporter runs and the port is free", async () => {
    expect((await msg(setup(timeout()))).message).toBe(timeout().message);
  });

  it("says it with the automatic watch on, beside the watch note", async () => {
    const c = setup(timeout(), { reporters: async () => [7], logs: () => LOGS }, "127.0.0.1", { autoWatch: true } as Config);
    c.watchCheck = async () => ({ ok: false, text: "Workbench not watched: nothing listens." });
    const err = await msg(c);
    expect(err.message).toContain("Workbench appears to have crashed: CrashReporter PID 7 is running");
    expect(err.message).toContain("Watchdog: Workbench not watched: nothing listens.");
  });

  it("a live Workbench (a hang or a dialog) gets no crash line and keeps the dialog report", async () => {
    const modal = { hwnd: 5, cls: "Qt683QWindowIcon", text: "Validating $A:Worlds/B.ent", visible: true, children: [], buttons: ["Yes", "No"] };
    const c = setup(timeout(), { reporters: async () => [49736], netstat: async () => LISTEN(4242), logs: () => LOGS, live: [4242] });
    c.dialogProbe = async () => [{ pid: 4242, dialogs: [modal] }];
    const err = await msg(c);
    expect(err.message).not.toContain("crashed");
    expect(err.message).toContain("timed out after 10000ms");
    expect(err.message).toContain("Validating");
    expect(err.dialogs).toHaveLength(1);
  });

  it("a probe that throws or fails never hides the timeout", async () => {
    const boom = async (): Promise<never> => { throw new Error("no powershell"); };
    const all = await msg(setup(timeout(), { reporters: boom, netstat: boom }));
    expect(all.code).toBe("TIMEOUT");
    expect(all.message).toBe(timeout().message);
    const logs = await msg(setup(timeout(), { reporters: async () => [1], logs: () => { throw new Error("no folder"); } }));
    expect(logs.code).toBe("TIMEOUT");
    expect(logs.message).toContain("timed out after 10000ms");
    // one failing probe leaves the other one's finding
    expect((await msg(setup(timeout(), { reporters: boom, netstat: async () => LISTEN(19664) }))).message).toContain("PID 19664 holds port 5775");
    expect((await msg(setup(timeout(), { reporters: async () => [49736], netstat: boom }))).message).toContain("CrashReporter PID 49736 is running");
  });

  it("is not run for a Workbench on another machine", async () => {
    const reporters = vi.fn(async () => [1]);
    const err = await msg(setup(timeout(), { reporters }, "10.0.0.5"));
    expect(err.message).toBe(timeout().message);
    expect(reporters).not.toHaveBeenCalled();
  });

  it("a connection reset gets the line; a reset with nothing found, or a live Workbench, is unchanged", async () => {
    const err = await msg(setup(reset(), { reporters: async () => [49736], netstat: async () => LISTEN(19664), logs: () => LOGS }));
    expect(err.code).toBe("PROTOCOL_ERROR");
    expect(err.message).toBe([reset().message, CRASHED("CrashReporter PID 49736 holds port 5775")].join("\n"));
    expect((await msg(setup(reset()))).message).toBe(reset().message);
    expect((await msg(setup(reset(), { reporters: async () => [1], live: [4242] }))).message).toBe(reset().message);
  });

  it("another protocol error is not checked", async () => {
    const reporters = vi.fn(async () => [1]);
    const other = new WorkbenchError("Response too large", "PROTOCOL_ERROR");
    expect((await msg(setup(other, { reporters }))).message).toBe("Response too large");
    expect(reporters).not.toHaveBeenCalled();
  });
});

describe("through a real socket", () => {
  let server: Server | undefined;
  const sockets: Socket[] = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.destroy();
    await new Promise<void>((res) => (server ? server.close(() => res()) : res()));
    server = undefined;
    vi.mocked(findPids).mockReset().mockReturnValue([]);
  });
  const listen = async (onData: (s: Socket) => void) => {
    let connections = 0;
    server = createServer({ allowHalfOpen: true }, (s) => { connections++; sockets.push(s); s.on("data", () => onData(s)); });
    await new Promise<void>((res) => server!.listen(0, "127.0.0.1", res));
    const c = new WorkbenchClient("127.0.0.1", (server.address() as { port: number }).port);
    c.dialogProbe = async () => [];
    c.worldProbe.netstat = async () => "";
    c.crashProbe = { reporters: async () => [49736], logs: () => LOGS };
    return { c, connections: () => connections };
  };

  it("a timeout gets the line and makes no second NET API call", async () => {
    const { c, connections } = await listen(() => {});
    const err = await c.call("EMCP_WB_GetState", {}, { timeout: 150 }).catch((e) => e);
    expect(err.code).toBe("TIMEOUT");
    expect(err.message).toContain("timed out after 150ms");
    expect(err.message).toContain("Workbench appears to have crashed: CrashReporter PID 49736 is running");
    expect(connections()).toBe(1);
  });

  it("a reset connection gets the line", async () => {
    const { c, connections } = await listen((s) => s.resetAndDestroy());
    const err = await c.call("EMCP_WB_GetState", {}, { timeout: 2000 }).catch((e) => e);
    expect(err.code).toBe("PROTOCOL_ERROR");
    expect(err.message).toContain("ECONNRESET");
    expect(err.message).toContain("Workbench appears to have crashed: CrashReporter PID 49736 is running");
    expect(connections()).toBe(1);
  });
});

describe("the logs folder the line names", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const profile = (...logFolders: string[]) => {
    const root = mkdtempSync(join(tmpdir(), "emcp-crash-"));
    dirs.push(root);
    vi.stubEnv("ENFUSION_WORKBENCH_PROFILE", root);
    mkdirSync(join(root, "logs"), { recursive: true });
    logFolders.forEach((f, i) => {
      mkdirSync(join(root, "logs", f));
      utimesSync(join(root, "logs", f), new Date(2026, 0, 1 + i), new Date(2026, 0, 1 + i));
    });
    return { root, client: new WorkbenchClient("127.0.0.1", PORT, { projectPath: join(root, "proj") } as Config) };
  };

  it("is the newest logs_ folder", () => {
    const { root, client } = profile("logs_2026-11-10_08-00-00", "logs_2026-11-10_09-08-52");
    expect(client.crashProbe.logs()).toBe(join(root, "logs", "logs_2026-11-10_09-08-52"));
  });

  it("is the logs root when it holds no folder", () => {
    const { root, client } = profile();
    expect(client.crashProbe.logs()).toBe(join(root, "logs"));
  });

  it("is nothing without a config", () => {
    expect(new WorkbenchClient("127.0.0.1", PORT).crashProbe.logs()).toBeUndefined();
  });
});
