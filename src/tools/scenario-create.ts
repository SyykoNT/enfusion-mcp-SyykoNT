import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import type { Config } from "../config.js";
import {
  generateConflictScenario,
  resolveWorldRef,
  KNOWN_WORLDS,
  type ConflictBaseSpec,
} from "../templates/scenario.js";
import { worldMeta, overrideMeta, stripGuid } from "../formats/config-override.js";
import { buildStack } from "../pak/stack.js";
import { generateGuid } from "../formats/guid.js";
import { validateFilename } from "../utils/safe-path.js";
import { resolveWriteAddon } from "../utils/game-paths.js";

const BASE_SPEC_SCHEMA = z.object({
  name: z
    .string()
    .min(1)
    .describe(
      "Base name / callsign, e.g. 'BaseAlpha'. Used as the entity name and in the mission header base whitelist. " +
      "No spaces — use underscores or CamelCase."
    ),
  position: z
    .string()
    .describe(
      "World position as 'x y z', e.g. '1200 0 3400'. Y=0 is fine — Workbench snaps to terrain when opened."
    ),
  faction: z
    .string()
    .describe("Starting faction key: 'US', 'USSR', 'FIA', or a custom key."),
  type: z
    .enum(["base", "major", "MOB", "controlPoint", "sourceBase", "harbor", "relay"])
    .optional()
    .describe(
      "Base type. 'base' (default) = standard contested base. 'major' = large base with CAH areas (harbour, port, airfield). " +
      "'MOB' = main operating base / HQ (no seizing, 3000 supplies, radio source). " +
      "'controlPoint' = lightweight capture point. 'sourceBase' = supply source only, not capturable. " +
      "'harbor' = supply-income harbor (skipped in Bases.layer, uses own prefab family). " +
      "'relay' = pre-placed always-on radio relay tower, not capturable, extends coverage into radio gaps (default range 3000m)."
    ),
  radioRange: z
    .number()
    .optional()
    .describe("Radio antenna service range in meters (default 1470, or 3000 for type='relay'). Increase for MOBs on islands."),
  patrolCount: z
    .number()
    .min(0)
    .max(6)
    .optional()
    .describe("Number of ambient patrol spawnpoints around this base (0-6, default 2)."),
});

// shortcut: class names in a world's string table, not a parse of its entities; a parent with another
// game mode class is not seen. Upgrade if a parent needs it.
const GAME_MODE_RE = /\bSCR_GameModeCampaign\b|\bSCR_BaseGameMode\b/;
const FACTION_MGR_RE = /\bSCR_CampaignFactionManager\b|\bSCR_FactionManager\b/;

/** What a parent world's bytes (read as latin1: vanilla worlds are binary) say it already holds. */
export function parentWorldHas(text: string): { gameMode: boolean; factionManager: boolean } {
  return { gameMode: GAME_MODE_RE.test(text), factionManager: FACTION_MGR_RE.test(text) };
}

/** The parent world and its _Layers files as one latin1 string, from the top layer of the addon's stack that has it; null when unreadable. */
export function readParentWorld(config: Config, gproj: string, worldRef: string): string | null {
  const path = stripGuid(worldRef);
  let layers;
  try {
    layers = buildStack(config, gproj).layers;
  } catch {
    return null;
  }
  for (const l of [...layers].reverse()) {
    // Pak paths are lower-case (worlds/...), so retry with a case-insensitive match
    const file = l.read(path) ? path : l.list(dirname(path)).find((f) => f.toLowerCase() === path.toLowerCase());
    const buf = file ? l.read(file) : null;
    if (!buf) continue;
    const layerFiles = l.list(path.replace(/\.ent$/i, "_Layers")).filter((f) => /\.layer$/i.test(f));
    return [buf, ...layerFiles.map((f) => l.read(f) ?? Buffer.alloc(0))].map((b) => b.toString("latin1")).join("\n");
  }
  return null;
}

function parentNotes(
  parent: { gameMode: boolean; factionManager: boolean } | null,
  given: { suppliesIncome?: number; seedingEnabled?: boolean }
): string[] {
  if (!parent) {
    return [`Parent world not readable: the game mode and faction manager are written; remove them if the parent has its own.`, ``];
  }
  const skipped = [parent.gameMode && "game mode", parent.factionManager && "faction manager"].filter(Boolean);
  if (skipped.length === 0) return [];
  const ignored = [
    "the control point threshold",
    given.suppliesIncome !== undefined && "suppliesIncome",
    given.seedingEnabled && "the seeding game mode settings",
  ].filter(Boolean);
  return [
    `The parent world already has a ${skipped.join(" and a ")}, so none is written; the parent's is used.`,
    ...(parent.gameMode ? [`Ignored because the game mode is the parent's: ${ignored.join(", ")}.`] : []),
    ``,
  ];
}

export function registerScenarioCreate(server: McpServer, config: Config): void {
  server.registerTool(
    "scenario_create_conflict",
    {
      description:
        "Generate a Conflict multiplayer scenario: a mission header (.conf with its .meta), a sub-scene world (.ent with its .meta) and 3 to 6 layer files " +
        "(the result lists every file written). Generates the vanilla game mode (GameMode_Campaign) and CampaignFactionManager, each written only when the parent world has none, " +
        "military bases with seizing, radio and patrol spawnpoints, optional relay towers (base type='relay') and optional seeding mode. " +
        "Seeding needs a third-party mod (see the seedingEnabled input). " +
        "Known worlds: " + KNOWN_WORLDS.join(", ") + ". " +
        "For custom maps pass the full resource ref as worldName, e.g. '{GUID}worlds/MyMap.ent'.",
      inputSchema: {
        scenarioName: z
          .string()
          .min(1)
          .describe(
            "Scenario identifier used as the filename (no spaces, e.g. 'MyConflict_Everon'). " +
            "Also used as the display name unless scenarioDisplayName is provided."
          ),
        scenarioDisplayName: z
          .string()
          .optional()
          .describe("Human-readable display name shown in the scenario browser (default: scenarioName)."),
        worldName: z
          .string()
          .describe(
            "Base world to inherit. Use 'Everon', 'Arland', or 'Western Everon' for vanilla maps, " +
            "or a full resource ref like '{GUID}worlds/MyMap.ent' for custom maps."
          ),
        bases: z
          .array(BASE_SPEC_SCHEMA)
          .min(1)
          .describe(
            "List of military bases to place. Include at least one MOB per faction and 2+ contested bases. " +
            "Positions are world-space coordinates — use the map to find sensible locations."
          ),
        playerCount: z
          .number()
          .min(1)
          .max(256)
          .optional()
          .describe("Max player count (default 40)."),
        xpMultiplier: z
          .number()
          .optional()
          .describe("XP multiplier. Use 0.5 for PvE, 1.0 for standard PvP (default 1.0, omitted if 1.0)."),
        gameModeLabel: z
          .string()
          .optional()
          .describe("Game mode display label shown in the server browser (default 'Conflict')."),
        description: z
          .string()
          .optional()
          .describe("Scenario description shown in the mission browser."),
        author: z
          .string()
          .optional()
          .describe("Author name shown in the mission browser."),
        civVehicleCount: z
          .number()
          .min(0)
          .max(50)
          .optional()
          .describe("Number of civilian ambient vehicle spawnpoints to place (default 0). Generates AmbientVehicles.layer when > 0."),
        suppliesIncome: z
          .number()
          .optional()
          .describe("Regular per-tick supply income for contested bases (default 50)."),
        seedingEnabled: z
          .boolean()
          .optional()
          .describe(
            "Enable low-population seeding mode: restricts players to MOB areas via a restriction zone on each MOB " +
            "and spawns fast-respawning AI patrols (AmbientPatrols_SEEDING.layer) until seedingThreshold players connect. " +
            "One-way transition — never re-activates once crossed. Requires at least one MOB base. " +
            "REQUIRES A THIRD-PARTY MOD: seeding is not vanilla. This emits prefab references " +
            "(E_SeedingRestrictionZoneBase.et, IRON_AmbientPatrolSpawnpoint_Base_Seeding.et) and gamemode properties " +
            "(m_bServerSeedingEnabled, m_iServerSeedingThreshold) that do not exist in the base game — they come from the " +
            "ConflictEscalation / IRON seeding mod. Without it the references fail to resolve and the properties are " +
            "silently ignored. Only enable if the user has that dependency or will add the properties via a modded class."
          ),
        seedingThreshold: z
          .number()
          .min(1)
          .max(128)
          .optional()
          .describe("Player count at which seeding mode permanently ends (default 12). Ignored unless seedingEnabled."),
        projectPath: z
          .string()
          .optional()
          .describe("Addon root path. Wins over modName. modName or projectPath is required to write."),
        modName: z
          .string()
          .optional()
          .describe("Addon folder under the project path or ENFUSION_ADDONS_DIR."),
      },
    },
    async ({
      scenarioName,
      scenarioDisplayName,
      worldName,
      bases,
      playerCount,
      xpMultiplier,
      gameModeLabel,
      description,
      author,
      civVehicleCount,
      suppliesIncome,
      seedingEnabled,
      seedingThreshold,
      projectPath,
      modName,
    }) => {
      const target = resolveWriteAddon(config, { projectPath, modName });
      try {
        validateFilename(scenarioName);

        // Offline read of the parent world: null = not readable (also when there is no target to write to)
        const parentText = "error" in target ? null : readParentWorld(config, target.gproj, resolveWorldRef(worldName));
        const parent = parentText === null ? null : parentWorldHas(parentText);

        const worldGuid = generateGuid();
        const headerGuid = generateGuid();
        const confMetaText = overrideMeta(headerGuid, `Missions/${scenarioName}.conf`);
        const worldMetaText = worldMeta(worldGuid, `Worlds/${scenarioName}.ent`);
        const output = generateConflictScenario({
          scenarioName: scenarioDisplayName ?? scenarioName,
          worldName,
          subSceneRef: `{${worldGuid}}Worlds/${scenarioName}.ent`,
          bases: bases as ConflictBaseSpec[],
          playerCount,
          xpMultiplier,
          parentHasGameMode: parent?.gameMode,
          parentHasFactionManager: parent?.factionManager,
          gameModeLabel,
          description,
          author,
          civVehicleCount,
          suppliesIncome,
          seedingEnabled,
          seedingThreshold,
        });

        if (!("error" in target)) {
          const basePath = target.dir;
          const missionsDir = resolve(basePath, "Missions");
          const worldsDir   = resolve(basePath, "Worlds");
          const layersDir   = resolve(basePath, "Worlds", `${scenarioName}_Layers`);
          const confPath          = join(missionsDir, `${scenarioName}.conf`);
          const confMetaPath      = confPath + ".meta";
          const entPath           = join(worldsDir,   `${scenarioName}.ent`);
          const metaPath          = entPath + ".meta";
          const defaultLayPath    = join(layersDir,   `default.layer`);
          const basesLayPath      = join(layersDir,   `Bases.layer`);
          const cahLayPath        = join(layersDir,   `CAH.layer`);
          const defendersLayPath  = join(layersDir,   `Defenders.layer`);
          const vehiclesLayPath   = join(layersDir,   `AmbientVehicles.layer`);
          const seedingLayPath    = join(layersDir,   `AmbientPatrols_SEEDING.layer`);

          mkdirSync(missionsDir, { recursive: true });
          mkdirSync(worldsDir,   { recursive: true });
          mkdirSync(layersDir,   { recursive: true });

          const existing: string[] = [];
          if (existsSync(confPath))         existing.push(`Missions/${scenarioName}.conf`);
          if (existsSync(confMetaPath))     existing.push(`Missions/${scenarioName}.conf.meta`);
          if (existsSync(entPath))          existing.push(`Worlds/${scenarioName}.ent`);
          if (existsSync(metaPath))         existing.push(`Worlds/${scenarioName}.ent.meta`);
          if (existsSync(defaultLayPath))   existing.push(`Worlds/${scenarioName}_Layers/default.layer`);
          if (existsSync(basesLayPath))     existing.push(`Worlds/${scenarioName}_Layers/Bases.layer`);
          if (existsSync(defendersLayPath)) existing.push(`Worlds/${scenarioName}_Layers/Defenders.layer`);
          if (existsSync(cahLayPath))       existing.push(`Worlds/${scenarioName}_Layers/CAH.layer`);
          if (existsSync(vehiclesLayPath))  existing.push(`Worlds/${scenarioName}_Layers/AmbientVehicles.layer`);
          if (existsSync(seedingLayPath))   existing.push(`Worlds/${scenarioName}_Layers/AmbientPatrols_SEEDING.layer`);

          if (existing.length > 0) {
            return {
              content: [{
                type: "text" as const,
                text:
                  `Files already exist: ${existing.join(", ")}\n\n` +
                  `Generated content (not written):\n\n` +
                  `**Missions/${scenarioName}.conf**\n\`\`\`\n${output.missionConf}\n\`\`\`\n\n` +
                  `**Missions/${scenarioName}.conf.meta**\n\`\`\`\n${confMetaText}\n\`\`\`\n\n` +
                  `**Worlds/${scenarioName}.ent**\n\`\`\`\n${output.worldEnt}\n\`\`\`\n\n` +
                  `**Worlds/${scenarioName}.ent.meta**\n\`\`\`\n${worldMetaText}\n\`\`\`\n\n` +
                  `**Worlds/${scenarioName}_Layers/default.layer**\n\`\`\`\n${output.defaultLayer}\n\`\`\`\n\n` +
                  `**Worlds/${scenarioName}_Layers/Bases.layer**\n\`\`\`\n${output.basesLayer}\n\`\`\``,
              }],
            };
          }

          // Write all files with rollback on partial failure
          const writtenPaths: string[] = [];
          try {
            writeFileSync(confPath,        output.missionConf,  "utf-8"); writtenPaths.push(confPath);
            writeFileSync(confMetaPath,    confMetaText, "utf-8"); writtenPaths.push(confMetaPath);
            writeFileSync(entPath,         output.worldEnt,     "utf-8"); writtenPaths.push(entPath);
            writeFileSync(metaPath,        worldMetaText, "utf-8"); writtenPaths.push(metaPath);
            writeFileSync(defaultLayPath,  output.defaultLayer, "utf-8"); writtenPaths.push(defaultLayPath);
            writeFileSync(basesLayPath,    output.basesLayer,   "utf-8"); writtenPaths.push(basesLayPath);
            writeFileSync(defendersLayPath, output.defendersLayer, "utf-8"); writtenPaths.push(defendersLayPath);
            if (output.cahLayer)             { writeFileSync(cahLayPath,      output.cahLayer,      "utf-8"); writtenPaths.push(cahLayPath); }
            if (output.ambientVehiclesLayer) { writeFileSync(vehiclesLayPath, output.ambientVehiclesLayer, "utf-8"); writtenPaths.push(vehiclesLayPath); }
            if (output.seedingLayer)         { writeFileSync(seedingLayPath,  output.seedingLayer,  "utf-8"); writtenPaths.push(seedingLayPath); }
          } catch (writeErr) {
            // Rollback: remove any files we already wrote to avoid partial scenarios
            for (const p of writtenPaths) {
              try { unlinkSync(p); } catch { /* best-effort cleanup */ }
            }
            throw writeErr;
          }

          const factions = [...new Set(bases.map(b => b.faction))];
          const writtenFiles = [
            `  Missions/${scenarioName}.conf`,
            `  Missions/${scenarioName}.conf.meta`,
            `  Worlds/${scenarioName}.ent`,
            `  Worlds/${scenarioName}.ent.meta`,
            `  Worlds/${scenarioName}_Layers/default.layer`,
            `  Worlds/${scenarioName}_Layers/Bases.layer`,
            `  Worlds/${scenarioName}_Layers/Defenders.layer`,
            ...(output.cahLayer ? [`  Worlds/${scenarioName}_Layers/CAH.layer`] : []),
            ...(output.ambientVehiclesLayer ? [`  Worlds/${scenarioName}_Layers/AmbientVehicles.layer`] : []),
            ...(output.seedingLayer ? [`  Worlds/${scenarioName}_Layers/AmbientPatrols_SEEDING.layer`] : []),
          ];

          return {
            content: [{
              type: "text" as const,
              text: [
                `**Conflict scenario created: ${scenarioName}**`,
                ``,
                `Files written:`,
                ...writtenFiles,
                ``,
                `Mission header: {${headerGuid}}Missions/${scenarioName}.conf`,
                ``,
                `Bases (${bases.length}): ${bases.map(b => `${b.name} [${b.type ?? "base"}, ${b.faction}]`).join(", ")}`,
                `Factions: ${factions.join(", ")}`,
                `Players: ${playerCount ?? 40}`,
                ``,
                ...parentNotes(parent, { suppliesIncome, seedingEnabled }),
                ...(seedingEnabled
                  ? [
                      `WARNING — seeding requires a third-party dependency:`,
                      `  Seeding is NOT vanilla. The generated files reference two prefabs that do not`,
                      `  exist in the base game (E_SeedingRestrictionZoneBase.et,`,
                      `  IRON_AmbientPatrolSpawnpoint_Base_Seeding.et) and set gamemode properties`,
                      `  (m_bServerSeedingEnabled, m_iServerSeedingThreshold) that vanilla`,
                      `  SCR_GameModeCampaign does not define.`,
                      `  Without the ConflictEscalation / IRON seeding mod loaded, the prefab references`,
                      `  fail to resolve and the properties are silently ignored — the scenario will`,
                      `  otherwise load, but seeding will simply not happen.`,
                      `  To use it: load that mod as a dependency, or add the two properties yourself`,
                      `  via 'modded class SCR_GameModeCampaign' and supply your own restriction-zone`,
                      `  and seeding-patrol prefabs.`,
                      ``,
                    ]
                  : []),
                `Next steps:`,
                `1. Open Worlds/${scenarioName}.ent in Workbench.`,
                `2. Select all base entities and use "Snap to Terrain" to fix Y positions.`,
                `3. Adjust patrol spawnpoint positions around each base (currently offset ±30m).`,
                `4. Add defender spawnpoints (SCR_DefenderSpawnerComponent) inside base buildings.`,
                `5. If radio coverage has gaps between distant bases, add a base with type='relay' there (regenerate or hand-edit Bases.layer).`,
                `6. Save and run a test with the scenario in the server browser.`,
              ].join("\n"),
            }],
          };
        }

        // No valid target: return generated content only
        const parts: string[] = [
          target.error,
          ``,
          `Generated conflict scenario (not written):`,
          ``,
          `**Missions/${scenarioName}.conf**`,
          `\`\`\``,
          output.missionConf,
          `\`\`\``,
          ``,
          `**Missions/${scenarioName}.conf.meta**`,
          `\`\`\``,
          confMetaText,
          `\`\`\``,
          ``,
          `**Worlds/${scenarioName}.ent**`,
          `\`\`\``,
          output.worldEnt,
          `\`\`\``,
          ``,
          `**Worlds/${scenarioName}.ent.meta**`,
          `\`\`\``,
          worldMetaText,
          `\`\`\``,
          ``,
          `**Worlds/${scenarioName}_Layers/default.layer**`,
          `\`\`\``,
          output.defaultLayer,
          `\`\`\``,
          ``,
          `**Worlds/${scenarioName}_Layers/Bases.layer**`,
          `\`\`\``,
          output.basesLayer,
          `\`\`\``,
          ``,
          `**Worlds/${scenarioName}_Layers/Defenders.layer**`,
          `\`\`\``,
          output.defendersLayer,
          `\`\`\``,
        ];
        if (output.cahLayer) {
          parts.push(``, `**Worlds/${scenarioName}_Layers/CAH.layer**`, `\`\`\``, output.cahLayer, `\`\`\``);
        }
        if (output.ambientVehiclesLayer) {
          parts.push(``, `**Worlds/${scenarioName}_Layers/AmbientVehicles.layer**`, `\`\`\``, output.ambientVehiclesLayer, `\`\`\``);
        }
        if (output.seedingLayer) {
          parts.push(``, `**Worlds/${scenarioName}_Layers/AmbientPatrols_SEEDING.layer**`, `\`\`\``, output.seedingLayer, `\`\`\``);
        }
        return {
          content: [{ type: "text" as const, text: parts.join("\n") }],
          isError: true,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `Error creating scenario: ${msg}` }],
        isError: true,
        };
      }
    }
  );
}
