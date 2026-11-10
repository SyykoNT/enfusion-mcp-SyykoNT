# Changelog

What changed for users, newest first. Full release notes are on the [releases page](https://github.com/SyykoNT/enfusion-mcp-SyykoNT/releases). What this fork changed since enfusion-mcp-BK is in [docs/SINCE-BK.md](docs/SINCE-BK.md).

## 0.16.0 (2026-11-10)

- Published on npm as `enfusion-mcp-syykont`; run it with `npx -y enfusion-mcp-syykont`.
- Any live call attaches a watcher to the Workbench on the NET API port, however it was started; `ENFUSION_WB_AUTOWATCH=off` restores the 0.15.0 behavior.
- Finished Workbench runs that crashed are copied to the crash logs folder before any Workbench starts and when a watcher attaches.
- After Workbench refuses an open, the state-reading tools refuse until a `.ent` opens, since a state read then crashed Workbench in 3 of 3 recorded runs.
- `.ent` opens refuse a world with unsaved changes; `wb_open_resource` and `wb_projects open` refuse a `.gproj` outright (use `wb_launch gprojPath`).
- Servers and game clients the MCP starts run with `-noThrow` and a process watcher; `server start` waits for the online line (up to 120 s).
- `mission_server` takes one CPU mask per client and `status` filters by `port`; `server config` and `server_config` take `bindAddress`.
- `wb_launch` names the Workbench on the NET API port and refuses a different project there, refuses a GUI start below 4 GB free memory, and refuses two copies of one addon GUID.
- `scenario_create_conflict` writes a header that names the new world and the flags a 1.9 Conflict start needs; the tuning server reads and writes 1.9 vehicle data.
- `game launch` takes a `{GUID}Missions/Name.conf` mission header; `server start` takes `cpuMask`.
- Fixes: `wb_entity_select getSelected`, `wb_execute_action` with no world, false returns from `wb_resources register` and `open`, damaged instance start times.

## 0.15.0 (2026-11-08)

- The watcher answers the "Script Authorization Required" dialog by rule or in `all` mode, and a crashed Workbench's
  log files are copied and its own CrashReporter ended.
- The API index is rebuilt from the Arma Reforger 1.9.0.37 script API docs.
- `wb_prefabs locate` sends the fields the handler expects, refuses the game's data roots and reads the project's
  prefab paths.
- The README and package description say 1.9.

## 0.14.2 (2026-11-02)

- CI runs on Windows and Linux with Node.js 20 and 22, and can be started by hand.
- `mission_git` works on a CRF clone reached through a short path or a link.

## 0.14.1 (2026-11-02)

- A contributing guide for this fork, package metadata and CI that describe it, and BK's leftover working files removed.

## 0.14.0 (2026-11-02)

- The COALITION mission-making tools are off unless `ENFUSION_COALITION_TOOLS` is on.
- The server reports `<version>+<commit>` and `env_check` shows the build.
- `release_audit` git checks fail closed, and one list of AI tool attribution serves `release_audit` and the commit
  hook.
- `ENFUSION_GITHUB_OWNERS` and `ENFUSION_TEXT_STYLE` became settings, and tool text speaks to the user.
- A timed-out call or `wb_launch` wait names the open Workbench dialog.
- `mission_server` starts clients that join (peers), with checks on memory and cores; `scenario_create_conflict`
  builds on the game's own campaign game mode.
