# COALITION mission making (optional)

> **Only for COALITION missions.** The tools in this part are for missions built on COALITION's framework (CRF) and COALITION-Lobby. If you make missions for other communities or servers, you can skip this whole part: it does not change how any other tool works, and these tools stay off unless you turn them on.
>
> The COALITION mission-making tools are off by default. To make missions for the COALITION community, ask your agent to enable COALITION mission making. It sets `ENFUSION_COALITION_TOOLS` to `on` in this server's MCP config, and the tools below appear after the server restarts.
>
> Once they are on, `server_params` prints COALITION's settings, including `-addons "COALITIONFramework"`, if it is called. For a mission of your own, use `mission_server` (in [Tools](TOOLS.md#build-and-test)).

Set up your local repo of CRF via GitHub according to the Coalition Mission Making Guide found here:
https://www.coalitiongroup.net/mission-making-guide

Then run `coalition_doctor` to check your setup against the guide.

All tools in this part only read, except `mission_git` with `fetch: true`, which writes git refs in the CRF clone.

## Tools

| Tool | Purpose |
|---|---|
| `coalition_doctor` | Checks this PC against the guide's Tools Setup, each row with its state and the guide's fix: Arma Reforger Tools and Server, Git with its user name and commit email, GitHub Desktop installed (the sign-in is not checked), the server mods downloaded in the game, the Workbench mods link and its check, the Projects folder, the CRF clone, its release branch and your mission branch, updating from release, opening the framework project, the `enfusion://` protocol; plus this server's own setup (Python 3.11+, COALITION-Lobby, `ENFUSION_PROJECT_PATH`, `ENFUSION_PROTECTED_ADDONS`, handler files git-ignored). Writes nothing and never fetches |
| `mission_inspect` | Per-side readiness report for a mission world from its saved layers: slots, spawn points, safestart and forward-deploy zones, markers, MSPs, vehicle spawners and depots; entity names the mission's components refer to, checked against the world with near-miss suggestions; Task Creator entries; and rule checks from the guide |
| `mission_validate` | Runs CRF's own mission checks (`validate_mission.py`, `mission_synopsis.py`, `validate_resources.py`) on one mission world or on the worlds a branch changes, with the Lobby clone from `lobbyPath` or beside CRF; returns failures, warnings, the pull request title and check ticks CI would set, and the synopsis |
| `gearscript_inspect` | What each role in a gearscript spawns with, by the rules of COALITION-Lobby's gear manager: weapons, magazines, clothing, items and radios; lists what the gear manager skips, and with `usedBy` which missions use the gearscript |
| `mission_names` | The guide's five mission names (branch, world file, mission `.conf`, in-game name, pull request title): `build` makes them, `check` compares a world, its `.conf` and the CRF branch with the rules |
| `server_params` | The settings for Workbench's Dedicated Server Tool as the guide fills them, with your real folders: the Params line, the mission header `.conf` for a world, and the Diag server and client executables |
| `mission_git` | Branch and change report for a mission branch: the branch (warns unless `mission/<name>`), commits ahead and behind `origin/release` as of the last fetch, changed files by kind, and warnings for handler files, files outside the mission folders, a world without a `.conf` or the reverse, and new resources without a `.meta` |
| `mission_pr_draft` | Drafts the hand-filled parts of CRF's mission pull request template from the mission files: a side, faction and role line per slotted side, assets per side, objectives, a testing note from the newest Workbench log, and mods added to `addon.gproj`; lists what it could not fill. Returns text only |
| `mission_preflight` | One go or no-go before you push a mission branch: runs `mission_git`, `mission_names check`, `mission_validate`, the `mission_inspect` rules and the newest Workbench log, then prints the guide's Before You Submit and pull request checklists with each row marked pass, FAIL, warn, not run, in game or you |

## Where the tools find CRF and COALITION-Lobby

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

## What each tool needs

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

## The Workbench addons link

The guide links `Documents\My Games\ArmaReforgerWorkbench\addons` to the game's Workshop cache. With
`ENFUSION_PROJECT_PATH` unset that folder is the default project path, and because it resolves into the Workshop
cache, tools refuse to write there. `wb_launch` without `gprojPath`, for example, answers:

> Refused: ...\Documents\My Games\ArmaReforgerWorkbench\addons\EnfusionMCP is inside ...\Documents\My
> Games\ArmaReforger\addons (game or Tools install, Workshop cache, or ENFUSION_FORBIDDEN_DIRS); wb_launch would
> copy handler scripts into it. Pass the .gproj of an addon of your own.

Where the junction cannot be made (Documents on OneDrive), mods copied into that folder by hand are Workshop
downloads (they hold `ServerData.json`), and writes into them are refused as well. The tools in this part
only read (apart from those git refs), so they are not affected. To write, name an addon of your own with `gprojPath` or `projectPath`.

## Safety notes for these tools

- `mission_validate`, and `mission_preflight` through it, run the Python scripts of the CRF clone in place
  (`python -I -B -X utf8`). They write nothing, but they execute that clone's code.
- `mission_git` with `fetch: true` runs `git fetch origin release` in the CRF clone, which writes refs. Without
  it, and in `mission_pr_draft` and `mission_preflight`, nothing is fetched, committed, pushed or posted.
