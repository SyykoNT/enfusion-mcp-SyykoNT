import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerWbKnowledge } from "../../src/tools/wb-knowledge.js";

type Handler = (a: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
let kb!: Handler;
registerWbKnowledge({ registerTool: (_n: string, _d: unknown, h: Handler) => { kb = h; } } as unknown as McpServer);
const file = resolve(dirname(fileURLToPath(import.meta.url)), "../../data/kb/patterns/GameModes_And_Scenarios/scenario-framework.md");

describe("wb_knowledge", () => {
  it("keeps a 4-file answer under 31,000 chars and says how to read on", async () => {
    const t = (await kb({ query: "scenario framework", max_files: 4 })).content[0].text;
    expect(t.length).toBeLessThan(31_000);
    expect(t).toContain('Continue: wb_knowledge title="Scenario Framework" offset=');
    expect(t).not.toContain("narrow the query");
  });

  it("reads one file by title to its end, matching the file on disk", async () => {
    let all = "", offset = 0;
    for (let i = 0; i < 10; i++) {
      const t = (await kb({ title: "scenario framework", offset })).content[0].text;
      const end = t.search(/\n\n(Continue: .*|\(end of file\))$/);
      all += t.slice(t.indexOf("\n\n") + 2, end < 0 ? undefined : end);
      const next = t.match(/offset=(\d+)$/);
      if (!next) break;
      offset = Number(next[1]);
    }
    expect(all).toBe(readFileSync(file, "utf-8"));
  });

  it("returns isError without query or title, and for an unknown title", async () => {
    expect((await kb({ max_files: 2 })).isError).toBe(true);
    expect((await kb({ title: "Nope" })).isError).toBe(true);
  });
});
