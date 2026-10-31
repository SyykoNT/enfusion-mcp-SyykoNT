import { describe, it, expect } from "vitest";
import { pageLines, takePart } from "../../src/utils/paging.js";

describe("takePart", () => {
  const parts = (t: string, max: number) => {
    const out: string[] = [];
    for (let at = 0; at < t.length; ) { const p = takePart(t, at, max); out.push(p.body); at = p.end; }
    return out;
  };

  it("returns a short text whole and refuses an offset past the end", () => {
    expect(takePart("abc", 0, 10)).toEqual({ body: "abc", end: 3, total: 3, partNo: 1, partCount: 1 });
    expect(() => takePart("abc", 3, 10)).toThrow("offset 3 is past the end (3 chars)");
  });

  it("ends at a blank line in the last quarter (LF and CRLF), else a newline, else a space, else mid-word", () => {
    expect(takePart(`${"a".repeat(80)}\n\nbbbbbbbbbbbbbbbbbbbbbbbbb`, 0, 100).body).toBe(`${"a".repeat(80)}\n\n`);
    expect(takePart(`${"a".repeat(80)}\r\n\r\nbbbbbbbbbbbbbbbbbbbbbbbbb`, 0, 100).body).toBe(`${"a".repeat(80)}\r\n\r\n`);
    expect(takePart(`aaa\n\n${"b".repeat(50)}\n${"c".repeat(80)}`, 0, 100).end).toBe(56);
    expect(takePart(`${"a".repeat(60)} ${"b".repeat(60)}`, 0, 100).end).toBe(61);
    expect(takePart("x".repeat(250), 0, 100).end).toBe(100);
  });

  it("parts put together give the text back, with part numbers", () => {
    const t = Array.from({ length: 200 }, (_, i) => `para ${i} ${"w ".repeat(i % 17)}`).join("\n\n");
    expect(parts(t, 500).join("")).toBe(t);
    expect(takePart(t, 1000, 500).partNo).toBe(3);
  });
});

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
