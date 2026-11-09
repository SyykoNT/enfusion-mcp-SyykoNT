import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dirname } from "node:path";
import { WorkbenchError, type WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus, ensureMode } from "../workbench/status.js";
import { diffSnapshots, snapshotDir } from "../workbench/files.js";

export function registerWbEditorTools(server: McpServer, client: WorkbenchClient): void {
  // wb_play — Switch to game mode (Play in Editor)
  server.registerTool(
    "wb_play",
    {
      description:
        "Switch Workbench to game (play) mode. Compiles scripts and launches the world for testing. Equivalent to pressing Play in the World Editor. Requires edit mode.",
      inputSchema: {
        debugMode: z
          .boolean()
          .optional()
          .describe("Enable debug mode (script breakpoints, extra logging)"),
        fullScreen: z
          .boolean()
          .optional()
          .describe("Launch in full-screen mode instead of windowed"),
      },
    },
    async ({ debugMode, fullScreen }) => {
      const modeErr = await ensureMode(client, "edit", "start play mode");
      if (modeErr) {
        return { content: [{ type: "text" as const, text: modeErr + formatConnectionStatus(client) }], isError: true };
      }
      try {
        const params: Record<string, unknown> = { action: "play" };
        if (debugMode !== undefined) params.debugMode = debugMode;
        if (fullScreen !== undefined) params.fullScreen = fullScreen;

        const result = await client.call<Record<string, unknown>>("EMCP_WB_EditorControl", params);
        client.setMode("play");

        return {
          content: [
            {
              type: "text" as const,
              text: `**Play Mode Started**\n\nWorkbench is now compiling and entering game mode.${result.message ? `\n${result.message}` : ""}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `Error starting play mode: ${msg}${formatConnectionStatus(client)}` }],
        isError: true,
        };
      }
    }
  );

  // wb_stop — Switch to edit mode
  server.registerTool(
    "wb_stop",
    {
      description:
        "Stop game mode and return to the World Editor. Equivalent to pressing Stop in the World Editor. Requires play mode.",
      inputSchema: {},
    },
    async () => {
      const modeErr = await ensureMode(client, "play", "stop play mode");
      if (modeErr) {
        return { content: [{ type: "text" as const, text: modeErr + formatConnectionStatus(client) }], isError: true };
      }
      try {
        const result = await client.call<Record<string, unknown>>("EMCP_WB_EditorControl", {
          action: "stop",
        });
        client.setMode("edit");

        return {
          content: [
            {
              type: "text" as const,
              text: `**Edit Mode Restored**\n\nWorkbench has returned to edit mode.${result.message ? `\n${result.message}` : ""}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `Error stopping play mode: ${msg}${formatConnectionStatus(client)}` }],
        isError: true,
        };
      }
    }
  );

  // wb_save — Save the current world
  server.registerTool(
    "wb_save",
    {
      description:
        "Save the open world in the World Editor (edit mode only) and list the files written under the world's folder. " +
        "Refuses, without saving, an unnamed world or prefab edit mode (both would open a blocking \"Save world as\" dialog). " +
        "Save As is not reachable from the 1.8 script API, so a path is refused.",
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe("Not supported: Save As is not reachable from the 1.8 script API (live check 2026-11-02), so any path is refused"),
      },
    },
    async ({ path }) => {
      const reply = (text: string, isError = false) => ({
        content: [{ type: "text" as const, text: text + formatConnectionStatus(client) }],
        ...(isError ? { isError: true as const } : {}),
      });
      if (path) return reply("Save As is not reachable from the 1.8 script API: GameWorldEditor (which has SaveWorldAs) is not a Workbench module, GetGame().GetWorldEditor() returns null in Workbench, and the World Editor module has only Save(). Save under a new name by hand (File > Save World As). Nothing was saved.", true);
      const modeErr = await ensureMode(client, "edit", "save");
      if (modeErr) return reply(modeErr, true);

      let info: Record<string, unknown>;
      try {
        info = await client.call<Record<string, unknown>>("EMCP_WB_EditorControl", { action: "worldInfo" });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // An old handler cannot guard its save, so never fall through to it.
        if (msg.startsWith("Unknown action")) {
          return reply("EMCP_WB_EditorControl is out of date; refresh the handlers (see CHANGELOG). Nothing was saved.", true);
        }
        return reply(`Could not read the open world: ${msg}. Nothing was saved.`, true);
      }
      // The handler guards too; these repeat it so the reason reads the same either way.
      if (info.prefabEditMode) return reply("Prefab edit mode: wb_save saves worlds. Use wb_prefabs save for the prefab.", true);
      if (info.gameMode) return reply("Play mode: stop it with wb_stop before saving. Nothing was saved.", true);
      const worldPath = typeof info.worldPath === "string" ? info.worldPath : "";
      if (!worldPath) {
        return reply(
          "No world file: the open world is unnamed. Saving would open Workbench's \"Save world as\" dialog and block every MCP call. " +
            "Save it once in Workbench (File > Save World As) or open a world from a file.",
          true
        );
      }
      // Until probed, a world without a disk path (packed addon, unresolved path) is not saved: no folder to check, unknown dialogs.
      const absPath = typeof info.absPath === "string" ? info.absPath : "";
      if (!absPath) return reply(`World ${worldPath} has no file on disk that Workbench could resolve (packed addon?). Nothing was saved.`, true);

      const folder = dirname(absPath);
      const before = await snapshotDir(folder);
      const written = async () => {
        const d = diffSnapshots(before, await snapshotDir(folder));
        return { files: [...d.changed, ...d.added], removed: d.removed, unchanged: Object.keys(before).length - d.changed.length - d.removed.length };
      };
      let result: Record<string, unknown>;
      try {
        result = await client.call<Record<string, unknown>>("EMCP_WB_EditorControl", { action: "save" }, { timeout: 30_000 });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const w = await written();
        const so = `Files changed so far: ${w.files.length ? w.files.join(", ") : "none"}.`;
        if (e instanceof WorkbenchError && e.code === "TIMEOUT") {
          return reply(`No answer from Workbench in 30 s. A dialog is probably open and blocks every MCP call until it is answered (B-007). ${so}`, true);
        }
        return reply(`Error saving: ${msg}. ${so}`, true);
      }

      const w = await written();
      const saved = result.saved === true;
      if (!w.files.length) {
        return saved
          ? reply(`Save() returned true but no file under ${folder} changed. Check terrain files and the world path.`, true)
          : reply("Save() returned false and no file changed. Workbench may have had nothing to save (unverified meaning of false).");
      }
      return reply(
        `**World saved**\nWorld: ${worldPath}\n` +
          `Written (${w.files.length}) under ${folder}: ${w.files.join(", ")}\n` +
          (w.removed.length ? `Removed (${w.removed.length}): ${w.removed.join(", ")}\n` : "") +
          `Not changed: ${w.unchanged} other files\n` +
          // The files are the proof; on 1.9.0.37 Save() returns false although it writes them.
          `Save() returned ${saved}${saved ? "" : "; on 1.9.0.37 it also returns false when files are written"}`
      );
    }
  );

  // wb_undo_redo — Undo or redo
  server.registerTool(
    "wb_undo_redo",
    {
      description: "Undo or redo the last action in the World Editor.",
      inputSchema: {
        action: z
          .enum(["undo", "redo"])
          .describe("Whether to undo or redo"),
      },
    },
    async ({ action }) => {
      try {
        const result = await client.call<Record<string, unknown>>("EMCP_WB_EditorControl", {
          action,
        });

        const label = action === "undo" ? "Undo" : "Redo";
        return {
          content: [
            {
              type: "text" as const,
              text: `**${label} Complete**${result.message ? `\n\n${result.message}` : ""}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `Error performing ${action}: ${msg}${formatConnectionStatus(client)}` }],
        isError: true,
        };
      }
    }
  );

  // wb_open_resource — Open a resource in Workbench
  server.registerTool(
    "wb_open_resource",
    {
      description:
        "Open a resource file in the appropriate Workbench editor (e.g., a .et prefab in the Prefab Editor, a .c script in the Script Editor). " +
        "Opening a world (.ent) while the current world has unsaved changes makes Workbench ask \"Loading world\" (Yes/No/Cancel); that dialog blocks every MCP call until a person answers it, and the script API cannot tell whether the world has unsaved changes. " +
        "Run wb_save first, or let the user discard the changes in Workbench.",
      inputSchema: {
        path: z
          .string()
          .describe("Resource path to open (e.g., 'Prefabs/Weapons/AK47.et', 'Scripts/Game/MyScript.c')"),
      },
    },
    async ({ path }) => {
      try {
        const result = await client.call<Record<string, unknown>>("EMCP_WB_EditorControl", {
          action: "openResource",
          path,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `**Resource Opened**\n\nOpened: ${path}${result.message ? `\n${result.message}` : ""}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Only a world open raises "Loading world"; skip it when the client's report already names a different dialog
        const hint =
          e instanceof WorkbenchError && e.code === "TIMEOUT" && /\.ent$/i.test(path) && (!msg.includes("has a dialog open") || msg.includes("\"Loading world\""))
            ? "\n\nA timeout here usually means Workbench is showing the \"Loading world\" dialog (the current world has unsaved changes). Ask the user to answer it in Workbench; use wb_save before opening another world."
            : "";
        return {
          content: [{ type: "text" as const, text: `Error opening resource: ${msg}${hint}${formatConnectionStatus(client)}` }],
        isError: true,
        };
      }
    }
  );
}
