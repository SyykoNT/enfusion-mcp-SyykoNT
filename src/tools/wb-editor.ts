import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dirname } from "node:path";
import { WorkbenchError, isWorldPath, type WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus, ensureMode } from "../workbench/status.js";
import { diffSnapshots, snapshotDir } from "../workbench/files.js";
import { forbiddenRoot } from "../utils/safe-path.js";
import type { Config } from "../config.js";

/** The open world's worldInfo, or the refusal text; an old handler cannot guard its action, so never fall through to it. */
async function readWorld(client: WorkbenchClient, nothing: string): Promise<{ info: Record<string, unknown> } | { error: string }> {
  try {
    return { info: await client.call<Record<string, unknown>>("EMCP_WB_EditorControl", { action: "worldInfo" }) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith("Unknown action")) return { error: `EMCP_WB_EditorControl is out of date; refresh the handlers (see CHANGELOG). ${nothing}` };
    return { error: `Could not read the open world: ${msg}. ${nothing}` };
  }
}

export function registerWbEditorTools(server: McpServer, client: WorkbenchClient, config: Config): void {
  // wb_play — Switch to game mode (Play in Editor)
  server.registerTool(
    "wb_play",
    {
      description:
        "Switch Workbench to game (play) mode. Compiles scripts and launches the world for testing. Equivalent to pressing Play in the World Editor. Requires edit mode. " +
        "Refuses, without playing, an unnamed world and a world with no writable file (inside a .pak, the game or Tools folders, or the Workshop cache): " +
        "play may ask to save it and Save would write into those folders. Play a sub-scene of it in your own test addon. " +
        "Also refuses, without playing, a world with unsaved changes (local Workbench on Windows only), because Workbench asks \"World needs to be saved\" and that dialog blocks every MCP call; run wb_save first. It plays with a warning when it cannot check.",
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
      const refuse = (text: string) => ({ content: [{ type: "text" as const, text: text + formatConnectionStatus(client) }], isError: true });
      const world = await readWorld(client, "Play was not started.");
      if ("error" in world) return refuse(world.error);
      const worldPath = typeof world.info.worldPath === "string" ? world.info.worldPath : "";
      if (!worldPath) {
        return refuse(
          "No world file: the open world is unnamed. Play may ask to save it, which opens Workbench's \"Save world as\" dialog and blocks every MCP call. " +
            "Save it once in Workbench (File > Save World As) or open a world from a file. Play was not started."
        );
      }
      const absPath = typeof world.info.absPath === "string" ? world.info.absPath : "";
      const root = absPath ? forbiddenRoot(config, absPath) : null;
      if (!absPath || root) {
        return refuse(
          `Play is refused on a world without a writable file: ${worldPath} ${root ? `is inside ${root}` : "has no file on disk (inside a .pak, Workshop or vanilla)"}. ` +
            "Play may ask to save it, and Save would write into the game or Workshop folders. Play a sub-scene of it in your own test addon. Play was not started."
        );
      }
      const guard = await client.checkUnsaved("Starting play", '"World needs to be saved" prompt');
      if (guard && "refuse" in guard) return refuse(guard.refuse);
      const warn = guard ? `\n\n${guard.warn}` : "";
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
              text: `**Play Mode Started**\n\nWorkbench is now compiling and entering game mode.${result.message ? `\n${result.message}` : ""}${warn}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `Error starting play mode: ${msg}${warn}${formatConnectionStatus(client)}` }],
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
        "Refuses, without saving, an unnamed world or prefab edit mode (both would open a blocking \"Save world as\" dialog), and a world file inside the game or Tools folders or the Workshop cache. " +
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

      const world = await readWorld(client, "Nothing was saved.");
      if ("error" in world) return reply(world.error, true);
      const info = world.info;
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
      const root = forbiddenRoot(config, absPath);
      if (root) return reply(`World ${worldPath} is inside ${root} (game or Tools install, Workshop cache, or ENFUSION_FORBIDDEN_DIRS): a save would write there. Nothing was saved.`, true);

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

      client.clearLayerMark(); // the call ran: a pending layer is written by it, and a hand-saved world has nothing left to write
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
        "Opening a world (.ent) while the current world has unsaved changes makes Workbench ask \"Loading world\" (Yes/No/Cancel); that dialog blocks every MCP call until a person answers it. " +
        "The tool refuses a world open when the World Editor title shows unsaved changes (local Workbench on Windows only) and opens with a warning when it cannot check. " +
        "A layer this MCP created with wb_layers counts as unsaved until wb_save runs. " +
        "Run wb_save first, or let the user discard the changes in Workbench.",
      inputSchema: {
        path: z
          .string()
          .describe("Resource path to open (e.g., 'Prefabs/Weapons/AK47.et', 'Scripts/Game/MyScript.c')"),
      },
    },
    async ({ path }) => {
      let warn = "";
      try {
        const guard = isWorldPath(path) ? await client.checkWorldOpen(path) : undefined;
        if (guard && "refuse" in guard) return { content: [{ type: "text" as const, text: guard.refuse }], isError: true };
        if (guard) warn = `\n\n${guard.warn}`;

        const result = await client.call<Record<string, unknown>>("EMCP_WB_EditorControl", {
          action: "openResource",
          path,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: `**Resource Opened**\n\nOpened: ${path}${result.message ? `\n${result.message}` : ""}${warn}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Only a world open raises "Loading world"; skip it when the client's probe found a different dialog
        const found = e instanceof WorkbenchError ? (e.dialogs ?? []).flatMap((p) => ("dialogs" in p ? p.dialogs : [])) : [];
        const hint =
          e instanceof WorkbenchError && e.code === "TIMEOUT" && isWorldPath(path) && (found.length === 0 || found.some((w) => w.text === "Loading world"))
            ? "\n\nA timeout here usually means Workbench is showing the \"Loading world\" dialog (the current world has unsaved changes). Ask the user to answer it in Workbench; use wb_save before opening another world."
            : "";
        return {
          content: [{ type: "text" as const, text: `Error opening resource: ${msg}${hint}${warn}${formatConnectionStatus(client)}` }],
        isError: true,
        };
      }
    }
  );
}
