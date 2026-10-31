# enfusion-mcp-syykont

A maintained MCP server for Arma Reforger modding, ready for 1.8.

It gives an AI agent working access to the Arma Reforger script API, the game's packed data, Workbench and
the dedicated server. It speaks the Model Context Protocol over stdio, so it is not tied to one assistant: any
agent or client that can launch an MCP server can use it.

- **Maintained.** Changes land on the `syyko/dev` branch after review and a full test run.
- **Ready for 1.8.** Tested against Arma Reforger and Arma Reforger Tools 1.8.0.13 (stable).
- **For new and experienced modders.** If you build mods by describing them to an AI agent, the agent works
  from the real 1.8 API and the game's own files instead of guessing. If you write Enforce Script yourself,
  the repetitive Workbench steps become single tool calls.
- **Built on enfusion-mcp-BK.** This fork extends steffenbk's enfusion-mcp-BK and has been improved and
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

## Lineage

| Project | Contribution |
|---|---|
| [steffenbk/enfusion-mcp-BK](https://github.com/steffenbk/enfusion-mcp-BK) (steffenbk, Articulated7) | The server itself: API, wiki and knowledge-base search, game data access, file generators, and the Workbench NET API tools with their Enforce handlers. |
| [MyckaelAutier/enfusion-mcp-ma](https://github.com/MyckaelAutier/enfusion-mcp-ma) | Seven commits on BK `0acfa88`: the API index rebuilt from the 1.8 docs; recipes, knowledge base and script templates aligned with 1.8; and the `mod` compile and pack, `server`, `game`, `economy`, `config_override`, `env_check` and `wb_close` tools. |
| enfusion-mcp-syykont (this repository) | Re-testing on 1.8 and the fixes below. |

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

Test suite: 638 passed, 12 skipped.

## Requirements

| Requirement | Notes |
|---|---|
| Windows | The server drives Workbench, the game and the dedicated server, which are Windows executables. Tested on Windows 11. |
| Node.js 20 or later | Tested with Node.js 24.22.1 and npm 11.19.1. |
| Arma Reforger (Steam) | Read for game data, and launched for tests. 1.8 stable. |
| Arma Reforger Tools (Steam) | Workbench (`ArmaReforgerWorkbenchSteamDiag.exe`) compiles, packs and runs the `wb_*` tools. 1.8 stable. |
| Arma Reforger Server (optional) | The Steam install is used when present; `server install` can download it through SteamCMD. |
| Workbench NET API (for `wb_*` tools) | Enable it in Workbench: File > Options > General > Net API. |

## Installation

The package is not published to npm under this name. Build it from source:

```bash
git clone -b syyko/dev https://github.com/SyykoNT/enfusion-mcp-syykont.git
cd enfusion-mcp-syykont
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
    "enfusion-mcp-syykont": {
      "command": "node",
      "args": ["C:\\path\\to\\enfusion-mcp-syykont\\dist\\index.js"],
      "env": {
        "ENFUSION_PROJECT_PATH": "C:\\path\\to\\your\\addons"
      }
    }
  }
}
```

Other MCP clients use the same command, argument and environment in their own configuration format.

Once connected, ask the agent to run `env_check`. It reports the game, Tools, server and folder paths it
found, and what to set for anything missing. `env_check configure` saves paths to `~/.enfusion-mcp/config.json`.

## Configuration

All settings are optional. Order of precedence: environment variables, then `~/.enfusion-mcp/config.json`,
then `enfusion-mcp.config.json` in the repository root (see `enfusion-mcp.config.example.json`), then the
defaults.

| Environment variable | Config key | Default |
|---|---|---|
| `ENFUSION_WORKBENCH_PATH` | `workbenchPath` | `C:\Program Files (x86)\Steam\steamapps\common\Arma Reforger Tools` |
| `ENFUSION_GAME_PATH` | `gamePath` | The `Arma Reforger` folder next to the Tools folder |
| `ENFUSION_PROJECT_PATH` | `projectPath` | `Documents\My Games\ArmaReforgerWorkbench\addons` (OneDrive Documents detected) |
| `ENFUSION_PACKED_PATH` | `packedPath` | `Documents\My Games\ArmaReforgerWorkbench\packed` |
| `ENFUSION_ADDONS_DIR` | `addonsDir` | None. Passed to Workbench as `-addonsDir` (comma-separated) |
| `ENFUSION_DEFAULT_MOD` | `defaultMod` | None. Set at runtime to the addon `wb_launch` opens |
| `ENFUSION_SERVER_PATH` | `serverPath` | Steam's `Arma Reforger Server` folder if installed, else `~/.enfusion-mcp/server` |
| `ENFUSION_SERVER_PROFILE` | `serverProfilePath` | `~/.enfusion-mcp/server-profile` |
| `ENFUSION_STEAMCMD_PATH` | `steamcmdPath` | `~/.enfusion-mcp/steamcmd` |
| `ENFUSION_WORKBENCH_HOST` | `workbenchHost` | `127.0.0.1` |
| `ENFUSION_WORKBENCH_PORT` | `workbenchPort` | `5775` |
| `ENFUSION_EXTRACTED_PATH` | `extractedPath` | An `extracted` folder next to the addons folder, if one exists |
| `ENFUSION_MCP_DATA_DIR` | `dataDir` | The bundled `data/` folder |
| `ENFUSION_WORKBENCH_PROFILE` | | Workbench profile folder used to find its `logs/`; detected when not set |
| `ENFUSION_MCP_DEBUG` | | Any value turns on debug logging (stderr) |

## Tool reference

60 tools, 3 guided prompts and 3 resource templates.

### Knowledge (offline)
| Tool | Purpose |
|---|---|
| `api_search` | Classes, methods and enums of the 1.8 script API, with inherited methods |
| `component_search` | Script components by category or event handler |
| `wiki_search` / `wiki_read` | Bundled Bohemia wiki pages and tutorials |
| `wb_knowledge` | Bundled modding knowledge base |
| `asset_search` | Game assets by name, with `{GUID}path` |
| `game_browse` / `game_read` | Browse and read game files, including inside `.pak` archives |
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
| `env_check` | Check the setup (`check`) or save paths (`configure`) |

### Workbench session (NET API)
| Tool | Purpose |
|---|---|
| `wb_launch` | Install the handler scripts into an addon and start Workbench |
| `wb_connect` / `wb_diagnose` | Test the connection; full diagnostic without launching |
| `wb_state` | Mode, entity counts, selection, terrain bounds |
| `wb_close` | Save the open world and exit Workbench |
| `wb_cleanup` | Remove the handler scripts from an addon |
| `wb_play` / `wb_stop` | Enter and leave play mode |
| `wb_save` | Save the world, optionally to a new path |
| `wb_undo_redo` | Undo or redo in the World Editor |
| `wb_open_resource` | Open a resource in its Workbench editor |
| `wb_execute_action` | Run a Workbench menu action by path |
| `wb_reload` | Request a script or plugin reload (see Known limitations) |
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
  `Scripts/WorkbenchGame/EnfusionMCP/`. `mod pack` warns when they are present. Run `wb_cleanup` before you
  publish, and keep that folder out of version control.
- Most `wb_*` calls start Workbench when it is not running (`wb_connect` and `wb_diagnose` do not).
- When no addon is named, `config_override`, `economy`, `game_duplicate`, `wb_entity_duplicate` and the
  handler install use `ENFUSION_DEFAULT_MOD`, or the first addon in the project path. Name the target addon in
  every write.
- Workbench's NET API listens on all network interfaces (`0.0.0.0:5775`). Block inbound TCP 5775 in the
  Windows firewall unless you need remote access.
- The server does not publish to the Workshop. Publishing stays a manual step in Workbench.

## Known limitations

- `wb_reload` does not reload scripts on 1.8: the menu paths it tries do not exist there. It says so
  ("Reload not confirmed") instead of reporting success. Use `mod compile` to check scripts.
- `server stop` needs `force: true`; the console server ignores the close request.
- `prefab create` from a recipe resolves the parent's components only when `parentPrefab` is given. Without
  it, the parent's components are added a second time.
- Loading a generated config override or recipe prefab inside Workbench has not been tested yet.
- Tools that need edit or play mode refuse while the mode is unknown. Call `wb_state` once at the start of a
  session.
- While Workbench shows a modal dialog, NET API calls time out after 10 seconds.
- `wb_resources register` reports "Registered" even when Workbench returns false (for example, a file that is
  already registered).
- `economy set` for ranks changes every faction's rank file that contains the rank.
- `game_read` returns a whole file in one result, with no paging. Some clients truncate very large results.

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
  pak/          .pak reader and resourceDatabase.rdb reader
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

Version 0.13.1. Under review and not yet merged: refusing writes into protected addons, requiring a named
target addon for writes, and no Workbench auto-launch from read-only tools.

## Credits and license

- [steffenbk/enfusion-mcp-BK](https://github.com/steffenbk/enfusion-mcp-BK), by steffenbk and Articulated7: the
  original project.
- [MyckaelAutier/enfusion-mcp-ma](https://github.com/MyckaelAutier/enfusion-mcp-ma), by MyckaelAutier: the 1.8
  update and the build, server and economy tools.
- [SyykoNT](https://github.com/SyykoNT): this fork.

This project is not affiliated with Bohemia Interactive.

MIT License. See [LICENSE](LICENSE).
