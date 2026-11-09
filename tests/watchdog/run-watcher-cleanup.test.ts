import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Only rmSync of a lock file is stubbed, to fail like a scanner holding it (EBUSY). No probe, PowerShell or Workbench runs.
const rm = vi.hoisted(() => ({ fail: false }));
vi.mock("node:fs", async (orig) => {
  const fs = await orig<typeof import("node:fs")>();
  return {
    ...fs,
    rmSync: (p: Parameters<typeof fs.rmSync>[0], o?: Parameters<typeof fs.rmSync>[1]) => {
      if (rm.fail && String(p).endsWith(".lock")) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      return fs.rmSync(p, o);
    },
  };
});

import { runWatcher } from "../../src/watchdog/wb-watch.js";

describe("runWatcher's finally (B-099 item 2)", () => {
  it("a lock that cannot be removed after a clean exit does not turn exit 0 into a throw", async () => {
    const stateDir = mkdtempSync(join(tmpdir(), "emcp-rw-"));
    let alive = true;
    rm.fail = true;
    try {
      const code = await runWatcher(
        { pid: 19524, owned: false, stateDir, dismiss: "watched", autoRecover: false, recoverAfterMin: 5, host: "127.0.0.1", port: 5775 },
        { probe: () => ({ stop: vi.fn() }), alive: () => alive, wait: () => new Promise((r) => setImmediate(() => { alive = false; r(undefined); })) }
      );
      expect(code).toBe(0);
    } finally {
      rm.fail = false;
    }
    expect(existsSync(join(stateDir, "19524.lock"))).toBe(true); // left behind; the next claim takes it over
  });
});
