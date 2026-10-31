import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SearchEngine } from "../index/search-engine.js";
import { takePart } from "../utils/paging.js";

export function registerWikiRead(server: McpServer, searchEngine: SearchEngine): void {
  server.registerTool(
    "wiki_read",
    {
      description:
        "Read a wiki page by title or URL. Use wiki_search first to find pages, then this tool for the complete text " +
        "including code examples and tutorials. Long pages come in parts (default 30,000 chars); each part ends with the " +
        "call that reads the next one.",
      inputSchema: {
        title: z.string().optional().describe("Page title as listed by wiki_search ('Arma Reforger:' prefix and underscores accepted)"),
        url: z.string().optional().describe("A community.bistudio.com/wiki/... URL as printed by wiki_search"),
        offset: z.number().int().min(0).optional().describe("Character position to start from (from the previous part's Continue line)"),
        maxChars: z.number().int().min(2000).max(45000).optional().describe("Size of this part (default 30,000)"),
      },
    },
    async ({ title, url, offset, maxChars }) => {
      if (!title && !url) return { content: [{ type: "text", text: "Pass title or url." }], isError: true };
      const page = searchEngine.findWikiPage({ title, url });
      const asked = title ?? url!;

      if (!page) {
        const suggestions = searchEngine.suggestWiki(title ?? url!.split("/").pop()!, 5);
        return {
          content: [{
            type: "text",
            text: suggestions.length
              ? `No wiki page "${asked}". Did you mean: ${suggestions.map((t) => `"${t}"`).join(", ")}? Use wiki_read title="<one of these>".`
              : `No wiki page "${asked}". Use wiki_search to find available pages.`,
          }],
          isError: true,
        };
      }

      const sourceLabel =
        page.source === "bistudio-wiki"
          ? "BI Community Wiki"
          : page.source === "enfusion"
            ? "Enfusion Engine docs"
            : "Arma Reforger docs";
      const size = maxChars ?? 30_000;
      if (offset && offset >= page.content.length) {
        return { content: [{ type: "text", text: `offset ${offset} is past the end of "${page.title}" (${page.content.length.toLocaleString("en-US")} chars).` }], isError: true };
      }
      // maxChars bounds the whole result: leave room for the title, source, part and Continue lines
      const part = takePart(page.content, offset ?? 0, size - 2 * page.title.length - (page.url?.length ?? 0) - 200);
      const whole = part.end === part.total && !offset;
      const lines = [`## ${page.title}`, `Source: ${sourceLabel}${page.url ? `, ${page.url}` : ""}`];
      if (!whole) {
        const n = (v: number) => v.toLocaleString("en-US");
        lines.push(`Part ${part.partNo} of about ${part.partCount} (chars ${n(offset ?? 0)} to ${n(part.end)} of ${n(part.total)})`);
      }
      lines.push("", part.body);
      if (!whole) lines.push("", part.end < part.total ? `Continue: wiki_read title="${page.title}" offset=${part.end}` : "(end of page)");
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
