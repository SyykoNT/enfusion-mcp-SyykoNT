import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus, ensureMode } from "../workbench/status.js";
import { readWorld, saveRefusal } from "./wb-editor.js";
import type { Config } from "../config.js";

const MUTATING_LAYER_ACTIONS = new Set(["create", "toggleLock", "setActive"]);
// Becomes <World>_Layers\<name>.layer on save; COALITION's layer names (_INIT, MARKERS, GameBorderS ...) fit
const LAYER_NAME = /^[A-Za-z0-9_]{1,64}$/;
// Handlers older than WE-SAVEAS answer these with "Unknown action"
const NEW_HANDLER_ACTIONS = new Set(["create", "setActive"]);

export function registerWbLayers(server: McpServer, client: WorkbenchClient, config: Config): void {
  server.registerTool(
    "wb_layers",
    {
      description:
        "Manage layers in the World Editor. create makes a top-level layer in the sub-scene being edited (nested layers made " +
        "through the script API are not saved, so they are not offered); " +
        "it is written to disk on the next wb_save. create is refused, without creating, in a world wb_save would refuse (unnamed, packed, in the game or Tools folders or the Workshop cache), because the layer could never be saved. " +
        "Until a wb_save runs, a world open (.ent or .gproj) is refused, and wb_play and a wb_close that does not save add a line that the layer is dropped unsaved. setActive sets the layer new entities go to and confirms it by reading it back. " +
        "getActive reports the current sub-scene and its active layer. Also list, isVisible, getInfo and toggleLock (layer IDs). " +
        "create, setActive and toggleLock only work in edit mode.",
      inputSchema: {
        action: z
          .enum(["list", "getActive", "create", "setActive", "isVisible", "getInfo", "toggleLock"])
          .describe("Layer management action to perform"),
        subScene: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Sub-scene index (default: the sub-scene being edited; 0 is the terrain's base world). create and setActive work only in the edited one"),
        layerPath: z
          .string()
          .optional()
          .describe("Layer path as list or create shows it (e.g. 'MISSION'). Required for setActive"),
        name: z
          .string()
          .optional()
          .describe("Layer name for create: 1 to 64 letters, digits or '_' (it becomes the .layer file name)"),
        parentPath: z
          .string()
          .optional()
          .describe("Not supported: nested layers made through the script API are not saved, so any parentPath is refused"),
      },
    },
    async ({ action, subScene, layerPath, name, parentPath }) => {
      const refuse = (text: string) => ({ content: [{ type: "text" as const, text: text + formatConnectionStatus(client) }], isError: true as const });
      if (action === "create") {
        // Refused here, not dropped: a nested request must not quietly become a top-level layer
        if (parentPath) {
          return refuse("Nested layers are not offered: a layer created under another layer through the script API is not saved (Save() returned false and its entities were lost, live check 2026-11-02). Create a top-level layer. Nothing was changed.");
        }
        if (!name || !LAYER_NAME.test(name)) {
          return refuse(`Layer name must be 1 to 64 letters, digits or '_' (it becomes the .layer file name): "${name ?? ""}". Nothing was changed.`);
        }
      }
      if (MUTATING_LAYER_ACTIONS.has(action)) {
        const modeErr = await ensureMode(client, "edit", `${action} layer`);
        if (modeErr) {
          return { content: [{ type: "text" as const, text: modeErr + formatConnectionStatus(client) }], isError: true };
        }
      }
      if (action === "create") {
        // A layer in a world wb_save refuses could never be saved, and the unsaved mark would then block every open.
        const world = await readWorld(client, "Nothing was changed.");
        if ("error" in world) return refuse(world.error);
        const why = saveRefusal(world.info, config);
        if (why) return refuse(`${why.text} A layer created here could not be saved, so none was created. Nothing was changed.`);
      }
      try {
        const params: Record<string, unknown> = { action };
        if (subScene !== undefined) params.subScene = subScene;
        if (layerPath) params.layerPath = layerPath;
        if (name) params.name = name;

        const result = await client.call<Record<string, unknown>>("EMCP_WB_Layers", params);
        if (action === "create") await client.markLayerCreated();

        if (action === "list") {
          // 1.9 packs an extra empty object before each real row; a real row has a path, name or layer ID (the count may be missing)
          const layers = (Array.isArray(result.layers) ? result.layers : []).filter((l) => l?.path || l?.name || typeof l?.layerID === "number");
          if (layers.length === 0) {
            return {
              content: [{ type: "text" as const, text: `**No layers found.**${formatConnectionStatus(client)}` }],
            };
          }

          const lines = [`**Layers** (SubScene ${result.currentSubScene ?? subScene ?? "current"})\n`];
          for (const layer of layers) {
            const l = layer as Record<string, unknown>;
            // An old handler sends no path; a layer the handler could not name is shown by its ID
            const path = l.path || `(layer id ${l.layerID})`;
            const flags: string[] = [];
            if (l.path && l.path === result.activeLayer) flags.push("ACTIVE");
            if (l.locked) flags.push("LOCKED");
            if (l.visible === false) flags.push("HIDDEN");
            const flagStr = flags.length > 0 ? ` [${flags.join(", ")}]` : "";
            lines.push(`- ${path}${flagStr}${typeof l.entityCount === "number" ? ` (${l.entityCount} entities)` : ""}`);
          }

          if (result.activeLayer) {
            lines.push(`\nActive layer: **${result.activeLayer}**`);
          }
          // What the entity counts cover, as the handler states it
          if (typeof result.message === "string" && result.message) {
            lines.push(`\n${result.message}`);
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

        // toggleLock, the one action left
        return done(`**Layer Lock Toggled**\n\nLayer "${layerPath}" is now ${result.layerLocked ? "locked" : "unlocked"}`);
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
