import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { basename, dirname, join, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import type { Config } from "../config.js";
import type { WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus } from "../workbench/status.js";
import { findPids, killPids, sleep } from "../utils/process.js";
import { isOwned } from "../utils/instances.js";

export function registerWbLaunch(
  server: McpServer,
  config: Config,
  client: WorkbenchClient
): void {
  server.registerTool(
    "wb_launch",
    {
      description:
        "Start Workbench on one project and install the MCP handler scripts into that addon " +
        "(Scripts/WorkbenchGame/EnfusionMCP/), then wait for the NET API. In a git repo it first adds that folder to the " +
        "repo's local exclude file (.git/info/exclude) and refuses if handler files are committed. Pass gprojPath; without it the server " +
        "picks ENFUSION_DEFAULT_MOD or the first .gproj under the project path, never one in ENFUSION_PROTECTED_ADDONS. " +
        "A protected gprojPath opens only when it already holds the handlers (nothing is written into it); otherwise it is refused. If a Workbench already answers on " +
        "the NET API it reports that and starts nothing; if one is running but not answering it refuses to start " +
        "another. Check that nobody else is using Workbench first. When done, call wb_cleanup to remove the " +
        "handler scripts from the mod before the user publishes.",
      inputSchema: {
        gprojPath: z
          .string()
          .optional()
          .describe(
            "Path to a .gproj file to open directly. Skips the Workbench launcher screen and goes straight " +
            "into the World Editor. Handler scripts are copied into the mod so all wb_* tools work; a protected addon " +
            "(ENFUSION_PROTECTED_ADDONS) is never written to and must already hold them. " +
            "If omitted, the server falls back to ENFUSION_DEFAULT_MOD or the first .gproj it finds that is not protected."
          ),
        unattended: z
          .boolean()
          .optional()
          .describe(
            "Start Workbench with -noThrow, which Bohemia documents as disabling error message dialogs (asserts, crashes). " +
            "Untested on a GUI Workbench and on Script Authorization prompts; use only for unattended runs."
          ),
        worldPath: z
          .string()
          .optional()
          .describe(
            "A world (.ent) of the opened project to load in the World Editor at start (-wbModule=WorldEditor -run -load). " +
            "Needs gprojPath or ENFUSION_DEFAULT_MOD. Only on a fresh start: a running Workbench does not switch worlds."
          ),
      },
    },
    async ({ gprojPath, unattended, worldPath }) => {
      try {
        const alreadyRunning = await client.ping();
        const gitNote = alreadyRunning ? undefined : await client.ensureRunning(gprojPath, unattended, worldPath);

        // Remember which addon was requested so other tools default to it (not after a refused launch)
        if (gprojPath) {
          config.defaultMod = basename(dirname(resolve(gprojPath)));
        }

        if (alreadyRunning) {
          const notOpened = worldPath
            ? `\n\nworldPath was not opened: a running Workbench does not switch worlds here. Open it with **wb_open_resource**, or close Workbench and launch again.`
            : "";
          return {
            content: [
              {
                type: "text" as const,
                text: `**Workbench Already Running**: NET API is responding. All \`wb_*\` tools are available.${notOpened}${formatConnectionStatus(client)}`,
              },
            ],
          };
        }

        const modDir = gprojPath ? dirname(resolve(gprojPath)) : null;
        const isProtected = !!modDir && client.isProtectedMod(modDir);
        const stale = isProtected ? client.staleHandlers(modDir!) : [];
        const note = isProtected
          ? `\n\nProtected addon: handlers already present, nothing written.` +
            (stale.length ? `\n\n**Warning:** stale handlers, refresh by hand (missing or different from the bundled copy): ${stale.join(", ")}` : "")
          : modDir
          ? `\n\nNote: Handler scripts were copied to ${modDir}/Scripts/WorkbenchGame/EnfusionMCP/. ` +
            `Call **wb_cleanup** with the mod directory path when done to remove them before publishing.`
          : "";
        // Not verified here (no handler for it yet): the caller confirms with wb_state.
        const world = worldPath ? `\n\nWorld requested at start: ${worldPath}. Confirm it loaded with **wb_state**.` : "";

        return {
          content: [
            {
              type: "text" as const,
              text: `**Workbench Ready**: launched, ${isProtected ? "handler scripts present" : "handler scripts installed"}, NET API responding. All \`wb_*\` tools are available.${world}${note}${gitNote ? `\n\n${gitNote}` : ""}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [
            {
              type: "text" as const,
              text: `**Launch Failed**\n\n${msg}${formatConnectionStatus(client)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "wb_close",
    {
      description:
        "Close a Workbench this MCP session started (recorded at launch); any other Workbench is refused and left running. " +
        "By default saves the open world first and exits cleanly through the NET API (skipped while another Workbench runs, " +
        "because that one may own the NET API port); force=true kills the owned process if it does not exit.",
      inputSchema: {
        save: z.boolean().default(true).describe("Save the open world before exiting (default true)"),
        force: z.boolean().default(false).describe("Kill the process if it does not exit on its own (unsaved work is lost)"),
      },
    },
    async ({ save, force }) => {
      const image = "ArmaReforgerWorkbenchSteamDiag.exe";
      const pids = findPids(image);
      if (pids.length === 0) {
        return { content: [{ type: "text" as const, text: "Workbench is not running." }] };
      }
      const owned = pids.filter((pid) => isOwned(pid));
      const others = pids.filter((pid) => !owned.includes(pid));
      const untouched = others.length
        ? ` Not touched: Workbench pid ${others.join(", ")}, not started by this MCP session; close it in Workbench or ask whoever uses it.`
        : "";
      if (!owned.length) {
        return { content: [{ type: "text" as const, text: `**Not closed.**${untouched}` }], isError: true };
      }
      const alive = () => findPids(image).filter((pid) => owned.includes(pid));
      const notes: string[] = [];
      if (others.length) {
        notes.push("NET API exit skipped (another Workbench may be the one answering on the NET API port).");
      } else {
        try {
          const r = await client.call<Record<string, unknown>>("EMCP_WB_Exit", { save }, { timeout: 20_000 });
          notes.push(save ? (r.saved ? "World saved." : "Nothing saved (no world open or save refused).") : "Closed without saving.");
        } catch (e) {
          // In edit mode the handler exits at once, so the connection drops before it answers.
          await sleep(1500);
          if (alive().length) notes.push(`NET API exit failed (${e instanceof Error ? e.message : String(e)}).`);
        }
        for (let i = 0; i < 10 && alive().length; i++) await sleep(500);
      }
      // Each polite close shuts one top-level window, so repeat it while waiting.
      for (let i = 0; i < 20 && alive().length; i++) {
        if (i % 4 === 0) killPids(alive());
        await sleep(500);
      }
      if (alive().length && force) {
        // Re-check ownership right before the kill: a PID can be reused while we waited.
        killPids(alive().filter((pid) => isOwned(pid)), true);
        await sleep(1000);
        notes.push("Process killed (force).");
      }
      const still = alive().length > 0;
      return {
        content: [{
          type: "text" as const,
          text: still
            ? `**Workbench is still running**: it may be showing a dialog. ${notes.join(" ")} Retry with force=true to kill it.${untouched}`
            : `**Workbench closed.** ${notes.join(" ")}${untouched}`,
        }],
        ...(still ? { isError: true as const } : {}),
      };
    }
  );

  // Cleanup tool to remove handler scripts after Workbench work is done
  server.registerTool(
    "wb_cleanup",
    {
      description:
        "Remove the temporary EnfusionMCP handler scripts from mod directories. " +
        "Removes the MCP's own EMCP_* handler files from addons; other scripts in that folder stay. " +
        "Call this after finishing Workbench work and before the user publishes their mod. " +
        "Handlers are injected into whichever mod is open at the time, so they accumulate across " +
        "unrelated addons over many sessions — call with NO arguments to list every addon that " +
        "currently has them (safe, read-only), then pass all=true to clear them all, or modDir to " +
        "clear just one. Safe to call even if scripts were never installed.",
      inputSchema: {
        modDir: z
          .string()
          .optional()
          .describe("Path to a single mod's root directory (the folder containing the .gproj file). Omit to list, or use with all=true to clear everything."),
        all: z
          .boolean()
          .optional()
          .describe("Remove handler scripts from EVERY addon that has them. Run with no arguments first to see the list."),
      },
    },
    async ({ modDir, all }) => {
      // No target named: report what is installed rather than guessing. Clearing 20+
      // directories is not something to do implicitly off an empty call.
      if (!modDir && !all) {
        const installed = client.listInstalledHandlerMods();
        if (installed.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `**No handler scripts installed** in any addon under the configured project path. Nothing to clean.${formatConnectionStatus(client)}`,
            }],
          };
        }
        const lines = [
          `**Handler scripts are installed in ${installed.length} addon${installed.length === 1 ? "" : "s"}**`,
          ``,
          `These are injected automatically so Workbench compiles the NET API handlers. They are`,
          `harmless locally, but they ship with the mod if it is published.`,
          ``,
          ...installed.map((m) => `- \`${m.modDir}\` *(${m.fileCount} files${m.protected ? ", protected: kept" : ""})*`),
          ``,
          `Pass \`all: true\` to remove them from all ${installed.length}, or \`modDir\` for a single one.`,
        ];
        return { content: [{ type: "text" as const, text: lines.join("\n") + formatConnectionStatus(client) }] };
      }

      if (all) {
        const installed = client.listInstalledHandlerMods();
        if (installed.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: `**Nothing to clean** — no addon under the project path has handler scripts.${formatConnectionStatus(client)}`,
            }],
          };
        }
        const cleaned: string[] = [];
        const failed: string[] = [];
        const kept = installed.filter((m) => m.protected).map((m) => m.modDir);
        for (const mod of installed) {
          if (mod.protected) continue;
          try {
            if (client.cleanupHandlerScripts(mod.modDir)) cleaned.push(mod.modDir);
          } catch (e) {
            failed.push(`${mod.modDir} — ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        const lines = [`**Cleanup Complete** — handler scripts removed from ${cleaned.length} addon${cleaned.length === 1 ? "" : "s"}.`, ``];
        lines.push(...cleaned.map((c) => `- \`${c}\``));
        if (kept.length > 0) {
          lines.push(``, `**Kept (protected, ENFUSION_PROTECTED_ADDONS):**`, ...kept.map((k) => `- \`${k}\``));
        }
        if (failed.length > 0) {
          lines.push(``, `**Failed (${failed.length}):**`, ...failed.map((f) => `- ${f}`));
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") + formatConnectionStatus(client) }],
          ...(failed.length > 0 ? { isError: true as const } : {}),
        };
      }

      modDir = modDir as string;
      // Resolve to absolute path and validate
      const resolvedModDir = resolve(modDir);
      if (!existsSync(resolvedModDir)) {
        return {
          content: [{
            type: "text" as const,
            text: `**Error:** Directory not found: ${modDir}${formatConnectionStatus(client)}`,
          }],
        isError: true,
        };
      }
      const hasGproj = readdirSync(resolvedModDir).some(f => f.endsWith(".gproj"));
      if (!hasGproj) {
        return {
          content: [{
            type: "text" as const,
            text: `**Error:** "${resolvedModDir}" does not appear to be a mod directory (no .gproj file found). Provide the mod root directory containing the .gproj file.${formatConnectionStatus(client)}`,
          }],
        isError: true,
        };
      }

      if (client.isProtectedMod(resolvedModDir)) {
        return {
          content: [{
            type: "text" as const,
            text: `**Refused:** ${resolvedModDir} is a protected addon (ENFUSION_PROTECTED_ADDONS); its handler scripts are kept.${formatConnectionStatus(client)}`,
          }],
          isError: true,
        };
      }
      const removed = client.cleanupHandlerScripts(resolvedModDir);
      if (removed) {
        return {
          content: [
            {
              type: "text" as const,
              text: `**Cleanup Complete**: EnfusionMCP handler scripts removed from the mod. For a release check, run **release_audit**.${formatConnectionStatus(client)}`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `**No Cleanup Needed** — Handler scripts were not present in the mod directory.${formatConnectionStatus(client)}`,
          },
        ],
      };
    }
  );
}
