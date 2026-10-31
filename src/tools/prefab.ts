import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Config } from "../config.js";
import { entityTemplateMeta } from "../formats/config-override.js";
import { generateGuid } from "../formats/guid.js";
import { resourceName } from "../pak/rdb.js";
import { resolveWriteAddon } from "../utils/game-paths.js";
import {
  generatePrefab,
  getPrefabSubdirectory,
  getPrefabFilename,
  type PrefabType,
  type ComponentDef,
} from "../templates/prefab.js";
import { recipeLoader } from "../templates/recipe-loader.js";
import {
  walkChain,
  mergeAncestryComponents,
  mergeTopLevelComponents,
  parseTopLevelComponents,
  type AncestorLevel,
  type ParsedComponent,
} from "../utils/prefab-ancestry.js";
import { checkComponentDependencies } from "../utils/component-dependencies.js";
import { validateFilename } from "../utils/safe-path.js";

// ── Inspect helpers ────────────────────────────────────────────────────────────

function formatReport(
  levels: AncestorLevel[],
  warnings: string[],
  includeRaw: boolean
): string {
  const lines: string[] = [];

  lines.push("=== Prefab Inheritance Chain ===");
  for (const level of levels) {
    const tag = level.depth === levels.length - 1 ? "  ← this file" : "";
    lines.push(`  [${level.depth}] ${level.path}  [${level.entityClass}]${tag}`);
  }

  if (warnings.length > 0) {
    lines.push("");
    for (const w of warnings) lines.push(`  WARNING: ${w}`);
  }

  const merged = mergeAncestryComponents(levels);

  const depWarnings = checkComponentDependencies(
    Array.from(merged.values()).map(({ comp }) => comp)
  );
  if (depWarnings.length > 0) {
    lines.push("");
    lines.push("=== Component Dependency Warnings ===");
    for (const w of depWarnings) lines.push(`  WARNING: ${w}`);
  }

  lines.push("");
  lines.push("=== Merged Components ===");

  if (merged.size === 0) {
    lines.push("  (no components found in chain)");
  }

  for (const [, { comp, source }] of merged) {
    const isLeaf = source.depth === levels.length - 1;
    const srcTag = isLeaf ? "← this file" : `inherited from [${source.depth}]: ${source.path}`;
    lines.push("");
    lines.push(`[${comp.typeName} {${comp.guid}}]  ${srcTag}`);
    for (const bl of comp.rawBody.split("\n")) {
      if (bl.trim()) lines.push(`  ${bl}`);
    }
  }

  if (includeRaw) {
    lines.push("");
    lines.push("=== Raw File Contents ===");
    for (const level of levels) {
      lines.push(`\n--- [${level.depth}] ${level.path} ---\n${level.rawContent}`);
    }
  }

  return lines.join("\n");
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerPrefab(server: McpServer, config: Config): void {
  server.registerTool(
    "prefab",
    {
      description:
        "Create or inspect Arma Reforger prefab (.et) files.\n\n" +
        "action=create: Create a new Entity Template (.et) prefab file for an Arma Reforger mod. Generates a properly structured prefab with components in valid Enfusion text serialization format. " +
        "Writes a child prefab of parentPrefab (or the recipe's parent) as {GUID}path, with the parent's root class, only the components that set a value " +
        "(each reusing the parent's component ID), and a .meta. Needs modName or projectPath (an addon root with a .gproj). " +
        "IMPORTANT: For 'interactive' and other visible prefabs, the MeshObject component MUST have its 'Object' property set to a base game .xob model path (e.g., '{5F4C4181F065B447}Assets/Props/Military/Barrels/BarrelGreen_01.xob') or the entity will be invisible in-game. Use api_search to find model paths. " +
        "Both actions flag known hard component-dependency violations (e.g. a DamageManager component with no RplComponent or no HitZone, a WeaponComponent with no RigidBody) as warnings — see arma-knowledge component-anatomy-and-dependencies.md for the full rule set and for implicit (non-checkable) coupling like signal names, collider names, and bone PivotIDs that require manual review.\n\n" +
        "action=inspect: Inspect an Arma Reforger prefab (.et file) and its full inheritance chain. " +
        "Reads each ancestor prefab, parses all components, and returns a fully merged view " +
        "showing which ancestor each component comes from. " +
        "Child values override parent values (matched by component GUID). " +
        "Use this to understand the complete component set of a prefab, including all " +
        "inherited values not visible in the prefab file itself.",
      inputSchema: {
        action: z.enum(["create", "inspect"]).describe(
          "Action to perform: 'create' to generate a new prefab file, 'inspect' to view the full inheritance chain of an existing prefab."
        ),
        // create params
        name: z
          .string()
          .min(1)
          .optional()
          .describe("(create) Prefab name (e.g., 'MySpawnPoint', 'CustomVehicle')"),
        prefabType: z
          .enum([
            "firearm",
            "attachment",
            "ground_vehicle",
            "air_vehicle",
            "character",
            "prop",
            "building",
            "item",
            "group",
            "spawnpoint",
            "gamemode",
            "generic",
          ])
          .optional()
          .describe(
            "(create) Prefab template type. Determines the root entity type, default components, and file location."
          ),
        variant: z
          .string()
          .optional()
          .describe(
            "(create) Optional recipe variant (e.g., 'handgun' for firearm, 'rifle', 'launcher', 'machinegun'). " +
            "Variants specialize the recipe with different base parents and placeholder components."
          ),
        parentPrefab: z
          .string()
          .optional()
          .describe(
            "(create) Parent prefab to inherit from (e.g., '{GUID}Prefabs/Weapons/AK47.et'). Omit to create a standalone prefab."
          ),
        components: z
          .array(
            z.object({
              type: z.string().describe("Component class name (e.g., 'RigidBody', 'MeshObject')"),
              guid: z
                .string()
                .regex(/^[0-9A-Fa-f]{16}$/)
                .optional()
                .describe("16-hex ID of the parent component to override, needed when the parent has this type more than once"),
              properties: z
                .record(z.string())
                .optional()
                .describe("Component property key-value pairs"),
            })
          )
          .optional()
          .describe("(create) Additional components to add beyond the defaults for this prefab type"),
        description: z
          .string()
          .optional()
          .describe(
            "(create) Description for the prefab. Used as the display name in Game Master."
          ),
        includeAncestry: z
          .boolean()
          .default(true)
          .describe(
            "(create) Resolve the parent chain so the root class is the parent's and each component reuses the parent's ID " +
            "for its type (an override, not a second component). Defaults to true. Set false to skip it (IDs may then duplicate)."
          ),
        // inspect params
        path: z.string().optional().describe(
          "(inspect) Relative prefab path, e.g. 'Prefabs/Weapons/Handguns/M9/Handgun_M9.et'. " +
          "A leading {GUID} prefix is accepted and stripped automatically."
        ),
        include_raw: z.boolean().default(false).describe(
          "(inspect) Include the full raw .et text for each ancestor at the bottom of the report."
        ),
        // shared params
        projectPath: z
          .string()
          .optional()
          .describe("Addon root path / mod project root. (create) Wins over modName; modName or projectPath is required to write."),
        modName: z
          .string()
          .optional()
          .describe("(create) Addon folder under the project path or ENFUSION_ADDONS_DIR."),
      },
    },
    async (params) => {
      const { action } = params;

      if (action === "create") {
        const { name, prefabType, variant, parentPrefab, components, description, includeAncestry, projectPath, modName } = params;

        try {
          if (!name) {
            return {
              content: [{ type: "text", text: "Error creating prefab: 'name' is required for action=create" }],
              isError: true,
            };
          }
          if (!prefabType) {
            return {
              content: [{ type: "text", text: "Error creating prefab: 'prefabType' is required for action=create" }],
              isError: true,
            };
          }

          validateFilename(name);

          // Get recipe to extract postCreateNotes
          let recipe;
          try {
            recipe = recipeLoader.getRecipe(prefabType as PrefabType, variant as string | undefined);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return {
              content: [{ type: "text", text: `Error loading recipe: ${msg}` }],
              isError: true,
            };
          }

          const target = resolveWriteAddon(config, { projectPath, modName });
          const addonDir = "error" in target ? undefined : target.dir;

          // Parent from the call or the recipe (variant-aware); its chain gives the root class and component IDs
          const parent = parentPrefab || recipe.defaultParent;
          let rootClass: string | undefined;
          let parentComponents: { type: string; guid: string }[] | undefined;
          let parentTop: ParsedComponent[] = [];
          let ancestryNote = "";

          if (parent && includeAncestry) {
            const { levels, warnings } = walkChain(parent, config, addonDir);
            if (levels.length === 0) {
              return {
                content: [{
                  type: "text",
                  text: `Parent not found: ${parent} (checked the addon and the game data). Use asset_search to get the exact path, or pass includeAncestry=false.` +
                    (warnings.length > 0 ? `\nWarnings: ${warnings.join("; ")}` : ""),
                }],
                isError: true,
              };
            }
            rootClass = levels[levels.length - 1].entityClass;
            parentTop = [...mergeTopLevelComponents(levels).values()].map(({ comp }) => comp);
            parentComponents = parentTop.map((c) => ({ type: c.typeName, guid: c.guid }));
            ancestryNote = `\n\nParent chain: ${levels.length} level(s), ${parentComponents.length} top-level component(s); components of those types override them by ID.`;
            if (warnings.length > 0) ancestryNote += `\nWarnings: ${warnings.join("; ")}`;
          } else if (parent) {
            ancestryNote = `\n\nincludeAncestry=false: component IDs were not matched to the parent, so a type the parent already has is added a second time.`;
          }

          let parentName = parent;
          if (parent && !/^\{[0-9A-Fa-f]{16}\}/.test(parent)) {
            const metaPath = addonDir ? join(addonDir, `${parent}.meta`) : "";
            const addonName = metaPath && existsSync(metaPath) ? /Name\s+"([^"]+)"/.exec(readFileSync(metaPath, "utf-8"))?.[1] : undefined;
            parentName = resourceName(config.gamePath, parent) ?? addonName ?? parent;
            if (parentName === parent) ancestryNote += `\nWarning: parent written without GUID (not found in the game resource database or the addon).`;
          }

          const content = generatePrefab({
            name,
            prefabType: prefabType as PrefabType,
            variant: variant as string | undefined,
            parentPrefab: parentName,
            components: components as ComponentDef[] | undefined,
            description,
            rootClass,
            parentComponents,
          });

          // Format post-creation checklist from recipe
          const checklist = recipe.postCreateNotes.length > 0
            ? "\n\nRequired follow-up:\n" + recipe.postCreateNotes.map((note) => `[ ] ${note}`).join("\n")
            : "";

          // Check the parent's components plus this file's against known hard dependency rules
          const depWarnings = checkComponentDependencies([
            ...new Map([...parentTop, ...parseTopLevelComponents(content).values()].map((c) => [c.guid, c])).values(),
          ]);
          const depWarningsNote = depWarnings.length > 0
            ? "\n\nComponent dependency warnings:\n" + depWarnings.map((w) => `  WARNING: ${w}`).join("\n")
            : "";

          if (!("error" in target)) {
            const subdir = getPrefabSubdirectory(prefabType as PrefabType, variant as string | undefined);
            const filename = getPrefabFilename(name);
            const targetDir = resolve(target.dir, subdir);
            const targetPath = join(targetDir, filename);

            mkdirSync(targetDir, { recursive: true });

            if (existsSync(targetPath)) {
              return {
                content: [
                  {
                    type: "text",
                    text: `File already exists: ${subdir}/${filename}\n\nGenerated content (not written):\n\n\`\`\`\n${content}\n\`\`\`${checklist}${depWarningsNote}${ancestryNote}`,
                  },
                ],
              };
            }

            const resourcePath = `${subdir}/${filename}`;
            const resourceGuid = generateGuid();
            writeFileSync(targetPath, content, "utf-8");
            writeFileSync(`${targetPath}.meta`, entityTemplateMeta(resourceGuid, resourcePath), "utf-8");

            const variantTag = variant ? ` (variant: ${variant})` : "";
            const parentLine = parentName ? `\nParent: ${parentName}${rootClass ? `  [${rootClass}]` : ""}` : "";
            return {
              content: [
                {
                  type: "text",
                  text: `Prefab created: ${resourcePath} (+ .meta)\nReference it as: {${resourceGuid}}${resourcePath}${parentLine}\nType: ${prefabType}${variantTag}\n\n\`\`\`\n${content}\n\`\`\`${checklist}${depWarningsNote}${ancestryNote}` +
                    `\n\nNot registered yet: open the addon in Workbench or run one headless Workbench scan before a server test.`,
                },
              ],
            };
          }

          return {
            content: [
              {
                type: "text",
                text: `${target.error}\n\nGenerated prefab (not written):\n\n\`\`\`\n${content}\n\`\`\`${checklist}${depWarningsNote}${ancestryNote}`,
              },
            ],
            isError: true,
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Error creating prefab: ${msg}` }],
            isError: true,
          };
        }
      }

      // action === "inspect"
      const { path: inputPath, include_raw, projectPath } = params;

      try {
        if (!inputPath) {
          return {
            content: [{ type: "text", text: "Error: 'path' is required for action=inspect" }],
            isError: true,
          };
        }

        const { levels, warnings } = walkChain(inputPath, config, projectPath);

        if (levels.length === 0) {
          return {
            content: [{
              type: "text",
              text: `Could not read prefab: ${inputPath}\n` +
                (warnings.length > 0 ? warnings.join("\n") : "File not found."),
            }],
            isError: true,
          };
        }

        return {
          content: [{
            type: "text",
            text: formatReport(levels, warnings, include_raw ?? false),
          }],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
      }
    }
  );
}
