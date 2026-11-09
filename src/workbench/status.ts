import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { WorkbenchClient } from "./client.js";
import { WATCH_DIR, alertLine, isAlert, readStates } from "../watchdog/wb-watch.js";
import { isAlive } from "../utils/process.js";

/**
 * Build a status footer line showing current Workbench connection state.
 * Appended to all wb_* tool responses so the LLM always knows the mode.
 */
export function formatConnectionStatus(client: WorkbenchClient, watchDir = WATCH_DIR): string {
  return connectionLine(client) + watchAlerts(watchDir) + portOwnerLines(watchDir, client.port) + watchEvents(watchDir);
}

/** One footer line per watched Workbench (live state, watcher alive) that does not hold the NET API port: another process answers it. Reads the state files only. */
export function portOwnerLines(dir: string, port: number, alive = isAlive): string {
  return readStates(dir).states
    .filter((s) => s.state !== "exited" && s.state !== "crashed" && alive(s.watcherPid) && s.portOwner && s.portOwner !== s.pid)
    .map((s) => `\n\`Watchdog: Workbench PID ${s.pid} does not hold NET API port ${port}; PID ${s.portOwner} answers it.\``)
    .join("");
}

/** Events from before this MCP process started are not repeated in its tool results. */
let eventsSeen = Date.now();

/** One footer line per Script Authorization answer, crash, dialog press or automatic attach a watcher logged since the last call, then "". */
export function watchEvents(dir = WATCH_DIR): string {
  const { lines, last } = eventLines(dir, eventsSeen);
  eventsSeen = Math.max(eventsSeen, last);
  return lines.map((l) => `\n\`Watchdog: ${l}\``).join("");
}

/** The auth, crash, dialog, watch and settings lines in events.jsonl (its last 256 KB) with a time after `since`, and the newest time among them. */
export function eventLines(dir: string, since: number): { lines: string[]; last: number } {
  let text = "";
  try {
    const file = join(dir, "events.jsonl");
    const size = statSync(file).size;
    const fd = openSync(file, "r");
    try {
      const len = Math.min(size, 262_144);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      text = buf.toString("utf-8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return { lines: [], last: since };
  }
  const lines: string[] = [];
  let last = since;
  for (const raw of text.split("\n")) {
    try {
      const e = JSON.parse(raw) as { t: number; kind?: string; action?: string };
      if (e.kind && ["auth", "crash", "dialog", "watch", "settings"].includes(e.kind) && e.action && e.t > since) {
        lines.push(e.action);
        last = Math.max(last, e.t);
      }
    } catch {
      // a partial first line of the tail, or a line that is not JSON
    }
  }
  return { lines, last };
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
    case "timeout": {
      const watch = await client.watchNote();
      return (
        `Cannot ${action}: Workbench did not answer within 3 s, most likely because a dialog is open in it.` +
        (watch ? `\n${watch}\n` : " ") +
        "If the dialog is still open and no watcher answers it, ask the user to check Workbench and answer it."
      );
    }
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
