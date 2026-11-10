# enfusion-mcp-SyykoNT

enfusion-mcp-SyykoNT is an MCP (Model Context Protocol) server for Arma Reforger modding on Windows, for modders and mission makers who work with an AI agent. It gives the agent the 1.9 script API, the game's packed data, Workbench, the game client and the dedicated server as 69 tools. It is a maintained fork of [steffenbk/enfusion-mcp-BK](https://github.com/steffenbk/enfusion-mcp-BK), rebuilt for Reforger 1.9.0.37.

**Status:** maintained. Version 0.16.0 was tested on Arma Reforger, Arma Reforger Tools and the dedicated server 1.9.0.37 (stable); what that covered is in the [0.16.0 release notes](https://github.com/SyykoNT/enfusion-mcp-SyykoNT/releases/tag/v0.16.0). Open bugs are listed in [Known issues](docs/KNOWN-ISSUES.md), and changes per version in [CHANGELOG.md](CHANGELOG.md).

## Install

Add the server to your MCP client. For Claude Code, in the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "enfusion-mcp-SyykoNT": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "enfusion-mcp-syykont"],
      "env": { "ENFUSION_PROJECT_PATH": "C:\\path\\to\\your\\addons" }
    }
  }
}
```

Any client that can start a stdio MCP server works the same way. Requires Windows, Node.js 20 or newer, and Arma Reforger plus Arma Reforger Tools from Steam. The `wb_*` tools also need Workbench's NET API turned on (File > Options > General > Net API). It runs with `npx -y enfusion-mcp-syykont`.

To run from source instead, build a clone and point `command` at `node` with `dist\index.js` as the argument:

```bash
git clone https://github.com/SyykoNT/enfusion-mcp-SyykoNT.git
cd enfusion-mcp-SyykoNT
npm ci
node scripts/build-info.mjs && npx tsc -p tsconfig.build.json
```

Re-run the build line after every pull. It writes `dist/build-info.json`, so the server reports `<version>+<commit>`. If `NODE_ENV=production` is set, use `npm ci --include=dev`.

## Quick start

Ask the agent to run `env_check`. It needs no Workbench and writes nothing:

<!-- TODO(fact): replace both outputs below with a run of the 0.16.0 build before publishing -->

```
## Environment
- MCP build: 0.15.0+c070e21, built 2026-11-10T14:44:24.899Z
✅ Game: ...\steamapps\common\Arma Reforger (v1.9.0.37)
✅ Game Diag exe (needed for game launch connect/world)
✅ Workbench: ...\Arma Reforger Tools\Workbench\ArmaReforgerWorkbenchSteamDiag.exe
✅ Dedicated server: ...\steamapps\common\Arma Reforger Server (v1.9.0.37)
❌ SteamCMD: not downloaded (server install does it)
✅ Base-game resource database: 102069 resources with GUIDs

## Running
- Workbench: no · NET API: not reachable (127.0.0.1:5775)
```

Then ask for something 1.9 changed, such as `api_search VehicleWheelEffectComponent`:

```
## VehicleWheelEffectComponent
Source: Arma Reforger API
Group: Vehicles
Inherits from: GameComponent
Direct subclasses: SCR_VehicleDustPerWheel

### Public Methods (16)
- proto external float GetWheelTemperature (int wheelIdx) -- Returns the wheel surface temperature in degrees Celcius. The burnout effect starts at 150 degrees
...
```

That class is new in 1.9 and is missing from BK's index. The first reply tells you what the server can reach; the second shows the agent reading the 1.9 API. (Paths shortened.)

**Why not just use enfusion-mcp-BK?** BK is the base of this fork and its tools are still here. Its bundled script API was scraped in February 2026, while Reforger 1.6 was live, and its last commit (2026-08-05) predates the 1.8 release by eight days. BK starts Workbench on any live call, and on a setup like the COALITION guide's it can copy its scripts into a downloaded Workshop mod. This fork re-tested BK's tools on 1.8.0.13 and 1.9.0.37, fixed what failed, and added the build, server, watchdog and release tools that agents running a long modding session need.

| | enfusion-mcp-BK 0.12.0 | enfusion-mcp-SyykoNT 0.16.0 |
|---|---|---|
| Script API index | Scraped Feb 2026 (1.6 era), 8,693 classes | Rebuilt from the 1.9.0.37 docs, 9,119 classes |
| Tools | 54 | 69, plus 9 optional COALITION tools |
| Starting Workbench | Any `wb_*` call that finds it closed launches it | Only `wb_launch` starts it; it refuses installs, the Workshop cache and Workshop downloads |
| Compile errors | Read them in Workbench | `mod compile` runs Workbench headless and returns `file:line` |
| Blocking dialogs | The call times out after 10 s | The error names the dialog; a watcher answers Script Authorization and the leak assert by rule |
| Crash logs | Lost when the next Workbench start prunes old log folders | Copied to a crash logs folder first |
| File writes | Any absolute path the model passes | One write guard: a named addon only, never the game, Tools, Workshop or protected addons |
| Config overrides | No override tool | `config_override` and `economy` on a lossless parser that keeps `+` appends, quoting and line endings |
| Dedicated server and client | `server_config` writes a `server.json` | Start, join, stop and read logs, only for processes this server started |
| Before you publish | Run `wb_cleanup` by hand | `release_audit`, `addon_deps`, git hooks, and `mod pack` refuses packed handler scripts |
| Bundled prompts | "YOU ARE FULLY AUTONOMOUS" | Ask before closing Workbench, starting servers, downloads or deletes |
| Tests and CI | CI on Ubuntu, Node 20 and 22 | 2,409 tests in 171 files; CI on Windows and Linux, Node 20 and 22 |

The full list of fixes and additions since BK is in [What changed since BK](docs/SINCE-BK.md).

## Usage

| Goal | Tools | Docs |
|---|---|---|
| Look up the API, wiki, knowledge base or game files | `api_search`, `wiki_read`, `wb_knowledge`, `game_read`, `asset_search` | [Tools](docs/TOOLS.md#knowledge) |
| See what a prefab really contains across your mod stack | `resource_resolve` | [Tools](docs/TOOLS.md#knowledge) |
| Scaffold scripts, prefabs, configs, layouts and menus | `script_create`, `prefab`, `config_create`, `layout_recipe`, `menu_create` | [Tools](docs/TOOLS.md#files-and-generators) |
| Override vanilla configs, XP, ranks or supply costs | `config_override`, `economy` | [Tools](docs/TOOLS.md#files-and-generators) |
| Compile and pack without opening Workbench | `mod compile`, `mod pack`, `mod build` | [Tools](docs/TOOLS.md#build-and-test) |
| Run a dedicated server and join it | `server`, `mission_server`, `game` | [Tools](docs/TOOLS.md#build-and-test) |
| Read script errors from any log | `script_errors`, `log_watch` | [Tools](docs/TOOLS.md#build-and-test) |
| Drive Workbench and the World Editor | `wb_launch`, `wb_entity_*`, `wb_layers`, `wb_save`, `wb_close` | [Tools](docs/TOOLS.md#workbench-session) |
| Keep an eye on a running Workbench | `wb_watch` (attaches by itself) | [Safety](docs/SAFETY.md#the-watcher) |
| Check an addon before a commit or Workshop publish | `release_audit`, `addon_deps`, `addon_git_guard`, `workshop_info` | [Tools](docs/TOOLS.md#release) |

Every setting is optional. `ENFUSION_PROJECT_PATH` is the one most setups need; the rest are in [Configuration](docs/CONFIGURATION.md).

## COALITION mission making (off by default)

Nine tools for missions built on the [COALITION](https://www.coalitiongroup.net) Reforger Framework (CRF) and COALITION-Lobby. If you make missions for another community, skip this part: the tools stay unregistered and change nothing else.

Set `ENFUSION_COALITION_TOOLS=on` (or ask your agent to enable COALITION mission making) and restart the server. Set up CRF as the [COALITION Mission Making Guide](https://www.coalitiongroup.net/mission-making-guide) describes, then run `coalition_doctor` to check your PC against the guide.

| Tool | What it does |
|---|---|
| `coalition_doctor` | Checks this PC against the guide's Tools Setup, row by row, with the guide's fix |
| `mission_inspect` | Per-side readiness: slots, spawns, safestart and forward-deploy zones, markers, vehicles, briefings, rule checks |
| `mission_validate` | Runs CRF's own Python checks, the ones its pull request CI runs |
| `gearscript_inspect` | What each role spawns with, by the Lobby gear manager's rules |
| `mission_names` | Builds and checks the guide's five mission names |
| `mission_git` | Branch report against `origin/release` |
| `mission_pr_draft` | Drafts the hand-filled parts of CRF's mission PR template |
| `mission_preflight` | One go or no-go before you push, with the guide's checklists marked |
| `server_params` | Dedicated Server Tool settings with your real folders |

All of them only read, except `mission_git fetch: true`, which updates git refs in the CRF clone. Details in [COALITION](docs/COALITION.md).

## Safety in one paragraph

The server writes only into an addon you name, never into the game or Tools installs, the Workshop cache, Workshop downloads or addons in `ENFUSION_PROTECTED_ADDONS`. Only `wb_launch` starts Workbench, and `wb_close`, `server stop` and `game stop` act only on processes this server started. `wb_launch` copies handler scripts into the addon it opens and keeps them out of git; run `wb_cleanup` before you publish. Workbench's NET API listens on `0.0.0.0:5775`, so block inbound TCP 5775 in the Windows firewall unless you need it. The server never publishes to the Workshop. The full rules are in [Safety](docs/SAFETY.md).

## When to use something else

- **macOS or Linux only.** The build and test suite run there, but Workbench, the game and the server are Windows executables, so the live tools do nothing. A VS Code Enforce Script extension such as [yuvalino/enscript](https://github.com/yuvalino/enscript) covers editing.
- **You want the agent to act with no checks.** This fork refuses on purpose: unsaved worlds, other people's processes, Workshop folders.
- **Terrain sculpting or painting.** No tool does it, and 1.9 removed the `WorldEditorAPI.ModifyHeightMap` and `ModifyLayers` calls.
- **Workshop publishing.** Stays a manual step in Workbench.

## Contributing

Open an [issue](https://github.com/SyykoNT/enfusion-mcp-SyykoNT/issues) first for anything bigger than a small fix. Pull requests that fit: a bug fix with a test that fails without it, a tool reply that is wrong on 1.9, a knowledge base page corrected against the 1.9 game files. Pull requests that don't fit: a writing tool that drops the write guard, a large change with no issue behind it. Build and test steps are in [contributing.md](contributing.md); scripts, the vehicle tuning server and the source layout are in [Development](docs/DEVELOPMENT.md).

## Credits and license

- [steffenbk/enfusion-mcp-BK](https://github.com/steffenbk/enfusion-mcp-BK), by steffenbk and Articulated7: the server, its Workbench handlers, the knowledge base and the generators.
- [MyckaelAutier/enfusion-mcp-ma](https://github.com/MyckaelAutier/enfusion-mcp-ma), by MyckaelAutier: the 1.8 update and the `mod` compile and pack, `server`, `game`, `economy`, `config_override`, `env_check` and `wb_close` tools, ported here as one credited commit.
- [SyykoNT](https://github.com/SyykoNT): this fork.

Not affiliated with Bohemia Interactive. MIT. See [LICENSE](LICENSE).
