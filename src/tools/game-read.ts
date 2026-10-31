import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname } from "node:path";
import type { Config } from "../config.js";
import { validateProjectPath } from "../utils/safe-path.js";
import { PakVirtualFS } from "../pak/vfs.js";
import { resourceName } from "../pak/rdb.js";
import { buildStack } from "../pak/stack.js";
import { stripGuid } from "../formats/config-override.js";
import { resolveGameDataPath } from "../utils/game-paths.js";
import { pageLines } from "../utils/paging.js";

/** Known binary types, refused without reading; everything else is judged by content */
const BINARY_EXTENSIONS = new Set([".xob", ".edds", ".dds", ".png", ".wav", ".anm", ".pak", ".nmn", ".txo"]);
const MAX_BYTES = 20 * 1024 * 1024;

/** Text when the first 4 KB hold no NUL and under 1% control bytes (besides tab, CR, LF), and it is not packed EBIN. */
export function isProbablyText(buf: Buffer): boolean {
  if (buf.subarray(0, 4).toString("latin1") === "EBIN") return false;
  const head = buf.subarray(0, 4096);
  let ctrl = 0;
  for (const b of head) {
    if (b === 0) return false;
    if (b < 32 && b !== 9 && b !== 10 && b !== 13) ctrl++;
  }
  return ctrl === 0 || ctrl * 100 < head.length;
}

type Source = { size: number; read: () => Buffer; from: string } | { dir: true } | null;

export function registerGameRead(server: McpServer, config: Config): void {
  server.registerTool(
    "game_read",
    {
      description:
        "Read a text file from the base game data (loose files and .pak archives), or with addon from one addon's own files " +
        "(a Workshop folder, a project, an ID or a GUID). Any Enfusion text format reads (.c, .et, .conf, .ct, .acp, .agr, .gamemat ...); " +
        "binary files are reported. Pages by lines: offset and limit (default 400); follow 'continue with offset=N'. " +
        "The header shows the resource GUID when the resourceDatabase.rdb knows it. Packed addons ship no .meta files: " +
        "asking for X.meta returns a Name line synthesized from the rdb, the GUID an override of X needs.",
      inputSchema: {
        path: z.string().describe("Path within the game data, {GUID} prefix accepted (e.g. 'Scripts/Game/Character/SCR_CharacterControllerComponent.c')"),
        offset: z.number().int().min(0).optional().describe("First line to return (0-based, default 0)"),
        limit: z.number().int().min(1).max(2000).optional().describe("Lines per page (default 400)"),
        addon: z.string().optional().describe("Read from this addon's own layer instead of the base game: Workshop folder name, project folder, ID or GUID"),
      },
    },
    async ({ path: rawPath, offset, limit, addon }) => {
      const subPath = stripGuid(rawPath).replace(/\\/g, "/");
      const basePath = resolveGameDataPath(config.gamePath);
      if (!basePath && !addon) {
        return {
          content: [{ type: "text", text: `Base game not found at ${config.gamePath}. Set ENFUSION_GAME_PATH or ensure Arma Reforger is installed.` }],
          isError: true,
        };
      }

      try {
        // The addon's own files only, not the merged stack (resource_resolve shows that)
        const layer = addon ? buildStack(config, addon).layers.at(-1)! : null;
        const guidOf = (p: string) => (layer ? layer.guidOf(p) : resourceName(config.gamePath, p)?.slice(1, 17));
        const readSource = (p: string): Source => {
          if (layer) {
            if (!layer.exists(p)) return null;
            const buf = layer.read(p);
            // shortcut: an addon layer file is read before its size is checked
            return buf ? { size: buf.length, read: () => buf, from: `${layer.id}, ${layer.kind}` } : { dir: true };
          }
          const filePath = validateProjectPath(basePath!, p);
          if (existsSync(filePath)) {
            const stats = statSync(filePath);
            return stats.isDirectory() ? { dir: true } : { size: stats.size, read: () => readFileSync(filePath), from: "loose" };
          }
          const pakVfs = PakVirtualFS.get(config.gamePath);
          if (!pakVfs?.exists(p)) return null;
          const size = pakVfs.fileSize(p);
          return size < 0 ? { dir: true } : { size, read: () => pakVfs.readFile(p), from: ".pak" };
        };

        const src = readSource(subPath);
        if (!src) {
          if (subPath.toLowerCase().endsWith(".meta")) {
            const target = subPath.slice(0, -5);
            const guid = guidOf(target);
            if (!guid) return { content: [{ type: "text", text: `No GUID for ${target} in resourceDatabase.rdb (scripts and .layer files have none).` }], isError: true };
            return {
              content: [{
                type: "text",
                text:
                  `// ${subPath} is not shipped: packed addons contain no .meta files (0 in the vanilla paks).\n` +
                  `// Synthesized from resourceDatabase.rdb. Import settings (Configurations) are not recoverable.\n` +
                  `// For an override in your addon, use this Name with the same path (see config_override).\n` +
                  `MetaFileClass {\n Name "{${guid}}${target}"\n}\n`,
              }],
            };
          }
          return { content: [{ type: "text", text: `File not found: ${subPath}` }], isError: true };
        }
        if ("dir" in src) return { content: [{ type: "text", text: `"${subPath}" is a directory. Use game_browse to list its contents.` }] };

        const ext = extname(subPath).toLowerCase();
        if (BINARY_EXTENSIONS.has(ext)) return { content: [{ type: "text", text: `Binary file: ${subPath} (${ext}, ${src.size} bytes)` }] };
        if (src.size > MAX_BYTES) {
          return { content: [{ type: "text", text: `File too large to page: ${subPath} (${(src.size / 1048576).toFixed(1)} MB, limit 20 MB)` }], isError: true };
        }
        const buf = src.read();
        if (!isProbablyText(buf)) return { content: [{ type: "text", text: `Binary file: ${subPath} (${ext || "no extension"}, ${buf.length} bytes)` }] };

        const page = pageLines(buf.toString("utf-8"), offset ?? 0, limit ?? 400);
        const guid = guidOf(subPath);
        const name = guid ? ` {${guid}}${subPath}` : "";
        return {
          content: [{
            type: "text",
            // The body is verbatim: a continue line follows only pages that end in a newline (all but the last)
            text: `// ${subPath} (from ${src.from})${name} | ${buf.length} bytes | ${page.footer}\n\n${page.body}` +
              (page.footer.endsWith("(end)") ? "" : `// ${page.footer}`),
          }],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `Error reading game file: ${msg}` }], isError: true };
      }
    }
  );
}
