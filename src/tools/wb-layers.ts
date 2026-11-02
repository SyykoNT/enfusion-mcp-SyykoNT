import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus, ensureMode } from "../workbench/status.js";

const MUTATING_LAYER_ACTIONS = new Set(["create", "delete", "rename", "toggleLock", "setActive"]);
// Handlers older than WE-SAVEAS answer these with "Unknown action"
const NEW_HANDLER_ACTIONS = new Set(["create", "setActive"]);

export function registerWbLayers(server: McpServer, client: WorkbenchClient): void {
  server.registerTool(
    "wb_layers",
    {
      description:
        "Manage layers in the World Editor. create makes a layer (nested with parentPath) in the sub-scene being edited; " +
        "it is written to disk on the next wb_save. setActive sets the layer new entities go to and confirms it by reading it back. " +
        "getActive reports the current sub-scene and its active layer. Also list, isVisible, getInfo and toggleLock (layer IDs). " +
        "create, setActive and toggleLock only work in edit mode.",
      inputSchema: {
        action: z
          .enum([
            "list",
            "getActive",
            "create",
            "delete",
            "rename",
            "setActive",
            "setVisibility",
            "lock",
            "unlock",
            "isVisible",
            "getInfo",
            "toggleLock",
          ])
          .describe("Layer management action to perform"),
        subScene: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Sub-scene index (default: the sub-scene being edited; 0 is the terrain's base world). create works only in the edited one"),
        layerPath: z
          .string()
          .optional()
          .describe("Layer path as create returns it (e.g. 'MISSION' or 'MISSION/OBJECTIVES'). Required for setActive"),
        name: z
          .string()
          .optional()
          .describe("Layer name for create (one name, no '/')"),
        parentPath: z
          .string()
          .optional()
          .describe("Existing layer to create the new one under (e.g. 'MISSION'); omit for a top-level layer"),
        visible: z
          .boolean()
          .optional()
          .describe("Visibility state for setVisibility (true = visible, false = hidden)"),
      },
    },
    async ({ action, subScene, layerPath, name, parentPath, visible }) => {
      if (MUTATING_LAYER_ACTIONS.has(action)) {
        const modeErr = await ensureMode(client, "edit", `${action} layer`);
        if (modeErr) {
          return { content: [{ type: "text" as const, text: modeErr + formatConnectionStatus(client) }], isError: true };
        }
      }
      try {
        const params: Record<string, unknown> = { action };
        if (subScene !== undefined) params.subScene = subScene;
        if (layerPath) params.layerPath = layerPath;
        if (name) params.name = name;
        if (parentPath) params.parentPath = parentPath;
        if (visible !== undefined) params.visible = visible;

        const result = await client.call<Record<string, unknown>>("EMCP_WB_Layers", params);

        if (action === "list") {
          const layers = Array.isArray(result.layers) ? result.layers : [];
          if (layers.length === 0) {
            return {
              content: [{ type: "text" as const, text: `**No layers found.**${formatConnectionStatus(client)}` }],
            };
          }

          const lines = [`**Layers** (SubScene ${result.currentSubScene ?? subScene ?? "current"})\n`];
          for (const layer of layers) {
            const l = layer as Record<string, unknown>;
            const path = l.path || l.name || "(unnamed)";
            const flags: string[] = [];
            if (l.active) flags.push("ACTIVE");
            if (l.locked) flags.push("LOCKED");
            if (l.visible === false) flags.push("HIDDEN");
            const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
            const entityCount = l.entityCount !== undefined ? ` (${l.entityCount} entities)` : "";
            lines.push(`- ${path}${flagStr}${entityCount}`);
          }

          if (result.activeLayer) {
            lines.push(`\nActive layer: **${result.activeLayer}**`);
          }

          return { content: [{ type: "text" as const, text: lines.join("\n") + formatConnectionStatus(client) }] };
        }

        if (action === "isVisible" || action === "getInfo") {
          const lines = [`**Layer ${layerPath || result.layerID}**\n`];
          if (result.layerVisible !== undefined) lines.push(`- **Visible:** ${result.layerVisible}`);
          if (result.layerLocked !== undefined) lines.push(`- **Locked:** ${result.layerLocked}`);
          if (result.layerActive !== undefined) lines.push(`- **Active:** ${result.layerActive}`);
          if (result.layerEntityCount !== undefined) lines.push(`- **Entities:** ${result.layerEntityCount}`);
          if (result.layerID !== undefined) lines.push(`- **Layer ID:** ${result.layerID}`);
          return { content: [{ type: "text" as const, text: lines.join("\n") + formatConnectionStatus(client) }] };
        }

        const done = (text: string) => ({ content: [{ type: "text" as const, text: text + formatConnectionStatus(client) }] });
        // An old handler's getActive reports the sub-scene only
        const active = typeof result.activeLayer === "string" && result.activeLayer ? result.activeLayer : "(not reported: handler out of date)";
        if (action === "getActive") {
          return done(`**Active Layer**\n\n- **Sub-scene:** ${result.currentSubScene}\n- **Active layer:** ${active}`);
        }
        if (action === "create") {
          return done(`**Layer Created**\n\n- **Layer:** ${result.layerPath}\n- **Active layer:** ${active}\n\nWritten to disk on the next wb_save.`);
        }
        if (action === "setActive") {
          // The handler confirms by reading the layer back; ok means it took
          return done(`**Active Layer Set**\n\n- **Active layer:** ${active}\n\nNew entities go to this layer.`);
        }

        if (action === "toggleLock") {
          const nowLocked = result.layerLocked;
          return {
            content: [{
              type: "text" as const,
              text: `**Layer Lock Toggled**\n\nLayer "${layerPath}" is now ${nowLocked ? "locked" : "unlocked"}${formatConnectionStatus(client)}`,
            }],
          };
        }

        const actionLabels: Record<string, string> = {
          delete: `Deleted layer "${layerPath}"`,
          rename: `Renamed layer "${layerPath}" to "${name}"`,
          setVisibility: `Set "${layerPath}" visibility to ${visible ? "visible" : "hidden"}`,
          lock: `Locked layer "${layerPath}"`,
          unlock: `Unlocked layer "${layerPath}"`,
          isVisible: `Queried visibility of layer "${layerPath}"`,
          getInfo: `Got info for layer "${layerPath}"`,
          toggleLock: `Toggled lock on layer "${layerPath}"`,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `**Layer Updated**\n\n${actionLabels[action] || action}${result.message ? `\n${result.message}` : ""}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        let msg = e instanceof Error ? e.message : String(e);
        if (msg.startsWith("Unknown action") && NEW_HANDLER_ACTIONS.has(action)) {
          msg = `EMCP_WB_Layers is out of date (it has no ${action}); refresh the handlers (see CHANGELOG). Nothing was changed.`;
        }
        return {
          content: [
            { type: "text" as const, text: `Error managing layers (${action}): ${msg}${formatConnectionStatus(client)}` },
          ],
          isError: true,
        };
      }
    }
  );
}
