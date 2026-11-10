# Configuration

All settings are optional. Order of precedence: environment variables, then `~/.enfusion-mcp/config.json`,
then `enfusion-mcp.config.json` in the repository root (see `enfusion-mcp.config.example.json`), then the
defaults.

With `ENFUSION_PROJECT_PATH` unset, tools write into addons under `My Games\ArmaReforgerWorkbench\addons`, but
never into Workshop downloads there (folders with `ServerData.json`) or into the game's Workshop cache. This
works only when that folder is a real folder: where it is a link to the game's Workshop cache (the COALITION guide
sets one up), writes there are refused (see [COALITION missions](COALITION.md)).

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
| `ENFUSION_WORKBENCH_PORT` | `workbenchPort` | `5775`. Workbench itself moves its NET API port only through the `NetAPI_Port` value (REG_DWORD) under `HKEY_CURRENT_USER\Software\Bohemia Interactive\Arma Reforger Workbench\Workbench` and ignores a `-netApiPort` launch argument; set this to the same port |
| `ENFUSION_EXTRACTED_PATH` | `extractedPath` | An `extracted` folder next to the addons folder, if one exists |
| `ENFUSION_MCP_DATA_DIR` | `dataDir` | The bundled `data/` folder |
| `ENFUSION_FORBIDDEN_DIRS` | | None. Extra folders no tool writes into (comma-separated). The game and Tools installs, the game's Workshop cache and Workshop downloads (folders with `ServerData.json`) are always refused |
| `ENFUSION_WORKBENCH_PROFILE` | | Workbench profile folder used to find its `logs/`; detected when not set |
| `ENFUSION_WORKBENCH_LOCK` | | None. A shared lock file for Workbench; `mod compile`, `pack` and `build` name its `owner:` line when they refuse because Workbench is open |
| `ENFUSION_TEXT_STYLE` | | Unset. `strict` turns on the text style checks: `release_audit` T2 (en or em dashes, the words Claude or Anthropic in public text) and `workshop_info` (the same, plus non-ASCII characters and trailing spaces in Workshop text). Length limits are always checked |
| `ENFUSION_LOG_ROOTS` | `logRoots` | None. Extra folders `log_watch` may read logs under (comma-separated), besides the server profile, client profiles, Workbench and game log folders |
| `ENFUSION_COALITION_TOOLS` | `coalitionTools` | Off. `on`, `1` or `true` (any case; `true` in the config file) registers the nine COALITION mission-making tools, see [COALITION missions](COALITION.md). Unset or any other value leaves them off |
| `ENFUSION_SCRIPT_AUTH` | `scriptAuth` | `rules`. How the watchdog answers Workbench's "Script Authorization Required" dialog, in any Workbench the server watches. `rules`: Yes for a script call from an addon that Workbench loaded, No for a script that is in none of them; a request to run a program (`Workbench.RunCmd`, `Workbench.RunProcess`) and a dialog it cannot read are left open and reported, for the agent to answer with `wb_watch answer`. `all`: Yes to All on every request, program runs included; set it only if you trust every addon you load. `off`: report only. Any other value is read as `rules` and logged once. The server never uses `-scriptAuthorizeAll` |
| `ENFUSION_CRASH_LOGS_DIR` | `crashLogsDir` | `Workbench Crash Logs` beside the Workbench profile folder (for the default profile, `Documents\My Games\Workbench Crash Logs`). Crash and log files are copied here, because a new Workbench start removes the older log folders: finished Workbench runs that crashed are copied before the server starts any Workbench (`wb_launch`, or a headless `mod` compile, pack or build) and when a watcher attaches (see [Troubleshooting](KNOWN-ISSUES.md#troubleshooting)), and a Workbench the server watches is copied when it crashes; then that Workbench's own CrashReporter is ended without sending a report, only when the Workbench's start time is known (otherwise it is left running and the report says so). A setting inside the game, Tools or Workshop folders or an `ENFUSION_FORBIDDEN_DIRS` folder, or one that cannot be read, is refused: the default folder is used (none, if that is refused too) and `env_check` says why |
| `ENFUSION_WB_AUTOWATCH` | `autoWatch` | On. Any live call attaches a watcher by itself to the Workbench on the NET API port of this PC, whoever started it. `off`, `0`, `false` or `no` (any case) turns that off; `on`, `1`, `true` and `yes` keep it on. Any other value is off, with one warning in the log |
| `ENFUSION_MCP_DEBUG` | | Any value turns on debug logging (stderr) |

The COALITION tools also read `ENFUSION_PYTHON`; see [COALITION missions](COALITION.md).
