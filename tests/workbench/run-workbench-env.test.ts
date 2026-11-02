import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config.js";

// spawn is a stub that exits at once: no Workbench starts.
const sys = vi.hoisted(() => ({ env: [] as NodeJS.ProcessEnv[] }));
vi.mock("node:child_process", async (orig) => ({
  ...(await orig<typeof import("node:child_process")>()),
  spawn: vi.fn((_exe: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
    sys.env.push(opts.env ?? {});
    return { kill: () => {}, on: (ev: string, cb: (code: number) => void) => { if (ev === "close") setTimeout(() => cb(0)); } };
  }),
}));
vi.mock("../../src/utils/game-paths.js", async (orig) => ({
  ...(await orig<typeof import("../../src/utils/game-paths.js")>()),
  findWorkbenchExe: () => "C:\\Tools\\Workbench\\ArmaReforgerWorkbenchSteamDiag.exe",
}));

const { runWorkbench } = await import("../../src/workbench/cli.js");

describe("headless Workbench runs", () => {
  it("start as the Tools app in Steam and keep the rest of the environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "emcp-rw-"));
    const run = await runWorkbench({ projectPath: join(root, "projects"), gamePath: root, workbenchPath: root } as Config, ["-wbSilent"], 5000);
    expect(run.exitCode).toBe(0);
    expect(sys.env[0]).toMatchObject({ SteamAppId: "1874910", SteamGameId: "1874910" });
    expect(sys.env[0].PATH ?? sys.env[0].Path).toBe(process.env.PATH ?? process.env.Path);
  });
});
