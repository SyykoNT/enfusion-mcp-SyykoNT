import { describe, it, expect } from "vitest";
import { join, resolve } from "node:path";
import {
  parseLogChunk, parseCrashLog, loadedProjects, likelyTrigger, leakAssertButton, lockHeldBy, portOwner, decide, newCarry,
  isDialog, dialogKind, formatDialogs,
  type Signals, type Ctx, type LogCarry, type WinInfo,
} from "../../src/watchdog/signals.js";

// Lines copied from logs_2026-10-31_06-12-43 (Workbench PID 19524, started 06:12:43), unless noted.
const L2215 = "06:13:27.050 DEFAULT      : Pending workshop invites request done (1)";
const L2216 = "09:32:52.901  SCRIPT       : SCRIPT       : Reloading game scripts";
const L2380 = "09:32:54.550  PROFILING    : Script validation took: 1568.574200 ms";
const L2381 = "09:32:55.739  RESOURCES    : ThermalProfile system/thermal/thermalProfileTerrainDefault.conf 65 bytes 160";
const L2431 = "12:01:28.636  ENGINE       : Game destroyed.";
const L2730 = "12:01:38.153 PROFILING    : Reloading game scripts took: 8925251.756100 ms";
const L2735 = "12:02:41.716 ENGINE    (W): Application hangs (generated dump and waiting) 63 s";
// logs_2026-10-31_01-20-00 console.log:2322-2323: a headless run that hung 60 s and went on logging.
const H2322 = "01:21:16.119 ENGINE    (W): Application hangs (generated dump and waiting) 60 s";
const H2323 = "01:21:16.124  SCRIPT    (W): Scripts/Game/NightVisionThermalComponent.c(1194): warning: No need to use 'Cast' for up-casting";
const CRASH = [
  "---------------------------------------------",
  "Log C:\\Users\\donmu\\OneDrive\\Documents\\My Games\\ArmaReforgerWorkbench\\logs\\logs_2026-10-31_06-12-43\\crash.log started at 2026-10-31 09:32:55 (2026-10-31 13:32:55 UTC)",
  "", "", "",
  "------------------------------------",
  "31.10 2026 09:32:55",
  "Assertion failed",
  "",
  "Program: C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arma Reforger Tools\\Workbench\\ArmaReforgerWorkbenchSteamDiag.exe",
  "File: E:\\jenkins\\workspace\\continuous_branches_stable_1.8.0\\ARGamecode\\Enfusion\\GameLib\\Source\\GameLib\\Framework\\GameApp.cpp",
  "Line: 1287",
  "",
  "Reason: Resources are leaking! Check log!",
].join("\r\n");

const at = (hms: string) => new Date(`2026-10-31T${hms}`).getTime();
const START = at("06:12:43.000");

/** Feed lines one tick at a time, as the watcher does, and keep what decide() needs. */
function replay(chunks: string[]) {
  let carry: LogCarry = newCarry(START);
  const s: Partial<Signals> = {};
  for (const text of chunks) {
    const r = parseLogChunk(text, carry);
    carry = r.carry;
    if (r.lastAt) s.lastLogAt = r.lastAt;
    for (const e of r.events) {
      if (e.kind === "reloadStart") s.reloadOpenSince = e.at;
      if (e.kind === "reloadEnd") s.reloadOpenSince = undefined;
      if (e.kind === "appHangs") s.hangAt = e.at;
      if (e.kind === "shutdown") s.shutdownSeen = true;
    }
  }
  return s;
}
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ owned: false, dismiss: "watched", autoRecover: false, lockHeld: false, recoverAfterMs: 300_000, ...over });

describe("parseLogChunk", () => {
  it("keeps a half-written line for the next chunk and stamps lines with the log day", () => {
    const a = parseLogChunk(`${L2215}\r\n09:32:52.901  SCRIPT       : SCRIPT       : Reloading ga`, newCarry(START));
    expect(a.events).toEqual([]);
    const b = parseLogChunk("me scripts\r\n", a.carry);
    expect(b.events).toEqual([{ kind: "reloadStart", at: at("09:32:52.901"), line: L2216 }]);
  });

  it("tells reload start from reload end and rolls over midnight", () => {
    const r = parseLogChunk(`${L2730}\n23:59:59.000 X : y\n00:00:01.000 X : z\n`, newCarry(START));
    expect(r.events.map((e) => e.kind)).toEqual(["reloadEnd"]);
    expect(r.lastAt).toBe(at("00:00:01.000") + 86_400_000);
  });
});

describe("parseCrashLog", () => {
  it("reads the assert reason, file and line", () => {
    expect(parseCrashLog(CRASH)).toEqual({
      reason: "Resources are leaking! Check log!",
      file: "E:\\jenkins\\workspace\\continuous_branches_stable_1.8.0\\ARGamecode\\Enfusion\\GameLib\\Source\\GameLib\\Framework\\GameApp.cpp",
      line: 1287,
      assert: true,
    });
  });
});

describe("loadedProjects", () => {
  // Windows only: the log holds C:\ paths, which node's path functions read as relative paths off Windows.
  it.skipIf(process.platform !== "win32")("follows Dependencies from the CLI -gproj, not every gproj line", () => {
    const head = [
      "06:12:44.479   ENGINE       : CLI Params: -gproj C:\\Arma Reforger Modding\\test-addons\\SYK_AMTest\\addon.gproj -addonsDir C:\\Arma Reforger Modding\\projects -wbModule WorldEditor",
      "06:12:44.794    ENGINE       : gproj: 'C:/Arma Reforger Modding/test-addons/SYK_AMTest/addon.gproj' guid: '4833511065131B41'",
      "06:12:44.794    ENGINE       : gproj: 'C:/Arma Reforger Modding/projects/Server-Hop/addon.gproj' guid: 'A08A4D2609C9E981'",
      "06:12:44.794    ENGINE       : gproj: 'C:/Arma Reforger Modding/projects/SyykoNT-VinDrinDop-Navmesh/addon.gproj' guid: '761C2D648D80BA76'",
    ].join("\n");
    const gproj: Record<string, string> = {
      [resolve("C:/Arma Reforger Modding/test-addons/SYK_AMTest/addon.gproj")]: 'GameProject {\n Dependencies {\n  "58D0FB3206B6F859" "761C2D648D80BA76"\n }\n}',
      [resolve("C:/Arma Reforger Modding/projects/SyykoNT-VinDrinDop-Navmesh/addon.gproj")]: 'GameProject {\n Dependencies {\n  "58D0FB3206B6F859" "4833511065131B41"\n }\n}',
    };
    expect(loadedProjects(head, (p) => gproj[p])).toEqual([
      resolve("C:/Arma Reforger Modding/test-addons/SYK_AMTest"),
      resolve("C:/Arma Reforger Modding/projects/SyykoNT-VinDrinDop-Navmesh"),
    ]);
  });
});

describe("replay of 2026-10-31", () => {
  const trigger = join("C:/Arma Reforger Modding/projects/SyykoNT-VinDrinDop-Navmesh/Scripts/Game/SYK_VDD", "SYK_VDD_BoatRouteData.c");
  const files = [
    { path: trigger, mtimeMs: at("09:32:52.635") },
    { path: "C:/elsewhere/Old.c", mtimeMs: at("09:20:00.000") },
  ];

  it("an idle gap of hours is ok", () => {
    const s = replay([`${L2215}\n`]);
    expect(decide({ ...s, now: at("09:30:00.000"), alive: true }, ctx()).state).toBe("ok");
  });

  it("reload plus crash.log is blocked_dialog leak_assert at 09:32:55 and names the saved .c file", () => {
    const s = replay([`${L2215}\n${L2216}\n`, `${L2380}\n${L2381}\n`]);
    const crash = { at: at("09:32:55.800"), ...parseCrashLog(CRASH) };
    const d = decide({ ...s, crash, now: at("09:32:55.900"), alive: true }, ctx());
    expect(d).toEqual({ state: "blocked_dialog", kind: "leak_assert", actions: [] });
    expect(likelyTrigger(files, s.reloadOpenSince!)).toEqual([trigger]);
  });

  it("is busy once Workbench logs again after the dialog, ok after the reload ends", () => {
    const crash = { at: at("09:32:55.800"), ...parseCrashLog(CRASH) };
    const busy = replay([`${L2216}\n${L2381}\n${L2431}\n`]);
    expect(decide({ ...busy, crash, now: at("12:01:30.000"), alive: true }, ctx()).state).toBe("busy");
    const done = replay([`${L2216}\n${L2381}\n${L2431}\n${L2730}\n`]);
    expect(decide({ ...done, crash, now: at("12:01:40.000"), alive: true }, ctx()).state).toBe("ok");
  });

  it("a reload with no end and no new line for 10 min is stalled", () => {
    const s = replay([`${L2216}\n`]);
    expect(decide({ ...s, now: at("09:42:52.000"), alive: true }, ctx()).state).toBe("busy");
    expect(decide({ ...s, now: at("09:42:53.000"), alive: true }, ctx()).state).toBe("stalled");
  });

  it("an Application hangs line is not_responding while it is the last line, not after the log goes on", () => {
    expect(decide({ ...replay([`${L2730}\n${L2735}\n`]), now: at("12:02:45.000"), alive: true }, ctx()).state).toBe("not_responding");
    expect(decide({ ...replay([`${H2322}\n${H2323}\n`]), now: at("01:21:20.000"), alive: true }, ctx()).state).toBe("ok");
  });

  it("IsHungAppWindow counts after 60 s", () => {
    const now = at("10:00:00.000");
    expect(decide({ now, alive: true, hungSince: now - 59_000 }, ctx()).state).toBe("ok");
    expect(decide({ now, alive: true, hungSince: now - 60_000 }, ctx()).state).toBe("not_responding");
  });

  it("gone with a fresh crash.log is crashed; gone after shutdown lines is exited", () => {
    const crash = { at: at("09:32:55.800"), ...parseCrashLog(CRASH) };
    expect(decide({ ...replay([`${L2381}\n`]), crash, now: at("09:33:00.000"), alive: false }, ctx()).state).toBe("crashed");
    expect(decide({ ...replay([`${L2381}\n`]), shutdownSeen: true, crash, now: at("09:33:00.000"), alive: false }, ctx()).state).toBe("exited");
    expect(decide({ now: at("09:33:00.000"), alive: false }, ctx()).state).toBe("exited");
  });
});

describe("decide: who may be clicked or killed", () => {
  const now = at("02:14:15.000");
  const leak = { hwnd: 11, kind: "leak_assert" as const, since: now - 6000, button: 12 };
  const clicks = (c: Ctx, dialog: Signals["dialog"] = leak) => decide({ now, alive: true, dialog }, c).actions.filter((a) => a.type === "click");

  it("clicks Ignore on an owned leak assert after 5 s, once", () => {
    expect(clicks(ctx({ owned: true }))).toEqual([{ type: "click", hwnd: 11, button: 12 }]);
    expect(clicks(ctx({ owned: true }), { ...leak, since: now - 4000 })).toEqual([]);
    expect(decide({ now, alive: true, dialog: leak, clicked: 11 }, ctx({ owned: true })).actions).toEqual([]);
  });

  it("clicks the leak assert in a Workbench it did not start (D-031, the default); owned and never do not", () => {
    expect(clicks(ctx({ owned: false }))).toEqual([{ type: "click", hwnd: 11, button: 12 }]);
    expect(clicks(ctx({ owned: false, dismiss: "owned" }))).toEqual([]);
    expect(clicks(ctx({ owned: false, dismiss: "never" }))).toEqual([]);
    expect(clicks(ctx({ owned: true, dismiss: "never" }))).toEqual([]);
  });

  it("never clicks a dialog that is not the leak assert, owned or not", () => {
    const other = { hwnd: 11, kind: "other" as const, since: now - 60_000 };
    expect(clicks(ctx({ owned: false }), other)).toEqual([]);
    expect(clicks(ctx({ owned: true }), other)).toEqual([]);
    // A leak assert seen without its &Ignore button is not clicked either.
    expect(clicks(ctx({ owned: false }), { ...leak, button: undefined })).toEqual([]);
  });

  it("never kills or recovers a Workbench it did not start, even with the Ignore click allowed", () => {
    const hungNow = { now, alive: true, hungSince: now - 400_000, dialog: leak };
    expect(decide(hungNow, ctx({ owned: false, autoRecover: true, lockHeld: true, badSince: now - 400_000 })).actions.map((a) => a.type)).toEqual(["click"]);
  });

  const hung = { now, alive: true, hungSince: now - 400_000 };
  const recover = (c: Partial<Ctx>) => decide(hung, ctx({ badSince: now - 340_000, autoRecover: true, ...c })).actions;

  it("recovers only an owned Workbench whose lock this session holds, after recoverAfterMin", () => {
    expect(recover({ owned: true, lockHeld: true })).toEqual([{ type: "recover" }]);
    expect(recover({ owned: false, lockHeld: true })).toEqual([]);
    expect(recover({ owned: true, lockHeld: false })).toEqual([]);
    expect(recover({ owned: true, lockHeld: true, autoRecover: false })).toEqual([]);
    expect(recover({ owned: true, lockHeld: true, recovered: true })).toEqual([]);
    expect(recover({ owned: true, lockHeld: true, badSince: now - 10_000 })).toEqual([]);
  });

  it("a lock held by a person is never ours: only a session line naming this session counts", () => {
    const lock = "owner: Don (AM test)\npid: 19524\nsince: 2026-10-31 06:12\n";
    expect(lockHeldBy(lock, { session: "s1" })).toBe(false);
    expect(lockHeldBy(lock, {})).toBe(false);
    expect(lockHeldBy("owner: overnight-boats\nsession: s1\n", { session: "s1" })).toBe(true);
    expect(lockHeldBy("owner: overnight-boats\nsession: s2\n", { session: "s1" })).toBe(false);
    expect(lockHeldBy(undefined, { session: "s1" })).toBe(false);
  });
});

// Title and text as SCN-STUB / P-SUB-1 read them from the live modal; hwnds and owner are made up.
const OBSOLETE = "File data structure of the world is obsolete and needs to be changed. Do you want to change it now?";
const validating = (over: Partial<WinInfo> = {}): WinInfo => ({
  hwnd: 5, cls: "Qt683QWindowIcon", text: "Validating $MCPParity:Worlds/ScnStub_V1.ent", visible: true,
  children: [{ hwnd: 0, cls: "Text", text: OBSOLETE }], buttons: ["Yes", "No"], ...over,
});

describe("isDialog", () => {
  it("is true for a window whose same-PID owner is disabled, even with an unknown title", () => {
    expect(isDialog(validating({ text: "Some new Qt dialog", owner: 4, ownerEnabled: false }))).toBe(true);
  });
  it("is false for a tool window that a modal disabled too (live PR-1: the Resource Browser under the Validating box)", () => {
    expect(isDialog({ hwnd: 9, cls: "Qt683QWindowToolSaveBits", text: "Resource Browser", visible: true, owner: 4, ownerEnabled: false, enabled: false })).toBe(false);
    expect(isDialog(validating({ owner: 4, ownerEnabled: false, enabled: true }))).toBe(true);
  });
  it("is false for an owned tool window whose owner is enabled, or whose owner is another process's", () => {
    expect(isDialog({ hwnd: 6, cls: "Qt683QWindowIcon", text: "Resource Browser", visible: true, owner: 4, ownerEnabled: true })).toBe(false);
    expect(isDialog({ hwnd: 6, cls: "Qt683QWindowIcon", text: "Tool", visible: true, owner: 4, ownerEnabled: null })).toBe(false);
  });
  it("falls back to the box class and the known titles when no owner was read", () => {
    expect(isDialog({ hwnd: 7, cls: "#32770", text: "Assertion", visible: true })).toBe(true);
    expect(isDialog(validating())).toBe(true);
    expect(isDialog({ hwnd: 8, cls: "Qt683QWindowIcon", text: "Opening world", visible: true })).toBe(true);
  });
  it("is false for the World Editor window and for a hidden window", () => {
    expect(isDialog({ hwnd: 4, cls: "Qt683QWindowIcon", text: "World Editor - MCPParity", visible: true, owner: 0, ownerEnabled: null })).toBe(false);
    expect(isDialog(validating({ visible: false, owner: 4, ownerEnabled: false }))).toBe(false);
  });
});

describe("dialogKind", () => {
  it.each<[string, WinInfo, string]>([
    ["leak assert", { hwnd: 1, cls: "#32770", text: "Assertion", visible: true, children: [{ hwnd: 2, cls: "Static", text: "Reason: Resources are leaking! Check log!" }, { hwnd: 3, cls: "Button", text: "&Ignore" }] }, "leak_assert"],
    ["script authorization", { hwnd: 1, cls: "Qt683QWindowIcon", text: "Script Authorization Required", visible: true }, "script_authorization"],
    ["open world prompt", { hwnd: 1, cls: "Qt683QWindowIcon", text: "Opening world", visible: true }, "open_world_prompt"],
    ["obsolete world", validating(), "obsolete_world"],
    ["save as", { hwnd: 1, cls: "Qt683QWindowIcon", text: "Save world as", visible: true }, "save_as"],
    ["anything else", validating({ text: "Validating x", children: [{ hwnd: 0, cls: "Text", text: "Please wait" }] }), "other"],
  ])("%s", (_n, win, kind) => {
    expect(dialogKind(win)).toBe(kind);
  });
});

describe("formatDialogs", () => {
  it("names one dialog with its class, text, buttons and kind", () => {
    expect(formatDialogs([{ pid: 89992, dialogs: [validating()] }])).toBe(
      "Workbench PID 89992 has a dialog open, which blocks every NET API call:\n" +
      `- "Validating $MCPParity:Worlds/ScnStub_V1.ent" (Qt683QWindowIcon): "${OBSOLETE}" buttons: Yes, No [obsolete_world]\n` +
      "The call may still run once the dialog is closed. Check the state before repeating it."
    );
  });
  it("says so when there is none, and when the check could not run", () => {
    expect(formatDialogs([{ pid: 7, dialogs: [] }])).toBe("No dialog was found in Workbench PID 7; it may be loading, compiling, hung, or showing a dialog this check cannot see.");
    expect(formatDialogs([{ pid: 7, unavailable: "boom" }])).toBe("Workbench PID 7 (dialog check unavailable: boom)");
    expect(formatDialogs([])).toBe("");
  });
  it("leaves out buttons with no name", () => {
    expect(formatDialogs([{ pid: 1, dialogs: [validating({ buttons: ["", "Yes", "", "No"] })] }])).toContain("buttons: Yes, No [");
  });
  it("caps the text of a dialog at 300 characters", () => {
    const long = validating({ children: [{ hwnd: 0, cls: "Text", text: "x".repeat(500) }] });
    expect(formatDialogs([{ pid: 1, dialogs: [long] }])).toContain(`"${"x".repeat(300)}" buttons`);
  });
});

describe("leakAssertButton and portOwner", () => {
  const box = (text: string, button: string) => ({
    hwnd: 1, cls: "#32770", text: "Assertion", visible: true,
    children: [{ hwnd: 2, cls: "Static", text: `Reason: ${text}` }, { hwnd: 3, cls: "Button", text: button }],
  });
  it("matches only the exact leak text with an &Ignore button", () => {
    expect(leakAssertButton(box("Resources are leaking! Check log!", "&Ignore"))).toBe(3);
    expect(leakAssertButton(box("Resources are leaking!", "&Ignore"))).toBeUndefined();
    expect(leakAssertButton(box("Resources are leaking! Check log!", "&Abort"))).toBeUndefined();
    expect(leakAssertButton({ ...box("Resources are leaking! Check log!", "&Ignore"), cls: "Qt5QWindowIcon" })).toBeUndefined();
  });
  it("reads the LISTENING PID from netstat -ano", () => {
    const out = "  TCP    127.0.0.1:57750   0.0.0.0:0   LISTENING   1\r\n  TCP    127.0.0.1:5775    0.0.0.0:0   LISTENING   22172\r\n";
    expect(portOwner(out, 5775)).toBe(22172);
    expect(portOwner(out, 5776)).toBeUndefined();
  });
});
