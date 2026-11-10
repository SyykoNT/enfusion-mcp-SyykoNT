# Tool reference

The tools, guided prompts and resource templates, by area. The COALITION mission tools are in [COALITION](COALITION.md).

## Knowledge

Offline: no Workbench needed.

| Tool | Purpose |
|---|---|
| `api_search` | Classes, methods and enums of the 1.9 script API, with inherited methods |
| `component_search` | Script components by category or event handler |
| `wiki_search` / `wiki_read` | Bundled Bohemia wiki pages and tutorials; `wiki_read` takes a title or the page URL and returns long pages in parts |
| `wb_knowledge` | Bundled modding knowledge base; long topics continue with `title` and `offset` |
| `asset_search` | Game assets by name, with `{GUID}path` |
| `game_browse` / `game_read` | Browse and read game files, including inside `.pak` archives; `game_read` pages long files, shows the GUID, and with `addon` reads one Workshop mod or project |
| `resource_resolve` | Effective prefab or config values across an addon's dependency stack, with the source of each value; also `providers`, `diff` and `stack` |

## Files and generators

Offline. Every tool here writes only into an addon named with `modName` or `projectPath` (see [Safety](SAFETY.md)).

| Tool | Purpose |
|---|---|
| `project` | Browse, read and write files in a Workbench project; `write` writes only into the addon that holds the file |
| `script_create` | Enforce Script files from templates |
| `prefab` | Create a prefab, or inspect a prefab's inheritance chain |
| `config_create` | Faction, mission header, entity catalog and editor placeable configs |
| `layout_create` / `layout_recipe` | UI layouts, from scratch or from recipes taken from game HUDs |
| `menu_create` | A custom menu: script class, layout and menu preset entry |
| `gamemode_scaffold` | A modded `SCR_GameModeCampaign` composed from feature recipes |
| `scenario_create_conflict` | A Conflict scenario: mission header (its World names the new world, and it gets its own `.meta`), world stub and layer files, into the addon named by `modName` or `projectPath` |
| `animation_graph` | Author, inspect and set up vehicle animation graphs; `author` and `setup` write only with `modName` or `projectPath` |
| `building_setup` | Destructible building prefabs from a Blender export manifest |
| `game_duplicate` | Copy a game prefab or config into an addon, inherited components included |
| `config_override` | Override any game config or prefab: `inspect`, `set`, `list` |
| `economy` | XP rewards, rank thresholds, arsenal and loadout costs: `inspect`, `set` |

## Build and test

| Tool | Purpose |
|---|---|
| `mod` | `create`, `validate`, `compile`, `pack`, `build` (headless Workbench for compile and pack) |
| `server` | Dedicated server: `install`, `update`, `config`, `validate`, `start`, `stop`, `status`, `logs`, `scenarios`. `start` waits for the online line (up to 120 s) and takes `cpuMask`; `config` takes an optional `bindAddress` |
| `server_config` | Generate a `server.json`; optional `bindAddress` (IPv4, default `0.0.0.0`, `127.0.0.1` for this PC only) |
| `game` | Game client: `launch` (addons, connect, a world `.ent` or a `{GUID}Missions/Name.conf` mission header), `stop`, `status`, `logs`, only for clients this server started |
| `env_check` | Check the setup and say what to set for anything missing; game and server versions are read from their exe files, and the crash logs folder in use is shown |
| `script_errors` | Script runtime errors from Workbench, game client or dedicated server logs, grouped with counts, first and last time and the addon that owns the top frame. Compile errors stay with `mod compile` |
| `log_watch` | Wait for patterns in a server, client or Workbench log (`wait`), or scan one (`scan`); read-only, returns a cursor to resume from |
| `mission_server` | Run a mission world from an unpacked addon on a local dedicated server without Workbench, the way Workbench's Dedicated Server Tool does, with optional game clients that join it: `start`, `join`, `status` and `stop` (only its own processes). Each client needs at least 4 GB of free memory, `serverCpuMask` and `clientCpuMask` (one mask for all clients, or one per client as a comma-separated list; `join` takes its own) keep the server and the clients on separate cores, `status` with `port` lists only that port, `start` stops clients that do not join in time, and `join` refuses while an earlier client is hung or not counted by the server |

Script errors and dialogs in the servers and game clients the MCP starts (`server`, `mission_server`, `game`):
- Every server and game client it starts (`server start`, `mission_server` `start` and `join`, `game launch`) runs with `-noThrow`, which Bohemia documents as disabling error dialogs, so a script exception goes to the log instead of a popup.
- Script error report: the `server` start and status replies, the `mission_server` start, join and status replies (for the server and each client) and the `game` status reply (for each client the MCP started) show how many script exceptions the run logged with the first one in full (reason, class, function and stack), and the start of the run's `crash.log` when it has one.
- Process watcher (Windows): the MCP starts one for every dedicated server, every `mission_server` client and every game client it starts. It ends that one process, and only that one, when a window of class `#32770` titled "Virtual machine exception" (the script exception window) stays open on it, and only after it has checked that the process is the one this MCP session started. Any other dialog is reported and left open, and the watcher never clicks, answers or focuses a window. The `server`, `game` and `mission_server` status replies show what a watcher did.
- Crash folder: when a watcher ends a process it copies that run's `crash.log`, `console.log`, `error.log`, `script.log` and any `.mdmp` dump into a folder named `server_<date>_<time>_<PID>` or `client_<date>_<time>_<PID>` inside the crash logs folder (`ENFUSION_CRASH_LOGS_DIR`, the folder used for Workbench crashes). The status reply names that folder, or says why nothing was copied; the originals stay where they are.

## Release

Read-only checks before a commit, test pack or Workshop publish, plus one hook installer.

| Tool | Purpose |
|---|---|
| `release_audit` | Read-only release report for one addon before a commit, test pack or publish: handler files, git state and commit messages, `.gproj`, meta and `resourceDatabase.rdb` registration, GUIDs shared with dependencies (a warning at another path, info when it overrides the same path), mission config images without a source, leftovers, BOM and public-text rules, size, preview image. Stable finding IDs (U1 marks an unreadable file or a check that failed) and a verdict (blocked, warnings, clean) |
| `addon_deps` | Read-only dependency check before publishing: each dependency's version and source, references into it, and findings such as undeclared, missing, unused or redundant dependencies, cycles and game version drift; plus the load order |
| `addon_git_guard` | Local git commit guard for addon repos: `status`, `check` (both read-only) and `install` |
| `workshop_info` | Workshop metadata from an addon's `.gproj` |

## Workbench session

Through Workbench's NET API. Only `wb_launch` starts Workbench.

| Tool | Purpose |
|---|---|
| `wb_launch` | Install the handler scripts into an addon (replacing missing or stale ones), start Workbench and watch it; names the Workbench that already answers the NET API port and refuses a different project; refuses below 4 GB of free memory (see [Safety notes](SAFETY.md)) |
| `wb_connect` / `wb_diagnose` | Test the connection; full diagnostic without launching, watchdog reports included. When the Workbench that answers holds an addon whose handler scripts are missing or differ from this version's, `wb_connect` says so, whoever started that Workbench; it writes nothing |
| `wb_watch` | Watchdog for Workbench: `status`, `start` (attach to a running Workbench now, or replace the automatic watcher; `authorizeScripts` picks which Workbench gets automatic Script Authorization answers), `stop` (that Workbench run is not watched again automatically), and `answer` (Yes or No on an open Script Authorization dialog, with the reason) |
| `wb_state` | Mode, entity counts, selection, terrain bounds. After Workbench refuses an open, this and the other state-reading tools refuse until a `.ent` opens or Workbench restarts, since a state read then could crash Workbench |
| `wb_close` | Save the open world and exit a Workbench this server started. When the save cannot happen (unnamed, packed or play-mode world, prefab edit mode) it closes without saving, and first refuses a world with unsaved changes unless `force=true`. `save=false` closes without a check. With another Workbench running, a window close of an unsaved world is refused unless `force=true` |
| `wb_cleanup` | Remove the handler scripts from an addon |
| `wb_handlers` | `install`, `remove` and `status` of the server's own `EMCP_*` handler scripts in one addon; the only tool that writes them into a protected addon, such as a framework clone you share with others |
| `wb_play` / `wb_stop` | Enter and leave play mode; `wb_play` refuses a world without a writable file (inside a `.pak`, or in the game, Tools or Workshop folders) and says to play a sub-scene of it in your own test addon. A world with unsaved changes plays without a prompt; a layer made with `wb_layers` and not saved yet is dropped, and the reply says so |
| `wb_save` | Save the world; it refuses an unnamed world, prefab edit mode and a world file in the game, Tools or Workshop folders, and a `path` argument (Save As was not reachable from the script API when tested) |
| `wb_undo_redo` | Undo or redo in the World Editor |
| `wb_open_resource` | Open a resource in its Workbench editor. A `.gproj` is refused before anything is sent (start Workbench on a project with `wb_launch gprojPath`). A world (`.ent`) open is refused when the World Editor title shows unsaved changes (local Workbench on Windows only), and goes ahead with a warning when that cannot be checked; a layer this MCP created with `wb_layers` counts as unsaved until `wb_save` runs |
| `wb_execute_action` | Run a Workbench menu action by path; actions of other modules and the World Editor Plugins menus run with no world open |
| `wb_reload` | Reload game scripts with Workbench's built-in `ReloadScripts` call, plugins through one menu action, Plugins > Reload (see Known limitations) |
| `wb_projects` | List, locate or open loaded projects. `open` refuses a `.gproj` before anything is sent, and a `.ent` while the open world has unsaved changes (local Workbench on Windows only) |

## World Editor

Through the NET API, mostly in edit mode.

| Tool | Purpose |
|---|---|
| `wb_entity_create` / `wb_entity_delete` | Create an entity from a prefab; delete one by name |
| `wb_entity_list` / `wb_entity_inspect` | List entities; show one entity's components and properties |
| `wb_entity_modify` | Move, rotate, rename, reparent; get, set and clear properties and array items |
| `wb_entity_select` | Deselect, clear or read the selection (`getSelected`); `select` only locates the entity (see [Known issues](KNOWN-ISSUES.md#known-issues)) |
| `wb_entity_duplicate` | Save a scene entity as a new prefab in an addon |
| `wb_component` | Add, remove or list an entity's components |
| `wb_layers` | List layers, create top-level layers, set and read the active layer, show layer info and toggle a layer's lock; a new layer counts as unsaved until `wb_save` runs, and `create` refuses a world `wb_save` would refuse |
| `wb_clipboard` | Copy, cut, paste and duplicate entities |
| `wb_terrain` | Terrain height at a point; world bounds |
| `wb_prefabs` | Create templates, save prefabs, look up GUIDs, ancestors and paths |
| `wb_read_props` | Resolved property values of a prefab or config, read through Workbench |
| `scenario_create` | Place Scenario Framework objectives or Conflict bases in the open world |

## Other Workbench editors

| Tool | Purpose |
|---|---|
| `wb_resources` | Register resources, rebuild databases, get info, open. `register` refuses a relative or missing path and a file that already has a `.meta`, before Workbench is called. `open` of a `.ent` or `.gproj` is refused while the open world has unsaved changes |
| `wb_script_editor` | Read and edit lines in the Script Editor |
| `wb_localization` | Read and edit localization tables |
| `wb_validate` | Run Workbench's material and texture validators |

## Prompts and resources

| Name | Purpose |
|---|---|
| `create-mod` | Guided workflow from a description to a new mod |
| `modify-mod` | Guided workflow to change an existing mod |
| `server-mod` | Guided workflow for a server-side mod through config overrides |
| `enfusion://class/{className}` | Documentation of one API class |
| `enfusion://pattern/{patternName}` | A mod pattern |
| `enfusion://group/{groupName}` | An API group and its classes |
