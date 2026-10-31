import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { parse, type EnfusionNode } from "../formats/enfusion-text.js";
import { findGproj, resolveAddonDir } from "../utils/game-paths.js";

export function registerWorkshopInfo(server: McpServer, config: Config): void {
  server.registerTool(
    "workshop_info",
    {
      description:
        "Read Workshop metadata from a mod's .gproj file. Shows mod ID, GUID, title, " +
        "dependencies, and configurations. Useful for checking publish state before releasing. Read only, never publishes.",
      inputSchema: {
        projectPath: z
          .string()
          .optional()
          .describe(
            "Absolute path to the mod directory (containing the .gproj). Uses configured default if omitted."
          ),
        modName: z
          .string()
          .optional()
          .describe(
            "Addon folder name under projectPath (or the projects path); any .gproj inside counts. Defaults to ENFUSION_DEFAULT_MOD."
          ),
      },
    },
    async ({ projectPath, modName }) => {
      try {
        const basePath = projectPath || config.projectPath;
        if (!basePath) {
          return {
            content: [
              { type: "text", text: "No project path configured. Set ENFUSION_PROJECT_PATH or provide projectPath parameter." },
            ],
            isError: true,
          };
        }
        // projectPath may be the addon folder itself; otherwise look under it by name (any .gproj name)
        const name = modName ?? config.defaultMod;
        const gprojPath = (projectPath && findGproj(projectPath)) || findGproj(resolveAddonDir(basePath, name) ?? "");

        if (!gprojPath) {
          return {
            content: [
              {
                type: "text",
                text: `No .gproj found in ${projectPath ? `${projectPath} or ` : ""}${name ? join(basePath, name) : `any folder under ${basePath}`}.`,
              },
            ],
            isError: true,
          };
        }

        const raw = readFileSync(gprojPath, "utf-8");
        const root = parse(raw);

        const id = getProperty(root, "ID") || "(unknown)";
        const guid = getProperty(root, "GUID") || "(unknown)";
        const title = getProperty(root, "TITLE") || id;

        // Extract dependencies
        const deps: string[] = [];
        const depNode = findChild(root, "Dependencies");
        if (depNode) {
          for (const val of depNode.values) {
            deps.push(String(val));
          }
        }

        // Extract configurations
        const configs: string[] = [];
        const configsNode = findChild(root, "Configurations");
        if (configsNode) {
          for (const child of configsNode.children) {
            const name = child.id || getProperty(child, "name") || child.type;
            if (name) configs.push(name);
          }
        }

        const lines: string[] = [];
        lines.push("**Workshop Info**\n");
        lines.push(`- **ID:** ${id}`);
        lines.push(`- **GUID:** ${guid}`);
        lines.push(`- **Title:** ${title}`);
        lines.push(`- **File:** ${gprojPath}`);

        if (deps.length > 0) {
          lines.push(`\n### Dependencies (${deps.length})`);
          for (const dep of deps) {
            const label = dep === "58D0FB3206B6F859" ? " (Arma Reforger)" : "";
            lines.push(`- ${dep}${label}`);
          }
        }

        if (configs.length > 0) {
          lines.push(`\n### Configurations`);
          for (const cfg of configs) {
            lines.push(`- ${cfg}`);
          }
        }

        lines.push("\nPublishing is done by Don in Workbench > Publish Project (first publish in the GUI). This tool does not publish.");

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Error reading workshop info: ${msg}` }],
        isError: true,
        };
      }
    }
  );
}

function getProperty(node: EnfusionNode, key: string): string {
  for (const prop of node.properties) {
    if (prop.key === key) return String(prop.value ?? "");
  }
  return "";
}

function findChild(node: EnfusionNode, type: string): EnfusionNode | null {
  return node.children.find((c) => c.type === type) || null;
}
