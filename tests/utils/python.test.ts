import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const { execFileSync } = await import("node:child_process");
const exec = vi.mocked(execFileSync);

/** Fresh module each time, since findPython caches per process. */
async function find() {
  vi.resetModules();
  return (await import("../../src/utils/python.js")).findPython();
}

/** Fake interpreters: command name -> `--version` output; anything else is "not found". */
function installed(versions: Record<string, string>) {
  exec.mockImplementation(((cmd: string) => {
    if (cmd in versions) return versions[cmd];
    throw new Error(`spawn ${cmd} ENOENT`);
  }) as never);
}

beforeEach(() => {
  exec.mockReset();
  delete process.env.ENFUSION_PYTHON;
});
afterEach(() => {
  delete process.env.ENFUSION_PYTHON;
});

describe("findPython", () => {
  it("prefers ENFUSION_PYTHON", async () => {
    process.env.ENFUSION_PYTHON = "C:\\Py\\python.exe";
    installed({ "C:\\Py\\python.exe": "Python 3.12.1\n", py: "Python 3.14.2\n", python: "Python 3.14.2\n" });
    expect(await find()).toEqual({ cmd: "C:\\Py\\python.exe", args: [], version: "3.12.1" });
  });

  it("falls through a missing ENFUSION_PYTHON to python", async () => {
    process.env.ENFUSION_PYTHON = "C:\\nope\\python.exe";
    installed({ python: "Python 3.14.2\n" });
    expect(await find()).toEqual({ cmd: "python", args: [], version: "3.14.2" });
  });

  it("rejects Python 2.7 and versions below 3.11", async () => {
    installed({ py: "Python 3.10.4\n", python: "Python 2.7.18\n" });
    expect(await find()).toBeNull();
    installed({ py: "Python 3.10.4\n", python: "Python 2.7.18\n", python3: "Python 3.11.0\n" });
    expect(await find()).toEqual({ cmd: "python3", args: [], version: "3.11.0" });
  });
});
