import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { PatternLibrary } from "../patterns/loader.js";

export function registerCreateModPrompt(server: McpServer, patterns: PatternLibrary): void {
  const patternList = patterns.getSummary();

  server.registerPrompt(
    "create-mod",
    {
      title: "Create a new Arma Reforger mod",
      description:
        "Guided workflow to scaffold a complete mod from a description. Creates the addon structure, scripts, and prefabs.",
      argsSchema: {
        description: z
          .string()
          .describe("Describe what the mod should do (e.g., 'A zombie survival game mode with waves of AI enemies')"),
      },
    },
    ({ description }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `I want to create an Arma Reforger mod: ${description}

Work step by step. Ask the user when information is missing or before anything that affects shared resources (closing Workbench, starting servers, downloads, deleting files). End with what was done, what was not verified, and any step the user must do in the GUI.

## STEP 0: ASSESS COMPLEXITY

Before writing any code, assess the scope of what the user is asking for. Think about how many distinct systems, scripts, prefabs, and configs this mod would need if fully built.

**Simple mod** (1-5 scripts, 1-3 prefabs — e.g., a HUD widget, a custom action, a weapon reskin):
→ Skip to STEP 1 and build it in one pass. No need to discuss the plan.

**Complex mod** (6+ scripts, multiple interconnected systems — e.g., a survival game mode, a DayZ-style overhaul, a full faction with custom AI):
→ Do NOT attempt to build everything at once. Instead:

1. Tell the user this is a large project and roughly how many systems are involved.
2. Break the full mod into **phases**, where each phase is a standalone deliverable that builds on the previous one. Phase 1 should always be the minimum viable foundation — the mod should load and do *something* testable after Phase 1.
3. For each phase, list:
   - What systems/features it covers
   - What scripts, prefabs, and configs it will need
   - What it will look like when tested in-game
4. Present this plan to the user and **wait for their input** before writing any code. They may want to reorder phases, cut features, or adjust scope.
5. Once the user approves (or adjusts) the plan, build **only Phase 1**.
6. After building Phase 1, use **project** (action='write') to create a \`MODPLAN.md\` file in the project root with this exact structure:

\`\`\`markdown
# Mod Plan: [Mod Name]

## Concept
[1-2 sentence description of the full mod vision]

## Phases

### Phase 1: [Title] — COMPLETE
- [What was built]
- [Key files created]

### Phase 2: [Title] — PENDING
- [What this phase covers]
- [Systems/features involved]
- [Expected scripts, prefabs, configs]

### Phase 3: [Title] — PENDING
...

## Architecture Notes
- Class prefix: [PREFIX_]
- [Any important design decisions, dependencies between systems, etc.]
\`\`\`

This file is the handoff document. A future Claude instance with zero context will read this file and know exactly what the mod is, what's done, and what to build next. Be specific — list actual file names, class names, and system relationships. The user can then use \`/modify-mod\` to continue with subsequent phases.

## RESEARCH

Use the MCP tools first (they read .pak files and an offline wiki snapshot). If they disagree with the local Workbench API docs, the docs win.
- **asset_search**: prefabs, models, textures, scripts and configs by name
- **game_browse** / **game_read**: list and read game files (loose files and .pak contents)
- **api_search**: class definitions, methods and properties
- **component_search**: components by category (character, vehicle, weapon, damage, inventory, ai, ui) or event handler
- **wiki_search** / **wiki_read**: tutorials and guides from the wiki snapshot

## CRITICAL: API VERIFICATION RULE

**NEVER guess, assume, or invent Enfusion API method names.** The Enfusion scripting API is non-standard and poorly documented. Methods that seem obvious often do not exist (e.g., \`HitZone.SetHealth()\`, \`IEntity.GetVelocity()\`, \`AIWorld.GetAIGroups()\`).

Before writing ANY script that calls an Enfusion API method, you MUST:
1. Use **api_search** to find the class — inherited methods from parent classes are included automatically, so one lookup is usually enough
2. Read the method list in the results (includes both own and inherited methods)
3. Only use methods that appear in the search results
4. If the method you need doesn't exist, search for alternative classes or approaches — check the **Related Classes** section for sibling classes in the same API group
5. For enums/constants: use \`api_search(type: "enum")\` — this detects enum-like constant classes even when formal enum data is missing
6. For damage/health: use \`SCR_CharacterDamageManagerComponent.FullHeal()\`, NOT per-hitzone SetHealth
7. For any class interaction: search the class first, read its methods, then write code

If you cannot find a method via api_search, it probably does not exist. Do NOT write code that calls unverified methods — it will fail to compile silently in Workbench.

## CRITICAL: VISIBLE ENTITIES NEED A MESH

Any entity that should be visible in the game world MUST have a **MeshObject** component with its \`Object\` property set to an actual 3D model (\`.xob\` file) from the base game. Without this, the entity will be **completely invisible** — no model, no collision, nothing.

You don't need to create custom models. Borrow one from the base game that roughly fits the purpose:
- Find a model with **asset_search** (type 'model'), copy its {GUID}path from the result.
- After creating a prefab with **prefab** (action='create'), use **project** (action='read') + **project** (action='write') to set the MeshObject \`Object\` property to a real model path

This applies to ALL physical in-game objects: interactive props, spawn points with markers, placed items, vehicles, weapons, etc.

## STEP 1: BUILD

1. Use **api_search** to find the relevant Enfusion API classes AND verify that the methods you plan to use actually exist. Search every class you intend to call methods on. Do this BEFORE writing any scripts.

2. Use **mod** (action='create') to scaffold the addon project. Pick a good name, class prefix, and pattern based on the description.

3. Use **script_create** for each script:
   - Correct scriptType (component, gamemode, action, modded, etc.)
   - Proper method stubs and description comments
   - ONLY call methods verified via api_search

4. Use **prefab** (action='create') for any prefabs needed (spawn points, entities, game mode, etc.)

5. Use **layout_create** for any UI layouts (hud, menu, dialog, list, custom).

6. Use **config_create** for config files (factions, mission headers, entity catalogs).

7. Server-side tuning (XP, rank thresholds, arsenal/loadout supply costs, AI limits…): use **economy** for the common
   values and **config_override** for any other base-game config/prefab value. Both write proper override files
   (same path + .meta with the base GUID); never copy a whole base config by hand.

8. Use **mod** (action='validate') to check for structural issues.

9. **Compile** (MANDATORY): **mod** (action='compile'). It runs Workbench headless and lists script errors as
   \`file:line message\`. Fix them with **project** (action='write') and compile again until it reports OK.
   mod compile refuses while a Workbench GUI is open unless force is set (two instances on one addon can crash the GUI one). Ask the user to close that Workbench, or wait.

10. Optional in-editor work (placing entities, worlds, live inspection): **wb_launch** with \`gprojPath\`, then the
    wb_* tools; **wb_resources** (action "register") for files that need a GUID; **wb_close** when done and
    **wb_cleanup** to remove the handler scripts (NEVER skip before publishing).

11. **Build**: **mod** (action='build') → packed addon (data.pak + .gproj + resourceDatabase.rdb).

12. **Test it running**:
    - Single player / client-side: **game** (action 'launch', addons [name]) then **game** 'logs' (errorsOnly) and 'stop'.
    - Multiplayer / server mods: **server** 'status' (→ 'install' once if missing), 'config' (pick a scenario with
      'scenarios'), 'start' with addons [name], check 'logs' (errorsOnly), join with **game** 'launch' connect
      127.0.0.1 and the same addons, then 'stop' both.

## STEP 2: SUMMARIZE

Enfusion rules:
- NEVER guess API methods — if you didn't find it via api_search, it doesn't exist
- All scripts go in Scripts/Game/ (other folders are silently ignored)
- Use a consistent class prefix (e.g., ZS_ for Zombie Survival)
- modded classes affect ALL instances globally
- Always call super.MethodName() in overrides unless intentionally replacing
- Prefab files use Enfusion text serialization, not JSON

The final summary lists the files created and what each does, how the mod works, tuning values, what was not verified, and any step the user must do in the GUI. For complex mods, say what this phase built and what the next one covers.

Pick a pattern that fits; say which one you picked and why in one line. If no pattern fits, use no pattern.

Available patterns:
${patternList}`,
          },
        },
      ],
    })
  );
}
