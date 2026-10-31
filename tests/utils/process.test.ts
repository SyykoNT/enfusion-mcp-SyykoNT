import { describe, it, expect } from "vitest";
import { argValue, parseProcJson } from "../../src/utils/process.js";

// Hand-made in the shape of the Win32_Process query (ConvertTo-Json -Compress); no real process is queried.
const ONE = '{"ProcessId":41236,"ParentProcessId":1200,"CommandLine":"\\"C:\\\\S\\\\ArmaReforgerServerDiag.exe\\" -profile \\"C:\\\\Users\\\\me\\\\.enfusion-mcp\\\\server-profile\\" -bindPort 2001","Created":1761890000000}';

describe("parseProcJson", () => {
  it("reads a single object", () => {
    expect(parseProcJson(ONE)).toEqual([
      { pid: 41236, ppid: 1200, cmd: '"C:\\S\\ArmaReforgerServerDiag.exe" -profile "C:\\Users\\me\\.enfusion-mcp\\server-profile" -bindPort 2001', created: 1761890000000 },
    ]);
  });

  it("reads an array", () => {
    expect(parseProcJson(`[${ONE},${ONE.replace("41236", "41237")}]`).map((p) => p.pid)).toEqual([41236, 41237]);
  });

  it("reads empty output as no processes", () => {
    expect(parseProcJson("")).toEqual([]);
    expect(parseProcJson("  \r\n")).toEqual([]);
  });

  it("turns a null CommandLine (access denied) into an empty string", () => {
    expect(parseProcJson('{"ProcessId":4,"ParentProcessId":0,"CommandLine":null,"Created":0}')[0].cmd).toBe("");
  });
});

describe("argValue", () => {
  const cmd = '"C:\\Program Files\\S\\ArmaReforgerServerDiag.exe" -server worlds/x.ent -profile "C:\\My Dir\\p" -addr 127.0.0.1:2502 -noThrow';

  it("reads a quoted value with spaces", () => {
    expect(argValue(cmd, "-profile")).toBe("C:\\My Dir\\p");
  });

  it("reads a bare value", () => {
    expect(argValue(cmd, "-addr")).toBe("127.0.0.1:2502");
  });

  it("is case-insensitive and returns undefined when the flag is absent", () => {
    expect(argValue("x.exe -PROFILE C:\\p", "-profile")).toBe("C:\\p");
    expect(argValue(cmd, "-bindPort")).toBeUndefined();
  });
});
