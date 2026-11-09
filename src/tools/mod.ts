import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, mkdirSync, writeFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, extname, relative, dirname, basename } from "node:path";
import type { Config } from "../config.js";
import { generateGproj } from "../templates/gproj.js";
import { generateScript } from "../templates/script.js";
import type { PatternLibrary } from "../patterns/loader.js";
import { forbiddenRoot, sameRealPath, validateFilename, validateProjectPath } from "../utils/safe-path.js";
import { findGproj } from "../utils/game-paths.js";
import type { SearchEngine } from "../index/search-engine.js";
import { parse, getProperty } from "../formats/enfusion-text.js";

import { addonsDirsError, checkPackOutput, compileAddon, handlerFiles, packAddon, pakSummary, readGproj, resolveGproj } from "../workbench/cli.js";
import { findPids, workbenchCommandLines } from "../utils/process.js";
import { duplicateAddonError } from "../pak/stack.js";

// ─── create helpers ───────────────────────────────────────────────────────────

/**
 * Derive a 2-4 character prefix from the mod name.
 * "MyCustomMod" → "MCM", "ZombieDefense" → "ZD"
 */
function derivePrefix(name: string): string {
  // Extract uppercase letters
  const uppers = name.replace(/[^A-Z]/g, "");
  if (uppers.length >= 2 && uppers.length <= 4) return uppers;
  if (uppers.length > 4) return uppers.slice(0, 3);

  // Fallback: first 3 chars uppercased
  return name.slice(0, 3).toUpperCase();
}

// ─── validate helpers ─────────────────────────────────────────────────────────

interface ValidationIssue {
  level: "error" | "warning" | "info";
  message: string;
}

type CheckName = "structure" | "gproj" | "scripts" | "prefabs" | "configs" | "references" | "naming";

const ALL_CHECKS: CheckName[] = ["structure", "gproj", "scripts", "prefabs", "configs", "references", "naming"];

function findFiles(dir: string, ext: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;

  const walk = (current: string) => {
    try {
      const entries = readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (extname(entry.name).toLowerCase() === ext) {
          results.push(fullPath);
        }
      }
    } catch {
      // Skip directories we can't read
    }
  };
  walk(dir);
  return results;
}

function checkStructure(projectPath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Check for .gproj file
  const gprojFiles = readdirSync(projectPath).filter(
    (f) => extname(f).toLowerCase() === ".gproj"
  );
  if (gprojFiles.length === 0) {
    issues.push({ level: "error", message: "No .gproj file found in project root" });
  } else if (gprojFiles.length > 1) {
    issues.push({ level: "warning", message: `Multiple .gproj files found: ${gprojFiles.join(", ")}` });
  }

  // Check standard directories
  const expectedDirs = ["Scripts/Game"];
  for (const dir of expectedDirs) {
    if (!existsSync(resolve(projectPath, dir))) {
      issues.push({ level: "warning", message: `Missing expected directory: ${dir}` });
    }
  }

  return issues;
}

export function checkGproj(projectPath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const gprojFiles = readdirSync(projectPath).filter(
    (f) => extname(f).toLowerCase() === ".gproj"
  );
  if (gprojFiles.length === 0) return issues;

  for (const filename of gprojFiles) {
    const filepath = resolve(projectPath, filename);
    try {
      const content = readFileSync(filepath, "utf-8");
      const node = parse(content);

      if (node.type !== "GameProject") {
        issues.push({ level: "error", message: `${filename}: Root node is "${node.type}", expected "GameProject"` });
      }

      const id = getProperty(node, "ID");
      if (!id) {
        issues.push({ level: "error", message: `${filename}: Missing ID field` });
      }

      const guid = getProperty(node, "GUID");
      if (!guid) {
        issues.push({ level: "error", message: `${filename}: Missing GUID field` });
      } else if (typeof guid === "string" && !/^[0-9A-Fa-f]{16}$/.test(guid)) {
        issues.push({ level: "warning", message: `${filename}: GUID "${guid}" is not a valid 16-char hex string` });
      }

      const deps = node.children.find((c) => c.type === "Dependencies");
      if (!deps) {
        issues.push({ level: "error", message: `${filename}: Missing Dependencies block — mod won't load` });
      } else if (!deps.values.includes("58D0FB3206B6F859")) {
        issues.push({ level: "error", message: `${filename}: Missing base game dependency (58D0FB3206B6F859)` });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      issues.push({ level: "error", message: `${filename}: Failed to parse — ${msg}` });
    }
  }

  return issues;
}

function checkScripts(projectPath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // Find all .c files in the project
  const allScripts = findFiles(projectPath, ".c");

  for (const scriptPath of allScripts) {
    const rel = relative(projectPath, scriptPath).replace(/\\/g, "/");

    // Check if script is in a valid module folder
    if (!rel.startsWith("Scripts/Game/") && !rel.startsWith("Scripts/GameLib/") && !rel.startsWith("Scripts/WorkbenchGame/")) {
      issues.push({
        level: "error",
        message: `${rel}: Script is outside a valid module folder (Scripts/Game/, Scripts/GameLib/, Scripts/WorkbenchGame/) — it will be silently ignored`,
      });
      continue;
    }

    // Basic syntax check: look for class declaration
    try {
      const content = readFileSync(scriptPath, "utf-8");
      const hasClass = /\b(class|modded\s+class)\s+\w+/.test(content);
      if (!hasClass) {
        issues.push({
          level: "warning",
          message: `${rel}: No class declaration found`,
        });
      }
    } catch {
      issues.push({
        level: "warning",
        message: `${rel}: Could not read file`,
      });
    }
  }

  return issues;
}

export function checkPrefabs(projectPath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const allPrefabs = findFiles(projectPath, ".et");

  for (const prefabPath of allPrefabs) {
    const rel = relative(projectPath, prefabPath).replace(/\\/g, "/");

    try {
      const content = readFileSync(prefabPath, "utf-8");
      parse(content); // Just verify it parses
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      issues.push({
        level: "error",
        message: `${rel}: Invalid prefab format — ${msg}`,
      });
    }
  }

  return issues;
}

export function checkConfigs(projectPath: string, searchEngine?: SearchEngine): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const allConfigs = findFiles(projectPath, ".conf");

  for (const configPath of allConfigs) {
    const rel = relative(projectPath, configPath).replace(/\\/g, "/");
    try {
      const content = readFileSync(configPath, "utf-8");
      const root = parse(content);

      // Check root node type against API index (only if searchEngine available)
      if (searchEngine && root.type && !searchEngine.hasClass(root.type)) {
        issues.push({
          level: "warning",
          message: `${rel}: Root class "${root.type}" not found in API index — may be from another mod or misspelled.`,
        });
      }

      // Walk children and check their type names
      if (searchEngine) {
        const walkNodes = (node: ReturnType<typeof parse>) => {
          for (const child of node.children || []) {
            // An object member's type is its key (`Suspension VehicleSuspension "{ID}" {`); check its class
            const cls = child.className ?? child.type;
            if (cls && /^[A-Z]/.test(cls) && !searchEngine.hasClass(cls)) {
              issues.push({
                level: "warning",
                message: `${rel}: Class "${cls}" not found in API index.`,
              });
            }
            walkNodes(child);
          }
        };
        walkNodes(root);
      }

    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      issues.push({
        level: "error",
        message: `${rel}: Invalid config format — ${msg}`,
      });
    }
  }

  return issues;
}

function checkReferences(projectPath: string, searchEngine: SearchEngine): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const allScripts = findFiles(projectPath, ".c");

  for (const scriptPath of allScripts) {
    const rel = relative(projectPath, scriptPath).replace(/\\/g, "/");

    try {
      const content = readFileSync(scriptPath, "utf-8");

      // Extract parent class from class declarations
      const classMatch = content.match(/(?:modded\s+)?class\s+\w+\s*:\s*(\w+)/);
      if (classMatch) {
        const parentClass = classMatch[1];
        if (!searchEngine.hasClass(parentClass)) {
          issues.push({
            level: "warning",
            message: `${rel}: Extends "${parentClass}" which is not in the API index (may be from another mod)`,
          });
        }
      }
    } catch {
      // Skip unreadable files
    }
  }

  return issues;
}

function checkNaming(projectPath: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  const allScripts = findFiles(projectPath, ".c");
  const prefixes: Map<string, number> = new Map();

  for (const scriptPath of allScripts) {
    try {
      const content = readFileSync(scriptPath, "utf-8");
      const classMatch = content.match(/(?:modded\s+)?class\s+(\w+)/);
      if (classMatch) {
        const className = classMatch[1];
        // Extract prefix (part before first underscore)
        const prefixMatch = className.match(/^([A-Z]+)_/);
        if (prefixMatch) {
          const prefix = prefixMatch[1];
          prefixes.set(prefix, (prefixes.get(prefix) || 0) + 1);
        }
      }
    } catch {
      // Skip
    }
  }

  // Find the most common prefix
  if (prefixes.size > 1) {
    let maxPrefix = "";
    let maxCount = 0;
    for (const [prefix, count] of prefixes) {
      if (count > maxCount) {
        maxPrefix = prefix;
        maxCount = count;
      }
    }

    for (const [prefix, count] of prefixes) {
      if (prefix !== maxPrefix) {
        issues.push({
          level: "info",
          message: `${count} class(es) use prefix "${prefix}_" instead of the most common prefix "${maxPrefix}_"`,
        });
      }
    }
  }

  return issues;
}

/** The dialog line of a headless run that stayed on one (it is the failure reason); nothing was answered. */
const dialogLine = (run: { dialog?: string; timedOut: boolean }) =>
  `Workbench showed a dialog that nothing answered: ${run.dialog}. ${run.timedOut ? "The run timed out with it open." : "The run was ended because it stayed open."}`;

/** Owner line of the shared Workbench lock file (ENFUSION_WORKBENCH_LOCK), for refusal messages. */
function lockOwner(): string {
  const path = process.env.ENFUSION_WORKBENCH_LOCK;
  if (!path) return "no lock file configured (ENFUSION_WORKBENCH_LOCK)";
  try {
    return /^\s*owner:\s*(.+)$/m.exec(readFileSync(path, "utf-8").replace(/^\uFEFF/, ""))?.[1].trim() ?? `no owner line in ${path}`;
  } catch {
    return `cannot read ${path}`;
  }
}

// ─── registerMod ──────────────────────────────────────────────────────────────

export function registerMod(
  server: McpServer,
  config: Config,
  searchEngine: SearchEngine,
  patterns: PatternLibrary
): void {
  server.registerTool(
    "mod",
    {
      description:
        "Manage Arma Reforger addons with headless Workbench runs (Workbench does not need to be open): " +
        "'compile' checks every script of the addon and lists errors with file:line; 'pack' produces the " +
        "loadable addon (data.pak + .gproj + resourceDatabase.rdb) for the game / dedicated server; " +
        "'build' = compile then pack (stops on script errors); 'create' scaffolds a new addon; " +
        "'validate' runs static checks without Workbench. " +
        "build, compile and pack are refused, before Workbench starts, when the addon or one of its dependencies exists as two copies with the same GUID in the -addonsDir folders (addonsDirs, else ENFUSION_ADDONS_DIR).",
      inputSchema: {
        action: z
          .enum(["build", "compile", "pack", "create", "validate"])
          .describe("build = compile + pack, compile = script check only, pack = package only, create = scaffold, validate = static checks."),

        // ── build / compile / pack params ─────────────────────────────────────
        addonName: z
          .string()
          .min(1)
          .optional()
          .describe("(build/compile/pack) Addon folder name under the project path. build and pack need addonName or gprojPath; compile defaults to the addon opened with wb_launch."),
        outputPath: z
          .string()
          .optional()
          .describe("(build/pack) Output directory for the packed addon. Default: <packedPath>/<AddonID>."),
        gprojPath: z
          .string()
          .optional()
          .describe("(build/compile/pack) Path to the .gproj instead of addonName."),
        force: z
          .boolean()
          .optional()
          .describe("(build/compile/pack) Run even while the Workbench GUI is open (it can crash when both work on the same addon)."),
        allowHandlers: z
          .boolean()
          .optional()
          .describe("(build/pack) Pack even if the addon holds the MCP handler scripts (local test packs only)."),
        cleanOutput: z
          .boolean()
          .optional()
          .describe("(build/pack) Pack into an output folder that holds other files too (nothing is deleted)."),
        listPak: z
          .boolean()
          .optional()
          .describe("(build/pack) List data.pak contents after packing (default true)."),
        addonsDirs: z
          .array(z.string())
          .optional()
          .describe(
            "(build/compile/pack) Folders for -addonsDir on this run (read only), in place of ENFUSION_ADDONS_DIR (an empty list [] counts as omitted: ENFUSION_ADDONS_DIR applies); each an existing absolute folder with no quote or comma. " +
            "Use a mission folder that holds the addon and junctions to its dependencies to build against that copy and no other. A pack output inside any of them is refused."
          ),

        // ── create params ─────────────────────────────────────────────────────
        name: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe("(create) Addon name (e.g., 'MyCustomMod'). Used as the project folder name."),
        description: z
          .string()
          .optional()
          .describe("(create) Brief description of what the mod does"),
        prefix: z
          .string()
          .min(1)
          .max(4)
          .optional()
          .describe("(create) Class name prefix (e.g., 'MCM'). Auto-derived from name if omitted."),
        pattern: z
          .string()
          .optional()
          .describe("(create) Mod pattern to apply (e.g., 'custom-faction', 'game-mode'). Use without this to get a bare scaffold."),
        projectPath: z
          .string()
          .optional()
          .describe("(create/validate) Parent directory where the addon folder will be created (create), or addon root directory (validate). Uses configured default if omitted."),

        // ── validate params ───────────────────────────────────────────────────
        checks: z
          .array(z.enum(["structure", "gproj", "scripts", "prefabs", "configs", "references", "naming"]))
          .optional()
          .describe("(validate) Specific checks to run. Runs all checks if omitted."),
      },
    },
    async ({ action, addonName, outputPath, gprojPath, force, allowHandlers, cleanOutput, listPak, name, description, prefix, pattern: patternName, projectPath, checks, addonsDirs }) => {

      // ── build / compile / pack ─────────────────────────────────────────────
      if (action === "build" || action === "compile" || action === "pack") {
        const badDirs = addonsDirs ? addonsDirsError(addonsDirs) : null;
        if (badDirs) return { content: [{ type: "text", text: badDirs }], isError: true };
        // wb_launch of an addon outside the project path leaves ENFUSION_DEFAULT_MOD naming another copy of it
        const opened = config.launchedGproj;
        if (action === "compile" && !addonName && !gprojPath && opened && !sameRealPath(dirname(dirname(opened)), config.projectPath)) {
          return { content: [{ type: "text", text: `Refused: the Workbench started by wb_launch runs ${opened}, which is not directly under the project path, so compiling the default addon would pick another copy. Pass gprojPath.` }], isError: true };
        }
        // build and pack run a headless Workbench on the addon, so they never default to ENFUSION_DEFAULT_MOD
        const gproj = resolveGproj(config, addonName ?? (action === "compile" ? config.defaultMod : undefined), gprojPath);
        if (!gproj) {
          return {
            content: [{ type: "text", text: `Addon not found. Pass addonName (a folder under ${config.projectPath}) or gprojPath.` }],
            isError: true,
          };
        }
        const dup = duplicateAddonError([gproj], (addonsDirs?.length ? addonsDirs.join(",") : config.addonsDir ?? "").split(","), { via: "addonsDirs" });
        if (dup) return { content: [{ type: "text", text: dup }], isError: true };
        const addonDir = dirname(gproj);
        const project = readGproj(gproj);
        const outDir = outputPath || join(config.packedPath, project.id || basename(addonDir));
        // Cheap file checks first, all before Workbench starts (a build compiles before it packs)
        if (action !== "compile") {
          const handlers = allowHandlers ? [] : handlerFiles(addonDir);
          if (handlers.length) {
            return {
              content: [{
                type: "text",
                text: `The addon contains ${handlers.length} MCP handler file(s) that would be packed: ${handlers.slice(0, 5).join(", ")}${handlers.length > 5 ? ", ..." : ""}. ` +
                  `Run wb_cleanup modDir=${addonDir} (then restart Workbench before more wb_* calls), or pass allowHandlers=true for a local test pack.`,
              }],
              isError: true,
            };
          }
          const outError = checkPackOutput(config, addonDir, project.guid, outDir, cleanOutput, addonsDirs);
          if (outError) return { content: [{ type: "text", text: outError }], isError: true };
        }
        if (!force && findPids("ArmaReforgerWorkbenchSteamDiag.exe").length > 0) {
          const open = workbenchCommandLines().map((w) => `PID ${w.pid} (${w.gproj || "unknown project"})`);
          return {
            content: [{
              type: "text",
              text: `Workbench is open${open.length ? `: ${open.join(", ")}` : ""}. Lock owner: ${lockOwner()}. ` +
                "A second headless Workbench on the same addon can crash the open one. If this MCP session started it, close it with wb_close; " +
                "otherwise ask the user or the lock owner, or wait. force=true runs anyway.",
            }],
            isError: true,
          };
        }
        const lines: string[] = [`## ${action === "compile" ? "Compile" : action === "pack" ? "Pack" : "Build"}: ${project.id || basename(addonDir)}`, ""];

        try {
          let compiled: { ok: boolean; errors: unknown[]; warnings: unknown[] } | undefined;
          if (action !== "pack") {
            const c = await compileAddon(config, gproj, undefined, addonsDirs);
            const own = c.errors.filter((e) => e.inAddon);
            compiled = { ok: c.ok, errors: own, warnings: c.warnings };
            lines.push(`**Scripts:** ${c.ok ? "compiled OK" : "FAILED"} (${c.run.seconds}s${c.run.timedOut ? ", timed out" : ""})`);
            if (own.length) {
              lines.push("", "### Errors in this addon");
              for (const e of own.slice(0, 50)) lines.push(`- \`${e.file}:${e.line}\` ${e.message}`);
            }
            const cascade = c.errors.length - own.length;
            if (!c.ok && cascade > 0) {
              lines.push("", `${cascade} more error(s) in base-game scripts, usually knock-on effects of the errors above` +
                (own.length ? "." : " (or a `modded class` breaking vanilla code). First ones:"));
              if (!own.length) for (const e of c.errors.slice(0, 15)) lines.push(`- \`${e.file}:${e.line}\` ${e.message}`);
            }
            if (c.warnings.length) {
              lines.push("", "### Warnings in this addon");
              for (const w of c.warnings.slice(0, 30)) lines.push(`- \`${w.file}:${w.line}\` ${w.message}`);
            }
            if (c.run.logDir) lines.push("", `Log: ${join(c.run.logDir, "console.log")}`);
            if (c.run.dialog) lines.push("", dialogLine(c.run));
            if (c.run.savedCrashes) lines.push("", c.run.savedCrashes);
            if (!c.ok) return { content: [{ type: "text", text: lines.join("\n") }], isError: true };
            if (action === "compile") return { content: [{ type: "text", text: lines.join("\n") }] };
            lines.push("");
          }

          const p = await packAddon(config, gproj, outDir, undefined, addonsDirs);
          lines.push(`**Pack:** ${p.ok ? "OK" : "FAILED"} (${p.run.seconds}s) → \`${outDir}\``);
          if (p.files.length) lines.push(`Files: ${p.files.join(", ")}`);
          let pak: ReturnType<typeof pakSummary> | undefined;
          if (listPak !== false && p.files.includes("data.pak")) {
            try {
              pak = pakSummary(join(outDir, "data.pak"));
              lines.push(`data.pak: ${pak.entries} entries, ${pak.bytes} bytes; by folder ${Object.entries(pak.byTopFolder).map(([k, v]) => `${k} ${v}`).join(", ")}; MCP handler entries: ${pak.handlerEntries}`);
            } catch (e) {
              lines.push(`data.pak could not be listed: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          if (existsSync(join(addonDir, "Scripts", "WorkbenchGame", "EnfusionMCP"))) {
            lines.push("", "⚠ The EnfusionMCP Workbench handler scripts are inside this addon and were packed with it. Run `wb_cleanup` before publishing.");
          }
          if (p.ok) {
            lines.push(
              "",
              "Load it locally with `game launch` / `server start` (addonsDir = " + `\`${dirname(outDir)}\`, addon GUID \`${project.guid}\`).`
            );
          } else {
            for (const e of p.errors.slice(0, 20)) lines.push(`- ${e}`);
            if (p.run.logDir) lines.push(`Log: ${join(p.run.logDir, "console.log")}`);
          }
          if (p.run.dialog) lines.push("", dialogLine(p.run));
          if (p.run.savedCrashes) lines.push("", p.run.savedCrashes);
          const result = {
            action, ok: p.ok,
            addon: { id: project.id, guid: project.guid, dir: addonDir },
            outDir, seconds: p.run.seconds,
            files: p.files.map((f) => ({ name: f, bytes: statSync(join(outDir, f)).size })),
            pak, compile: compiled, packErrors: p.errors, logDir: p.run.logDir,
          };
          lines.push("", "```json", JSON.stringify(result), "```");
          return { content: [{ type: "text", text: lines.join("\n") }], ...(p.ok ? {} : { isError: true }) };
        } catch (e) {
          return { content: [{ type: "text", text: `Error running Workbench: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
        }
      }

      // ── create ─────────────────────────────────────────────────────────────
      if (action === "create") {
        if (!name) {
          return {
            content: [{ type: "text", text: "Missing required parameter for action 'create': name" }],
            isError: true,
          };
        }

        const basePath = projectPath || config.projectPath;

        if (!basePath) {
          return {
            content: [
              {
                type: "text",
                text: "No project path configured. Set ENFUSION_PROJECT_PATH environment variable or provide projectPath parameter.",
              },
            ],
            isError: true,
          };
        }

        try {
          validateFilename(name);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Invalid addon name: ${msg}` }],
            isError: true,
          };
        }

        // Validate pattern before creating any directories
        if (patternName) {
          const patternDef = patterns.get(patternName);
          if (!patternDef) {
            const available = patterns.list().join(", ");
            return {
              content: [
                {
                  type: "text",
                  text: `Unknown pattern: "${patternName}"\nAvailable patterns: ${available}`,
                },
              ],
              isError: true,
            };
          }
        }

        const addonDir = resolve(basePath, name);
        const classPrefix = prefix ?? derivePrefix(name);

        if (existsSync(addonDir)) {
          return {
            content: [
              {
                type: "text",
                text: `Directory already exists: ${addonDir}\nUse a different name or delete the existing directory.`,
              },
            ],
            isError: true,
          };
        }

        const root = forbiddenRoot(config, addonDir);
        if (root) {
          return {
            content: [{
              type: "text",
              text: `Refused: ${addonDir} is inside ${root} (game or Tools install, Workshop cache, or ENFUSION_FORBIDDEN_DIRS). Create the addon in your own projects folder.`,
            }],
            isError: true,
          };
        }

        // A new addon never goes inside another addon (protected ones like CRF included)
        for (let d = resolve(basePath); ; d = dirname(d)) {
          const outer = findGproj(d);
          if (outer) {
            return {
              content: [{ type: "text", text: `Refused: ${basePath} is inside the addon ${d} (${basename(outer)}). Pass the folder that holds addons as projectPath.` }],
              isError: true,
            };
          }
          if (dirname(d) === d) break;
        }

        // Check for filename collisions after prefix replacement, before anything is written
        if (patternName) {
          const patternDef = patterns.get(patternName)!;
          const scriptPaths: string[] = [];
          for (const scriptDef of patternDef.scripts) {
            const className = scriptDef.className.replace(/\{PREFIX\}/g, classPrefix);
            const path = `Scripts/Game/${className}.c`;
            if (scriptPaths.includes(path)) {
              return {
                content: [{
                  type: "text",
                  text: `Pattern "${patternName}" produces duplicate script file after prefix replacement: ${path}\nUse a different prefix to avoid collisions.`,
                }],
                isError: true,
              };
            }
            scriptPaths.push(path);
          }

          const configPaths: string[] = [];
          for (const configDef of patternDef.configs) {
            const configName = configDef.name.replace(/\{PREFIX\}/g, classPrefix);
            const path = `Configs/${configName}.conf`;
            if (configPaths.includes(path)) {
              return {
                content: [{
                  type: "text",
                  text: `Pattern "${patternName}" produces duplicate config file after prefix replacement: ${path}\nUse a different prefix to avoid collisions.`,
                }],
                isError: true,
              };
            }
            configPaths.push(path);
          }
        }

        try {
          const createdFiles: string[] = [];

          // Create directory structure
          const dirs = [
            addonDir,
            join(addonDir, "Scripts", "Game"),
            join(addonDir, "Prefabs"),
            join(addonDir, "PrefabsEditable"),
            join(addonDir, "Configs"),
            join(addonDir, "Language"),
            join(addonDir, "Missions"),
            join(addonDir, "UI"),
            join(addonDir, "Worlds"),
          ];
          for (const dir of dirs) {
            mkdirSync(dir, { recursive: true });
          }

          // Generate and write .gproj
          const gprojContent = generateGproj({
            name,
            title: name,
          });
          const gprojFilePath = join(addonDir, `${name}.gproj`);
          writeFileSync(gprojFilePath, gprojContent, "utf-8");
          createdFiles.push(`${name}.gproj`);

          // Apply pattern if specified (already validated above)
          if (patternName) {
            const patternDef = patterns.get(patternName)!;

            // Generate scripts from pattern
            for (const scriptDef of patternDef.scripts) {
              const className = scriptDef.className.replace(/\{PREFIX\}/g, classPrefix);
              const code = generateScript({
                className,
                scriptType: scriptDef.scriptType as any,
                parentClass: scriptDef.parentClass || undefined,
                methods: scriptDef.methods.length > 0 ? scriptDef.methods : undefined,
                description: scriptDef.description,
              });
              const scriptPath = join(addonDir, "Scripts", "Game", `${className}.c`);
              writeFileSync(scriptPath, code, "utf-8");
              createdFiles.push(`Scripts/Game/${className}.c`);
            }

            // Create prefab subdirectories from pattern
            for (const prefabDef of patternDef.prefabs) {
              const prefabName = prefabDef.name.replace(/\{PREFIX\}/g, classPrefix);
              // Ensure directory exists (prefabs go in type-specific subdirs)
              const prefabDir = join(addonDir, "Prefabs");
              mkdirSync(prefabDir, { recursive: true });
              // Note: prefab file generation is done via prefab_create tool for full control
              createdFiles.push(`(Use prefab_create for: ${prefabName})`);
            }

            // Apply pattern configs
            for (const configDef of patternDef.configs) {
              const configName = configDef.name.replace(/\{PREFIX\}/g, classPrefix);
              const configContent = configDef.content.replace(/\{PREFIX\}/g, classPrefix);
              const targetPath = join(addonDir, "Configs", `${configName}.conf`);
              mkdirSync(resolve(targetPath, ".."), { recursive: true });
              writeFileSync(targetPath, configContent, "utf-8");
              createdFiles.push(`Configs/${configName}.conf`);
            }
          }

          // Build response
          const lines: string[] = [];
          lines.push(`## Addon Created: ${name}`);
          lines.push(`Path: ${addonDir}`);
          lines.push(`Class prefix: ${classPrefix}`);
          lines.push("");
          lines.push("### Created Files");
          for (const f of createdFiles) {
            lines.push(`- ${f}`);
          }
          lines.push("");
          lines.push("### Directory Structure");
          lines.push(`${name}/`);
          lines.push(`  ${name}.gproj`);
          lines.push("  Scripts/");
          lines.push("    Game/");
          if (createdFiles.some((f) => f.startsWith("Scripts/"))) {
            for (const f of createdFiles) {
              if (f.startsWith("Scripts/Game/")) {
                lines.push(`      ${f.replace("Scripts/Game/", "")}`);
              }
            }
          }
          lines.push("  Prefabs/");
          lines.push("  PrefabsEditable/");
          lines.push("  Configs/");
          if (createdFiles.some((f) => f.startsWith("Configs/"))) {
            for (const f of createdFiles) {
              if (f.startsWith("Configs/")) {
                lines.push(`    ${f.replace("Configs/", "")}`);
              }
            }
          }
          lines.push("  Language/");
          lines.push("  Missions/");
          lines.push("  UI/");
          lines.push("  Worlds/");
          lines.push("");
          lines.push("Addon scaffold is ready. Proceeding with file generation and Workbench integration automatically.");

          if (patternName) {
            const patternDef = patterns.get(patternName);
            if (patternDef?.instructions) {
              lines.push("");
              lines.push("### Pattern Instructions");
              lines.push(patternDef.instructions);
            }
          }

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Error creating addon: ${msg}` }],
            isError: true,
          };
        }
      }

      // ── validate ───────────────────────────────────────────────────────────
      // action === "validate"
      let basePath: string;
      if (projectPath) {
        // Validate user-supplied path is within the configured project directory
        try {
          basePath = validateProjectPath(config.projectPath, projectPath);
        } catch {
          return {
            content: [
              {
                type: "text",
                text: `Invalid project path: "${projectPath}". Path must be within the configured project directory (${config.projectPath}).`,
              },
            ],
          };
        }
      } else {
        basePath = config.projectPath;
      }

      if (!basePath) {
        return {
          content: [
            {
              type: "text",
              text: "No project path configured. Set ENFUSION_PROJECT_PATH environment variable or provide projectPath parameter.",
            },
          ],
          isError: true,
        };
      }

      if (!existsSync(basePath)) {
        return {
          content: [
            { type: "text", text: `Project directory not found: ${basePath}` },
          ],
          isError: true,
        };
      }

      const enabledChecks = (checks as CheckName[] | undefined) ?? ALL_CHECKS;
      const allIssues: ValidationIssue[] = [];

      const checkMap: Record<CheckName, () => ValidationIssue[]> = {
        structure: () => checkStructure(basePath),
        gproj: () => checkGproj(basePath),
        scripts: () => checkScripts(basePath),
        prefabs: () => checkPrefabs(basePath),
        configs: () => checkConfigs(basePath, searchEngine),
        references: () => checkReferences(basePath, searchEngine),
        naming: () => checkNaming(basePath),
      };

      const passedChecks: string[] = [];

      for (const check of enabledChecks) {
        const issues = checkMap[check]();
        if (issues.length === 0) {
          passedChecks.push(check);
        }
        allIssues.push(...issues);
      }

      // Format report
      const errors = allIssues.filter((i) => i.level === "error");
      const warnings = allIssues.filter((i) => i.level === "warning");
      const infos = allIssues.filter((i) => i.level === "info");

      const lines: string[] = [];
      const dirName = basePath.split(/[\\/]/).pop() || basePath;
      lines.push(`## Validation Report: ${dirName}`);
      lines.push("");

      if (errors.length > 0) {
        lines.push(`### Errors (${errors.length})`);
        for (const e of errors) lines.push(`- ${e.message}`);
        lines.push("");
      }

      if (warnings.length > 0) {
        lines.push(`### Warnings (${warnings.length})`);
        for (const w of warnings) lines.push(`- ${w.message}`);
        lines.push("");
      }

      if (infos.length > 0) {
        lines.push(`### Info (${infos.length})`);
        for (const i of infos) lines.push(`- ${i.message}`);
        lines.push("");
      }

      if (passedChecks.length > 0) {
        lines.push(`### Passed (${passedChecks.length})`);
        for (const c of passedChecks) lines.push(`- ${c}`);
        lines.push("");
      }

      if (errors.length === 0 && warnings.length === 0) {
        lines.push("All checks passed!");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
