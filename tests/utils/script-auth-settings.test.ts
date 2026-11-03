import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseAuthMode, type Config } from "../../src/config.js";
import { crashLogsDir } from "../../src/workbench/cli.js";
import { buildLaunchArgs } from "../../src/workbench/client.js";
import { SERVER_INSTRUCTIONS } from "../../src/server-instructions.js";
import { refusedArg } from "../../src/utils/process.js";
import { logger } from "../../src/utils/logger.js";

// loadConfig reads ~/.enfusion-mcp/config.json: point it at an empty folder so a real config cannot change the results.
const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (orig) => {
  const actual = await orig<typeof import("node:os")>();
  home.dir = `${actual.tmpdir()}/emcp-script-auth-home-${process.pid}`;
  return { ...actual, homedir: () => home.dir };
});

const saved = { auth: process.env.ENFUSION_SCRIPT_AUTH, dir: process.env.ENFUSION_CRASH_LOGS_DIR };
afterEach(() => {
  for (const [k, v] of [["ENFUSION_SCRIPT_AUTH", saved.auth], ["ENFUSION_CRASH_LOGS_DIR", saved.dir]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

describe("ENFUSION_SCRIPT_AUTH", () => {
  it("unset and rules give rules; all and off read as such, in any case", () => {
    expect(loadConfig().scriptAuth).toBe("rules");
    for (const [value, mode] of [["rules", "rules"], ["all", "all"], ["off", "off"], ["ALL", "all"], [" Off ", "off"]] as const) {
      process.env.ENFUSION_SCRIPT_AUTH = value;
      expect(loadConfig().scriptAuth, value).toBe(mode);
    }
  });

  it("any other value gives rules, with a warning", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    process.env.ENFUSION_SCRIPT_AUTH = "yes-to-all";
    expect(loadConfig().scriptAuth).toBe("rules");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"yes-to-all"'));
    loadConfig();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("ENFUSION_SCRIPT_AUTH"))).toHaveLength(1); // once per process
    expect(parseAuthMode("sometimes")).toEqual({ mode: "rules", invalid: "sometimes" });
    expect(parseAuthMode(true)).toEqual({ mode: "rules", invalid: "true" });
    expect(parseAuthMode(undefined)).toEqual({ mode: "rules" });
  });

  it("the config file is read by the same rule, and the variable wins", () => {
    mkdirSync(join(home.dir, ".enfusion-mcp"), { recursive: true });
    const file = join(home.dir, ".enfusion-mcp", "config.json");
    writeFileSync(file, JSON.stringify({ scriptAuth: "all", crashLogsDir: "D:\\Crashes" }));
    try {
      expect(loadConfig()).toMatchObject({ scriptAuth: "all", crashLogsDir: "D:\\Crashes" });
      process.env.ENFUSION_SCRIPT_AUTH = "off";
      process.env.ENFUSION_CRASH_LOGS_DIR = "E:\\Other";
      expect(loadConfig()).toMatchObject({ scriptAuth: "off", crashLogsDir: "E:\\Other" });
    } finally {
      writeFileSync(file, "{}");
    }
  });
});

describe("ENFUSION_CRASH_LOGS_DIR", () => {
  it("unset gives Workbench Crash Logs beside the Workbench profile folder", () => {
    const profile = mkdtempSync(join(tmpdir(), "emcp-crash-"));
    mkdirSync(join(profile, "Workbench", "logs"), { recursive: true });
    const config = { projectPath: join(profile, "Workbench", "addons") } as Config;
    expect(crashLogsDir(config)).toBe(join(profile, "Workbench Crash Logs"));
    expect(crashLogsDir({ ...config, crashLogsDir: "D:\\Crashes" })).toBe("D:\\Crashes");
  });

  it("the environment variable sets it", () => {
    process.env.ENFUSION_CRASH_LOGS_DIR = "E:\\Other";
    expect(loadConfig().crashLogsDir).toBe("E:\\Other");
    delete process.env.ENFUSION_CRASH_LOGS_DIR;
    expect(loadConfig().crashLogsDir).toBeUndefined();
  });
});

describe("-scriptAuthorizeAll stays impossible", () => {
  it("buildLaunchArgs never emits it, with or without a world and unattended", () => {
    for (const o of [{}, { gproj: "a.gproj" }, { gproj: "a.gproj", addonsDir: "d", unattended: true }, { gproj: "a.gproj", worldPath: "worlds/Map.ent" }]) {
      expect(buildLaunchArgs(o).join(" ").toLowerCase()).not.toContain("scriptauthorizeall");
    }
  });

  it("an extra argument naming it is refused, with any prefix", () => {
    for (const a of ["-scriptAuthorizeAll", "--scriptauthorizeall", "/ScriptAuthorizeAll", "+scriptAuthorizeAll"]) expect(refusedArg([a]), a).toBeDefined();
  });
});

describe("server instructions", () => {
  it("carry the one line about program-run dialogs and stay under 4,096 characters", () => {
    expect(SERVER_INSTRUCTIONS).toContain(
      'A "Script Authorization Required" dialog that asks to run a program is left open in the default mode; answer it with wb_watch answer, following the rules in that tool\'s description.'
    );
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(4096);
  });
});
