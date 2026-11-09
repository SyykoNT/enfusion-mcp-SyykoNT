# enfusion-mcp-SyykoNT

A maintained MCP server for Arma Reforger modding, tested on 1.9.

It gives an AI agent working access to the Arma Reforger script API, the game's packed data, Workbench and
the dedicated server. It speaks the Model Context Protocol over stdio, so it is not tied to one assistant: any
agent or client that can launch an MCP server can use it.

- **Maintained.** Changes land on the `syyko/dev` branch after review and a full test run.
- **Tested on 1.9.** Tested against Arma Reforger and Arma Reforger Tools 1.9.0.37 (stable); see the 0.15.0 release notes for known issues.
- **For new and experienced modders.** If you build mods by describing them to an AI agent, the agent works
  from the real 1.9 API and the game's own files instead of guessing. If you write Enforce Script yourself,
  the repetitive Workbench steps become single tool calls.
- **Built on enfusion-mcp-BK.** This is a direct fork of steffenbk's enfusion-mcp-BK, improved and
  optimized for 1.8, with the focus on stability: every tool call that worked under BK in real modding
  sessions, and every later addition, was re-tested on 1.8, and the failures found were fixed or documented.
  Version 0.15.0 was re-tested on 1.9.0.37; the
  [0.15.0 release notes](https://github.com/SyykoNT/enfusion-mcp-SyykoNT/releases/tag/v0.15.0)
  list what that re-test covered.
- **COALITION tools are optional.** One separate part of this README covers tools for missions built on COALITION's framework. If you make missions for other communities or servers you can skip it: [COALITION missions](#coalition-missions-optional).

## Contents

- [What it replaces in a manual workflow](#what-it-replaces-in-a-manual-workflow)
- [Lineage](#lineage)
- [What this fork changed](#what-this-fork-changed)
- [Requirements](#requirements)
- [Installation](#installation)
- [Connecting a client](#connecting-a-client)
- [Configuration](#configuration)
- [Tool reference](#tool-reference)
- [COALITION missions (optional)](#coalition-missions-optional)
- [Safety notes](#safety-notes)
- [Troubleshooting](#troubleshooting)
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
| Look up an API class or method | Browse the Doxygen HTML | `api_search` on an index built from the 1.9 script API docs, inherited methods included |
| Run a dedicated server with your addon | Write `server.json`, build the command line | `server config` validates against the game's own `backend/DSConfigSchema.json`; `server start` loads your packed addons |
| Join that server | Start the client with matching addons and flags | `game launch` with `connect` |
| Place and edit entities in a world | World Editor, by hand | `wb_entity_*`, `wb_layers`, `wb_component` through Workbench's NET API |
| See what a prefab or config really contains across your mods | Load the stack in Workbench, or unpack every mod and compare by hand | `resource_resolve` merges the inheritance chain and every same-path override from the base game, the Workshop cache and your projects, and names the addon and file behind each value |
| Notice that Workbench is stuck | Switch to Workbench and look for a dialog | `wb_watch` reports a blocking dialog, a hang, an unfinished script reload or a crash, in its own status and in the footer of every live tool |

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
- New tools: `resource_resolve`, `wb_watch`, `addon_git_guard`, `addon_deps`, `release_audit`,
  `script_errors`, `log_watch`, `wb_handlers` and `mission_server`; plus a set of COALITION CRF mission
  tools, off by default and read-only except `mission_git fetch`, which updates git's remote refs, described under
  [COALITION missions](#coalition-missions-optional).

Run the test suite with `npx vitest run`.

## Requirements

| Requirement | Notes |
|---|---|
| Windows | The server drives Workbench, the game and the dedicated server, which are Windows executables. Tested on Windows 11. |
| Node.js 20 or later | Tested with Node.js 24.22.1 and npm 11.19.1. |
| Arma Reforger (Steam) | Read for game data, and launched for tests. 1.9 stable. |
| Arma Reforger Tools (Steam) | Workbench (`ArmaReforgerWorkbenchSteamDiag.exe`) compiles, packs and runs the `wb_*` tools. 1.9 stable. |
| Arma Reforger Server (optional) | The Steam install is used when present; update it from Steam (`server install` and `update` refuse a folder under `steamapps\common`). To install it with SteamCMD instead, set `ENFUSION_SERVER_PATH` to a folder of its own. |
| Workbench NET API (for `wb_*` tools) | Enable it in Workbench: File > Options > General > Net API. |

## Installation

The package is not published to npm under this name. Build it from source:

```bash
git clone -b syyko/dev https://github.com/SyykoNT/enfusion-mcp-SyykoNT.git
cd enfusion-mcp-SyykoNT
npm ci
node scripts/build-info.mjs && npx tsc -p tsconfig.build.json
```

`npm ci` also builds once, through the `prepare` script, without the build stamp. Run the build command above again after every pull; it writes `dist/build-info.json`, so the server reports `<version>+<commit>` and `env_check` shows the build.
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
never into Workshop downloads there (folders with `ServerData.json`) or into the game's Workshop cache. This
works only when that folder is a real folder: where it is a link to the game's Workshop cache (the COALITION guide
sets one up), writes there are refused (see [COALITION missions](#coalition-missions-optional)).

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
| `ENFUSION_GITHUB_OWNERS` | `githubOwners` | None. GitHub users or orgs (comma-separated) whose repos `addon_git_guard install` treats as yours; a repo with any other `origin` needs `sharedRepoOk` |
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
| `ENFUSION_TEXT_STYLE` | | Unset. `strict` turns on the text style checks: `release_audit` T2 (en or em dashes, the words Claude or Anthropic in public text) and `workshop_info` (the same, plus non-ASCII characters and trailing spaces in Workshop text). Length limits are always checked |
| `ENFUSION_LOG_ROOTS` | `logRoots` | None. Extra folders `log_watch` may read logs under (comma-separated), besides the server profile, client profiles, Workbench and game log folders |
| `ENFUSION_COALITION_TOOLS` | `coalitionTools` | Off. `on`, `1` or `true` (any case; `true` in the config file) registers the nine COALITION mission-making tools, see [COALITION missions](#coalition-missions-optional). Unset or any other value leaves them off |
| `ENFUSION_SCRIPT_AUTH` | `scriptAuth` | `rules`. How the watchdog answers Workbench's "Script Authorization Required" dialog, in any Workbench the server watches. `rules`: Yes for a script call from an addon that Workbench loaded, No for a script that is in none of them; a request to run a program (`Workbench.RunCmd`, `Workbench.RunProcess`) and a dialog it cannot read are left open and reported, for the agent to answer with `wb_watch answer`. `all`: Yes to All on every request, program runs included; set it only if you trust every addon you load. `off`: report only. Any other value is read as `rules` and logged once. The server never uses `-scriptAuthorizeAll` |
| `ENFUSION_CRASH_LOGS_DIR` | `crashLogsDir` | `Workbench Crash Logs` beside the Workbench profile folder (for the default profile, `Documents\My Games\Workbench Crash Logs`). When a Workbench the server watches crashes, that run's crash and log files are copied here, because a new Workbench start removes the older log folders; then that Workbench's own CrashReporter is ended without sending a report, only when the Workbench's start time is known (otherwise it is left running and the report says so). A setting inside the game, Tools or Workshop folders or an `ENFUSION_FORBIDDEN_DIRS` folder, or one that cannot be read, is refused: the default folder is used (none, if that is refused too) and `env_check` says why |
| `ENFUSION_WB_AUTOWATCH` | `autoWatch` | On. Any live call attaches a watcher by itself to the Workbench on the NET API port of this PC, whoever started it. `off`, `0`, `false` or `no` (any case) turns that off; `on`, `1`, `true` and `yes` keep it on. Any other value is off, with one warning in the log |
| `ENFUSION_MCP_DEBUG` | | Any value turns on debug logging (stderr) |

The COALITION tools also read `ENFUSION_PYTHON`; see [COALITION missions](#coalition-missions-optional).

## Tool reference

The tools, guided prompts and resource templates, by area. The tools for COALITION missions are listed separately under [COALITION missions](#coalition-missions-optional).

### Knowledge (offline)
| Tool | Purpose |
|---|---|
| `api_search` | Classes, methods and enums of the 1.9 script API, with inherited methods |
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

### Build and test
| Tool | Purpose |
|---|---|
| `mod` | `create`, `validate`, `compile`, `pack`, `build` (headless Workbench for compile and pack) |
| `server` | Dedicated server: `install`, `update`, `config`, `validate`, `start`, `stop`, `status`, `logs`, `scenarios` |
| `server_config` | Generate a `server.json` |
| `game` | Game client: `launch` (addons, connect, world), `stop`, `status`, `logs` |
| `env_check` | Check the setup and say what to set for anything missing; game and server versions are read from their exe files, and the crash logs folder in use is shown |
| `addon_git_guard` | Local git commit guard for addon repos: `status`, `check` (both read-only) and `install` |
| `addon_deps` | Read-only dependency check before publishing: each dependency's version and source, references into it, and findings such as undeclared, missing, unused or redundant dependencies, cycles and game version drift; plus the load order |
| `script_errors` | Script runtime errors from Workbench, game client or dedicated server logs, grouped with counts, first and last time and the addon that owns the top frame. Compile errors stay with `mod compile` |
| `log_watch` | Wait for patterns in a server, client or Workbench log (`wait`), or scan one (`scan`); read-only, returns a cursor to resume from |
| `release_audit` | Read-only release report for one addon before a commit, test pack or publish: handler files, git state and commit messages, `.gproj`, meta and `resourceDatabase.rdb` registration, GUIDs shared with dependencies (a warning at another path, info when it overrides the same path), mission config images without a source, leftovers, BOM and public-text rules, size, preview image. Stable finding IDs (U1 marks an unreadable file or a check that failed) and a verdict (blocked, warnings, clean) |
| `mission_server` | Run a mission world from an unpacked addon on a local dedicated server without Workbench, the way Workbench's Dedicated Server Tool does, with optional game clients that join it: `start`, `join`, `status` and `stop` (only its own processes). Each client needs at least 4 GB of free memory, `serverCpuMask` and `clientCpuMask` can keep the server and the clients on separate cores, `start` stops clients that do not join in time, and `join` refuses while an earlier client is hung or not counted by the server |

### Workbench session (NET API)
| Tool | Purpose |
|---|---|
| `wb_launch` | Install the handler scripts into an addon, start Workbench and watch it |
| `wb_connect` / `wb_diagnose` | Test the connection; full diagnostic without launching, watchdog reports included |
| `wb_watch` | Watchdog for Workbench: `status`, `start` (attach to a running Workbench now, or replace the automatic watcher; `authorizeScripts` picks which Workbench gets automatic Script Authorization answers), `stop` (that Workbench run is not watched again automatically), and `answer` (Yes or No on an open Script Authorization dialog, with the reason) |
| `wb_state` | Mode, entity counts, selection, terrain bounds |
| `wb_close` | Save the open world and exit Workbench |
| `wb_cleanup` | Remove the handler scripts from an addon |
| `wb_handlers` | `install`, `remove` and `status` of the server's own `EMCP_*` handler scripts in one addon; the only tool that writes them into a protected addon, such as a framework clone you share with others |
| `wb_play` / `wb_stop` | Enter and leave play mode |
| `wb_save` | Save the world, optionally to a new path |
| `wb_undo_redo` | Undo or redo in the World Editor |
| `wb_open_resource` | Open a resource in its Workbench editor |
| `wb_execute_action` | Run a Workbench menu action by path |
| `wb_reload` | Reload game scripts with Workbench's built-in `ReloadScripts` call, plugins through one menu action (see Known limitations) |
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
| `wb_layers` | List layers, create top-level layers, set and read the active layer, show layer info and toggle a layer's lock |
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

## COALITION missions (optional)

> **Only for COALITION missions.** The tools in this part are for missions built on COALITION's framework (CRF) and COALITION-Lobby. If you make missions for other communities or servers, you can skip this whole part: it does not change how any other tool works, and these tools stay off unless you turn them on.
>
> The COALITION mission-making tools are off by default. To make missions for the COALITION community, ask your agent to enable COALITION mission making. It sets `ENFUSION_COALITION_TOOLS` to `on` in this server's MCP config, and the tools below appear after the server restarts.
>
> Once they are on, `server_params` prints COALITION's settings, including `-addons "COALITIONFramework"`, if it is called. For a mission of your own, use `mission_server` (in [Build and test](#build-and-test)).

Set up your local repo of CRF via GitHub according to the Coalition Mission Making Guide found here:
https://www.coalitiongroup.net/mission-making-guide

Then run `coalition_doctor` to check your setup against the guide.

All tools in this part only read, except `mission_git` with `fetch: true`, which writes git refs in the CRF clone.

### Tools

| Tool | Purpose |
|---|---|
| `coalition_doctor` | Checks this PC against the guide's Tools Setup, each row with its state and the guide's fix: Arma Reforger Tools and Server, Git with its user name and commit email, GitHub Desktop signed in, the server mods downloaded in the game, the Workbench mods link and its check, the Projects folder, the CRF clone, its release branch and your mission branch, updating from release, opening the framework project, the `enfusion://` protocol; plus this server's own setup (Python 3.11+, COALITION-Lobby, `ENFUSION_PROJECT_PATH`, `ENFUSION_PROTECTED_ADDONS`, handler files git-ignored). Writes nothing and never fetches |
| `mission_inspect` | Per-side readiness report for a mission world from its saved layers: slots, spawn points, safestart and forward-deploy zones, markers, MSPs, vehicle spawners and depots; entity names the mission's components refer to, checked against the world with near-miss suggestions; Task Creator entries; and rule checks from the guide |
| `mission_validate` | Runs CRF's own mission checks (`validate_mission.py`, `mission_synopsis.py`, `validate_resources.py`) on one mission world or on the worlds a branch changes, with the Lobby clone from `lobbyPath` or beside CRF; returns failures, warnings, the pull request title and check ticks CI would set, and the synopsis |
| `gearscript_inspect` | What each role in a gearscript spawns with, by the rules of COALITION-Lobby's gear manager: weapons, magazines, clothing, items and radios; lists what the gear manager skips, and with `usedBy` which missions use the gearscript |
| `mission_names` | The guide's five mission names (branch, world file, mission `.conf`, in-game name, pull request title): `build` makes them, `check` compares a world, its `.conf` and the CRF branch with the rules |
| `server_params` | The settings for Workbench's Dedicated Server Tool as the guide fills them, with your real folders: the Params line, the mission header `.conf` for a world, and the Diag server and client executables |
| `mission_git` | Branch and change report for a mission branch: the branch (warns unless `mission/<name>`), commits ahead and behind `origin/release` as of the last fetch, changed files by kind, and warnings for handler files, files outside the mission folders, a world without a `.conf` or the reverse, and new resources without a `.meta` |
| `mission_pr_draft` | Drafts the hand-filled parts of CRF's mission pull request template from the mission files: a side, faction and role line per slotted side, assets per side, objectives, a testing note from the newest Workbench log, and mods added to `addon.gproj`; lists what it could not fill. Returns text only |
| `mission_preflight` | One go or no-go before you push a mission branch: runs `mission_git`, `mission_names check`, `mission_validate`, the `mission_inspect` rules and the newest Workbench log, then prints the guide's Before You Submit and pull request checklists with each row marked pass, FAIL, warn, not run, in game or you |

### Where the tools find CRF and COALITION-Lobby

| Copy | Looked for, in this order |
|---|---|
| CRF | the `crfPath` argument; a clone in the project path (`ENFUSION_DEFAULT_MOD` first); the guide's folder, `Documents\My Games\ArmaReforgerWorkbench\Projects\Coalition-Reforger-Framework`; the Workshop download |
| COALITION-Lobby | the `lobbyPath` argument; a `COALITION-Lobby` clone beside CRF; the Workshop download |

- A clone always wins over the Workshop download. A CRF clone is a folder that holds
  `Tools/Validation/validate_mission.py`. `crfPath` and `lobbyPath` must be inside the project path or the
  guide's `Projects` folder.
- The Workshop downloads are read from `ENFUSION_WORKSHOP_PATH`. Set it if your game profile is not in the
  default place. Documents is taken from the Windows shell folder, so a Documents folder on OneDrive or moved
  elsewhere is found.
- `mission_inspect` and `gearscript_inspect` take `source`: `clone` reads only clones, `workshop` only the
  Workshop downloads (what servers run). `source: "workshop"` refuses `crfPath` and `lobbyPath`, since those
  name clones. Each reply of these two tools and of `mission_names` names the copies it read, for example
  `CRF: clone <branch> <hash>` or `Lobby: Workshop <version>`.
- Without a CRF or Lobby copy, these tools answer in words that name what is missing, and show no stack
  trace.

### What each tool needs

| Tool | Needs |
|---|---|
| `mission_inspect`, `gearscript_inspect`, `mission_names` | CRF and COALITION-Lobby as clones or Workshop downloads. `mission_names check` compares the CRF branch only for a clone |
| `mission_validate` | A CRF clone with a COALITION-Lobby clone beside it, and Python 3.11 or later. CRF's checks are Python scripts that only a clone has, and they read the Lobby folder: `mission_synopsis.py` stops without it, and the other two skip the Lobby's checks. With only a Workshop copy it says why and runs nothing |
| `mission_git` | A CRF clone: it reads the branch with git |
| `mission_pr_draft` | A CRF clone to find the changed world and the added mods. Given `world`, it drafts the rest from clones or Workshop downloads and lists the mods part as not filled |
| `mission_preflight` | Clones or Workshop downloads. Each step it cannot run, such as `mission_git` without a CRF clone or `mission_validate` without both clones, is marked not run with the reason |
| `coalition_doctor` | Nothing: it reports what it finds, and what is missing |
| `server_params` | No CRF or Lobby copy; `projectsFolder` and `modsFolder` override the guide's folders |

Python is needed only for `mission_validate` (and `coalition_doctor` reports whether you have it). Set `ENFUSION_PYTHON` to the `python.exe` to use; otherwise the server tries `py -3`, then `python`, then `python3`, and takes the first that is 3.11 or later.

### The Workbench addons link

The guide links `Documents\My Games\ArmaReforgerWorkbench\addons` to the game's Workshop cache. With
`ENFUSION_PROJECT_PATH` unset that folder is the default project path, and because it resolves into the Workshop
cache, tools refuse to write there. `wb_launch` without `gprojPath`, for example, answers:

> Refused: ...\Documents\My Games\ArmaReforgerWorkbench\addons\EnfusionMCP is inside ...\Documents\My
> Games\ArmaReforger\addons (game or Tools install, Workshop cache, or ENFUSION_FORBIDDEN_DIRS); wb_launch would
> copy handler scripts into it. Pass the .gproj of an addon of your own.

Where the junction cannot be made (Documents on OneDrive), mods copied into that folder by hand are Workshop
downloads (they hold `ServerData.json`), and writes into them are refused as well. The tools in this part
only read (apart from those git refs), so they are not affected. To write, name an addon of your own with `gprojPath` or `projectPath`.

### Safety notes for these tools

- `mission_validate`, and `mission_preflight` through it, run the Python scripts of the CRF clone in place
  (`python -I -B -X utf8`). They write nothing, but they execute that clone's code.
- `mission_git` with `fetch: true` runs `git fetch origin release` in the CRF clone, which writes refs. Without
  it, and in `mission_pr_draft` and `mission_preflight`, nothing is fetched, committed, pushed or posted.

## Safety notes

- `wb_launch` copies the server's handler scripts into the addon it opens, under
  `Scripts/WorkbenchGame/EnfusionMCP/`. In a git repo it first adds that folder to the repo's local
  `.git/info/exclude`, and refuses if handler files are already committed. `mod pack` and `mod build` refuse
  while they are present (`allowHandlers=true` for a local test pack). Run `wb_cleanup` before you publish, and
  keep that folder out of version control. `addon_git_guard install` adds local pre-commit and commit-msg hooks
  (`hooks` picks which; the commit-msg hook strips AI tool attribution lines); the pre-commit hook refuses commits of those files, their folder `.meta`,
  `resourceDatabase.rdb`, and `.c` files that start with a UTF-8 BOM.
- `wb_launch` refuses a `gprojPath` in the game or Tools install, in the game's Workshop cache or in a Workshop
  download (a folder with `ServerData.json`). Without `gprojPath` it falls back to `ENFUSION_DEFAULT_MOD` or the
  first addon in the project path, skipping those and `ENFUSION_PROTECTED_ADDONS`.
- `wb_launch` opens a protected addon (`ENFUSION_PROTECTED_ADDONS`) only when its handlers are already in place, and
  never writes into it; `wb_cleanup` keeps them.
- `wb_handlers` is the one way to put the handlers into a protected addon. It writes only the `EMCP_*` files and
  the local `.git/info/exclude` line, and `remove` deletes only `EMCP_*` files. It refuses an addon whose handler
  files are committed, one inside an install, a Workshop cache or `ENFUSION_FORBIDDEN_DIRS`, and a protected git
  repo when git is not on `PATH`. Only run it on a protected addon when its owner agrees. Workbench registers
  handlers at start, so restart it after an install.
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
  `layout_recipe`, `menu_create`, `game_duplicate`, `config_override`, `economy`, `gamemode_scaffold`,
  `building_setup`, `scenario_create_conflict`, `animation_graph` (`author`, `setup`) and `wb_entity_duplicate`.
  `server_config` takes its target from `projectPath` only (its `modName` is the addon ID to load), and
  `project write` from the addon that holds the file. They refuse the game and Tools installs, the game's
  Workshop cache, Workshop downloads (folders with `ServerData.json`), `ENFUSION_FORBIDDEN_DIRS`, the projects
  folder itself, folders without a `.gproj` and the addons in `ENFUSION_PROTECTED_ADDONS`. Without a valid target
  they write nothing.
- `server config` and `server start` replace only the server's own `<serverProfilePath>/server.json`; any other
  `configPath` must be a new file. A server started with local addons binds `127.0.0.1`. The generated
  `server.json` binds `0.0.0.0`.
- `wb_launch` starts a watcher for each Workbench it starts. Any live call also attaches one by itself to the
  Workbench that owns the NET API port on this PC, whoever started it, including one started by hand or by a
  launcher script; `ENFUSION_WB_AUTOWATCH=off` turns that off, and `wb_watch start` attaches one on request.
  A watcher never closes, kills or focuses a Workbench this server did not start. Its automatic actions
  are: Ignore on the diag build's "Resources are leaking!" assert (`dismissLeakAssert=never` turns it off); answers
  to "Script Authorization Required" by `ENFUSION_SCRIPT_AUTH` (`authorizeScripts=never` turns it off for one watch),
  by pressing Yes, No or, in `all` mode, Yes to All with UI Automation, never `No to All` and never
  `-scriptAuthorizeAll`; and, after a crash of a Workbench it watches, copying that run's log files to
  `ENFUSION_CRASH_LOGS_DIR` and ending that Workbench's own CrashReporter without sending a report (only when the Workbench's start time is known; otherwise it is left running and the report says so). Every action is
  reported. After an answer in a Workbench that loaded CRF or COALITION-Lobby, the report adds the `git status` and
  the diff stat of the gear list in those clones; nothing is restored.
- `addon_git_guard install` writes only into the `.git/hooks` folder of one named addon under the project path
  or `ENFUSION_ADDONS_DIR`. It refuses protected addons, installs, the game's Workshop cache and Workshop
  downloads, a repo with `core.hooksPath` set, an existing pre-commit hook it did not write, and a repo whose
  `origin` is not under a GitHub owner listed in `ENFUSION_GITHUB_OWNERS` unless `sharedRepoOk=true`. A repo with no `origin` installs.
- Workbench's NET API listens on all network interfaces (`0.0.0.0:5775`). Block inbound TCP 5775 in the
  Windows firewall unless you need remote access.
- The server does not publish to the Workshop. Publishing stays a manual step in Workbench.

## Troubleshooting

| Problem | What to do |
|---|---|
| Workbench stops on a "Script Authorization Required" dialog | Run `wb_watch status`. In the default mode the watcher answers Yes to a script from a loaded addon on its own. A request to run a program is left open and shown with the script, the line and the command read from the script's source: answer it with `wb_watch answer` (`yes` or `no`, with a reason) or in Workbench. Set `ENFUSION_SCRIPT_AUTH=all` to press Yes to All on every request, or `off` to answer only by hand. The watcher acts on any Workbench it watches: one this server started, or one it attached to by itself or through `wb_watch start` (`ENFUSION_WB_AUTOWATCH=off` stops the automatic attach) |
| Where crash logs go | When a Workbench the server watches crashes, that run's `crash.log`, any `.mdmp` dump, `console.log`, `error.log` and `script.log` are copied to the folder in `ENFUSION_CRASH_LOGS_DIR` (default: `Workbench Crash Logs` beside the Workbench profile folder; a setting inside the game, Tools or Workshop folders or an `ENFUSION_FORBIDDEN_DIRS` folder, or one that cannot be read, is refused and the default is used; if the default is refused too, no copy is made and `env_check` says so), into a subfolder named `<date>_<time>_<PID>`. The originals stay where they are. Workbench removes older log folders when it starts again, so use the copy |

## Known limitations

- `wb_reload` sends Workbench's built-in `ReloadScripts` call. Its Ok does not prove the scripts were recompiled: look for a
  new "Reloading game scripts took" line in Workbench's `console.log`. On the diag build (tested on 1.9.0.37) each reload raised the "Resources are leaking!"
  assert, which waits for Ignore; an attached `wb_watch` presses it. The plugin reload (`target` `plugins` or `both`) tries
  one Workbench menu action; on 1.9.0.37 it returned false, so the tool says "not confirmed". Saving a `.c`
  file of the loaded project also makes Workbench reload game scripts. `mod compile` refuses while a Workbench is open
  (`force=true` runs it anyway).
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
- `wb_launch` with `worldPath` (a `.ent` of the opened project) adds `-wbModule=WorldEditor -run -load` and waits up to 300 s; it does not check that the world loaded (use `wb_state`), and a running Workbench does not switch worlds.
- `economy set` for ranks changes every faction's rank file that contains the rank.
- `resource_resolve` assumes dependencies load depth first in `Dependencies` order; the engine's real order
  among sibling dependencies is not verified yet.
- When the project path is Workbench's `addons` folder (the default), Workshop downloads
  in it are read as loose projects, so `resource_resolve`, `addon_deps`, `release_audit` and `game_read` cannot
  read the contents of their `.pak` files.

## Development

```bash
npm run dev             # run the server from source (tsx)
npm test                # vitest
node scripts/build-info.mjs && npx tsc -p tsconfig.build.json   # compile to dist/ with the build stamp
npm run scrape          # rebuild data/api from the local Workbench docs (scrape:remote uses the BI website)
npm run check:recipes   # check prefab recipes against the installed game
npm run tuning-server   # local web UI for vehicle tuning (port 5790)
```

### Vehicle tuning server

`npm run tuning-server` serves a page at `http://127.0.0.1:5790` for the wheeled vehicles under
`Prefabs/Vehicles` in one addon (`ENFUSION_PROJECT_PATH` plus `ENFUSION_TUNING_ADDON`). It is built for the
Reforger 1.9 vehicle data.

- **Reads:** the engine, the tyre model (`Pacejka2002` or `Pacejka94`), each axle's Tyre, Steering, Suspension,
  Wheel and Swaybar, and the differentials. Each value shows whether it is set in the vehicle's own `.et`,
  inherited (from a parent prefab, the vanilla original of the same file, or a `.conf`) or a template default.
  Vanilla data comes from `ENFUSION_EXTRACTED_PATH` when it is set, otherwise from the installed game's paks.
- **Draws:** Pacejka 2002 curves from the published Magic Formula (MF 5.2) and the Pacejka '94 curves, using the
  prefab's coefficients. How the game itself evaluates them is not verified.
- **Writes:** only inline overrides in the vehicle's own `.et`, never a `.conf`. Axles are matched by their ID
  and differentials by name. A value goes only into a block that already exists in that `.et`; if the block is
  missing, nothing is written and the page says to add the override in Workbench first. Text fields such as a
  differential's `Type` are shown, not written. Close the prefab in Workbench before you apply.
- With writing on, the server does not start for an addon the other writing tools refuse (one in the game or Tools install,
  a Workshop cache or download, `ENFUSION_FORBIDDEN_DIRS` or `ENFUSION_PROTECTED_ADDONS`, the projects folder itself, or a
  folder without a `.gproj`) and says why; point `ENFUSION_TUNING_ADDON` at your own addon.
  `ENFUSION_TUNING_READONLY=1` turns writing off and starts anyway. The server listens on 127.0.0.1 only and refuses requests whose
  Host or Origin is not its own address.

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

`env_check` shows the exact version and build. Everything described here is merged on `syyko/dev`. Checks that need a running
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
