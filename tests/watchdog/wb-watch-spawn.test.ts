import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The spawn is a stub: no watcher process starts.
const spawnDetached = vi.hoisted(() => vi.fn((_exe: string, _args: string[], _cwd: string, _log?: string) => 1234));
vi.mock("../../src/utils/process.js", async (orig) => ({ ...(await orig<typeof import("../../src/utils/process.js")>()), spawnDetached }));

import { startWatcher } from "../../src/watchdog/wb-watch.js";

describe("startWatcher", () => {
  const base = () => ({ pid: 19524, owned: false, host: "127.0.0.1", port: 5775, stateDir: mkdtempSync(join(tmpdir(), "emcp-spawn-")) });

  it("passes --auto only for an automatic watch", () => {
    expect(startWatcher({ ...base(), auto: true })).toBe(1234);
    const withAuto = spawnDetached.mock.calls.at(-1)![1];
    expect(withAuto).toContain("--auto");
    expect(withAuto.slice(withAuto.indexOf("--pid"), withAuto.indexOf("--pid") + 2)).toEqual(["--pid", "19524"]);
    startWatcher(base());
    expect(spawnDetached.mock.calls.at(-1)![1]).not.toContain("--auto");
  });
});
