import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";

// A fake home first, so WATCH_DIR is a temp folder; taskkill is a stub.
const home = mkdtempSync(join(tmpdir(), "emcp-wr-home-"));
process.env.USERPROFILE = process.env.HOME = home;

const kills = vi.hoisted(() => [] as unknown[][]);
vi.mock("../../src/utils/process.js", async (orig) => ({
  ...(await orig<typeof import("../../src/utils/process.js")>()),
  killPids: (...a: unknown[]) => kills.push(a),
  isAlive: () => true,
  processInfo: (pid: number) => ({ pid, ppid: 1, cmd: "node.exe C:\\x\\dist\\watchdog\\wb-watch.js --pid 19524", created: 0 }),
}));

const { registerWbWatch } = await import("../../src/tools/wb-watch-tool.js");
const { WATCH_DIR } = await import("../../src/watchdog/wb-watch.js");

describe("wb_watch stop as registered", () => {
  it("ends the watcher with its tree, so its probe PowerShell goes too (review N1)", async () => {
    let handler: (a: unknown) => Promise<{ content: { text: string }[] }> = async () => ({ content: [] });
    registerWbWatch({ registerTool: (_n: string, _s: unknown, h: typeof handler) => (handler = h) } as never, { projectPath: join(home, "projects") } as Config);
    expect(WATCH_DIR.startsWith(home)).toBe(true);
    mkdirSync(WATCH_DIR, { recursive: true });
    writeFileSync(join(WATCH_DIR, "19524.lock"), "600");
    writeFileSync(join(WATCH_DIR, "19524.json"), JSON.stringify({ pid: 19524, watcherPid: 600 }));
    const r = await handler({ action: "stop", pid: 19524 });
    expect(r.content[0].text).toBe("Stopped watcher PID 600 for Workbench PID 19524.");
    expect(kills).toEqual([[[600], true, true]]);
  });
});
