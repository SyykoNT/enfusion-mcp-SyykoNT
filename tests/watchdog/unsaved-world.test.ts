import { describe, it, expect, vi } from "vitest";
import { unsavedWorld } from "../../src/watchdog/signals.js";
import { TITLES_SCRIPT, probeTitles, type PsRunner } from "../../src/watchdog/probe.js";

const wins = (...texts: string[]) => texts.map((text) => ({ text }));

describe("unsavedWorld (titles from the B-089 T1 record, Workbench 1.9.0.37)", () => {
  it("the dirty title returns the world", () => {
    expect(unsavedWorld(wins("World Editor - MCPParity/Worlds/MCPParity.ent*"))).toEqual({ state: "unsaved", world: "MCPParity/Worlds/MCPParity.ent" });
  });

  it.each([
    "World Editor - MCPParity/Worlds/MCPParity.ent",
    "World Editor - ArmaReforger/worlds/MP/MpTest/MpTest_Empty.ent",
    "Enfusion Workbench - TuningTest19",
    "World Editor - Unnamed empty world",
    "World Editor - Playing in Fullscreen",
    "Loading world",
    "Script Authorization Required",
    "Script Editor - Scripts/Game/MyScript.c*", // another module's * is not an unsaved world
    "World Editor - A*B/Worlds/X.ent", // a * in the middle
    "Arma Reforger Workbench",
  ])("%s is clean", (title) => {
    expect(unsavedWorld(wins(title))).toEqual({ state: "clean" });
  });

  it("the Qt683QWindowToolSaveBits window is clean, and the World Editor window is found wherever it sits in the list", () => {
    const main = "Enfusion Workbench - MCP Parity Test (throwaway)";
    expect(unsavedWorld(wins("Arma Reforger Workbench", main, "World Editor - MCPParity/Worlds/MCPParity.ent"))).toEqual({ state: "clean" });
    expect(unsavedWorld(wins("Arma Reforger Workbench", main, "World Editor - MCPParity/Worlds/MCPParity.ent*"))).toEqual({ state: "unsaved", world: "MCPParity/Worlds/MCPParity.ent" });
  });

  it("an empty window list is unknown, never clean", () => {
    expect(unsavedWorld([])).toEqual({ state: "unknown" });
  });
});

describe("TITLES_SCRIPT", () => {
  it("is read-only: it declares the five getters and nothing that posts, focuses, shows or automates", () => {
    expect([...TITLES_SCRIPT.matchAll(/static extern \w+ (\w+)\(/g)].map((m) => m[1]).sort()).toEqual(
      ["EnumWindows", "GetClassName", "GetWindowText", "GetWindowThreadProcessId", "IsWindowVisible"]
    );
    for (const banned of ["PostMessage", "SendMessage", "SetForegroundWindow", "ShowWindow", "System.Windows.Automation", "UIAutomation"]) {
      expect(TITLES_SCRIPT).not.toContain(banned);
    }
  });
});

describe("probeTitles through a stub runner", () => {
  const reply = (code: number, out: string): PsRunner => vi.fn(async () => ({ code, out }));

  it("returns the windows and runs the script for the PID with the 8 s timeout", async () => {
    const run = reply(0, '{"wins":[{"cls":"Qt683QWindowIcon","text":"World Editor - A/B.ent*"}]}\r\n');
    expect(await probeTitles(7, run)).toEqual({ wins: [{ cls: "Qt683QWindowIcon", text: "World Editor - A/B.ent*" }] });
    expect(run).toHaveBeenCalledWith(expect.stringMatching(/^\$WbPid = 7\n/), 8000);
  });

  it("an empty list stays an empty list", async () => {
    expect(await probeTitles(7, reply(0, '{"wins":[]}'))).toEqual({ wins: [] });
  });

  it.each([
    ["a failed or timed out run", reply(1, "")],
    ["output that is not JSON", reply(0, "not json")],
    ["output without a window list", reply(0, '{"other":1}')],
    ["a runner that throws", vi.fn(() => Promise.reject(new Error("no powershell")))],
  ])("%s is unavailable", async (_n, run) => {
    expect(await probeTitles(7, run as PsRunner)).toHaveProperty("unavailable");
  });
});
