import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { PROBE_SCRIPT, DISMISS_SCRIPT, dismissLeakAssert, startProbe, withArgs, type PsRunner } from "../../src/watchdog/probe.js";

describe("probe scripts", () => {
  it.each([["probe", PROBE_SCRIPT], ["dismiss", DISMISS_SCRIPT]])("%s never focuses, shows, closes or ends anything", (_n, script) => {
    for (const banned of ["SetForegroundWindow", "SetFocus", "ShowWindow", "WM_CLOSE", "Stop-Process", "taskkill"]) {
      expect(script).not.toContain(banned);
    }
  });

  it("the only message posted is BM_CLICK", () => {
    expect(PROBE_SCRIPT).not.toContain("]::PostMessage(");
    expect([...DISMISS_SCRIPT.matchAll(/\]::PostMessage\(([^)]*)\)/g)].map((m) => m[1].split(",")[1].trim())).toEqual(["0x00F5"]);
  });

  it("takes integer parameters only", () => {
    expect(withArgs("x", { WbPid: 12, Hwnd: 34 })).toBe("$WbPid = 12\n$Hwnd = 34\nx");
    expect(() => withArgs("x", { WbPid: Number("1; Stop") })).toThrow(/integer/);
  });
});

describe("dismissLeakAssert through a stub runner", () => {
  const dialog = (reason: string, button: string) => JSON.stringify({
    hwnd: 100, cls: "#32770", text: "Assertion", visible: true,
    children: [{ hwnd: 101, cls: "Static", text: `Reason: ${reason}` }, { hwnd: 102, cls: "Button", text: button }],
  });
  const runner = (look: { code: number; out: string }) => {
    const calls: string[] = [];
    const run: PsRunner = async (s) => {
      calls.push(s);
      return s.includes("$Button = 0") ? look : { code: 0, out: "clicked\r\n" };
    };
    return { run, calls };
  };

  it("clicks the &Ignore button of the exact leak assert", async () => {
    const { run, calls } = runner({ code: 0, out: dialog("Resources are leaking! Check log!", "&Ignore") });
    expect(await dismissLeakAssert(7, 100, run)).toBe("clicked");
    expect(calls[1]).toMatch(/^\$WbPid = 7\n\$Hwnd = 100\n\$Button = 102\n/);
  });

  it.each([
    ["other text", { code: 0, out: dialog("Something else", "&Ignore") }],
    ["no Ignore button", { code: 0, out: dialog("Resources are leaking! Check log!", "&Abort") }],
    ["window gone", { code: 2, out: "refused: the window is gone or is not a dialog box of that Workbench" }],
    ["garbage", { code: 0, out: "not json" }],
  ])("refuses on %s and never runs the click", async (_n, look) => {
    const { run, calls } = runner(look);
    expect(await dismissLeakAssert(7, 100, run)).toMatch(/^refused/);
    expect(calls).toHaveLength(1);
  });
});

describe("startProbe", () => {
  it("parses each JSON line and restarts a probe that died", () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const children: (EventEmitter & { stdout: PassThrough; kill: () => void })[] = [];
    const fakeSpawn = vi.fn(() => {
      const c = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn() });
      children.push(c);
      return c;
    });
    const seen: unknown[] = [];
    const probe = startProbe(42, 5775, (s) => seen.push(s), fakeSpawn as never);
    expect(fakeSpawn).toHaveBeenCalledTimes(1);
    return new Promise<void>((done) => {
      children[0].stdout.write('{"t":1,"alive":true}\nwarning text\n{"t":2,');
      children[0].stdout.end('"alive":false}\n');
      setImmediate(() => {
        expect(seen).toEqual([{ t: 1, alive: true }, { t: 2, alive: false }]);
        children[0].emit("exit", 0);
        vi.advanceTimersByTime(5000);
        expect(fakeSpawn).toHaveBeenCalledTimes(2);
        probe.stop();
        expect(children[1].kill).toHaveBeenCalled();
        children[1].emit("exit", 1);
        vi.advanceTimersByTime(5000);
        expect(fakeSpawn).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
        done();
      });
    });
  });
});
