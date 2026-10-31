import { describe, it, expect } from "vitest";
import { pageLines } from "../../src/utils/paging.js";

const text = Array.from({ length: 10 }, (_, i) => `line ${i}\r\n`).join("");

describe("pageLines", () => {
  it("pages first, middle and last, and the pages give the text back exactly (CRLF kept)", () => {
    const first = pageLines(text, 0, 4);
    expect(first.footer).toBe("lines 1-4 of 10; continue with offset=4");
    expect(first.body).toBe("line 0\r\nline 1\r\nline 2\r\nline 3\r\n");
    const mid = pageLines(text, 4, 4), last = pageLines(text, 8, 4);
    expect(last.footer).toBe("lines 9-10 of 10 (end)");
    expect(first.body + mid.body + last.body).toBe(text);
  });

  it("cuts a page short at the character cap but always returns one line", () => {
    expect(pageLines(text, 0, 400, 20).footer).toBe("lines 1-2 of 10; continue with offset=2");
    expect(pageLines("x".repeat(50), 0, 400, 20).body.length).toBe(50);
  });

  it("refuses an offset past the end and pages an empty text", () => {
    expect(() => pageLines(text, 10)).toThrow("offset 10 is past the end (10 lines)");
    expect(pageLines("", 0)).toEqual({ body: "", footer: "lines 0-0 of 0 (end)", total: 0 });
  });
});
