import { dirname, isAbsolute } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus } from "../workbench/status.js";

export function registerWbConnect(server: McpServer, client: WorkbenchClient): void {
  server.registerTool(
    "wb_connect",
    {
      description:
        "Test connection to Arma Reforger Workbench. Returns connection status and current editor mode. Use this to verify Workbench is running with the NET API enabled. " +
        "When the Workbench that answers has stale or missing handler scripts in its project compared with this MCP version, the reply adds a line saying so (nothing is written).",
      inputSchema: {},
    },
    async () => {
      try {
        const alive = await client.ping();
        if (!alive) {
          return {
            content: [
              {
                type: "text" as const,
                text: "**Connection Failed**\n\nCould not reach Workbench. Ensure:\n1. Arma Reforger Tools (Workbench) is running; start it with wb_launch after checking that nobody else is using Workbench\n2. NET API is enabled: File > Options > General > Net API\n3. The EnfusionMCP handler addon is loaded in Workbench",
              },
            ],
            isError: true,
          };
        }

        // Get detailed state — Ping returns: status, mode, message
        const details = await client.call<Record<string, unknown>>("EMCP_WB_Ping");

        const lines: string[] = [];
        lines.push("**Workbench Connected**\n");
        lines.push(`- **Status:** Connected`);
        if (details.mode) lines.push(`- **Mode:** ${details.mode}`);
        if (details.message) lines.push(`- **Info:** ${details.message}`);

        // Read only. An addon with no handlers of its own is skipped: the running ones come from a dependency, and a second copy would clash.
        const gproj = (await client.portOwnerInfo()).gproj;
        if (gproj && isAbsolute(gproj)) {
          try {
            const h = client.handlerFiles(dirname(gproj));
            if (h.stale.length + h.missing.length && h.current.length + h.stale.length) {
              lines.push(
                `\nHandlers in ${dirname(gproj)} differ from this MCP version (${h.stale.length} stale, ${h.missing.length} missing): ` +
                  `run wb_handlers install with the user's OK, then restart Workbench.`
              );
            }
          } catch { /* unreadable addon folder: no line */ }
        }

        return { content: [{ type: "text" as const, text: lines.join("\n") + formatConnectionStatus(client) }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [
            {
              type: "text" as const,
              text: `**Connection Failed**\n\n${msg}\n\nEnsure Workbench is running with NET API enabled (File > Options > General > Net API).${formatConnectionStatus(client)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
