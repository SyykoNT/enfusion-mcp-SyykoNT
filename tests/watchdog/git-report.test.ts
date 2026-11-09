import { describe, it, expect, vi } from "vitest";

const fail = vi.hoisted(() => ({ error: undefined as unknown }));
vi.mock("../../src/release/git.js", async (orig) => ({
  ...(await orig<typeof import("../../src/release/git.js")>()),
  gitOrNull: () => {
    throw fail.error;
  },
}));
import { gitReport } from "../../src/watchdog/auth.js";

const clone = [{ name: "COALITION-Lobby", root: "C:\\clone" }];

describe("gitReport failure line", () => {
  it("says 'git not available' only when git is missing", () => {
    fail.error = new Error("git not found on PATH");
    expect(gitReport(clone)).toBe("COALITION-Lobby: git not available (git not found on PATH)");
  });

  it("names any other failure with git's own first line", () => {
    fail.error = Object.assign(new Error("Command failed: git status"), { stderr: "fatal: detected dubious ownership\nhint: x" });
    expect(gitReport(clone)).toBe("COALITION-Lobby: git failed (fatal: detected dubious ownership)");
  });
});
