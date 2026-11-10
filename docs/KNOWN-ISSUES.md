# Known issues and limitations

State at `c070e21` on Arma Reforger 1.9.0.37.

## Known issues

Open bugs you can hit today, with what to do where a way is known.

- A dedicated server started with `-addons` naming a mod that is in no addon folder and no cache still stops at a
  "Missing Addon" dialog, even with `-noThrow`. The process watcher reports it as waiting for OK and does not end it. Close that dialog (the server
  then starts without the mod), or end the server with `server stop` or `mission_server stop`, whichever started it.
- `-noThrow` on a game client was checked once on 1.9.0.37: the script exception was logged and no exception window
  showed in 125 s, but no client without `-noThrow` was run to compare. If the window shows up on a client this MCP
  session started, its process watcher ends that client.
- `mission_server` on a COALITION (CRF) mission: a bare server sees only the folders in `addonsDirs`, so the mission's
  Workshop dependencies have to be in them. In the check on 2026-11-10 the server exited at start because CRF and
  COALITION-Lobby need Workshop addons no listed folder held.
- The unsaved-world check reads the World Editor window title, so it runs only against a local Workbench on Windows;
  where it cannot check, the call goes ahead with a warning.
- `wb_launch` never refreshes handler scripts in a protected addon such as a framework clone, so stale ones there are
  only reported (by `wb_connect` and `wb_launch`), and a Workbench you start yourself gets no check at launch. Refresh
  them with `wb_handlers install` (with the owner's OK) and restart Workbench.
- `wb_entity_modify` `setProperty` stores any name for an enum property on 1.9.0.37, also one that is not in the
  property's list. The handler's enum check (`a3a5db1`) did not fire in a live test.
- `wb_script_editor` `getCurrentFile` and `getLine` return empty text on 1.9 after `openFile`, while
  `getLinesCount`, `insertLine` and `removeLine` work. Read the file with `project read`.
- `wb_entity_select` with `select` clears the current selection and only locates the entity; it does not select it.
  Select the entity in Workbench by hand.
- A dedicated server started on a scenario made by `scenario_create_conflict` has not been re-checked since the
  template was updated for 1.9.0.37. If it fails to start, run `mission_server status` for a run that `mission_server`
  started, or `server status` for one that `server start` started: the reply gives the run's log location and any
  script exception or `crash.log` from that run.

## Known limitations

- `wb_reload` sends Workbench's built-in `ReloadScripts` call. Its Ok does not prove the scripts were recompiled: look for a
  new "Reloading game scripts took" line in Workbench's `console.log`. On the diag build (tested on 1.9.0.37) each reload raised the "Resources are leaking!"
  assert, which waits for Ignore; an attached `wb_watch` presses it. The plugin reload (`target` `plugins` or `both`) tries
  one Workbench menu action, Plugins > Reload; on 1.9.0.37 it returned false, so the tool says "not confirmed". Saving a `.c`
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

## Troubleshooting

| Problem | What to do |
|---|---|
| Workbench stops on a "Script Authorization Required" dialog | Run `wb_watch status`. In the default mode the watcher answers Yes to a script from a loaded addon on its own. A request to run a program is left open and shown with the script, the line and the command read from the script's source: answer it with `wb_watch answer` (`yes` or `no`, with a reason) or in Workbench. Set `ENFUSION_SCRIPT_AUTH=all` to press Yes to All on every request, or `off` to answer only by hand. The watcher acts on any Workbench it watches: one this server started, or one it attached to by itself or through `wb_watch start` (`ENFUSION_WB_AUTOWATCH=off` stops the automatic attach) |
| Where crash logs go | When a Workbench the server watches crashes, that run's `crash.log`, any `.mdmp` dump, `console.log`, `error.log` and `script.log` are copied to a subfolder named `<date>_<time>_<PID>` of the crash logs folder (`ENFUSION_CRASH_LOGS_DIR`; default: `Workbench Crash Logs` beside the Workbench profile folder; a setting inside the game, Tools or Workshop folders or an `ENFUSION_FORBIDDEN_DIRS` folder, or one that cannot be read, is refused and the default is used; if the default is refused too, no copy is made and `env_check` says so). The server also saves earlier crashes nobody watched: before it starts any Workbench (`wb_launch`, or a headless `mod` compile, pack or build) and when a watcher attaches, each finished Workbench log folder whose `crash.log` has an `Unhandled exception` entry, or that holds a dump not named `FREEZE_*`, is copied under its own `logs_<date>_<time>` name; hang-only dumps and leak asserts alone are not copied, the folder of a running Workbench is skipped, and a folder already saved is not copied again. The originals stay where they are. Workbench removes older log folders when it starts again, so use the copy |
