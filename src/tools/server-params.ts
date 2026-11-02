import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Config } from "../config.js";
import { findGproj } from "../utils/game-paths.js";

const SHELL_FOLDERS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders";

/** The Windows Documents folder from the shell folder entry (follows OneDrive and moved folders), else ~/Documents. */
export function documentsDir(query = () => execFileSync("reg", ["query", SHELL_FOLDERS, "/v", "Personal"], { encoding: "utf-8", windowsHide: true })): string {
  try {
    const raw = query().match(/Personal\s+REG_(?:EXPAND_)?SZ\s+(.+)/)?.[1]?.trim();
    if (raw) return raw.replace(/%([^%]+)%/g, (m, v: string) => process.env[v] ?? m);
  } catch {
    // no registry (not Windows) or no entry
  }
  return join(homedir(), "Documents");
}

/** The header .conf (as the {GUID}path the tool's picker stores) whose World is this .ent, searched under the addon's Missions folder. */
export function findMissionHeader(worldFile: string): { header?: string; addon?: string } {
  let addon = dirname(worldFile);
  while (!findGproj(addon) && dirname(addon) !== addon) addon = dirname(addon);
  if (!findGproj(addon)) return {};
  const rel = relative(addon, worldFile).replace(/\\/g, "/").toLowerCase();
  let files: string[] = [];
  try {
    files = readdirSync(join(addon, "Missions"), { recursive: true }).map(String).filter((f) => f.toLowerCase().endsWith(".conf"));
  } catch {
    return { addon };
  }
  for (const f of files) {
    const text = readFileSync(join(addon, "Missions", f), "utf-8");
    const world = text.match(/^\s*World\s+"(?:\{[0-9A-Fa-f]{16}\})?([^"]+)"/m)?.[1];
    if (!/^\s*SCR_MissionHeader\b/.test(text) || world?.toLowerCase() !== rel) continue;
    const path = "Missions/" + f.replace(/\\/g, "/");
    const meta = existsSync(join(addon, "Missions", f + ".meta")) ? readFileSync(join(addon, "Missions", f + ".meta"), "utf-8") : "";
    const guid = meta.match(/\{([0-9A-Fa-f]{16})\}/)?.[1];
    return { addon, header: guid ? `{${guid}}${path}` : path };
  }
  return { addon };
}

export interface ParamsArgs {
  world?: string;
  documentsFolder?: string;
  projectsFolder?: string;
  modsFolder?: string;
}

/** The Dedicated Server Tool fields as the guide [p15-p16] fills them, with this PC's paths. */
export function serverParams(a: ParamsArgs, config: Pick<Config, "serverPath" | "gamePath">, docs = documentsDir): string {
  const documents = a.documentsFolder || docs();
  const workbench = join(documents, "My Games", "ArmaReforgerWorkbench");
  const projects = a.projectsFolder || join(workbench, "Projects");
  const mods = a.modsFolder || join(workbench, "addons");
  const found = (p: string) => `${p} (${existsSync(p) ? "found" : "NOT FOUND"})`;

  let header = "leave empty unless you test a mission: pass world to look up its header";
  if (a.world) {
    const h = findMissionHeader(a.world);
    header = h.header ?? (h.addon ? `none in ${join(h.addon, "Missions")} names this world: run Lobby plugin 6 first` : `no .gproj above ${a.world}`);
  }
  return [
    "**Dedicated Server Tool settings** (World Editor with your mission open, Ctrl+Shift+D)",
    "",
    "Server",
    "- Config: DedicatedServerPluginCLI_Server",
    "- World: leave empty (the open world)",
    `- Mission Header: ${header}`,
    `- Executable: ${found(join(config.serverPath, "ArmaReforgerServerDiag.exe"))}`,
    "- Profile: server",
    "- No Throw: ticked",
    `- Params: -addonsDir "${projects},${mods}" -addons "COALITIONFramework"`,
    "",
    "Peers",
    "- Run Peers: ticked",
    `- Peer Executable: ${found(join(config.gamePath, "ArmaReforgerSteamDiag.exe"))}`,
    "- Peers Config: click + once per client, tick Enabled and leave Rpl Auto Join ticked",
    "",
    `Documents: ${documents}${a.documentsFolder ? " (given)" : " (Windows shell folder)"}`,
    "Note: the tool itself also passes Workbench's own -addonsDir and the IDs of the loaded addons (SCR_DedicatedServerPlugin.c), " +
      "so Params repeats them; which copy the server uses is unverified.",
  ].join("\n");
}

// Paths go into text the user pastes into Params: absolute, with no quote or line break that would split the line.
const folder = z.string().refine((p) => isAbsolute(p) && !/["\r\n]/.test(p), "an absolute path without quotes or line breaks");

export function registerServerParams(server: McpServer, config: Config): void {
  server.registerTool(
    "server_params",
    {
      description:
        "Read only. The settings for Workbench's Dedicated Server Tool (Ctrl+Shift+D) as the COALITION guide fills them, with this PC's real paths: " +
        "the Params line (-addonsDir with the Projects and mods folders, -addons), the Mission Header .conf for a world, and the Server and client Diag executables. " +
        "Finds Documents from the Windows shell folder, so a OneDrive or moved Documents folder is right.",
      inputSchema: {
        world: folder.optional().describe("Absolute path of the mission's .ent; its header .conf is looked up in that addon's Missions folder"),
        documentsFolder: folder.optional().describe("Documents folder, if not the Windows one"),
        projectsFolder: folder.optional().describe("Workbench projects folder (default <Documents>\\My Games\\ArmaReforgerWorkbench\\Projects)"),
        modsFolder: folder.optional().describe("Mods folder (default the Workbench addons folder)"),
      },
    },
    async (a) => ({ content: [{ type: "text" as const, text: serverParams(a, config) }] })
  );
}
