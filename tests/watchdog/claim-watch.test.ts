import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stub only readFileSync so a test can change what the claim reads back.
const readFile = vi.hoisted(() => ({ fn: undefined as undefined | ((...a: unknown[]) => unknown) }));
vi.mock("node:fs", async (orig) => {
  const fs = await orig<typeof import("node:fs")>();
  return { ...fs, readFileSync: (...a: unknown[]) => (readFile.fn ?? fs.readFileSync)(...(a as Parameters<typeof fs.readFileSync>)) };
});

import { claimWatch } from "../../src/watchdog/wb-watch.js";

const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "emcp-cl-"));
  return { dir, lock: join(dir, "19524.lock") };
};
const ago = (file: string, s: number) => utimesSync(file, new Date(Date.now() - s * 1000), new Date(Date.now() - s * 1000));

describe("claimWatch", () => {
  it("an empty lock under 5 s old is a claim in progress: held, not taken over", () => {
    const t = setup();
    writeFileSync(t.lock, "");
    expect(claimWatch(t.dir, 19524, () => false, 101)).toEqual({ ok: false, by: 0 });
    expect(existsSync(t.lock)).toBe(true);
  });

  it("an older empty or unparsable lock is stale and taken over", () => {
    for (const text of ["", "abc"]) {
      const t = setup();
      writeFileSync(t.lock, text);
      ago(t.lock, 10);
      expect(claimWatch(t.dir, 19524, () => false, 101), text).toEqual({ ok: true });
      expect(readFileSync(t.lock, "utf8")).toBe("101");
    }
  });

  it("a lock naming this very process (a reused PID of a dead watcher) is stale", () => {
    const t = setup();
    writeFileSync(t.lock, "101");
    expect(claimWatch(t.dir, 19524, () => true, 101)).toEqual({ ok: true });
  });

  it("the lock is read back after the write: a rival that replaced it wins, this claimer exits", () => {
    const t = setup();
    const real = readFile.fn;
    readFile.fn = () => "102"; // what the rival wrote after our write
    try {
      expect(claimWatch(t.dir, 19524, () => true, 101)).toEqual({ ok: false, by: 102 });
    } finally {
      readFile.fn = real;
    }
  });

  it("two claimers on a dead holder end with exactly one", () => {
    const t = setup();
    writeFileSync(t.lock, "999");
    let first: ReturnType<typeof claimWatch> | undefined;
    // Claimer 102 reads the dead holder 999; claimer 101 runs completely before 102 acts on it.
    const alive2 = (p: number) => {
      if (p === 999) first ??= claimWatch(t.dir, 19524, (q) => q !== 999, 101);
      return p === 101;
    };
    const second = claimWatch(t.dir, 19524, alive2, 102);
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: false, by: 101 });
    expect(readFileSync(t.lock, "utf8")).toBe("101");
  });
});
