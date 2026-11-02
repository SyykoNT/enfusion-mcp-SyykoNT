import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Config } from "../config.js";
import { findGproj, myGamesDir } from "../utils/game-paths.js";
import { workbenchProfileDir } from "../workbench/cli.js";

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

/**
 * Profile names the Dedicated Server Tool passes, from Workbench's settings dump (`ScriptTools\SCR_DedicatedServerPlugin=` line).
 * The dump leaves out strings at their default: a missing m_sProfile is "" (no -profile), a missing peer Profile is "PeerPlugin".
 * Peers are numbered as the plugin does: enabled ones only, from 1, each `<its own Profile><n>`; a peer with Profile "" gets no -profile
 * (it writes to the default client profile, source "game"), so it has no folder here.
 */
export function dstProfiles(dump: string): { server: string; peers: string[] } {
  const line = dump.match(/^ScriptTools\\SCR_DedicatedServerPlugin=(.*)$/m)?.[1] ?? "";
  // The dump escapes inside each quoted part: \" for a quote and \\ for a backslash (paths read C:\\Users\\...).
  const parts = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, "$1").trim());
  let server = "";
  const peers: string[] = [];
  let peer: { profile: string; enabled: boolean } | undefined;
  let n = 0;
  for (const t of parts) {
    if (/^PeerConfig\b.*\{$/.test(t)) peer = { profile: "PeerPlugin", enabled: true };
    else if (peer && t === "}") {
      if (peer.enabled && ++n && peer.profile) peers.push(peer.profile + n);
      peer = undefined;
    } else if (peer) {
      peer.profile = /^Profile "(.*)"$/.exec(t)?.[1] ?? peer.profile;
      if (t === "Enabled 0") peer.enabled = false;
    } else server = /^m_sProfile "(.*)"$/.exec(t)?.[1] ?? server;
  }
  return { server, peers };
}

/**
 * Profile folders of the Dedicated Server Tool's last setup: the server's, and each enabled peer's that exists.
 * A relative -profile lands in <Documents>\My Games\<name> (GI-14 probe, server log FileSystem lines); peers assumed the same (unverified).
 * Workbench writes the settings dump itself, so a change in the tool shows here once Workbench has saved its settings.
 */
export function dstProfileDirs(config: Config, myGames = myGamesDir): { server?: string; peers: string[]; settings: string } {
  const settings = join(workbenchProfileDir(config), "profile", "wbSettingsDump.ini");
  const p = dstProfiles(existsSync(settings) ? readFileSync(settings, "utf-8") : "");
  let mg: string | undefined;
  // These names lead to log roots: one that climbs out with ".." is dropped.
  const at = (name: string) =>
    name.split(/[\\/]/).includes("..") ? undefined : isAbsolute(name) ? name : join((mg ??= myGames()), name);
  return { server: p.server ? at(p.server) : undefined, peers: p.peers.map(at).filter((d): d is string => !!d && existsSync(d)), settings };
}

export interface ParamsArgs {
  world?: string;
  documentsFolder?: string;
  projectsFolder?: string;
  modsFolder?: string;
}

/** The Dedicated Server Tool fields as the guide [p15-p16] fills them, with this PC's paths. */
export function serverParams(a: ParamsArgs, config: Pick<Config, "serverPath" | "gamePath">, myGames = myGamesDir): string {
  const games = a.documentsFolder ? join(a.documentsFolder, "My Games") : myGames();
  const workbench = join(games, "ArmaReforgerWorkbench");
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
    `My Games: ${games}${a.documentsFolder ? " (from the given Documents folder)" : " (Windows Documents shell folder)"}`,
    "Note: the tool itself also passes Workbench's own -addonsDir and the IDs of the loaded addons (SCR_DedicatedServerPlugin.c), " +
      "so Params repeats them; which copy the server uses is unverified.",
  ].join("\n");
}

// Paths go into text the user pastes into Params: absolute, with no quote or line break that would split the line.
// A comma would split the -addonsDir list (review GI-12 N2).
const folder = z.string().refine((p) => isAbsolute(p) && !/[",\r\n]/.test(p), "an absolute path without quotes, commas or line breaks");

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
