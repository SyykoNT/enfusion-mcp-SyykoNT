import { describe, it, expect } from "vitest";
import { ANSWER_SCRIPT, DIALOG_SCRIPT, answerDialog, runPs, withArgs, type PsRunner } from "../../src/watchdog/probe.js";
import { textHash } from "../../src/watchdog/signals.js";

const body = ANSWER_SCRIPT.split("# --- answer body ---")[1];

describe("ANSWER_SCRIPT", () => {
  it("has a body that sends no input, focuses nothing and posts no window message", () => {
    expect(body.length).toBeGreaterThan(300);
    for (const banned of ["SetForegroundWindow", "SetFocus", "ShowWindow", "SendInput", "SendKeys", "PostMessage", "SendMessage", "keybd_event", "mouse_event", "Stop-Process", "taskkill", "WM_CLOSE"]) {
      expect(body, banned).not.toContain(banned);
    }
  });

  it("presses with one UI Automation Invoke, and only the buttons Yes, No and Yes to All", () => {
    expect(body.match(/Invoke\(/g)).toHaveLength(1);
    expect(body).toContain("1 { 'Yes' } 2 { 'No' } 3 { 'Yes to All' } default { $null }");
    expect(body).not.toContain("No to All");
    expect(body).toContain("-ceq $want");
  });

  it("re-checks the owner PID, visibility, the exact title, the text hash and a single exactly named button before pressing", () => {
    for (const check of [
      "$owner -ne $WbPid", "IsWindowVisible($h)", "-cne 'Script Authorization Required'", "$hash -ne [uint64]$TextHash", "$btn.Count -ne 1",
    ]) {
      expect(body, check).toContain(check);
    }
    expect(body.indexOf("$hash -ne")).toBeLessThan(body.indexOf("Invoke("));
    expect(body.indexOf("$btn.Count -ne 1")).toBeLessThan(body.indexOf("Invoke("));
  });

  it("is given integers only: the PID, the window, the choice and the text hash", () => {
    const s = withArgs(ANSWER_SCRIPT, { WbPid: 7, Hwnd: 100, Choice: 2, TextHash: 3735928559 });
    expect(s.startsWith("$WbPid = 7\n$Hwnd = 100\n$Choice = 2\n$TextHash = 3735928559\n")).toBe(true);
    expect(() => withArgs(ANSWER_SCRIPT, { Choice: Number("1; Stop-Process") })).toThrow(/integer/);
  });

  it("leaves DIALOG_SCRIPT as it was: a read-only body that never invokes", () => {
    const dialogBody = DIALOG_SCRIPT.split("# --- dialog probe body ---")[1];
    expect(dialogBody).not.toContain("Invoke(");
    expect(dialogBody).not.toContain("InvokePattern");
  });
});

describe("answerDialog through a stub runner", () => {
  const stub = (out: string, code = 0) => {
    const calls: { script: string; timeout?: number }[] = [];
    const run: PsRunner = async (script, timeout) => (calls.push({ script, timeout }), { code, out });
    return { run, calls };
  };

  it("runs the script once with the four integers and returns its last line", async () => {
    const { run, calls } = stub("noise\r\nanswered Yes\r\n");
    expect(await answerDialog(9, 77, 1, 123, run)).toBe("answered Yes");
    expect(calls).toHaveLength(1);
    expect(calls[0].script.split("\n").slice(0, 4)).toEqual(["$WbPid = 9", "$Hwnd = 77", "$Choice = 1", "$TextHash = 123"]);
  });

  it("refuses a choice that is not 1, 2 or 3 without running anything (No to All does not exist)", async () => {
    const { run, calls } = stub("answered No to All");
    expect(await answerDialog(9, 77, 4 as 1, 123, run)).toMatch(/^refused: choice/);
    expect(await answerDialog(9, 77, 0 as 1, 123, run)).toMatch(/^refused: choice/);
    expect(calls).toHaveLength(0);
  });

  it("passes the script's refusal on, and says so when the script printed nothing", async () => {
    expect(await answerDialog(9, 77, 2, 1, stub("refused: the dialog text changed\r\n", 2).run)).toBe("refused: the dialog text changed");
    expect(await answerDialog(9, 77, 2, 1, stub("", 1).run)).toMatch(/^refused: the answer check failed \(exit 1\)/);
  });
});

// The scripts run in Windows PowerShell and use UI Automation, so only a Windows machine can run them.
describe.skipIf(process.platform !== "win32")("ANSWER_SCRIPT in PowerShell", () => {
  it("refuses a window that is not there, and recomputes the same hash as textHash (also for non-ASCII text)", async () => {
    const gone = await runPs(withArgs(ANSWER_SCRIPT, { WbPid: 4, Hwnd: 1, Choice: 1, TextHash: 0 }), 30_000);
    expect(gone.out.trim()).toBe("refused: the window is gone or is not a window of that Workbench");
    expect((await runPs(withArgs(ANSWER_SCRIPT, { WbPid: 4, Hwnd: 1, Choice: 4, TextHash: 0 }), 30_000)).out.trim()).toBe("refused: choice must be 1, 2 or 3");

    // The hash loop of the script, run on its own over a sample text
    const loop = ANSWER_SCRIPT.split("\n").filter((l) => l.startsWith("[uint64]$hash") || l.startsWith("foreach ($c in $text.ToCharArray())")).join("\n");
    const sample = "Allow script 'Scripts/Game/ä.c:32'\nmethod 'X.Y'? 😀";
    const ps = `$text = ('Allow script ''Scripts/Game/' + [string][char]228 + '.c:32''' + [string][char]10 + 'method ''X.Y''? ' + [string][char]0xD83D + [string][char]0xDE00)\n${loop}\n$hash`;
    const r = await runPs(ps, 30_000);
    expect(Number(r.out.trim())).toBe(textHash(sample));
  });
});
