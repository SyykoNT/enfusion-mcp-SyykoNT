import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus } from "../workbench/status.js";

export function registerWbReload(server: McpServer, client: WorkbenchClient): void {
  server.registerTool(
    "wb_reload",
    {
      description:
        "Asks Workbench to recompile scripts through a menu action. In 1.8 the menu paths it tries are missing, so the result says 'not confirmed'; check console.log for a new compile, or restart Workbench.",
      inputSchema: {
        target: z
          .enum(["scripts", "plugins", "both"])
          .default("scripts")
          .describe("What to reload: scripts, plugins, or both"),
      },
    },
    async ({ target }) => {
      try {
        const result = await client.call<Record<string, unknown>>("EMCP_WB_Reload", { target });
        const msg = String(result.message ?? "");
        // The handler tries known menu paths; "=false" means none of them existed.
        if (/ExecuteAction=false/.test(msg)) {
          return {
            content: [{
              type: "text" as const,
              text: `**Reload not confirmed**: ${msg}\n\nWorkbench exposed no matching menu action. To check that scripts compile, ` +
                `use \`mod\` with action "compile" (headless, reports errors with file:line); in the open Workbench, ` +
                `recompile from the Script Editor.${formatConnectionStatus(client)}`,
            }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `**Reload Complete**\n\n${result.message || "Reload triggered."}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `Error reloading: ${msg}${formatConnectionStatus(client)}` }],
        isError: true,
        };
      }
    }
  );
}
