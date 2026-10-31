import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SearchEngine } from "../../src/index/search-engine.js";
import { registerWikiRead } from "../../src/tools/wiki-read.js";
import { registerWikiSearch } from "../../src/tools/wiki-search.js";

const engine = new SearchEngine(resolve(dirname(fileURLToPath(import.meta.url)), "../../data"));
type Handler = (a: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
const capture = (register: (s: McpServer, e: SearchEngine) => void) => {
  let h!: Handler;
  register({ registerTool: (_n: string, _d: unknown, f: Handler) => { h = f; } } as unknown as McpServer, engine);
  return h;
};
const read = capture(registerWikiRead), search = capture(registerWikiSearch);

describe("wiki_read", () => {
  it.each(["Scenario Framework", "Diag Menu"])("reads %s to its last character in parts of at most 45,000 chars", async (title) => {
    const page = engine.getWikiPage(title)!;
    let all = "", offset = 0, last = "";
    for (let i = 0; i < 20; i++) {
      last = (await read({ title, offset, maxChars: 45_000 })).content[0].text;
      expect(last.length).toBeLessThanOrEqual(45_000);
      const body = last.slice(last.indexOf("\n\n") + 2, last.lastIndexOf("\n\n"));
      all += body;
      const next = last.match(/offset=(\d+)$/);
      if (!next) break;
      offset = Number(next[1]);
    }
    expect(all).toBe(page.content);
    expect(last).toMatch(/\(end of page\)$/);
  });

  it("finds a page from its URL alone and returns a short page whole", async () => {
    const r = await read({ url: "https://community.bistudio.com/wiki/Arma_Reforger:Prefabs_Basics" });
    expect(r.isError).toBeUndefined();
    expect(r.content[0].text).toMatch(/^## Prefabs Basics\nSource: BI Community Wiki, https:/);
    expect(r.content[0].text).not.toContain("Part ");
  });

  it("returns isError with a next step for a missing argument, an unknown page and an offset past the end", async () => {
    expect(await read({ offset: 10 })).toEqual({ content: [{ type: "text", text: "Pass title or url." }], isError: true });
    const miss = await read({ title: "Scenaro Framwork" });
    expect(miss.isError).toBe(true);
    expect(miss.content[0].text).toMatch(/Did you mean: .*"Scenario Framework".*Use wiki_read title=/);
    expect((await read({ title: "Scenario Framework", offset: 200_000 })).content[0].text).toBe('offset 200000 is past the end of "Scenario Framework" (131,512 chars).');
  });
});

describe("wiki_search", () => {
  it("prints the wiki_read call for every result", async () => {
    const t = (await search({ query: "replication", limit: 3 })).content[0].text;
    const blocks = t.split(/^## /m).slice(1);
    expect(blocks.length).toBeGreaterThan(0);
    for (const b of blocks) expect(b).toContain('Read: wiki_read title="');
  });
});
