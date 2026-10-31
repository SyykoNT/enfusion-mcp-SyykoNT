import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../config.js";
import { parse, type EnfusionNode } from "../formats/enfusion-text.js";
import { findGproj, resolveAddonDir } from "../utils/game-paths.js";
import { buildStack, type LayerKind } from "../pak/stack.js";
import { CHANGE_NOTES_MAX, DESCRIPTION_MAX, NAME_MAX, SUMMARY_MAX, workshopNameIssues, workshopTextIssues } from "../release/workshop-rules.js";

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
        name: z.string().optional().describe("Planned Workshop Project Name to lint (default: the .gproj TITLE)"),
        summary: z.string().optional().describe("Planned Workshop summary to lint"),
        description: z.string().optional().describe("Planned Workshop description to lint"),
        changeNotes: z.string().optional().describe("Planned change notes to lint"),
        textFiles: z
          .object({ summary: z.string().optional(), description: z.string().optional(), changeNotes: z.string().optional() })
          .optional()
          .describe("Paths of UTF-8 text files to lint instead of passing the text"),
      },
    },
    async ({ projectPath, modName, name, summary, description, changeNotes, textFiles }) => {
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
        const addonName = modName ?? config.defaultMod;
        const gprojPath = (projectPath && findGproj(projectPath)) || findGproj(resolveAddonDir(basePath, addonName) ?? "");

        if (!gprojPath) {
          return {
            content: [
              {
                type: "text",
                text: `No .gproj found in ${projectPath ? `${projectPath} or ` : ""}${addonName ? join(basePath, addonName) : `any folder under ${basePath}`}.`,
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

        const depInfo = dependencyLines(config, gprojPath, deps);
        if (deps.length > 0) {
          lines.push(`\n### Dependencies (${deps.length})`);
          lines.push(...depInfo.lines);
        }

        if (configs.length > 0) {
          lines.push(`\n### Configurations`);
          for (const cfg of configs) {
            lines.push(`- ${cfg}`);
          }
        }

        lines.push("\n### Workshop text");
        lines.push(...lintLines(dirname(gprojPath), title, name ?? title, { summary, description, changeNotes }, textFiles ?? {}));

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

type TextField = "summary" | "description" | "changeNotes";
const TEXT_MAX: Record<TextField, number> = { summary: SUMMARY_MAX, description: DESCRIPTION_MAX, changeNotes: CHANGE_NOTES_MAX };

/** One line per Workshop field given (the name always), plus the licence file and credits reminder. */
function lintLines(addonDir: string, title: string, name: string, text: Partial<Record<TextField, string>>, files: Partial<Record<TextField, string>>): string[] {
  const nameIssues = workshopNameIssues(name);
  const lines = [`- name: ${nameIssues.length ? nameIssues.join("; ") : `ok (${[...name].length}/${NAME_MAX})`}${name !== title ? ` (info: .gproj TITLE is "${title}")` : ""}`];
  for (const f of Object.keys(TEXT_MAX) as TextField[]) {
    let t = text[f];
    if (t === undefined && files[f]) {
      try {
        t = readFileSync(files[f]!, "utf-8").replace(/^﻿/, "").replace(/\r?\n$/, ""); // the dialog gets the text, not the file's last newline
      } catch (e) {
        lines.push(`- ${f}: cannot read ${files[f]}: ${(e as Error).message}`);
        continue;
      }
    }
    if (t === undefined) continue;
    const n = [...t].length;
    const issues = [...(n > TEXT_MAX[f] ? [`${n}/${TEXT_MAX[f]} characters`] : []), ...workshopTextIssues(t)];
    const note = f === "summary" ? " (measured dialog limit; BI documents 1024)" : "";
    lines.push(`- ${f}: ${issues.length ? issues.join("; ") : `ok (${n}/${TEXT_MAX[f]})`}${note}`);
  }
  lines.push(`- licence: license.txt ${existsSync(join(addonDir, "license.txt")) ? "present" : "absent"} (needed only for a Custom licence)`);
  // README and CREDITS are not packed, so credits they carry must go in the description
  const credits = readdirSync(addonDir, { withFileTypes: true })
    .filter((e) => e.isFile() && /^(readme|credits)/i.test(e.name) && /credit|licen[cs]e/i.test(readFileSync(join(addonDir, e.name), "utf-8")))
    .map((e) => e.name);
  if (credits.length) lines.push(`- reminder: ${credits.join(", ")} mention credits or a licence; these files are not packed, so put that text in the description`);
  return lines;
}

const SOURCE: Record<LayerKind, string> = { loose: "local", workshop: "workshop", vanilla: "game" };

/** Direct dependencies named from the addon stack, and the closure's GUIDs (missing ones included). Raw GUIDs when the stack cannot be built. */
function dependencyLines(config: Config, gproj: string, deps: string[]): { lines: string[]; closure: string[] } {
  try {
    const stack = buildStack(config, gproj);
    const layers = stack.layers.slice(0, -1); // the last layer is the addon itself
    const byGuid = new Map(layers.map((l) => [l.guid, l]));
    // RL-N3 (addon_deps) adds installed versions to these lines
    const lines = deps.map((d) => {
      const l = byGuid.get(d.toUpperCase());
      return l ? `- ${d} ${l.title || l.id} (${SOURCE[l.kind]})` : `- ${d} (missing: not in a local project, the Workshop cache or the base game)`;
    });
    lines.push(`Closure: ${layers.length} addons found${stack.missing.length ? `, ${stack.missing.length} missing (${stack.missing.join(", ")})` : ""}`);
    return { lines, closure: [...layers.map((l) => l.guid), ...stack.missing] };
  } catch (e) {
    return { lines: [...deps.map((d) => `- ${d}`), `(names unavailable: ${(e as Error).message})`], closure: deps.map((d) => d.toUpperCase()) };
  }
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
