import { describe, it, expect } from "vitest";
import {
  PROGRAM_METHODS, authLine, authText, crashFiles, crashLine, decideAuth, decide, parseAuthDialog, parseAuthWindow, programCommand,
  recentPresses, textHash, type AuthInput, type Signals, type Ctx, type WinInfo,
} from "../../src/watchdog/signals.js";

// The verbatim dialog texts from the PA-1 to PA-4 probes (the two line breaks are in the one UIA Text), and the vanilla one from the lock file.
const FIND = "Allow script 'Scripts/Game/MCPAuthProbe/MCPAuthProbe_GameCalls.c:32'\nto access potentially dangerous\nmethod 'FileIO.FindFiles'?";
const MKDIR = "Allow script 'Scripts/Game/MCPAuthProbe/MCPAuthProbe_GameCalls.c:38'\nto access potentially dangerous\nmethod 'FileIO.MakeDirectory'?";
const RUNCMD = "Allow script 'Scripts/WorkbenchGame/MCPAuthProbe/MCPAuthProbe_Plugins.c:43'\nto access potentially dangerous\nmethod 'Workbench.RunCmd'?";
const VANILLA = "Allow script 'Scripts/Game/GameMode/Loadout/SCR_ArsenalManagerComponent.c:1101' to access potentially dangerous method 'BaseContainerTools.LoadContainer'?";

describe("parseAuthDialog", () => {
  it.each([
    [FIND, "Scripts/Game/MCPAuthProbe/MCPAuthProbe_GameCalls.c", 32, "FileIO.FindFiles"],
    [MKDIR, "Scripts/Game/MCPAuthProbe/MCPAuthProbe_GameCalls.c", 38, "FileIO.MakeDirectory"],
    [RUNCMD, "Scripts/WorkbenchGame/MCPAuthProbe/MCPAuthProbe_Plugins.c", 43, "Workbench.RunCmd"],
    [VANILLA, "Scripts/Game/GameMode/Loadout/SCR_ArsenalManagerComponent.c", 1101, "BaseContainerTools.LoadContainer"],
  ])("reads the script, line and method of %#", (text, script, line, method) => {
    expect(parseAuthDialog(text)).toEqual({ script, line, method });
    expect(parseAuthDialog(`${text}\r\n`)).toEqual({ script, line, method });
  });

  it.each([
    ["a changed wording", "Allow script 'a.c:1'\nto run dangerous\nmethod 'A.B'?"],
    ["no line number", "Allow script 'a.c'\nto access potentially dangerous\nmethod 'A.B'?"],
    ["a method with a space", "Allow script 'a.c:1'\nto access potentially dangerous\nmethod 'A B'?"],
    ["text after the question mark", `${FIND} Always?`],
    ["empty", ""],
  ])("does not read %s", (_n, text) => {
    expect(parseAuthDialog(text)).toBeUndefined();
  });

  it("reads the request from a window whose Text elements also list the button labels", () => {
    const w: WinInfo = {
      hwnd: 1, cls: "Qt683QWindowIcon", text: "Script Authorization Required", visible: true,
      children: [FIND, "Yes", "Yes to All", "No", "No to All"].map((text) => ({ hwnd: 0, cls: "Text", text })),
    };
    expect(parseAuthWindow(w)?.method).toBe("FileIO.FindFiles");
    expect(authText(w)).toBe(`${FIND}\nYes\nYes to All\nNo\nNo to All`);
    expect(parseAuthWindow({ ...w, children: [] })).toBeUndefined();
  });
});

describe("textHash", () => {
  it("is FNV-1a over UTF-16 code units", () => {
    expect(textHash("")).toBe(2166136261);
    expect(textHash("a")).toBe(0xe40c292c);
    expect(textHash(FIND)).not.toBe(textHash(MKDIR));
    expect(textHash("\u00e4\u{1f600}")).toBe(textHash("\u00e4\ud83d\ude00"));
  });
});

describe("decideAuth", () => {
  const parsed = (method: string) => ({ script: "Scripts/Game/X.c", line: 5, method });
  const base: AuthInput = { mode: "rules", inScope: true, parsed: parsed("FileIO.FindFiles"), inLoadSet: true, presses: 0 };
  const choice = (over: Partial<AuthInput>) => decideAuth({ ...base, ...over }).choice;

  it("rules: yes for a script in a loaded addon, whatever the addon", () => {
    // A test addon, a user mod, CRF, Lobby, a Workshop mod and vanilla all reach decideAuth as "in the load set"
    expect(choice({})).toBe("yes");
    expect(choice({ parsed: parsed("BaseContainerTools.LoadContainer") })).toBe("yes");
  });

  it("rules: no for a script that is not in the load set", () => {
    expect(choice({ inLoadSet: false })).toBe("no");
    expect(choice({ inLoadSet: false, parsed: parsed("Workbench.RunCmd") })).toBe("no");
  });

  it("rules: a program run, an unreadable dialog and an unreadable load set are left open", () => {
    for (const m of PROGRAM_METHODS) expect(choice({ parsed: parsed(m) })).toBe("report");
    expect(choice({ parsed: undefined })).toBe("report");
    expect(choice({ inLoadSet: undefined })).toBe("report");
  });

  it("all: Yes to All on every request, program runs and unreadable text included", () => {
    expect(choice({ mode: "all" })).toBe("yes_to_all");
    expect(choice({ mode: "all", inLoadSet: false })).toBe("yes_to_all");
    for (const m of PROGRAM_METHODS) expect(choice({ mode: "all", parsed: parsed(m) })).toBe("yes_to_all");
    expect(choice({ mode: "all", parsed: undefined, inLoadSet: undefined })).toBe("yes_to_all");
  });

  it("off, and a Workbench outside the per-watch scope: report in every mode", () => {
    for (const parsedOver of [parsed("FileIO.FindFiles"), parsed("Workbench.RunCmd"), undefined]) expect(choice({ mode: "off", parsed: parsedOver })).toBe("report");
    for (const mode of ["rules", "all", "off"] as const) expect(choice({ mode, inScope: false })).toBe("report");
  });

  it("the fourth automatic answer in 60 s is left open, in every mode", () => {
    const times = [1000, 2000, 3000];
    expect(recentPresses(times, 4000)).toBe(3);
    expect(recentPresses(times, 62_500)).toBe(1);
    expect(choice({ presses: 2 })).toBe("yes");
    expect(choice({ presses: 3 })).toBe("report");
    expect(choice({ mode: "all", presses: 3 })).toBe("report");
    expect(decideAuth({ ...base, presses: 3 }).reason).toMatch(/loop limit/);
  });
});

describe("programCommand: the command line comes from the named source line", () => {
  it("a string literal", () => {
    const src = ["class P {", "  void Run() {", '    Workbench.RunCmd("cmd /c exit 0", true);', "  }", "}"].join("\n");
    expect(programCommand(src, 3, "Workbench.RunCmd")).toBe("cmd /c exit 0");
  });

  it("a variable, a literal joined with a variable, and a call on another method are not readable", () => {
    expect(programCommand("  string cmd = x;\n  Workbench.RunCmd(cmd, true);\n", 2, "Workbench.RunCmd")).toBeUndefined();
    expect(programCommand('  Workbench.RunCmd("cmd /c " + name, true);\n', 1, "Workbench.RunCmd")).toBeUndefined();
    expect(programCommand('  Workbench.RunProcess("a.exe");\n', 1, "Workbench.RunCmd")).toBeUndefined();
  });

  it("a call split over two lines, with an escaped quote and backslashes", () => {
    const src = ["  Workbench.RunProcess(", '    "C:\\\\Tools\\\\run.exe --name \\"x\\"",', "    true);"].join("\n");
    expect(programCommand(src, 1, "Workbench.RunProcess")).toBe('C:\\Tools\\run.exe --name "x"');
  });

  it("reads only the named line and the next two", () => {
    const src = ["", "", "", '  Workbench.RunCmd("late", true);'].join("\n");
    expect(programCommand(src, 2, "Workbench.RunCmd")).toBe("late");
    expect(programCommand(src, 1, "Workbench.RunCmd")).toBeUndefined();
  });
});

describe("log lines", () => {
  it("an answered dialog: the line names choice, script, addon, method, mode, reason, git and .edds", () => {
    const line = authLine({
      time: "10:02:03", pid: 4242, choice: "yes", parsed: parseAuthDialog(FIND), addon: "MCPAuthProbe", mode: "rules", reason: "a script in a loaded addon",
      git: "COALITION-Lobby: 1 changed files, GearScriptsConfigList.json unchanged", edds: 0,
    });
    expect(line).toBe(
      "AUTH 10:02:03 PID 4242 YES script 'Scripts/Game/MCPAuthProbe/MCPAuthProbe_GameCalls.c:32' (MCPAuthProbe) method 'FileIO.FindFiles' mode rules reason a script in a loaded addon" +
        " [git: COALITION-Lobby: 1 changed files, GearScriptsConfigList.json unchanged] [edds changed in mounted folders, last 5 min: 0]"
    );
  });

  it("a program run left open names the command, or says it is not readable; an explicit answer is marked", () => {
    const base = { time: "10:02:03", pid: 1, choice: "report" as const, parsed: parseAuthDialog(RUNCMD), addon: "MCPAuthProbe", mode: "rules" as const, reason: "runs a program" };
    expect(authLine({ ...base, command: "cmd /c exit 0" })).toContain("LEFT OPEN script");
    expect(authLine({ ...base, command: "cmd /c exit 0" })).toContain("method 'Workbench.RunCmd' command 'cmd /c exit 0' mode rules");
    expect(authLine(base)).toContain("command not readable from source");
    expect(authLine({ ...base, choice: "no", explicit: true })).toContain("NO explicit script");
    expect(authLine({ ...base, choice: "yes_to_all", parsed: undefined, addon: undefined })).toContain("YES TO ALL script (unreadable) method (unreadable)");
  });

  it("text from a script is one short line", () => {
    const line = authLine({ time: "t", pid: 1, choice: "report", parsed: parseAuthDialog(RUNCMD), mode: "rules", reason: "r", command: `a${"\n"}b ${"x".repeat(500)}` });
    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThan(600);
  });

  it("a crash: copied files with sizes, what is missing, and the CrashReporter that was ended", () => {
    expect(
      crashLine({
        time: "09:32:55", pid: 7, reason: "Resources are leaking! Check log!", dir: "C:\\Crash\\2026-11-03_09-32-55_7",
        copied: [{ name: "crash.log", size: 120 }, { name: "a.mdmp", size: 9000 }], missing: ["error.log"], reporters: [{ pid: 88, ended: true }],
      })
    ).toBe(
      "CRASH 09:32:55 PID 7 reason Resources are leaking! Check log! copied 2 files to C:\\Crash\\2026-11-03_09-32-55_7 (crash.log 120 bytes, a.mdmp 9000 bytes) missing error.log CrashReporter 88 ended"
    );
    expect(crashLine({ time: "t", pid: 7, copied: [], missing: [], reporters: [] })).toContain("CrashReporter none");
    expect(crashLine({ time: "t", pid: 7, copied: [], missing: [], reporters: [{ pid: 9, ended: false, why: "x" }] })).toContain("CrashReporter 9 not ended (x)");
  });

  it("crashFiles picks crash.log, every .mdmp, console.log, error.log and script.log, and names what is missing", () => {
    expect(crashFiles(["console.log", "crash.log", "A.mdmp", "FREEZE_1.MDMP", "script.log", "other.txt"])).toEqual({
      copy: ["crash.log", "console.log", "script.log", "A.mdmp", "FREEZE_1.MDMP"],
      missing: ["error.log"],
    });
    expect(crashFiles([]).missing).toEqual(["crash.log", "console.log", "error.log", "script.log", "*.mdmp"]);
  });
});

describe("a Script Authorization dialog that stays open is reported as that kind", () => {
  const ctx: Ctx = { owned: false, dismiss: "watched", autoRecover: false, lockHeld: false, recoverAfterMs: 300_000 };
  const sig = (kind: "script_authorization" | "other"): Signals => ({ now: 20_000, alive: true, dialog: { hwnd: 1, kind, since: 5000 } });

  it("after 10 s the state is blocked_dialog with kind script_authorization, and it is never clicked", () => {
    expect(decide(sig("script_authorization"), ctx)).toEqual({ state: "blocked_dialog", kind: "script_authorization", actions: [] });
    expect(decide(sig("other"), ctx).kind).toBe("other");
  });
});
