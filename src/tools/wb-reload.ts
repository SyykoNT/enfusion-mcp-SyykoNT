import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WorkbenchError, type WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus } from "../workbench/status.js";

/** A script reload can run for minutes on a large project; the 10 s default would report a working reload as a timeout. */
const RELOAD_TIMEOUT_MS = 180_000;

/** What the user checks after ReloadScripts answers Ok: the answer alone does not prove the scripts were recompiled. */
const RELOAD_NOTE =
  "Workbench accepted the reload. A new \"Reloading game scripts took\" line in Workbench's console.log confirms it ran; " +
  "if there is none, do not assume it ran.";

/** Sends the built-in ReloadScripts (also used by the tuning server). Its documented reply is a bare Ok, which the decoder throws; that counts as success. Returns RELOAD_NOTE. */
export async function reloadScripts(client: Pick<WorkbenchClient, "call">): Promise<string> {
  try {
    await client.call("ReloadScripts", {}, { timeout: RELOAD_TIMEOUT_MS });
  } catch (e) {
    if (!(e instanceof Error && /Ok status with (empty|no) payload/.test(e.message))) throw e;
  }
  return RELOAD_NOTE;
}

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
      const parts: string[] = [];
      try {
        let isError = false;

        if (target !== "plugins") parts.push("**ReloadScripts answered Ok**\n\n" + (await reloadScripts(client)));

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
        // target both: keep the scripts part when the plugins step throws; with no part yet, the scripts step failed and plugins never ran.
        const kept = parts.length ? parts.join("\n\n") + "\n\n" : "";
        const skipped = target === "both" && !parts.length ? " Plugins were not tried." : "";
        return {
          content: [{ type: "text" as const, text: `${kept}Error reloading: ${msg}${hint}${skipped}${formatConnectionStatus(client)}` }],
          isError: true,
        };
      }
    }
  );
}
