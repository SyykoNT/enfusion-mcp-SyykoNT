import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseAuthMode, parseAutoWatch, type Config } from "../../src/config.js";
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

const saved = { auth: process.env.ENFUSION_SCRIPT_AUTH, dir: process.env.ENFUSION_CRASH_LOGS_DIR, watch: process.env.ENFUSION_WB_AUTOWATCH };
afterEach(() => {
  for (const [k, v] of [["ENFUSION_SCRIPT_AUTH", saved.auth], ["ENFUSION_CRASH_LOGS_DIR", saved.dir], ["ENFUSION_WB_AUTOWATCH", saved.watch]] as const) {
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

describe("ENFUSION_WB_AUTOWATCH", () => {
  it("vitest.config.ts turns it off for every test", () => {
    expect(saved.watch).toBe("off");
  });

  it("unset or on, 1, true, yes in any case is on; off, 0, false, no is off", () => {
    delete process.env.ENFUSION_WB_AUTOWATCH;
    expect(loadConfig().autoWatch).toBe(true);
    for (const [value, on] of [["on", true], ["1", true], ["TRUE", true], [" yes ", true], ["off", false], ["0", false], ["false", false], ["NO", false]] as const) {
      process.env.ENFUSION_WB_AUTOWATCH = value;
      expect(loadConfig().autoWatch, value).toBe(on);
    }
  });

  it("any other value is off, with one warning per process", () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    process.env.ENFUSION_WB_AUTOWATCH = "sometimes";
    expect(loadConfig().autoWatch).toBe(false);
    loadConfig();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("ENFUSION_WB_AUTOWATCH"))).toEqual([['ENFUSION_WB_AUTOWATCH "sometimes" is not on or off; automatic watch is off.']]);
    expect(parseAutoWatch(undefined)).toEqual({ on: true });
    expect(parseAutoWatch(false)).toEqual({ on: false });
    expect(parseAutoWatch(2)).toEqual({ on: false, invalid: "2" });
  });

  it("the config file is read by the same rule, and the variable wins", () => {
    delete process.env.ENFUSION_WB_AUTOWATCH;
    mkdirSync(join(home.dir, ".enfusion-mcp"), { recursive: true });
    const file = join(home.dir, ".enfusion-mcp", "config.json");
    writeFileSync(file, JSON.stringify({ autoWatch: false }));
    try {
      expect(loadConfig().autoWatch).toBe(false);
      process.env.ENFUSION_WB_AUTOWATCH = "on";
      expect(loadConfig().autoWatch).toBe(true);
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
      'The watcher answers "Script Authorization Required" by ENFUSION_SCRIPT_AUTH; a dialog that asks to run a program is left open in the default mode; answer it with wb_watch answer, following the rules in that tool\'s description.'
    );
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(4096);
  });
});
