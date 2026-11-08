import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus, ensureMode } from "../workbench/status.js";

const MUTATING_PREFAB_ACTIONS = new Set(["createTemplate", "save"]);

/**
 * Vanilla LocatePrefabsFromPath (AssetLibraryUtils.c) runs FindFiles(selectedFolder, ".et") when selectedFolder contains projectPath,
 * and FindFiles searches every mounted file system. So an empty folder scans every mounted pak (about 5 min of a hung Workbench), and a
 * single top-level folder ("Prefabs") walks that tree of vanilla plus every loaded addon (scan time unmeasured). Mapping: vanilla
 * "Prefabs/Weapons/Rifles" -> selectedProject "ArmaReforger", projectPath "Prefabs"; addon "$MyAddon:Prefabs/X" -> selectedProject "MyAddon",
 * projectPath "$MyAddon:Prefabs" (addon form inferred, not run live).
 * Returns undefined when the folder is a data root ("", "/", ".", "..", "...", "$Addon:", "$Addon:.", "$:"), an unprefixed single segment, or not a virtual
 * game path: control or format characters, a colon anywhere but the "$Addon:" prefix ("C:", "/C:/x", "D:Prefabs/X") or UNC input ("//server/share") are refused instead of being rewritten.
 * The optional "$Addon:" prefix is split off first so that it cannot hide a root behind it.
 */
export function locateRequest(searchPath: string) {
  const input = searchPath.trim();
  if (/\p{C}/u.test(input) || /^[\\/]{2}/.test(input)) return undefined;
  const [, prefix = "", rest] = /^(\$[^:/]*:|[A-Za-z]:)?([\s\S]*)$/.exec(input)!;
  if (prefix && !prefix.startsWith("$")) return undefined;
  const segs = rest.replace(/\\/g, "/").split("/").map((x) => x.trim()).filter((x) => x && x !== ".");
  const addon = prefix.startsWith("$") ? prefix.slice(1, -1).trim() : undefined;
  if (!segs.length || segs.some((x) => /^[.\s]+$|:/.test(x)) || addon === "" || (addon === undefined && segs.length < 2)) return undefined;
  return {
    selectedProject: addon || "ArmaReforger",
    projectPath: prefix + segs[0],
    selectedFolder: prefix + segs.join("/"),
  };
}

export function registerWbPrefabs(server: McpServer, client: WorkbenchClient): void {
  server.registerTool(
    "wb_prefabs",
    {
      description:
        "Prefab operations in the Workbench. Create entity templates, save prefab changes, look up prefab GUIDs, or locate prefabs by path. createTemplate/save only work in edit mode. locate lists the .et files under one folder (never a whole data root) and Workbench asks for Script Authorization (FileIO.FindFiles) before it answers.",
      inputSchema: {
        action: z
          .enum(["createTemplate", "save", "getGuid", "locate", "getAncestor"])
          .describe(
            "Action: createTemplate (create .et from entity), save (save prefab changes), getGuid (look up GUID), locate (find prefabs in path), getAncestor (get the ancestor prefab path of a scene entity)"
          ),
        entityName: z
          .string()
          .optional()
          .describe("Entity name (required for createTemplate and save)"),
        templatePath: z
          .string()
          .optional()
          .describe("Output path for createTemplate (e.g., 'Prefabs/Custom/MyEntity.et')"),
        searchPath: z
          .string()
          .optional()
          .describe("Folder for locate, at least two levels deep, e.g. 'Prefabs/Weapons/Rifles/AK74'. A data root (empty, '/', '.') or a single top-level folder ('Prefabs') is refused"),
      },
    },
    async ({ action, entityName, templatePath, searchPath }) => {
      if (MUTATING_PREFAB_ACTIONS.has(action)) {
        const modeErr = await ensureMode(client, "edit", `${action === "createTemplate" ? "create template" : "save prefab"}`);
        if (modeErr) {
          return { content: [{ type: "text" as const, text: modeErr + formatConnectionStatus(client) }], isError: true };
        }
      }
      try {
        if (action === "getGuid") {
          if (!templatePath && !searchPath) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: Provide `templatePath` (prefab resource path) for getGuid.",
                },
              ],
              isError: true,
            };
          }

          const result = await client.call<Record<string, unknown>>("GetPrefabGUID", {
            path: templatePath || searchPath,
          });

          return {
            content: [
              {
                type: "text" as const,
                text: `**Prefab GUID**\n\n- **Path:** ${templatePath || searchPath}\n- **GUID:** ${result.guid || result.GUID || "(not found)"}${formatConnectionStatus(client)}`,
              },
            ],
          };
        }

        if (action === "locate") {
          if (!searchPath) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Error: Provide `searchPath` for the locate action.",
                },
              ],
              isError: true,
            };
          }

          const request = locateRequest(searchPath);
          if (!request) {
            return {
              content: [{ type: "text" as const, text: `Error: \`searchPath\` "${searchPath}" is empty, a whole data root, a single top-level folder, a drive or network path, or contains control or invisible characters; locate needs a virtual game folder such as 'Prefabs/Weapons/Rifles'.` }],
              isError: true,
            };
          }

          const result = await client.call<Record<string, unknown>>("LocatePrefabsFromPath", request);

          // The vanilla handler reports failure in-band as status "ERROR" (upper case, which the client does not rethrow).
          if (String(result.status).toLowerCase() === "error") {
            return {
              content: [{ type: "text" as const, text: `Error locating prefabs in ${searchPath}: ${result.message || "(no message)"}${formatConnectionStatus(client)}` }],
              isError: true,
            };
          }

          const prefabs = Array.isArray(result.prefabsPaths) ? result.prefabsPaths : [];
          if (prefabs.length === 0) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `**No prefabs found** in: ${searchPath}${formatConnectionStatus(client)}`,
                },
              ],
            };
          }

          const lines = [`**Prefabs in ${searchPath}** (${prefabs.length})\n`];
          for (const p of prefabs) {
            if (typeof p === "string") {
              lines.push(`- ${p}`);
            } else {
              const pObj = p as Record<string, unknown>;
              lines.push(`- ${pObj.path || pObj.name || JSON.stringify(pObj)}`);
            }
          }
          return { content: [{ type: "text" as const, text: lines.join("\n") + formatConnectionStatus(client) }] };
        }

        if (action === "getAncestor") {
          if (!entityName) {
            return { content: [{ type: "text" as const, text: "Error: `entityName` is required for getAncestor." }], isError: true };
          }
          const result = await client.call<{ status: string; ancestorPath?: string; message?: string }>(
            "EMCP_WB_Prefabs", { action: "getAncestor", entityName }
          );
          return {
            content: [{
              type: "text" as const,
              text: `**Ancestor Prefab**\n\n- **Entity:** ${entityName}\n- **Ancestor:** ${result.ancestorPath || "(none)"}`,
            }],
          };
        }

        // createTemplate and save use EMCP_WB_Prefabs
        if ((action === "createTemplate" || action === "save") && !entityName) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Error: \`entityName\` is required for the "${action}" action.`,
              },
            ],
            isError: true,
          };
        }

        const params: Record<string, unknown> = { action, entityName };
        if (templatePath) params.templatePath = templatePath;

        const result = await client.call<Record<string, unknown>>("EMCP_WB_Prefabs", params);

        if (action === "createTemplate") {
          return {
            content: [
              {
                type: "text" as const,
                text: `**Template Created**\n\n- **Entity:** ${entityName}\n- **Path:** ${templatePath || result.path || "(auto)"}${result.guid ? `\n- **GUID:** ${result.guid}` : ""}${formatConnectionStatus(client)}`,
              },
            ],
          };
        }

        // save
        return {
          content: [
            {
              type: "text" as const,
              text: `**Prefab Saved**\n\n- **Entity:** ${entityName}${result.message ? `\n- **Note:** ${result.message}` : ""}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error with prefab operation (${action}): ${msg}${formatConnectionStatus(client)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
