import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSTANCE_FILE,
  OWNER,
  classify,
  pidInstanceFile,
  isOwned,
  planStop,
  scan,
  writeInstance,
  type Instance,
} from "../../src/utils/instances.js";
import type { ProcInfo } from "../../src/utils/process.js";

const T = 1_761_890_000_000;
const proc = (pid: number, cmd = "", created = T): ProcInfo => ({ pid, ppid: 1, cmd, created });
const inst = (pid: number, over: Partial<Instance> = {}): Instance => ({
  kind: "server", name: "default", pid, ownerPid: OWNER.pid, ownerStartedAt: OWNER.startedAt, startedAt: T, exe: "x.exe", ...over,
});

describe("classify", () => {
  it("own: this MCP started it and the PID still matches", () => {
    expect(classify(inst(10), proc(10))).toBe("own");
  });

  it("stale: the PID was reused (creation time far from startedAt)", () => {
    expect(classify(inst(10), proc(10, "", T + 60_000))).toBe("stale");
  });

  it("stale: a missing, string or NaN startedAt never reads as own", () => {
    for (const startedAt of [undefined, String(T), NaN]) {
      expect(classify(inst(10, { startedAt: startedAt as unknown as number }), proc(10))).toBe("stale");
    }
  });

  it("orphan: the owner MCP is gone, or its PID now belongs to a newer process", () => {
    const other = { ownerPid: 999_999, ownerStartedAt: T - 1000 };
    expect(classify(inst(10, other), proc(10), undefined)).toBe("orphan");
    expect(classify(inst(10, other), proc(10), T + 3_600_000)).toBe("orphan");
  });

  it("foreign: another live MCP, or no instance file at all", () => {
    expect(classify(inst(10, { ownerPid: 999_999, ownerStartedAt: T - 1000 }), proc(10), T - 1200)).toBe("foreign");
    expect(classify(undefined, proc(10))).toBe("foreign");
  });
});

describe("scan", () => {
  it("finds server files through -profile and treats a server without one as foreign", () => {
    const profile = mkdtempSync(join(tmpdir(), "emcp-srv-"));
    writeInstance(join(profile, INSTANCE_FILE), inst(10, { profileDir: profile }));
    const entries = scan([proc(10, `x.exe -profile "${profile}"`), proc(11, "x.exe -profile C:\\elsewhere"), proc(12, "x.exe")], {
      ownerCreated: () => undefined,
    });
    expect(entries.map((e) => e.cls)).toEqual(["own", "foreign", "foreign"]);
  });

  it("finds client files by PID; the user's own game (no file) is foreign", () => {
    const root = mkdtempSync(join(tmpdir(), "emcp-cli-"));
    writeInstance(pidInstanceFile(root, 20), inst(20, { kind: "client" }));
    const entries = scan([proc(20, "ArmaReforgerSteamDiag.exe -client 127.0.0.1"), proc(21, "ArmaReforgerSteam.exe")], { clientRoot: root });
    expect(entries.map((e) => e.cls)).toEqual(["own", "foreign"]);
  });

  it("looks up each other owner once", () => {
    const root = mkdtempSync(join(tmpdir(), "emcp-cli-"));
    const other = { kind: "client" as const, ownerPid: 999_999, ownerStartedAt: T - 1000 };
    writeInstance(pidInstanceFile(root, 30), inst(30, other));
    writeInstance(pidInstanceFile(root, 31), inst(31, other));
    let lookups = 0;
    const entries = scan([proc(30), proc(31)], { clientRoot: root, ownerCreated: () => (lookups++, T - 1200) });
    expect(entries.map((e) => e.cls)).toEqual(["foreign", "foreign"]);
    expect(lookups).toBe(1);
  });
});

describe("isOwned (Workbench registry)", () => {
  const root = mkdtempSync(join(tmpdir(), "emcp-wb-"));
  writeInstance(pidInstanceFile(root, 70), inst(70, { kind: "workbench" }));
  writeInstance(pidInstanceFile(root, 72), inst(72, { kind: "workbench", ownerPid: 999_999, ownerStartedAt: T - 1000 }));

  it("is true for a Workbench this MCP spawned", () => {
    expect(isOwned(70, root, proc(70))).toBe(true);
  });

  it("is false when the process start time differs (PID reused)", () => {
    expect(isOwned(70, root, proc(70, "", T + 60_000))).toBe(false);
  });

  it("is false with no record (the user's own Workbench) or another MCP's record", () => {
    expect(isOwned(71, root, proc(71))).toBe(false);
    expect(isOwned(72, root, proc(72))).toBe(false);
  });
});

describe("planStop", () => {
  const root = join(tmpdir(), "emcp-roots");
  const own = { proc: proc(1), cls: "own" as const, inst: inst(1), file: join(root, "a", INSTANCE_FILE) };
  const foreign = { proc: proc(2), cls: "foreign" as const };
  const otherMcp = { proc: proc(3), cls: "foreign" as const, inst: inst(3, { name: "pbr50", ownerPid: 18820 }), file: join(tmpdir(), "x", INSTANCE_FILE) };
  const orphanInRoot = { proc: proc(4), cls: "orphan" as const, inst: inst(4, { name: "old" }), file: join(root, "b", INSTANCE_FILE) };
  const orphanOutside = { proc: proc(5), cls: "orphan" as const, inst: inst(5, { name: "far" }), file: join(tmpdir(), "far", INSTANCE_FILE) };

  it("stops nothing when no own instance runs", () => {
    expect(planStop([foreign, otherMcp], { roots: [root] }).stop).toEqual([]);
  });

  it("stops own instances and leaves foreign ones alone", () => {
    expect(planStop([own, foreign, otherMcp], { roots: [root] }).stop).toEqual([own]);
  });

  it("refuses a named instance owned by another live MCP", () => {
    const r = planStop([own, otherMcp], { instance: "pbr50", roots: [root] });
    expect(r.stop).toEqual([]);
    expect(r.error).toContain("another session (MCP pid 18820)");
  });

  it("adopts orphans only with adoptOrphans and only under the MCP's own roots", () => {
    expect(planStop([orphanInRoot, orphanOutside], { roots: [root] }).stop).toEqual([]);
    expect(planStop([orphanInRoot, orphanOutside], { adoptOrphans: true, roots: [root] }).stop).toEqual([orphanInRoot]);
    expect(planStop([orphanInRoot], { instance: "old", roots: [root] }).error).toContain("adoptOrphans=true");
  });
});
