import { join } from "node:path";
import { loadConfig } from "../config.js";
import { createTuningServer } from "./server.js";
import { writeRefusal } from "./write-guard.js";
import { WorkbenchClient } from "../workbench/client.js";
import { PakVirtualFS } from "../pak/vfs.js";
import { baseReader } from "../tools/config-override.js";
import { notifyFailure, reloadScripts } from "../tools/wb-reload.js";

const config = loadConfig();
const addonName = process.env.ENFUSION_TUNING_ADDON || "RoadForger";
const addonPath = join(config.projectPath, addonName);
const port = process.env.ENFUSION_TUNING_PORT ? parseInt(process.env.ENFUSION_TUNING_PORT, 10) : 5790;

// Writing is on by default: editing the .et text directly is the documented-safe
// way to change a nested field (the Workbench API replaces the whole nested
// object and wipes siblings). Set ENFUSION_TUNING_READONLY=1 to lock it.
const allowWrite = process.env.ENFUSION_TUNING_READONLY !== "1";

// Writing into a game or Workshop folder or a protected addon is refused at start, like every other writing tool.
const refusal = allowWrite ? writeRefusal(config, addonPath) : null;
if (refusal) {
  console.error(`${refusal}\nThe tuning server did not start. Set ENFUSION_TUNING_ADDON to your own addon, or ENFUSION_TUNING_READONLY=1 to view without writing.`);
  process.exit(1);
}

// What to do in Workbench after a successful write, via ENFUSION_TUNING_POST_WRITE:
//   rebuild        (default) ask Workbench to rebuild the changed .et file (ResourceManager.RebuildResourceFile); the reply only says it was requested, the result is in console.log
//   scripts        the built-in NET API ReloadScripts, as wb_reload does (180 s timeout); the reply says to confirm
//                  with the "Reloading game scripts took" line in Workbench's console.log
//   menu:A,B       run an exact menu path against WorldEditor, e.g. menu:Plugins,Reload Scripts
//   none           write only
//
// Note on `scripts`: ReloadScripts keeps the NET API and the MCP handlers on 1.9.0.37 (tests/records
// 2026-11-08_WB19-LIVE_fix-checks.md, row 11). On the diag build every ReloadScripts raises the
// "Resources are leaking!" assert and the reply waits until it is answered, up to 180 s; the MCP's
// watcher (automatic, or `wb_watch start`) presses Ignore. The write itself always lands regardless
// of postWrite, and the reply reports what happened.
const postWrite = process.env.ENFUSION_TUNING_POST_WRITE || "rebuild";

const wbClient = new WorkbenchClient(config.workbenchHost, config.workbenchPort, config);

const CALL_OPTS = { timeout: 8000 } as const;

async function notifyWorkbench(relPath: string): Promise<string | null> {
  if (postWrite === "none") return null;

  try {
    let result: Record<string, unknown>;

    if (postWrite.startsWith("menu:")) {
      const menuPath = postWrite.slice("menu:".length);
      result = await wbClient.call("EMCP_WB_ExecuteAction", { menuPath }, CALL_OPTS);
    } else if (postWrite === "rebuild") {
      const wbPath = `$${addonName}:${relPath}`;
      result = await wbClient.call("EMCP_WB_Resources", { action: "rebuild", path: wbPath }, CALL_OPTS);
    } else {
      return `Workbench [scripts]: ReloadScripts answered Ok. ${await reloadScripts(wbClient)}`;
    }

    const msg = typeof result.message === "string" ? result.message : JSON.stringify(result);
    return `Workbench [${postWrite}]: ${msg}`;
  } catch (e) {
    return notifyFailure(e);
  }
}

// An extracted folder wins; otherwise vanilla files are read from the installed game paks.
const usePaks = !config.extractedPath && PakVirtualFS.get(config.gamePath) !== null;
const baseData = config.extractedPath
  ? `extracted ${config.extractedPath}`
  : usePaks
    ? `paks ${config.gamePath}`
    : "(neither an extracted folder nor game paks found, so inherited values will show as unresolved)";

const server = createTuningServer(addonPath, config.extractedPath, allowWrite, notifyWorkbench, usePaks ? baseReader(config) : undefined);
server.listen(port, "127.0.0.1", () => {
  console.log(`Vehicle tuning server: http://127.0.0.1:${port}`);
  console.log(`  addon:      ${addonName}`);
  console.log(`  path:       ${addonPath}`);
  console.log(`  mode:       ${allowWrite ? "read-write, close the prefab's Prefab Edit tab before applying" : "READ-ONLY (ENFUSION_TUNING_READONLY=1)"}`);
  console.log(`  after write: ${postWrite}${postWrite === "scripts" ? " (the reply waits for the reload, up to 180 s)" : ""}`);
  console.log(`  base data:  ${baseData}`);
  console.log(`  Set ENFUSION_TUNING_ADDON to point at a different addon, ENFUSION_TUNING_PORT to change the port.`);
});
