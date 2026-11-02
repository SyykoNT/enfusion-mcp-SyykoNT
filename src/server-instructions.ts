import type { Config } from "./config.js";

// Sent as the MCP server `instructions`: the one text clients load at session start (keep under 4,096 chars).
export const SERVER_INSTRUCTIONS = [
  "enfusion-mcp-syykont: Arma Reforger (Enfusion) modding tools. Offline: API, components, wiki snapshot, KB, game data in .pak files, assets. Files: addon scaffolding, scripts, prefabs, configs, layouts, overrides. Live: Enfusion Workbench over its NET API (127.0.0.1:5775). Processes: headless compile/pack, game client, dedicated server.",
  "Before live or process tools: Workbench may be shared with other users or agents. Check with the user (or a lock file the user names) before you launch, close, or edit in Workbench.",
  "wb_close and wb_launch act on the Workbench process, not on one project; never close a Workbench you did not start.",
  "A modal dialog in Workbench makes every live call time out; on a timeout ask the user to check Workbench for an open dialog and answer it.",
  "A timed-out mutation may still run later: check the state before repeating it.",
  "Never type {GUID}paths from memory; get them from asset_search, game_read or the project files.",
  "The wiki is an offline snapshot; for API facts prefer api_search and the local Workbench API docs.",
  "Ask the user before downloads (server install), deletions, or anything published.",
].join("\n");

const COALITION_OFF =
  "COALITION mission-making tools are off. If the user asks to enable them, set ENFUSION_COALITION_TOOLS=on in this server's env in the MCP config and restart the server.";

/** SERVER_INSTRUCTIONS, plus the way to turn the COALITION tools on while they are off (nothing in the tool list says they exist). */
export const serverInstructions = (config: Config) => (config.coalitionTools ? SERVER_INSTRUCTIONS : `${SERVER_INSTRUCTIONS}\n${COALITION_OFF}`);
