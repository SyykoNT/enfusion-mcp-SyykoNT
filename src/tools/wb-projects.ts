import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gprojOpenRefusal, isProjectPath, isWorldPath, type WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus } from "../workbench/status.js";

export function registerWbProjects(server: McpServer, client: WorkbenchClient): void {
  server.registerTool(
    "wb_projects",
    {
      description:
        "Query project information from the Workbench. List all loaded addon projects, locate a specific project by name, or open a world (.ent) in the World Editor. " +
        "A .gproj is refused before anything is sent: opening a project file this way does not load a project in Workbench 1.9 (it is refused and leaves the world unstable, or opens the modal Project Settings window); start Workbench on that project with wb_launch instead. " +
        "Opening a .ent while the current world has unsaved changes makes Workbench ask \"Loading world\" (Yes/No/Cancel), and that dialog blocks every MCP call until a person answers it, so open refuses then " +
        "(local Workbench on Windows only; it opens with a warning when it cannot check). A layer this MCP created with wb_layers counts as unsaved until wb_save runs. Run wb_save first, or let the user discard the changes in Workbench.",
      inputSchema: {
        action: z
          .enum(["list", "locate", "open"])
          .describe("Action: list (all loaded projects), locate (find specific project path), or open (open a .ent world; a .gproj is refused, use wb_launch)"),
        name: z
          .string()
          .optional()
          .describe("Project/addon name to locate (required for locate action), or .ent world path (required for open action)"),
      },
    },
    async ({ action, name }) => {
      let warn = "";
      try {
        if (action === "open") {
          if (!name) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: `name` is required for the open action. Provide the .gproj file path or addon name.",
                },
              ],
              isError: true,
            };
          }

          if (isProjectPath(name)) return { content: [{ type: "text" as const, text: gprojOpenRefusal(name, "wb_projects open") }], isError: true };

          const guard = isWorldPath(name) ? await client.checkWorldOpen(name) : undefined;
          if (guard && "refuse" in guard) return { content: [{ type: "text" as const, text: guard.refuse }], isError: true };
          if (guard) warn = `\n\n${guard.warn}`;

          const result = await client.call<Record<string, unknown>>("EMCP_WB_EditorControl", {
            action: "openResource",
            path: name,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: `**Project Opened**\n\nLoaded: ${name}${result.message ? `\n${result.message}` : ""}${warn}${formatConnectionStatus(client)}`,
              },
            ],
          };
        }

        if (action === "locate") {
          if (!name) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: `name` is required for the locate action.",
                },
              ],
              isError: true,
            };
          }

          const result = await client.call<Record<string, unknown>>("LocateProject", {
            name,
          });

          const path = result.path || result.projectPath || "(not found)";
          return {
            content: [
              {
                type: "text" as const,
                text: `**Project Located**\n\n- **Name:** ${name}\n- **Path:** ${path}${result.guid ? `\n- **GUID:** ${result.guid}` : ""}${formatConnectionStatus(client)}`,
              },
            ],
          };
        }

        // list
        const result = await client.call<Record<string, unknown>>("GetLoadedProjects");

        // Workbench 1.8 answers {"Loaded Projects": ["ArmaReforger", "MyMod"]}
        const projects = [result["Loaded Projects"], result.projects, result.addons].find(Array.isArray) ?? [];

        if (projects.length === 0) {
          return {
            content: [
              { type: "text" as const, text: `**No projects loaded** in Workbench.${formatConnectionStatus(client)}` },
            ],
          };
        }

        const lines = [`**Loaded Projects** (${projects.length})\n`];
        for (const proj of projects) {
          if (typeof proj === "string") {
            lines.push(`- ${proj}`);
          } else {
            const p = proj as Record<string, unknown>;
            const pName = p.name || p.id || "(unnamed)";
            const pPath = p.path ? ` - ${p.path}` : "";
            const pGuid = p.guid ? ` (${p.guid})` : "";
            lines.push(`- **${pName}**${pPath}${pGuid}`);
          }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") + formatConnectionStatus(client) }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error querying projects (${action}): ${msg}${warn}${formatConnectionStatus(client)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
