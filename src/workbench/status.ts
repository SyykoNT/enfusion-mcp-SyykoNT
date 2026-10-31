import type { WorkbenchClient } from "./client.js";
import { WATCH_DIR, alertLine, isAlert, readStates } from "../watchdog/wb-watch.js";

/**
 * Build a status footer line showing current Workbench connection state.
 * Appended to all wb_* tool responses so the LLM always knows the mode.
 */
export function formatConnectionStatus(client: WorkbenchClient, watchDir = WATCH_DIR): string {
  return connectionLine(client) + watchAlerts(watchDir);
}

/** One footer line naming every watched Workbench in trouble, or "" when all are fine. */
export function watchAlerts(dir = WATCH_DIR, now = Date.now()): string {
  const lines = readStates(dir).states.filter((s) => isAlert(s, now)).map((s) => alertLine(s, now));
  return lines.length ? `\n\`Watchdog: ${lines.join("; ")}. Run wb_watch status.\`` : "";
}

function connectionLine(client: WorkbenchClient): string {
  const { connected, mode } = client.state;
  if (!connected) return "\n\n---\n`Workbench: disconnected`";
  if (mode === "play") return "\n\n---\n`Workbench: play mode`";
  if (mode === "edit") return "\n\n---\n`Workbench: edit mode`";
  if (mode === "no_world") return "\n\n---\n`Workbench: no world open`";
  return "\n\n---\n`Workbench: connected (mode unknown)`";
}

/**
 * Gate for mutating tools: reads the live mode right before the action and never launches Workbench.
 * Returns null to go ahead, or the refusal text (callers return it with isError).
 */
export async function ensureMode(client: WorkbenchClient, want: "edit" | "play", action: string): Promise<string | null> {
  const mode = await client.probeMode();
  if (mode === want) return null;
  switch (mode) {
    case "not_running":
      return `Cannot ${action}: Workbench is not running on ${client.endpoint}. Start it with wb_launch (gprojPath) after checking that nobody else is using Workbench.`;
    case "timeout":
      return `Cannot ${action}: Workbench did not answer within 3 s. Ask the user to check Workbench for an open dialog and answer it.`;
    case "no_handlers":
      return `Cannot ${action}: the MCP handlers are not loaded in this Workbench; run wb_diagnose.`;
    case "unknown":
      return `Cannot ${action}: could not read the Workbench mode; run wb_diagnose.`;
    case "no_world":
      return `Cannot ${action}: no world is open in the World Editor (read just now). Open one first (wb_open_resource with a .ent world).`;
    case "play":
      return `Cannot ${action}: Workbench is in play mode (read just now). Call wb_stop first, or wait for the play test to end.`;
    case "edit":
      return `Cannot ${action}: Workbench is in edit mode (read just now). Call wb_play first to enter play mode.`;
  }
}
