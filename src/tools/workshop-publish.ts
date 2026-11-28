import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Config } from "../config.js";
import { findGproj, resolveAddonDir } from "../utils/game-paths.js";
import { forbiddenRoot } from "../utils/safe-path.js";
import { CHANGE_NOTES_MAX } from "../release/workshop-rules.js";
import { addonsDirsError, publishAddon, publishArgs, readGproj, type PublishOptions } from "../workbench/cli.js";

type Reply = { content: { type: "text"; text: string }[]; isError?: boolean };
const reply = (text: string, isError = false): Reply => ({ content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) });

/** Why the publish options cannot go to Workbench, or null. Each value becomes one process argument. */
export function publishOptionsError(config: Config, o: PublishOptions): string | null {
  if (o.version && !/^\d+(\.\d+){1,3}$/.test(o.version)) return `version must look like 1.2.3: ${o.version}`;
  if (o.changeNote !== undefined) {
    if (/[\r\n"]/.test(o.changeNote)) return "changeNote must be one line without double quotes (it is passed as one -publishAddonChangeNote argument)";
    if (o.changeNote.length > CHANGE_NOTES_MAX) return `changeNote is over ${CHANGE_NOTES_MAX} characters`;
  }
  const file = (k: string, p: string | undefined, dir: boolean) => {
    if (!p) return null;
    if (!isAbsolute(p) || /["\r\n]/.test(p) || !existsSync(p)) return `${k} must be an existing absolute path without quotes: ${p}`;
    if (statSync(p).isDirectory() !== dir) return `${k} must be a ${dir ? "folder" : "file"}: ${p}`;
    return null;
  };
  const bad = file("previewImage", o.previewImage, false) ?? file("screenshotsDir", o.screenshotsDir, true);
  if (bad) return bad;
  if (o.publishDir) {
    if (!isAbsolute(o.publishDir) || /["\r\n]/.test(o.publishDir)) return `publishDir must be an absolute path without quotes: ${o.publishDir}`;
    const root = forbiddenRoot(config, o.publishDir);
    if (root) return `Refused: publishDir is inside ${root} (the game, Workbench or Workshop download folder)`;
  }
  return null;
}

export function registerWorkshopPublish(server: McpServer, config: Config): void {
  server.registerTool(
    "workshop_publish",
    {
      description:
        "Publish an UPDATE of an addon that is already on the Workshop, with a headless Workbench run (-publishAddon and its -publishAddonVersion, " +
        "-publishAddonChangeNote, -publishAddonPreviewImage, -publishAddonScreenshots, -publishAddonDir flags). Bohemia documents these flags for updates only: " +
        "a first publish is done by a person in Workbench (File > Publish to Workshop). The default is a dry run that shows the command line. " +
        "Nothing is uploaded unless dryRun is false AND confirm is true; set them only after the user approved this exact publication. " +
        "The Bohemia account must be linked in Workbench. Verdict from console.log ('Project uploaded successfully'); the run is ended at timeoutSec " +
        "(the CLI publish is known to stall after 'Pending workshop invites request done'). Check the result with workshop_info online: true.",
      inputSchema: {
        projectPath: z.string().optional().describe("Absolute path to the addon folder (containing the .gproj). Uses modName or the default mod if omitted."),
        modName: z.string().optional().describe("Addon folder name under the projects path. Defaults to ENFUSION_DEFAULT_MOD."),
        version: z.string().optional().describe("Version to publish, e.g. 1.2.3 (-publishAddonVersion)"),
        changeNote: z.string().optional().describe("One-line change note (-publishAddonChangeNote); lint it first with workshop_info changeNotes"),
        previewImage: z.string().optional().describe("Absolute path to the preview image (-publishAddonPreviewImage)"),
        screenshotsDir: z.string().optional().describe("Absolute path to a folder of screenshots (-publishAddonScreenshots)"),
        publishDir: z.string().optional().describe("Absolute folder for the packed output (-publishAddonDir); refused inside the game, Workbench or Workshop folder"),
        addonsDirs: z.array(z.string()).optional().describe("-addonsDir folders for this run (default ENFUSION_ADDONS_DIR)"),
        timeoutSec: z.number().int().min(30).max(3600).default(600).describe("Hard limit for the run; the Workbench this call started is ended after it"),
        dryRun: z.boolean().default(true),
        confirm: z.boolean().default(false).describe("Must be true, with dryRun false, to upload. Only after the user's explicit approval."),
      },
    },
    async ({ projectPath, modName, version, changeNote, previewImage, screenshotsDir, publishDir, addonsDirs, timeoutSec, dryRun, confirm }) => {
      const gproj = (projectPath && findGproj(projectPath)) || findGproj(resolveAddonDir(config.projectPath, modName ?? config.defaultMod) ?? "");
      if (!gproj) return reply(`No .gproj found for ${projectPath ?? modName ?? config.defaultMod ?? "(no addon given)"}`, true);
      const o: PublishOptions = { version, changeNote, previewImage, screenshotsDir, publishDir };
      const bad = publishOptionsError(config, o) ?? (addonsDirs?.length ? addonsDirsError(addonsDirs) : null);
      if (bad) return reply(bad, true);
      const { id, guid } = readGproj(gproj);
      const link = guid ? `https://reforger.armaplatform.com/workshop/${guid}` : "";
      const cmd = publishArgs(gproj, o).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
      if (dryRun !== false || confirm !== true) {
        return reply(
          [`## Publish (dry run): ${id || gproj}`, "", "Nothing was uploaded. Workbench would run with:", "", `    ${cmd}`, "",
            "This updates an addon already on the Workshop; a first publish is done in Workbench (File > Publish to Workshop).",
            "To upload, call again with dryRun: false and confirm: true after the user approved it.", link && `Workshop page: ${link}`].filter((l) => l !== "").join("\n")
        );
      }
      try {
        const r = await publishAddon(config, gproj, o, timeoutSec * 1000, addonsDirs);
        const lines = [`## Publish: ${id || gproj}: ${r.ok ? "uploaded" : r.run.timedOut ? `ended after ${timeoutSec} s without a result` : "failed"}`, ""];
        if (r.run.dialog) lines.push(`A dialog stayed open and ended the run: ${r.run.dialog}`);
        if (r.run.timedOut) lines.push("The CLI publish is known to stall after 'Pending workshop invites request done'. Publish from Workbench (File > Publish to Workshop) instead.");
        for (const e of r.errors) lines.push(`- (E) ${e}`);
        if (r.lines.length) lines.push("", "Log lines:", ...r.lines.map((l) => `    ${l}`));
        if (r.run.logDir) lines.push("", `Log folder: ${r.run.logDir}`);
        if (r.ok && link) lines.push("", `Workshop page: ${link}`);
        return reply(lines.join("\n"), !r.ok);
      } catch (e) {
        return reply(`Error running Workbench: ${e instanceof Error ? e.message : String(e)}`, true);
      }
    }
  );
}
