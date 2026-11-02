# enfusion-mcp-SyykoNT

A maintained MCP server for Arma Reforger modding, ready for 1.8.

It gives an AI agent working access to the Arma Reforger script API, the game's packed data, Workbench and
the dedicated server. It speaks the Model Context Protocol over stdio, so it is not tied to one assistant: any
agent or client that can launch an MCP server can use it.

- **Maintained.** Changes land on the `syyko/dev` branch after review and a full test run.
- **Ready for 1.8.** Tested against Arma Reforger and Arma Reforger Tools 1.8.0.13 (stable).
- **For new and experienced modders.** If you build mods by describing them to an AI agent, the agent works
  from the real 1.8 API and the game's own files instead of guessing. If you write Enforce Script yourself,
  the repetitive Workbench steps become single tool calls.
- **Built on enfusion-mcp-BK.** This is a direct fork of steffenbk's enfusion-mcp-BK, improved and
  optimized for 1.8, with the focus on stability: every tool call that worked under BK in real modding
  sessions, and every later addition, was re-tested on 1.8, and the failures found were fixed or documented.

## Contents

- [What it replaces in a manual workflow](#what-it-replaces-in-a-manual-workflow)
- [Lineage](#lineage)
- [What this fork changed](#what-this-fork-changed)
- [Requirements](#requirements)
- [Installation](#installation)
- [Connecting a client](#connecting-a-client)
- [Configuration](#configuration)
- [Tool reference](#tool-reference)
- [Safety notes](#safety-notes)
- [Known limitations](#known-limitations)
- [Development](#development)
- [Status](#status)
- [Credits and license](#credits-and-license)

## What it replaces in a manual workflow

| Task | By hand | With this server |
|---|---|---|
| Check that scripts compile | Open the addon in Workbench, compile, read the log | `mod compile` runs Workbench headless and returns each error as `file:line` |
| Package an addon for a local test | Pack in Workbench, then find the output | `mod build` compiles, then writes `data.pak`, `.gproj` and `resourceDatabase.rdb` |
| Find a resource GUID | Search the Resource Browser and copy the `{GUID}path` | `asset_search` returns `{GUID}path` from the game's resource database |
| Read a vanilla script, prefab or config | Extract it from a `.pak` or open it in Workbench | `game_browse` and `game_read` read inside the `.pak` archives |
| Override a vanilla config value | "Override in addon", then edit the delta by hand | `config_override` writes the delta and a `.meta` carrying the base file's GUID |
| Change XP rewards, rank thresholds or supply costs | Find each config and override each value | `economy` lists the current values and writes the overrides |
| Look up an API class or method | Browse the Doxygen HTML | `api_search` on an index built from the 1.8 script API docs, inherited methods included |
| Run a dedicated server with your addon | Write `server.json`, build the command line | `server config` validates against the game's own `backend/DSConfigSchema.json`; `server start` loads your packed addons |
| Join that server | Start the client with matching addons and flags | `game launch` with `connect` |
| Place and edit entities in a world | World Editor, by hand | `wb_entity_*`, `wb_layers`, `wb_component` through Workbench's NET API |
| See what a prefab or config really contains across your mods | Load the stack in Workbench, or unpack every mod and compare by hand | `resource_resolve` merges the inheritance chain and every same-path override from the base game, the Workshop cache and your projects, and names the addon and file behind each value |
| Notice that Workbench is stuck | Switch to Workbench and look for a dialog | `wb_watch` reports a blocking dialog, a hang, an unfinished script reload or a crash, in its own status and in the footer of every live tool |
| Run COALITION CRF's mission checks before a pull request | Push and wait for CI | `mission_validate` runs CRF's own check scripts locally and returns failures, warnings and the synopsis |

## Lineage

| Project | Contribution |
|---|---|
| [steffenbk/enfusion-mcp-BK](https://github.com/steffenbk/enfusion-mcp-BK) (steffenbk, Articulated7) | The server itself: API, wiki and knowledge-base search, game data access, file generators, and the Workbench NET API tools with their Enforce handlers. |
| [MyckaelAutier/enfusion-mcp-ma](https://github.com/MyckaelAutier/enfusion-mcp-ma) (MyckaelAutier) | Three code commits on BK `0acfa88`, ported here as one commit credited to MyckaelAutier: the API index rebuilt from the 1.8 docs; recipes, knowledge base and script templates aligned with 1.8; and the `mod` compile and pack, `server`, `game`, `economy`, `config_override`, `env_check` and `wb_close` tools. Its README, npm package and plugin commits were not ported. |
| enfusion-mcp-SyykoNT (this repository) | A direct fork of enfusion-mcp-BK: the ported 1.8 commit, re-testing on 1.8 and the fixes below. |

## What this fork changed

Every tool call that worked under BK in real modding sessions (27) and every enfusion-mcp-ma addition (17) was
re-tested against Workbench 1.8.0.13: 44 checks, 40 pass, 3 partial, 1 not applicable (the npm package and Claude Code plugin,
which this fork does not use). The partial ones are listed under [Known limitations](#known-limitations).
Fixes made in the process:

- `wb_state` reports play mode correctly, so `wb_stop` works again.
- `wb_close` exits Workbench in edit mode, opens no "Save As" dialog when the world has no file, and does not
  save in prefab edit mode.
- Workbench and game logs are found when Documents is redirected to OneDrive, so `mod compile` lists errors,
  `mod pack` reports its result correctly and `game logs` works.
- `server start` with local addons runs the Diag server in `-server` mode, so the game client can join it.
- The server path defaults to the Steam dedicated server when it is installed.
- When a Workbench process exists but its NET API does not answer, the server reports it and does not start a
  second copy.
- `ENFUSION_ADDONS_DIR` passes `-addonsDir` to Workbench on GUI and headless launches, so addons that depend
  on other local projects load.
- `wb_cleanup` reports what it removed and removes only the server's own `EMCP_*` handler files, so other
  scripts in that folder survive.
- Generated overrides of non-void methods return the `super` call, so the scaffold compiles.
- `asset_search` no longer shows an all-zero GUID for scripts.

Added since that test pass:

- One write guard for every file-writing tool, and launch and stop rules that leave other people's Workbench,
  servers and game clients alone (see [Safety notes](#safety-notes)).
- A rewritten Enfusion text parser and writer that keep the original text. `config_override set` and
  `economy set` keep `+` appends, quoting, line endings and the final newline of an existing file. A read-only
  run over 29,863 base-game and addon text files found no token changes; 3 malformed files are refused with a
  line number.
- Paged results for long files: `game_read` by lines, `wiki_read`, `wb_knowledge` and `resource_resolve` in
  parts. `game_read` also reads one addon's own files, and answers `X.meta` from the resource database, since
  packed addons ship no `.meta` files.
- `mod pack` and `mod build` check the addon and the output folder before Workbench starts, and list the
  resulting `data.pak`.
- `server install` and `server update` leave Steam's own server install to Steam.
- New tools: `resource_resolve`, `wb_watch`, `addon_git_guard`, and two read-only tools for COALITION CRF
  missions, `mission_validate` and `gearscript_inspect`.

Test suite: 1005 passed, 13 skipped.

## Requirements

| Requirement | Notes |
|---|---|
| Windows | The server drives Workbench, the game and the dedicated server, which are Windows executables. Tested on Windows 11. |
| Node.js 20 or later | Tested with Node.js 24.22.1 and npm 11.19.1. |
| Arma Reforger (Steam) | Read for game data, and launched for tests. 1.8 stable. |
| Arma Reforger Tools (Steam) | Workbench (`ArmaReforgerWorkbenchSteamDiag.exe`) compiles, packs and runs the `wb_*` tools. 1.8 stable. |
| Arma Reforger Server (optional) | The Steam install is used when present; update it from Steam (`server install` and `update` refuse a folder under `steamapps\common`). To install it with SteamCMD instead, set `ENFUSION_SERVER_PATH` to a folder of its own. |
| Workbench NET API (for `wb_*` tools) | Enable it in Workbench: File > Options > General > Net API. |
| Python 3.11 or later (optional) | Only for `mission_validate`, which runs CRF's Python check scripts. |

## Installation

The package is not published to npm under this name. Build it from source:

```bash
git clone -b syyko/dev https://github.com/SyykoNT/enfusion-mcp-SyykoNT.git
cd enfusion-mcp-SyykoNT
npm ci
npm run build
```

`npm ci` also runs the build once, through the `prepare` script. Run `npm run build` again after every pull.
If your environment sets `NODE_ENV=production`, npm skips dev dependencies and the build fails with
`'tsc' is not recognized`; use `npm ci --include=dev` instead.

The server entry point is `dist/index.js`.

## Connecting a client

The server is a stdio process: the client runs `node` with the path to `dist/index.js`, plus any environment
variables from [Configuration](#configuration). For Claude Code, in a project's `.mcp.json`:

```json
{
  "mcpServers": {
    "enfusion-mcp-SyykoNT": {
      "command": "node",
      "args": ["C:\\path\\to\\enfusion-mcp-SyykoNT\\dist\\index.js"],
      "env": {
        "ENFUSION_PROJECT_PATH": "C:\\path\\to\\your\\addons"
      }
    }
  }
}
```

Other MCP clients use the same command, argument and environment in their own configuration format.

Once connected, ask the agent to run `env_check`. It reports the game, Tools, server and folder paths it
found, and what to set for anything missing.

## Configuration

All settings are optional. Order of precedence: environment variables, then `~/.enfusion-mcp/config.json`,
then `enfusion-mcp.config.json` in the repository root (see `enfusion-mcp.config.example.json`), then the
defaults.

With `ENFUSION_PROJECT_PATH` unset, tools write into addons under `My Games\ArmaReforgerWorkbench\addons`, but
never into Workshop downloads there (folders with `ServerData.json`) or into the game's Workshop cache.

| Environment variable | Config key | Default |
|---|---|---|
| `ENFUSION_WORKBENCH_PATH` | `workbenchPath` | `C:\Program Files (x86)\Steam\steamapps\common\Arma Reforger Tools` |
| `ENFUSION_GAME_PATH` | `gamePath` | The `Arma Reforger` folder next to the Tools folder |
| `ENFUSION_PROJECT_PATH` | `projectPath` | `Documents\My Games\ArmaReforgerWorkbench\addons` (OneDrive Documents detected) |
| `ENFUSION_PACKED_PATH` | `packedPath` | `Documents\My Games\ArmaReforgerWorkbench\packed` |
| `ENFUSION_ADDONS_DIR` | `addonsDir` | None. Passed to Workbench as `-addonsDir` (comma-separated) |
| `ENFUSION_WORKSHOP_PATH` | `workshopPath` | `Documents\My Games\ArmaReforger\addons`, the game's Workshop download cache. Read, never written |
| `ENFUSION_DEFAULT_MOD` | `defaultMod` | None. Set at runtime to the addon `wb_launch` opens |
| `ENFUSION_PROTECTED_ADDONS` | `protectedAddons` | None. Addons no tool writes into, by `.gproj` GUID, ID or folder name (comma-separated) |
| `ENFUSION_SERVER_PATH` | `serverPath` | Steam's `Arma Reforger Server` folder if installed, else `~/.enfusion-mcp/server` |
| `ENFUSION_SERVER_PROFILE` | `serverProfilePath` | `~/.enfusion-mcp/server-profile` |
| `ENFUSION_CLIENT_PROFILES` | `clientProfilesRoot` | `~/.enfusion-mcp/client-profiles`, where `game launch` records the clients it started |
| `ENFUSION_STEAMCMD_PATH` | `steamcmdPath` | `~/.enfusion-mcp/steamcmd` |
| `ENFUSION_WORKBENCH_HOST` | `workbenchHost` | `127.0.0.1` |
| `ENFUSION_WORKBENCH_PORT` | `workbenchPort` | `5775` |
| `ENFUSION_EXTRACTED_PATH` | `extractedPath` | An `extracted` folder next to the addons folder, if one exists |
| `ENFUSION_MCP_DATA_DIR` | `dataDir` | The bundled `data/` folder |
| `ENFUSION_FORBIDDEN_DIRS` | | None. Extra folders no tool writes into (comma-separated). The game and Tools installs, the game's Workshop cache and Workshop downloads (folders with `ServerData.json`) are always refused |
| `ENFUSION_WORKBENCH_PROFILE` | | Workbench profile folder used to find its `logs/`; detected when not set |
| `ENFUSION_WORKBENCH_LOCK` | | None. A shared lock file for Workbench; `mod compile`, `pack` and `build` name its `owner:` line when they refuse because Workbench is open |
| `ENFUSION_PYTHON` | | None. The `python.exe` for `mission_validate`; otherwise `py -3`, then `python`, then `python3`, the first that is 3.11 or later |
| `ENFUSION_MCP_DEBUG` | | Any value turns on debug logging (stderr) |

## Tool reference

65 tools, 3 guided prompts and 3 resource templates.

### Knowledge (offline)
| Tool | Purpose |
|---|---|
| `api_search` | Classes, methods and enums of the 1.8 script API, with inherited methods |
| `component_search` | Script components by category or event handler |
| `wiki_search` / `wiki_read` | Bundled Bohemia wiki pages and tutorials; `wiki_read` takes a title or the page URL and returns long pages in parts |
| `wb_knowledge` | Bundled modding knowledge base; long topics continue with `title` and `offset` |
| `asset_search` | Game assets by name, with `{GUID}path` |
| `game_browse` / `game_read` | Browse and read game files, including inside `.pak` archives; `game_read` pages long files, shows the GUID, and with `addon` reads one Workshop mod or project |
| `resource_resolve` | Effective prefab or config values across an addon's dependency stack, with the source of each value; also `providers`, `diff` and `stack` |
| `workshop_info` | Workshop metadata from an addon's `.gproj` |

### Files and generators (offline)
| Tool | Purpose |
|---|---|
| `project` | Browse, read and write files in a Workbench project |
| `script_create` | Enforce Script files from templates |
| `prefab` | Create a prefab, or inspect a prefab's inheritance chain |
| `config_create` | Faction, mission header, entity catalog and editor placeable configs |
| `layout_create` / `layout_recipe` | UI layouts, from scratch or from recipes taken from game HUDs |
| `menu_create` | A custom menu: script class, layout and menu preset entry |
| `gamemode_scaffold` | A modded `SCR_GameModeCampaign` composed from feature recipes |
| `scenario_create_conflict` | A Conflict scenario: mission header, world stub and layer files |
| `animation_graph` | Author, inspect and set up vehicle animation graphs |
| `building_setup` | Destructible building prefabs from a Blender export manifest |
| `game_duplicate` | Copy a game prefab or config into an addon, inherited components included |
| `config_override` | Override any game config or prefab: `inspect`, `set`, `list` |
| `economy` | XP rewards, rank thresholds, arsenal and loadout costs: `inspect`, `set` |

### Build and test
| Tool | Purpose |
|---|---|
| `mod` | `create`, `validate`, `compile`, `pack`, `build` (headless Workbench for compile and pack) |
| `server` | Dedicated server: `install`, `update`, `config`, `validate`, `start`, `stop`, `status`, `logs`, `scenarios` |
| `server_config` | Generate a `server.json` |
| `game` | Game client: `launch` (addons, connect, world), `stop`, `status`, `logs` |
| `env_check` | Check the setup and say what to set for anything missing |
| `addon_git_guard` | Local git commit guard for addon repos: `status`, `check` (both read-only) and `install` |
| `release_audit` | Read-only release report for one addon before a commit, test pack or publish: handler files, git state and commit messages, `.gproj`, meta and `resourceDatabase.rdb` registration, GUID clashes with dependencies, leftovers, BOM and public-text rules, size, preview image. Stable finding IDs and a verdict (blocked, warnings, clean) |

### COALITION CRF missions (offline, read-only)
Both tools read a CRF clone and its COALITION-Lobby clone, inside the project path.

| Tool | Purpose |
|---|---|
| `mission_validate` | Runs CRF's own mission checks (`validate_mission.py`, `mission_synopsis.py`, `validate_resources.py`) on one mission world or on the worlds a branch changes; returns failures, warnings, the pull request title and check ticks CI would set, and the synopsis |
| `gearscript_inspect` | What each role in a gearscript spawns with, by the rules of COALITION-Lobby's gear manager: weapons, magazines, clothing, items and radios; lists what the gear manager skips, and with `usedBy` which missions use the gearscript |

### Workbench session (NET API)
| Tool | Purpose |
|---|---|
| `wb_launch` | Install the handler scripts into an addon, start Workbench and watch it |
| `wb_connect` / `wb_diagnose` | Test the connection; full diagnostic without launching, watchdog reports included |
| `wb_watch` | Watchdog for Workbench: `status`, `start` (attach to a running Workbench) and `stop` |
| `wb_state` | Mode, entity counts, selection, terrain bounds |
| `wb_close` | Save the open world and exit Workbench |
| `wb_cleanup` | Remove the handler scripts from an addon |
| `wb_play` / `wb_stop` | Enter and leave play mode |
| `wb_save` | Save the world, optionally to a new path |
| `wb_undo_redo` | Undo or redo in the World Editor |
| `wb_open_resource` | Open a resource in its Workbench editor |
| `wb_execute_action` | Run a Workbench menu action by path |
| `wb_reload` | Request a script or plugin reload through menu actions (see Known limitations) |
| `wb_projects` | List, locate or open loaded projects |

### World Editor (NET API)
| Tool | Purpose |
|---|---|
| `wb_entity_create` / `wb_entity_delete` | Create an entity from a prefab; delete one by name |
| `wb_entity_list` / `wb_entity_inspect` | List entities; show one entity's components and properties |
| `wb_entity_modify` | Move, rotate, rename, reparent; get, set and clear properties and array items |
| `wb_entity_select` | Select, deselect, clear or read the selection |
| `wb_entity_duplicate` | Save a scene entity as a new prefab in an addon |
| `wb_component` | Add, remove or list an entity's components |
| `wb_layers` | List, create, delete, rename, activate, show, hide and lock layers |
| `wb_clipboard` | Copy, cut, paste and duplicate entities |
| `wb_terrain` | Terrain height at a point; world bounds |
| `wb_prefabs` | Create templates, save prefabs, look up GUIDs, ancestors and paths |
| `wb_read_props` | Resolved property values of a prefab or config, read through Workbench |
| `scenario_create` | Place Scenario Framework objectives or Conflict bases in the open world |

### Other Workbench editors (NET API)
| Tool | Purpose |
|---|---|
| `wb_resources` | Register resources, rebuild databases, get info, open |
| `wb_script_editor` | Read and edit lines in the Script Editor |
| `wb_localization` | Read and edit localization tables |
| `wb_validate` | Run Workbench's material and texture validators |

### Prompts and resources
| Name | Purpose |
|---|---|
| `create-mod` | Guided workflow from a description to a new mod |
| `modify-mod` | Guided workflow to change an existing mod |
| `server-mod` | Guided workflow for a server-side mod through config overrides |
| `enfusion://class/{className}` | Documentation of one API class |
| `enfusion://pattern/{patternName}` | A mod pattern |
| `enfusion://group/{groupName}` | An API group and its classes |

## Safety notes

- `wb_launch` copies the server's handler scripts into the addon it opens, under
  `Scripts/WorkbenchGame/EnfusionMCP/`. `mod pack` and `mod build` refuse while they are present
  (`allowHandlers=true` for a local test pack). Run `wb_cleanup` before you publish, and keep that folder out of
  version control. `addon_git_guard install` adds local pre-commit and commit-msg hooks (`hooks` picks which);
  the pre-commit hook refuses commits of those files,
  their folder `.meta`, `resourceDatabase.rdb`, and `.c` files that start with a UTF-8 BOM.
- `wb_launch` refuses a `gprojPath` in `ENFUSION_PROTECTED_ADDONS`, in the game or Tools install, in the game's
  Workshop cache or in a Workshop download (a folder with `ServerData.json`). Without `gprojPath` it falls back to `ENFUSION_DEFAULT_MOD` or the first addon in the project
  path, skipping those.
- Only `wb_launch` starts Workbench. `wb_cleanup`, `wb_diagnose` and `wb_knowledge` work without it, and
  `wb_close` reports that it is not running. Every other `wb_*` tool returns an error when Workbench is not
  running. Tools that need edit or play mode read the mode right before they act, and a refusal names the mode
  they saw.
- Workbench started by `wb_launch`, and headless runs (`mod compile`, `mod pack`, `mod build`), report to Steam as
  Arma Reforger Tools (app 1874910).
- `wb_close` closes only a Workbench this server started. `server stop` and `game stop` act only on servers and
  game clients this server started.
- These file-writing tools write only into an addon named with `modName` or `projectPath`, never into
  `ENFUSION_DEFAULT_MOD` by default: `script_create`, `prefab`, `config_create`, `layout_create`,
  `layout_recipe`, `menu_create`, `game_duplicate`, `config_override`, `economy`, `gamemode_scaffold` and
  `building_setup`. `server_config` takes its target from `projectPath` only (its `modName` is the addon ID to
  load). They refuse the game and Tools installs, the game's Workshop cache, Workshop downloads (folders with
  `ServerData.json`), `ENFUSION_FORBIDDEN_DIRS`, the projects folder itself, folders without a `.gproj` and the
  addons in `ENFUSION_PROTECTED_ADDONS`. Without a valid
  target they write nothing.
- `wb_entity_duplicate` still falls back to `ENFUSION_DEFAULT_MOD` or the first addon in the project path. Name
  the target addon.
- `server config` and `server start` replace only the server's own `<serverProfilePath>/server.json`; any other
  `configPath` must be a new file. A server started with local addons binds `127.0.0.1`. The generated
  `server.json` binds `0.0.0.0`.
- `wb_launch` starts a watcher for each Workbench it starts, and `wb_watch start` attaches one to another
  Workbench. A watcher never closes, kills or focuses a Workbench this server did not start. Its only automatic
  click is Ignore on the diag build's "Resources are leaking!" assert, in any Workbench it watches,
  and every click is reported. `wb_watch start` with `dismissLeakAssert=never` turns the click off.
- `mission_validate` runs the Python scripts of the CRF clone in place (`python -I -B -X utf8`). It writes
  nothing, but it executes that clone's code.
- `addon_git_guard install` writes only into the `.git/hooks` folder of one named addon under the project path
  or `ENFUSION_ADDONS_DIR`. It refuses protected addons, installs, the game's Workshop cache and Workshop downloads, a repo with
  `core.hooksPath` set, an existing pre-commit hook it did not write, and a repo whose `origin` is not under
  `github.com/SyykoNT` unless `sharedRepoOk=true`.
- Workbench's NET API listens on all network interfaces (`0.0.0.0:5775`). Block inbound TCP 5775 in the
  Windows firewall unless you need remote access.
- The server does not publish to the Workshop. Publishing stays a manual step in Workbench.

## Known limitations

- `wb_reload` does not reload scripts on 1.8: the menu paths it tries do not exist there. It says so
  ("Reload not confirmed") instead of reporting success. Workbench's built-in NET API call `ReloadScripts` does
  reload, but no tool sends it yet. Saving a `.c` file of the loaded project also makes Workbench reload game
  scripts. `mod compile` refuses while a Workbench is open (`force=true` runs it anyway).
- The console server ignores the close request, so `server stop` kills it after `graceSec` (default 10 seconds).
- `prefab create` from a recipe resolves the parent's components only when `parentPrefab` is given. Without
  it, the parent's components are added a second time.
- Loading a generated config override or recipe prefab inside Workbench has not been tested yet.
- While Workbench shows a modal dialog, NET API calls time out after 10 seconds. The watchdog recognizes
  standard Windows dialog boxes, and other dialogs only by the titles "Opening world" and "Script Authorization
  Required".
- `wb_watch` with `autoRecover` does not act yet: recovery needs a lock file entry naming the session, and no
  tool writes one.
- `wb_launch` with `unattended` passes `-noThrow`, which Bohemia documents as disabling error dialogs. It is
  untested on a GUI Workbench and on Script Authorization prompts.
- `wb_resources register` reports "Registered" even when Workbench returns false (for example, a file that is
  already registered).
- `economy set` for ranks changes every faction's rank file that contains the rank.
- `resource_resolve` assumes dependencies load depth first in `Dependencies` order; the engine's real order
  among sibling dependencies is not verified yet.

## Development

```bash
npm run dev             # run the server from source (tsx)
npm test                # vitest
npm run build           # compile to dist/
npm run scrape          # rebuild data/api from the local Workbench docs (scrape:remote uses the BI website)
npm run check:recipes   # check prefab recipes against the installed game
npm run tuning-server   # local web UI for vehicle engine values (port 5790)
```

```
src/
  tools/        one file per tool or tool family
  workbench/    NET API client and headless Workbench runner
  watchdog/     Workbench watcher process and its signals
  release/      git helpers and commit guard hooks
  pak/          .pak reader, resourceDatabase.rdb reader and the addon stack
  formats/      Enfusion text format parser and override engine
  scraper/      API docs scraper
  templates/    generators for scripts, prefabs, layouts, server.json
  prompts/      guided prompts
  resources/    MCP resources
mod/            Enforce handler scripts installed into Workbench addons
data/           API index, wiki, knowledge base, recipes, patterns
tests/          vitest
```

## Status

Version 0.13.1, 65 tools. Everything described here is merged on `syyko/dev`. Checks that need a running
Workbench are still open for the newest work: loading files written by the new text writer, and the watchdog
against live dialogs.

## Credits and license

- [steffenbk/enfusion-mcp-BK](https://github.com/steffenbk/enfusion-mcp-BK), by steffenbk and Articulated7: the
  original project.
- [MyckaelAutier/enfusion-mcp-ma](https://github.com/MyckaelAutier/enfusion-mcp-ma), by MyckaelAutier: the 1.8
  update and the build, server and economy tools.
- [SyykoNT](https://github.com/SyykoNT): this fork, enfusion-mcp-SyykoNT.

This project is not affiliated with Bohemia Interactive.

MIT License. See [LICENSE](LICENSE).
