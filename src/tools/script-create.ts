import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Config } from "../config.js";
import type { SearchEngine } from "../index/search-engine.js";
import {
  generateScript,
  getScriptModuleFolder,
  getScriptFilename,
  type ScriptType,
} from "../templates/script.js";
import { validateFilename, validateEnforceIdentifier } from "../utils/safe-path.js";
import { resolveWriteAddon } from "../utils/game-paths.js";
import { findPids } from "../utils/process.js";

const ATTRIBUTE_TYPE = /^[A-Za-z_]\w*(<[A-Za-z_]\w*(,\s*[A-Za-z_]\w*)?>)?$/;

export function registerScriptCreate(server: McpServer, config: Config, searchEngine?: SearchEngine): void {
  server.registerTool(
    "script_create",
    {
      description:
        "Create a new Enforce Script (.c) file in an addon's Scripts/Game. Generates a properly structured script from a template with correct class hierarchy and method stubs. When parentClass is specified and no explicit methods are given, automatically looks up overridable methods from the API index. Needs modName or projectPath (an addon root with a .gproj); without one the code is returned unwritten.",
      inputSchema: {
        className: z
          .string()
          .min(1)
          .describe(
            "Full class name including prefix (e.g., 'TAG_MyComponent', 'MCM_GameMode')"
          ),
        scriptType: z
          .enum(["modded", "component", "gamemode", "action", "entity", "manager", "basic"])
          .describe(
            "Script template type. 'modded' overrides an existing class. 'component' creates a ScriptComponent. 'gamemode' creates a game mode. 'action' creates an interactive UserAction. 'entity' creates a standalone entity. 'manager' creates a singleton class. 'basic' creates a plain class."
          ),
        parentClass: z
          .string()
          .optional()
          .describe(
            "Parent class to extend. Required for 'modded'. Uses sensible defaults for other types (e.g., ScriptComponent for 'component')."
          ),
        methods: z
          .array(z.string())
          .optional()
          .describe(
            "Method signatures to stub out (e.g., ['void OnGameStart()', 'bool CanPerform(IEntity user)']). Uses default methods per type if omitted."
          ),
        description: z
          .string()
          .optional()
          .describe("Description comment at the top of the file"),
        projectPath: z
          .string()
          .optional()
          .describe("Addon root path. Wins over modName. modName or projectPath is required to write."),
        modName: z
          .string()
          .optional()
          .describe("Addon folder under the project path or ENFUSION_ADDONS_DIR."),
        attributes: z
          .array(
            z.object({
              type: z.string().describe("Enforce type, e.g. 'float', 'ResourceName', 'array<string>'"),
              name: z.string().describe("Field name, e.g. 'm_fRate'"),
              default: z.string().optional().describe("Default value as written in the Attribute, e.g. '3'"),
              desc: z.string().optional().describe("Description shown in Workbench"),
            })
          )
          .optional()
          .describe("(component, entity) [Attribute] fields to add"),
        replicated: z
          .boolean()
          .optional()
          .describe("(component) Add one replicated property (RplProp) with an authority-checked setter; the prefab needs an RplComponent"),
      },
    },
    async ({ className, scriptType, parentClass, methods, description, projectPath, modName, attributes, replicated }) => {
      const target = resolveWriteAddon(config, { projectPath, modName });

      try {
        validateFilename(className);
        validateEnforceIdentifier(className);
        for (const a of attributes ?? []) {
          validateEnforceIdentifier(a.name);
          if (!ATTRIBUTE_TYPE.test(a.type)) throw new Error(`Invalid attribute type: ${a.type}`);
        }

        // Resolve parent methods from API index if available and no explicit methods given
        let dynamicMethods: string[] | undefined;
        if (!methods && searchEngine && parentClass) {
          const cls = searchEngine.getClass(parentClass);
          if (cls) {
            const allMethods = [
              ...(cls.methods || []),
              ...(cls.protectedMethods || []),
            ];
            // proto/static methods can't be overridden from script, and stubbing
            // plain getters/setters with an empty body would break the parent.
            const overridable = allMethods.filter((m) =>
              !/\b(proto|static)\b/.test(m.signature) &&
              (/^(On|EOn|Can|Handle)/.test(m.name) || /\bevent\b/.test(m.signature))
            );
            if (overridable.length > 0) {
              dynamicMethods = overridable
                .slice(0, 8)
                .map((m) => m.signature.replace(/\bevent\s+/, ""));
            }
          }
        }

        const code = generateScript({
          className,
          scriptType: scriptType as ScriptType,
          parentClass,
          methods,
          dynamicMethods,
          description,
          attributes,
          replicated,
        });

        if (!("error" in target)) {
          const moduleFolder = getScriptModuleFolder(scriptType as ScriptType);
          const filename = getScriptFilename(className);
          const targetDir = resolve(target.dir, moduleFolder);
          const targetPath = join(targetDir, filename);

          mkdirSync(targetDir, { recursive: true });

          if (existsSync(targetPath)) {
            return {
              content: [
                {
                  type: "text",
                  text: `File already exists: ${moduleFolder}/${filename}\n\nGenerated code (not written):\n\n\`\`\`c\n${code}\`\`\``,
                },
              ],
            };
          }

          writeFileSync(targetPath, code, "utf-8");

          const workbenchNote = findPids("ArmaReforgerWorkbenchSteamDiag.exe").length > 0
            ? "\n\nWorkbench is open: it auto-rebuilds on .c changes, which ends a running Play session. Check with wb_validate or wb_reload."
            : "";
          return {
            content: [
              {
                type: "text",
                text: `Script created: ${moduleFolder}/${filename}\n\n\`\`\`c\n${code}\`\`\`${workbenchNote}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `${target.error}\n\nGenerated code (not written):\n\n\`\`\`c\n${code}\`\`\``,
            },
          ],
          isError: true,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Error creating script: ${msg}` }],
        isError: true,
        };
      }
    }
  );
}
