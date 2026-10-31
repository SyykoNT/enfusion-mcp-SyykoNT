import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus, ensureMode } from "../workbench/status.js";

// Destructive menu paths, compared lower case with each segment trimmed
const BLOCKED_MENU_PREFIXES = ["file,close", "file,new", "file,exit", "file,quit"];

export function registerWbExecuteAction(server: McpServer, client: WorkbenchClient): void {
  server.registerTool(
    "wb_execute_action",
    {
      description:
        "Execute any Workbench menu action by its menu path. Use comma-separated path segments to identify the action (e.g., 'Game,Exit game' in WorldEditor). " +
        "Some destructive actions (File,Close; File,New; File,Exit) are blocked for safety, and so is File,Save in the World Editor (use wb_save).",
      inputSchema: {
        menuPath: z
          .string()
          .describe(
            "Comma-separated menu path (e.g., 'Game,Exit game', 'Edit,Undo')"
          ),
        module: z
          .enum(["WorldEditor", "ScriptEditor", "ResourceManager", "AnimEditor", "ParticleEditor", "BehaviorEditor", "AudioEditor", "LocalizationEditor"])
          .default("WorldEditor")
          .describe("Workbench module whose menu holds the action (default WorldEditor)"),
      },
    },
    async ({ menuPath, module }) => {
      try {
        // The handler trims each segment (EMCP_WB_ExecuteAction.c), so compare the same way.
        const normalizedPath = menuPath.split(",").map((s) => s.trim()).join(",").toLowerCase();
        const isWorldSave = module === "WorldEditor" && normalizedPath.startsWith("file,save");
        if (isWorldSave || BLOCKED_MENU_PREFIXES.some((p) => normalizedPath.startsWith(p))) {
          const hint = isWorldSave
            ? " Use wb_save: it refuses unnamed worlds and prefab edit mode, which open a blocking \"Save world as\" dialog."
            : " Perform it manually in Workbench.";
          return {
            content: [{ type: "text" as const, text: `**Blocked:** "${menuPath}" cannot be executed via this tool.${hint}${formatConnectionStatus(client)}` }],
          };
        }

        // Mutating actions require edit mode
        const modeErr = await ensureMode(client, "edit", `execute menu action "${menuPath}"`);
        if (modeErr) {
          return { content: [{ type: "text" as const, text: modeErr + formatConnectionStatus(client) }], isError: true };
        }
        const result = await client.call<Record<string, unknown>>("EMCP_WB_ExecuteAction", {
          menuPath,
          module,
        });
        if (!result.executed) {
          return {
            content: [{ type: "text" as const, text: `**Action not executed**: ${module} has no enabled menu item "${menuPath}".${formatConnectionStatus(client)}` }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `**Action Executed**\n\nMenu path: ${menuPath}${result.message ? `\n${result.message}` : ""}${result.result ? `\nResult: ${JSON.stringify(result.result)}` : ""}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error executing action "${menuPath}": ${msg}${formatConnectionStatus(client)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
