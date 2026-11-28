import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findWbPortFile, parseWbPort } from "../../src/config.js";

describe("parseWbPort", () => {
  it("reads one port number", () => {
    expect(parseWbPort("5776\r\n")).toBe(5776);
    expect(parseWbPort("0")).toBeUndefined();
    expect(parseWbPort("70000")).toBeUndefined();
    expect(parseWbPort("57x6")).toBeUndefined();
    expect(parseWbPort("")).toBeUndefined();
  });
});

describe("findWbPortFile", () => {
  it("finds the file in a parent of the project dir", () => {
    const root = mkdtempSync(join(tmpdir(), "emcp-wbport-"));
    const deep = join(root, "addons", "MyMod");
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(root, ".wb-port"), "5777\n");
    expect(findWbPortFile([deep])).toEqual({ port: 5777, file: join(root, ".wb-port") });
  });

  it("takes the first start dir that has one", () => {
    const a = mkdtempSync(join(tmpdir(), "emcp-wbport-a-"));
    const b = mkdtempSync(join(tmpdir(), "emcp-wbport-b-"));
    writeFileSync(join(a, ".wb-port"), "5778");
    writeFileSync(join(b, ".wb-port"), "5779");
    expect(findWbPortFile([a, b])?.port).toBe(5778);
  });

  it("gives no port for an invalid file", () => {
    const a = mkdtempSync(join(tmpdir(), "emcp-wbport-bad-"));
    writeFileSync(join(a, ".wb-port"), "abc");
    expect(findWbPortFile([a])).toBeUndefined();
  });
});
