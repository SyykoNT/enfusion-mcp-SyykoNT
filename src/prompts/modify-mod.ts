import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerModifyModPrompt(server: McpServer): void {
  server.registerPrompt(
    "modify-mod",
    {
      title: "Work on an existing Arma Reforger mod",
      description:
        "Guided workflow to modify, extend, or fix an existing mod. Reads the project, understands it, then makes changes.",
      argsSchema: {
        projectPath: z
          .string()
          .describe("Path to the addon root directory (the folder containing the .gproj file)"),
        task: z
          .string()
          .describe("Describe what you want to change (e.g., 'Add a stamina system', 'Fix the damage calculation', 'Add a new vehicle prefab')"),
      },
    },
    ({ projectPath, task }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `I have an existing Arma Reforger mod at: ${projectPath}

I want to: ${task}

Work step by step. Ask the user when information is missing or before anything that affects shared resources (closing Workbench, starting servers, downloads, deleting files). End with what was done, what was not verified, and any step the user must do in the GUI.

Follow this workflow:

1. **Read the plan**: use **project** (action='read') to check for a \`MODPLAN.md\` file in the addon root (path \`MODPLAN.md\` with projectPath = ${projectPath}).
   - If it exists: this is a phased project. Read the plan carefully. It contains the full mod vision, what's been completed, what's pending, architecture notes, class prefixes, and file names. Use this as your primary context. If the user's task matches the next pending phase, execute that phase. If it's a different task, still respect the existing architecture.
   - If it doesn't exist: this is either a simple mod or one created before planning was added. Proceed normally.

2. **Understand the project** — Use **project** (action='browse') and **project** (action='read') to explore:
   - Read the .gproj for addon name and dependencies
   - Read existing scripts, prefabs, configs, and layouts
   - Identify the class prefix convention in use

3. **Research the API**: use the MCP tools first (they read .pak files and an offline wiki snapshot). If they disagree with the local Workbench API docs, the docs win. **asset_search** finds assets by name, **game_browse**/**game_read** list and read game files, **api_search** looks up classes and methods, **component_search** finds components by category or event handler, **wiki_search**/**wiki_read** search and read the wiki snapshot.

   Use **api_search** to find relevant classes and methods. **CRITICAL: NEVER guess or assume Enfusion API method names.** The API is non-standard — methods that seem obvious often don't exist (e.g., \`HitZone.SetHealth()\`, \`IEntity.GetVelocity()\`). You MUST search every class you plan to call methods on and verify the methods exist in the search results — inherited methods from parent classes are included automatically, so one lookup is usually enough. Check the **Related Classes** section for sibling classes in the same API group. For enums/constants, use \`api_search(type: "enum")\` which detects enum-like constant classes. If a method isn't listed, it does not exist — find an alternative.

4. **Plan the changes** — Determine what to modify, create, or remove. For phased projects, verify your plan aligns with the MODPLAN. Only use API methods verified via api_search.

5. **Implement** — Make all modifications:
   - Existing files: **project** (action='read') then **project** (action='write')
   - New scripts: **script_create** (match existing prefix)
   - New prefabs: **prefab** (action='create')
   - New configs: **config_create**
   - New layouts: **layout_create**

6. **Validate** — Use **mod** (action='validate') to check for issues.

7. **Compile** (MANDATORY): **mod** (action='compile'): headless Workbench, errors reported as \`file:line\`.
   Fix and re-run until OK. mod compile refuses while a Workbench GUI is open unless force is set (two instances on one addon can crash the GUI one). Ask the user to close that Workbench, or wait.

8. **Build** with **mod** (action='build'), then test: **game** 'launch' (addons [name]) or, for server mods,
   **server** 'start' (addons [name]) + **game** 'launch' connect 127.0.0.1; read errors with 'logs' (errorsOnly).
   Value tweaks (XP, costs, ranks, limits) go through **economy** / **config_override**.

9. If you used the live editor (**wb_launch** …), finish with **wb_close** and **wb_cleanup** (remove the handler
   scripts before publishing; NEVER skip).

10. **Update the plan** — If a \`MODPLAN.md\` exists, use **project** (action='read') then **project** (action='write') to update it:
   - Mark completed phases as \`COMPLETE\` with a list of files created/modified
   - Keep pending phases unchanged (unless the user asked to adjust them)
   - Add any new architecture notes or design decisions made during this session
   - If the task was unplanned (not part of any phase), add it to a "Changes Outside Plan" section

11. Summarize what changed and how the mod works now.

Enfusion rules:
- NEVER guess API methods — if you didn't verify it via api_search, assume it doesn't exist
- Read existing code BEFORE modifying it. Understand what's there first.
- Match existing code style, class prefix, and naming conventions.
- All scripts go in Scripts/Game/ (other folders are silently ignored)
- modded classes affect ALL instances globally
- Always call super.MethodName() in overrides unless intentionally replacing
- VISIBLE ENTITIES NEED A MESH: Any entity placed in the world MUST have a MeshObject component with its \`Object\` property set to a base game \`.xob\` model path. Without this, the entity is invisible. You don't need custom models: find a model with asset_search (type 'model'), copy its {GUID}path from the result, and set it as the MeshObject Object property after creating the prefab.

The final summary lists the files changed or added and what each change does, how the mod works now, tuning values, what was not verified, and any step the user must do in the GUI. For phased projects, say which phase was completed and what the next one covers.`,
          },
        },
      ],
    })
  );
}
