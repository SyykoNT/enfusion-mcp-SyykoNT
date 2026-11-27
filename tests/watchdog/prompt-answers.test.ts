import { describe, it, expect } from "vitest";
import { decide, dialogKind, promptButton, promptKind, type Ctx, type Signals, type WinInfo } from "../../src/watchdog/signals.js";
import { PROMPT_SCRIPT, answerPrompt, type PsRunner } from "../../src/watchdog/probe.js";

// Window data only: no PowerShell or Workbench runs.
const box = (body: string, buttons = ["&Yes", "&No"]): WinInfo => ({
  hwnd: 500, cls: "#32770", text: "Workbench", visible: true,
  children: [{ hwnd: 501, cls: "Static", text: body }, ...buttons.map((b, i) => ({ hwnd: 510 + i, cls: "Button", text: b }))],
});
const RELOAD = "File 'scripts/Game/FH_Foo.c' has been modified by another program. Do you want to reload it?";
const SAVE = "Do you want to save changes to the world?";

describe("reload and save prompts", () => {
  it("reads the reload prompt and picks Yes, the save prompt and picks No", () => {
    expect(promptKind(box(RELOAD))).toBe("reload_prompt");
    expect(promptButton(box(RELOAD))).toBe(510);
    expect(promptKind(box(SAVE))).toBe("save_prompt");
    expect(promptButton(box(SAVE))).toBe(511);
    expect(dialogKind(box(SAVE))).toBe("save_prompt");
  });

  it("leaves anything else alone: other text, a Cancel button set, a hidden or non-#32770 window", () => {
    expect(promptKind(box("Delete the selected entities?"))).toBeUndefined();
    expect(promptKind(box(SAVE, ["&Save", "&Cancel"]))).toBeUndefined();
    expect(promptKind(box(SAVE, ["&Yes", "&Yes", "&No"]))).toBeUndefined();
    expect(promptKind({ ...box(SAVE), visible: false })).toBeUndefined();
    expect(promptKind({ ...box(SAVE), cls: "Qt5QWindowIcon" })).toBeUndefined();
  });

  const ctx = (over: Partial<Ctx> = {}): Ctx => ({ owned: false, dismiss: "watched", autoRecover: false, lockHeld: false, recoverAfterMs: 300_000, ...over });
  const sig = (kind: "reload_prompt" | "save_prompt", age: number): Signals => ({ now: 10_000 + age, alive: true, dialog: { hwnd: 500, kind, since: 10_000, button: 510 } });

  it("presses only when its setting is on, after 2 s, once, and within the dismiss scope", () => {
    expect(decide(sig("reload_prompt", 3000), ctx()).actions).toEqual([]);
    expect(decide(sig("reload_prompt", 1000), ctx({ reloadPrompt: "answer" })).actions).toEqual([]);
    expect(decide(sig("reload_prompt", 3000), ctx({ reloadPrompt: "answer" })).actions).toEqual([{ type: "click", hwnd: 500, button: 510, label: "Yes" }]);
    expect(decide(sig("save_prompt", 3000), ctx({ reloadPrompt: "answer" })).actions).toEqual([]);
    expect(decide(sig("save_prompt", 3000), ctx({ savePrompt: "answer" })).actions[0]).toMatchObject({ label: "No" });
    expect(decide({ ...sig("save_prompt", 3000), clicked: 500 }, ctx({ savePrompt: "answer" })).actions).toEqual([]);
    expect(decide(sig("save_prompt", 3000), ctx({ savePrompt: "answer", dismiss: "never" })).actions).toEqual([]);
  });

  it("a prompt left open is reported as blocked_dialog with its kind", () => {
    expect(decide(sig("save_prompt", 11_000), ctx())).toMatchObject({ state: "blocked_dialog", kind: "save_prompt" });
  });
});

describe("answerPrompt through a stub runner", () => {
  const runner = (look: WinInfo) => {
    const calls: string[] = [];
    const run: PsRunner = async (s) => {
      calls.push(s);
      return s.includes("$Button = 0") ? { code: 0, out: JSON.stringify(look) } : { code: 0, out: "clicked\r\n" };
    };
    return { run, calls };
  };

  it("re-reads the box, then presses Yes (choice 1) on a reload prompt", async () => {
    const { run, calls } = runner(box(RELOAD));
    expect(await answerPrompt(7, 500, run)).toBe("clicked");
    expect(calls[1]).toMatch(/^\$WbPid = 7\n\$Hwnd = 500\n\$Button = 510\n\$Choice = 1\n/);
  });

  it("presses No (choice 2) on a save prompt and refuses a box that is no longer a prompt", async () => {
    const save = runner(box(SAVE));
    expect(await answerPrompt(7, 500, save.run)).toBe("clicked");
    expect(save.calls[1]).toContain("$Button = 511\n$Choice = 2\n");
    const other = runner(box("Delete the selected entities?"));
    expect(await answerPrompt(7, 500, other.run)).toMatch(/^refused/);
    expect(other.calls).toHaveLength(1);
  });

  it("the press script never focuses or closes anything and only posts BM_CLICK", () => {
    for (const banned of ["SetForegroundWindow", "SetFocus", "ShowWindow", "WM_CLOSE", "Stop-Process", "taskkill", "SendKeys"]) expect(PROMPT_SCRIPT).not.toContain(banned);
    expect([...PROMPT_SCRIPT.matchAll(/\]::PostMessage\(([^)]*)\)/g)].map((m) => m[1].split(",")[1].trim())).toEqual(["0x00F5"]);
  });
});
