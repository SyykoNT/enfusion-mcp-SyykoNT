import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { searchKb, getIndexSummary, getKbEntry } from "./kb-loader.js";
import { takePart } from "../utils/paging.js";

/** Characters of KB text per answer, across all files: many MCP clients truncate results above about 50,000 characters. */
const BUDGET = 30_000;

const KB_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "data",
  "kb"
);

export function registerWbKnowledge(server: McpServer): void {
  server.registerTool(
    "wb_knowledge",
    {
      description:
        "Search the Arma Reforger modding knowledge base — distilled pattern files covering scripting, " +
        "audio, weapons, vehicles, AI, UI, game modes, animation, and all other modding domains. " +
        "Use this before writing EnforceScript code or setting up any Enfusion modding system. " +
        "Call with query='index' to see all available topics. One answer holds up to 30,000 chars; a file cut short " +
        "ends with the call (title and offset) that reads on.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Topic to look up (e.g. 'replication', 'weapon suppressor', 'scenario framework', 'audio signals'). Use 'index' to list all topics."
          ),
        max_files: z
          .number()
          .min(1)
          .max(4)
          .default(2)
          .describe("Maximum number of pattern files to return (default 2)"),
        title: z.string().optional().describe("Exact topic title from the index: returns that one file"),
        offset: z.number().int().min(0).optional().describe("With title: character position to start from"),
      },
    },
    async ({ query, max_files, title, offset }) => {
      const more = (t: string, at: number) => `Continue: wb_knowledge title="${t}" offset=${at}`;
      if (title) {
        const f = getKbEntry(KB_DIR, title);
        if (!f) return { content: [{ type: "text", text: `No KB topic "${title}". wb_knowledge query="index" lists the titles.` }], isError: true };
        if (offset && offset >= f.content.length) {
          return { content: [{ type: "text", text: `offset ${offset} is past the end of "${f.title}" (${f.content.length.toLocaleString("en-US")} chars).` }], isError: true };
        }
        const part = takePart(f.content, offset ?? 0, BUDGET);
        const tail = part.end < part.total ? `\n\n${more(f.title, part.end)}` : offset ? "\n\n(end of file)" : "";
        return { content: [{ type: "text", text: `## ${f.title}\n\n${part.body}${tail}` }] };
      }
      if (!query) return { content: [{ type: "text", text: 'Pass query (a topic, or "index") or title.' }], isError: true };
      const result = searchKb(KB_DIR, query, max_files);

      if (result.usedIndex || result.files.length === 0) {
        const summary = getIndexSummary(KB_DIR);
        const prefix =
          result.files.length === 0 && !result.usedIndex
            ? `No KB entries matched "${query}". Showing all available topics:\n\n`
            : "";
        return {
          content: [{ type: "text", text: prefix + summary }],
        };
      }

      // Files in score order, each gets what is left of the budget
      let left = BUDGET;
      const parts = result.files.map((f) => {
        const part = takePart(f.content, 0, Math.max(0, left));
        left -= part.body.length;
        return `## ${f.title}\n\n${part.body}${part.end < part.total ? `\n\n${more(f.title, part.end)}` : ""}`;
      });

      return {
        content: [{ type: "text", text: parts.join("\n\n---\n\n") }],
      };
    }
  );
}
