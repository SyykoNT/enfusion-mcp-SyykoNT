import { describe, it, expect } from "vitest";
import { mergeSummaries, parseLogTime, parseScriptErrors, scriptErrorParser } from "../../src/workbench/script-errors.js";

// Block shapes from 1.8 Workbench, client and server logs; vanilla names, test strings.
const HEADER = ["---------------------------------------------", "Log C:\\TestKit\\logs\\logs_2026-10-24_15-00-36\\console.log started at 2026-10-24 15:00:36 (2026-10-24 19:00:36 UTC)", ""];

const CLASS_BLOCK = (time: string, fn = "RefreshTooltip", prefix = "Scripts") => [
  `${time}  SCRIPT    (E): Virtual Machine Exception`,
  "",
  "Reason: NULL pointer to instance",
  "",
  "Class:      'SCR_LinkTooltipTargetEditorUIComponent'",
  `Function: '${fn}'`,
  "Stack trace:",
  `${prefix}/Game/Editor/UI/Components/Tooltips/Targets/SCR_BaseTooltipTargetEditorUIComponent.c:48 Function RefreshTooltip`,
  "Scripts/Game/Editor/UI/Components/Tooltips/Targets/SCR_LinkTooltipTargetEditorUIComponent.c:15 Function SetInfo",
  "",
];

const NO_CLASS_BLOCK = [
  "18:57:26.747 SCRIPT    (E): Virtual Machine Exception",
  "",
  "Reason: [TEST LOADOUT ERROR] ",
  "",
  " UNABLE TO INSERT ITEM BOX_TEST ",
  " NOT ENOUGH SPACE IN ENTITY/INVALID ITEM!",
  "",
  "Function: 'LogItemError#2778865'",
  "Stack trace:",
  "Scripts/Game/Test/TST_LoggingHelper.c:35 Function LogItemError#2778865",
  "Scripts/Game/game.c:885 Function OnUpdate",
  "",
];

const parse = (lines: string[], opts = {}) => {
  const p = scriptErrorParser(opts);
  lines.forEach((l) => p.line(l));
  return p.summary();
};

describe("scriptErrorParser", () => {
  it("parses a block with Class and groups repeats", () => {
    const s = parse([...HEADER, ...CLASS_BLOCK("15:04:01.964"), ...CLASS_BLOCK("15:04:02.100")]);
    expect(s.vme).toBe(2);
    expect(s.groups).toHaveLength(1);
    const g = s.groups[0];
    expect(g).toMatchObject({ kind: "vme", count: 2, reason: "NULL pointer to instance", className: "SCR_LinkTooltipTargetEditorUIComponent", func: "RefreshTooltip" });
    expect(g.frames[0]).toEqual({ file: "Scripts/Game/Editor/UI/Components/Tooltips/Targets/SCR_BaseTooltipTargetEditorUIComponent.c", line: 48, func: "RefreshTooltip" });
    expect(g.frames).toHaveLength(2);
    expect(new Date(g.first)).toEqual(new Date(2026, 9, 24, 15, 4, 1, 964));
  });

  it("parses a block without Class and a reason over several lines, merging #n suffixes", () => {
    const second = NO_CLASS_BLOCK.map((l) => l.replace("18:57:26.747", "18:57:27.001").replace(/#2778865/g, "#961057"));
    const s = parse([...NO_CLASS_BLOCK, ...second]);
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0]).toMatchObject({
      count: 2,
      className: undefined,
      func: "LogItemError",
      reason: "[TEST LOADOUT ERROR] UNABLE TO INSERT ITEM BOX_TEST NOT ENOUGH SPACE IN ENTITY/INVALID ITEM!",
    });
    expect(s.groups[0].frames[0].file).toBe("Scripts/Game/Test/TST_LoggingHelper.c");
  });

  it("merges Scripts/ and scripts/ spellings and ends a server stack at the next timestamped line", () => {
    const server = CLASS_BLOCK("13:36:10.000", "RefreshTooltip", "scripts").filter((l) => l !== "");
    const s = parse([...server, "13:36:10.050   SCRIPT       : next line", ...CLASS_BLOCK("13:36:11.000")]);
    expect(s.vme).toBe(2);
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0].frames).toHaveLength(2); // the timestamped line is not a frame
  });

  it("masks runtime errors with up to 3 examples and never counts compile errors", () => {
    const prefab = (g: string, p: string) => `10:00:00.000 SCRIPT    (E): Provided prefab '{${g}}Prefabs/${p}.et' is invalid!`;
    const s = parse([
      prefab("0123456789ABCDEF", "A"),
      prefab("1123456789ABCDEF", "B"),
      prefab("2123456789ABCDEF", "C"),
      prefab("3123456789ABCDEF", "D"),
      `10:00:01.000 SCRIPT    (E): @"Scripts/Game/Foo.c,12": Undefined variable 'x'`,
      "10:00:01.000 SCRIPT    (E): Can't compile \"Game\" script module!",
      "10:00:02.000 SCRIPT    (E): Faction '12' is not a valid SCR_Faction",
      "10:00:02.500 SCRIPT    (E): Faction '11' is not a valid SCR_Faction",
    ]);
    expect(s.vme).toBe(0);
    expect(s.errors).toBe(6);
    const [p, f] = s.groups;
    expect(p).toMatchObject({ kind: "error", count: 4, message: "Provided prefab '<resource>' is invalid!" });
    expect(p.examples).toHaveLength(3);
    expect(f).toMatchObject({ count: 2, message: "Faction '<n>' is not a valid SCR_Faction" });
    expect(f.examples).toEqual(["Faction '12' is not a valid SCR_Faction", "Faction '11' is not a valid SCR_Faction"]);
  });

  it("rolls over midnight and applies since on the right day", () => {
    const head = HEADER.map((l) => l.replace("2026-10-24 15:00:36", "2026-10-24 23:50:00"));
    const lines = [...head, ...CLASS_BLOCK("23:59:59.990"), "00:00:00.005 SCRIPT    (E): late", "23:59:59.999 SCRIPT    (E): out of order", "00:00:05.000 SCRIPT    (E): late"];
    const s = parse(lines);
    const late = s.groups.find((g) => g.message === "late")!;
    expect(new Date(late.last)).toEqual(new Date(2026, 9, 25, 0, 0, 5));
    expect(new Date(s.groups.find((g) => g.message === "out of order")!.first)).toEqual(new Date(2026, 9, 24, 23, 59, 59, 999));
    const after = parse(lines, { since: "00:00" });
    expect(after.vme).toBe(0);
    expect(after.errors).toBe(2); // 00:00 is the day after the 23:50 start, so both 23:59 lines are before it
  });

  it("counts a block cut off at the end of the log", () => {
    const s = parse(CLASS_BLOCK("15:04:01.964").slice(0, 5));
    expect(s.vme).toBe(1);
    expect(s.groups[0].frames).toEqual([]);
  });

  it("filters kinds, streams and merges sessions", async () => {
    const lines = [...CLASS_BLOCK("15:04:01.964"), "15:05:00.000 SCRIPT    (E): Something failed 3 times"];
    expect((await parseScriptErrors(lines, { kinds: ["error"] })).groups.map((g) => g.kind)).toEqual(["error"]);
    expect((await parseScriptErrors(lines, { kinds: ["vme"] })).errors).toBe(0);
    const a = await parseScriptErrors(lines, { session: "logs_a" });
    const b = await parseScriptErrors(lines, { session: "logs_b" });
    const m = mergeSummaries([a, b]);
    expect(m).toMatchObject({ vme: 2, errors: 2 });
    expect(m.groups[0]).toMatchObject({ count: 2, sessions: ["logs_a", "logs_b"] });
  });

  it("parseLogTime keeps untimed lines undefined", () => {
    expect(parseLogTime(undefined, "Stack trace:")).toBeUndefined();
  });
});
