# Safety

What the server will and will not touch, and what it does on its own.

## Writes, launches and processes

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
  never writes into it, and warns when its handlers are stale; `wb_cleanup` keeps them.
- In any other addon `wb_launch` also replaces handler scripts that are missing or differ from this version's copy,
  and the reply names the files it replaced. `wb_connect` only reports stale handlers, in the addon of the running
  Workbench, and writes nothing.
- When a Workbench already answers the NET API port, `wb_launch` names it (its PID, its project, and whether this
  server started it) and refuses when `gprojPath` names a different project: it starts, closes and writes nothing,
  and the other Workbench is left running. For the same project, or when it cannot tell the project, `wb_launch`
  reports the Workbench and goes on using it.
- `wb_launch` refuses to start a GUI Workbench when less than 4 GB of memory is free, before it writes or starts
  anything, and starts with a warning when less than 9 GB is free. A GUI Workbench held 4.3 to 8.9 GB on the PC
  where this was measured.
- A headless run (`mod compile`, `pack`, `build`) that stays on a dialog other than Script Authorization or a
  "Validating" progress window is ended (only its own process) and its result names the dialog (the leak assert is
  the exception, below). A Script Authorization dialog never ends the run; the result names it only when the run
  timed out. A run stopped on the diag "Resources are leaking" assert is ended the same way, but its result does not
  name it (it is judged from `console.log`) and it does not count as a failure.
- Before it starts any Workbench, and when a watcher attaches to one, the server copies finished Workbench log
  folders that hold a real crash to the crash logs folder (see `ENFUSION_CRASH_LOGS_DIR`). It only copies: nothing is
  moved or deleted.
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
  `server.json` binds `0.0.0.0` unless `bindAddress` says otherwise; `127.0.0.1` keeps a test server on this PC.
- `server start` refuses `extraArgs` that carry a flag the tool sets itself (`-config`, `-server`, `-addr`,
  `-addonsDir`, `-addons`, `-addonDownloadDir`), `-addonsRepair` or `-addonsVerify`, and flags that set a write path
  (such as `-profile`, `-logsDir`, `-addonTempDir`, `-saveDir`, `-cfg`). Every server the MCP starts (`server start`
  and `mission_server`) passes `-addonDownloadDir` set to `%USERPROFILE%\.enfusion-mcp\server-downloads`, so Workshop
  mods a server downloads never land in the game's Workshop cache. In a live check, a server started in `-server`
  mode with a Workshop mod that no addon folder held downloaded nothing: it stopped at a "Missing Addon" dialog (see
  [Known issues](KNOWN-ISSUES.md#known-issues)).

## The watcher

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
- The watcher also compares the settings classes in the settings files of the game and Workbench profiles, when it
  attaches and when that Workbench exits, and reports the ones that are gone. It only reports: no settings file is
  changed or restored.

## Git, network and publishing

- `addon_git_guard install` writes only into the `.git/hooks` folder of one named addon under the project path
  or `ENFUSION_ADDONS_DIR`. It refuses protected addons, installs, the game's Workshop cache and Workshop
  downloads, a repo with `core.hooksPath` set, an existing pre-commit hook it did not write, and a repo whose
  `origin` is not under a GitHub owner listed in `ENFUSION_GITHUB_OWNERS` unless `sharedRepoOk=true`. A repo with no `origin` installs.
- Workbench's NET API listens on all network interfaces (`0.0.0.0:5775`). Block inbound TCP 5775 in the
  Windows firewall unless you need remote access.
- The server does not publish to the Workshop. Publishing stays a manual step in Workbench.
