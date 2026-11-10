# What changed since enfusion-mcp-BK

This fork starts at enfusion-mcp-BK `0acfa88` (0.12.0, 2026-08-05). Since then: **500 commits**, 24 new tools, the script API rebuilt for 1.9.0.37, and every BK tool that worked in real modding sessions re-tested on Workbench 1.8.0.13 and again on 1.9.0.37.

**(ma)** marks a tool that came from [enfusion-mcp-ma](https://github.com/MyckaelAutier/enfusion-mcp-ma) by MyckaelAutier, ported as one credited commit; its bullet says what the tool does and what this fork changed in it. Everything else was written and tested in this fork.

## The re-test

On Workbench 1.8.0.13, 27 BK tool calls that worked in real sessions and 17 enfusion-mcp-ma additions were re-tested: 44 checks, 40 pass, 3 partial, 1 not applicable (the npm package and Claude Code plugin, which this fork does not ship). Version 0.15.0 was then re-tested on 1.9.0.37; the [0.15.0 release notes](https://github.com/SyykoNT/enfusion-mcp-SyykoNT/releases/tag/v0.15.0) list what that covered. Failures were fixed or written up in [Known issues](KNOWN-ISSUES.md).

## Arma Reforger 1.9

- `api_search`: Rebuilt from the 1.9.0.37 script API docs: 9,119 classes, against BK's 8,693 scraped in February 2026. 153 classes added and 18 removed since 1.8, including the removed `WorldEditorAPI` heightmap and layer calls.
- `scenario_create_conflict`: Writes what 1.9.0.37 reads. The mission header names the new world as `{GUID}Worlds/<name>.ent` with its own `.meta`, every MOB gets the HQ flags, fewer than 2 MOBs is refused, and a parent world without an AIWorld gets one. Template properties 1.9 no longer declares are gone.
- Tuning server: Reads and writes the 1.9 vehicle schema (engine, Pacejka 2002 or Pacejka '94 tyre model, axles, differentials), from the installed paks when there is no extracted folder.
- `wb_layers`, `wb_entity_inspect`, `wb_entity_modify`: Handle the empty rows 1.9 packs into replies, name each layer, and read held property values.
- Knowledge base: Supply, HQ, radio and rank pages checked against the 1.9.0.37 scripts and game mode prefab.

## Starting and stopping things

- Only `wb_launch` starts Workbench. Previously, any `wb_*` call that found Workbench closed launched it, and with no default mod it picked the first addon with a `.gproj`.
- `wb_launch`: Refuses the game and Tools installs, the Workshop cache and Workshop downloads. Previously, handler scripts could land in a downloaded Workshop mod.
- `wb_launch`: Names the Workbench that already holds the NET API port (PID, project, who started it) and refuses to open a different project there.
- `wb_launch`: Refuses a GUI start below 4 GB of free memory and warns below 9 GB. A GUI Workbench held 4.3 to 8.9 GB on the PC where this was measured.
- `wb_launch`: Refuses a launch that would load two copies of one addon GUID from different folders.
- `wb_launch`: Stops waiting when the Workbench it started exits, instead of waiting out the 90 s timer.
- `wb_launch`: `worldPath` opens a world in the World Editor at start.
- `wb_launch`, `mod`: `ENFUSION_ADDONS_DIR` and per-call `addonsDirs` pass `-addonsDir`, so addons that depend on other local projects load.
- `wb_launch`, headless `mod` runs: Report to Steam as Arma Reforger Tools (app 1874910).
- `wb_close` **(ma)**: Saves the world and exits Workbench. This fork made it exit in edit mode, open no Save As dialog for a world without a file, skip the save in prefab edit mode, and close only a Workbench this server started.
- `server stop`, `game stop`: Act only on servers and game clients this server started, never the user's own game.
- A Workbench whose process exists but whose NET API does not answer is reported, and no second copy is started.

## Workbench reliability

- `wb_watch`: A watcher attaches by itself to the Workbench on the NET API port, whoever started it. It reports a blocking dialog, a hang, an unfinished script reload or a crash in its own status and in the footer of every live tool.
- Watcher: Answers "Script Authorization Required" by rule (`ENFUSION_SCRIPT_AUTH`): Yes for scripts from loaded addons, program runs left open for the agent with `wb_watch answer`. It never uses `-scriptAuthorizeAll` or No to All.
- Watcher: Presses Ignore on the diag build's "Resources are leaking!" assert, which otherwise blocks every reload.
- Watcher: Reports profile settings blocks that disappear between Workbench runs.
- Crash logs: A crashed Workbench's `crash.log`, dumps and logs are copied to `ENFUSION_CRASH_LOGS_DIR` and only its own CrashReporter is closed. Finished runs that crashed are also copied before any Workbench start, since Workbench prunes old log folders when it starts.
- Timeouts name the open dialog (title, text, buttons) instead of only "timed out". A timeout that finds no Workbench but a CrashReporter on the port says Workbench appears to have crashed.
- Unsaved-world guard: An `.ent` open is refused when it would raise Workbench's "Loading world" prompt, matched against what 1.9.0.37 really prompts for. A `.gproj` open through `wb_open_resource` or `wb_projects`, which 1.9 refuses and which leaves the world unstable, is refused before it is sent.
- Refused-open guard: After Workbench refuses an open, the state-reading tools refuse until a `.ent` opens or Workbench restarts. In the recorded checks, a state read at that point crashed Workbench in 3 of 3 runs.
- `wb_save`: Refuses what would open a dialog (unnamed world, prefab edit mode, a world in the game, Tools or Workshop folders) and lists the files it wrote.
- `wb_state`: Reports play mode correctly, so `wb_stop` works again.
- `wb_prefabs locate`: Sends the fields the handler reads. Previously, Workbench searched every mounted folder and stopped responding for about five minutes.
- `wb_layers`: Creates layers and sets the active layer through the documented sub-scene calls, confirmed by reading back.
- `wb_entity_create`: Honors `layerPath` and refuses a layer that does not exist. Previously, the entity went to another layer.
- `wb_entity_select getSelected`: Reads the list the handler sends. Previously, it always said no entities were selected.
- `wb_execute_action`: Blocks World Editor File,Save in any spelling, and runs menu actions that need no world.
- `wb_launch`: Replaces missing or stale handler scripts and names the files; `wb_connect` reports stale ones without writing.
- `wb_handlers`: Installs, removes or checks the server's own `EMCP_*` handler scripts in one addon, on request.
- `wb_cleanup`: Removes only `EMCP_*` handler files and reports what it removed. Previously, other scripts in that folder could go too.

## Build, test and servers

- `mod compile` **(ma)**: Runs Workbench headless and returns each error as `file:line`. This fork fixed the log lookup when Documents is on OneDrive, so the errors are listed.
- `mod pack`, `mod build` **(ma)**: Pack an addon headless. This fork added checks of the addon and output folder before Workbench starts, refusal of packed handler scripts, and a list of the resulting `data.pak`.
- Headless runs: A run stuck on a dialog nobody answers is ended (its own process only) and the result names the dialog.
- `server` **(ma)**: Install, start, stop, status, logs, and config validated against the game's own `DSConfigSchema.json`. This fork added `-server` mode for local addons so the client can join, a `127.0.0.1` bind and a `bindAddress` setting, `-addonDownloadDir` away from the Workshop cache, `cpuMask`, a start that waits for the online line, and refusal of flags the tool sets itself or that write elsewhere.
- `mission_server`: Runs a mission world from an unpacked addon on a local dedicated server without Workbench, the way the Dedicated Server Tool does, with game clients that join it. Each client needs 4 GB free, and the server and each client can be pinned to their own cores.
- `game` **(ma)**: `launch` with addons, connect and world. This fork added `{GUID}Missions/Name.conf` mission headers and stops only clients it started.
- Servers and clients this server starts run with `-noThrow`. A process watcher ends one only when the "Virtual machine exception" window stays open on it, and copies its logs to a crash folder. Status replies show the first script exception in full.
- `script_errors`: Groups runtime errors from Workbench, client and server logs with counts, first and last time, and the addon that owns the top frame.
- `log_watch`: Waits for or scans patterns in any of those logs and returns a cursor to resume from.
- `env_check` **(ma)**: Checks the setup and says what to set for anything missing. This fork added the build stamp, game and server versions read from their exe files, and the crash logs folder.

## Files and data

- One write guard for every file-writing tool: a named addon only. The game and Tools installs, the Workshop cache, Workshop downloads, `ENFUSION_FORBIDDEN_DIRS` and `ENFUSION_PROTECTED_ADDONS` are always refused. Previously, any absolute path the model passed was accepted.
- Enfusion text parser: Rewritten to be lossless. A read-only run over 29,863 base-game and addon text files found no token changes; 3 malformed files are refused with a line number.
- `config_override`, `economy` **(ma)**: Override any config or prefab, XP, ranks and costs. This fork limited them to a named addon and moved them to the new parser, so they keep `+` appends, quoting, line endings and the final newline.
- `resource_resolve`: Merges a prefab's inheritance chain and every same-path override from the base game, the Workshop cache and your projects, and names the addon and file behind each value.
- `game_read`: Pages long files byte for byte, reads one addon's own files, and answers `X.meta` from the resource database, since packed addons ship no `.meta`.
- `wiki_read`, `wb_knowledge`: Take a page URL or title and return long pages in parts.
- `prefab create`: Writes a real child prefab with a full `.meta`.
- `script_create`: Templates set the event mask so `EOnInit` runs, and generated overrides of non-void methods return `super`, so the scaffold compiles.
- `asset_search`: No longer shows an all-zero GUID for scripts.
- Scraper: A remote run with missing pages fails instead of writing a partial index.

## Release hygiene

- `release_audit`: Read-only report for one addon before a commit or publish: handler files, git state, `.gproj`, metas, `resourceDatabase.rdb`, GUIDs shared with dependencies, leftovers, BOMs, size, preview image. Stable finding IDs and a verdict.
- `addon_deps`: Each dependency's version and source, the references into it, and undeclared, missing, unused or redundant dependencies, cycles and game version drift.
- `addon_git_guard`: Local pre-commit and commit-msg hooks that keep handler files, folder metas, `resourceDatabase.rdb`, BOM-prefixed scripts and AI tool attribution lines out of commits.
- `workshop_info`: Lints the planned Workshop name, summary and description, and checks the preview image's format, size and pixels.
- `wb_launch`: Adds the handler folder to a git repo's `.git/info/exclude` and refuses if handler files are already committed.

## Prompts and tool text

- `create-mod`, `modify-mod`: Ask before shared actions (closing Workbench, starting servers, downloads, deletes) and end with what was not verified. Previously, both told the agent "YOU ARE FULLY AUTONOMOUS" and to never give the user a manual step.
- `server-mod` **(ma)**: Guided workflow for a server-side mod through config overrides, rewritten here to the same ask-first rules.
- Tool descriptions state real side effects and known limits.

## Project

- CI on Windows and Linux with Node 20 and 22, startable by hand.
- 2,409 tests in 171 files at `293a705` (2,394 pass and 15 skip in Git Bash).
- The server reports `<version>+<commit>`; `env_check` shows the build.
