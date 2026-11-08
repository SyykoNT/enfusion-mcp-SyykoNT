import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WorkbenchError, type WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus } from "../workbench/status.js";

/** A script reload can run for minutes on a large project; the 10 s default would report a working reload as a timeout. */
const RELOAD_TIMEOUT_MS = 180_000;

export function registerWbReload(server: McpServer, client: WorkbenchClient): void {
  server.registerTool(
    "wb_reload",
    {
      description:
        "Reloads game scripts by sending Workbench's built-in NET API call ReloadScripts. Workbench answers Ok or 'Compilation failed'; " +
        "a new 'Reloading game scripts took' line in Workbench's console.log confirms the reload. target 'plugins' (and 'both') also tries " +
        "menu actions through a handler, which may report 'not confirmed'.",
      inputSchema: {
        target: z
          .enum(["scripts", "plugins", "both"])
          .default("scripts")
          .describe("What to reload: scripts, plugins, or both"),
      },
    },
    async ({ target }) => {
      try {
        const parts: string[] = [];
        let isError = false;

        if (target !== "plugins") {
          try {
            await client.call("ReloadScripts", {}, { timeout: RELOAD_TIMEOUT_MS });
          } catch (e) {
            // The documented reply is "Ok" with no body, which the decoder reports as an error.
            if (!(e instanceof Error && /Ok status with (empty|no) payload/.test(e.message))) throw e;
          }
          parts.push(
            "**ReloadScripts answered Ok**\n\n" +
              `Workbench accepted the reload. A new "Reloading game scripts took" line in Workbench's console.log confirms it ran; ` +
              "if there is none, do not assume it ran."
          );
        }

        if (target !== "scripts") {
          const result = await client.call<Record<string, unknown>>("EMCP_WB_Reload", { target: "plugins" });
          const msg = String(result.message ?? "");
          // The handler tries known menu paths; "=false" means none of them existed.
          if (/ExecuteAction=false/.test(msg)) {
            isError = true;
            parts.push(`**Plugin reload not confirmed**: ${msg}\n\nWorkbench exposed no matching menu action.`);
          } else {
            parts.push(`**Plugin reload triggered**\n\n${msg || "Reload triggered."}`);
          }
        }

        return { content: [{ type: "text" as const, text: parts.join("\n\n") + formatConnectionStatus(client) }], ...(isError && { isError }) };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const hint = e instanceof WorkbenchError && e.code === "TIMEOUT" ? " The reload may still be running; check console.log." : "";
        return {
          content: [{ type: "text" as const, text: `Error reloading: ${msg}${hint}${formatConnectionStatus(client)}` }],
          isError: true,
        };
      }
    }
  );
}
