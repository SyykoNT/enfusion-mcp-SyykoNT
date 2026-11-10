# Development

```bash
npm run dev             # run the server from source (tsx)
npm test                # vitest
node scripts/build-info.mjs && npx tsc -p tsconfig.build.json   # compile to dist/ with the build stamp
npm run scrape          # rebuild data/api from the local Workbench docs (scrape:remote uses the BI website)
npm run check:recipes   # check prefab recipes against the installed game
npm run tuning-server   # local web UI for vehicle tuning (port 5790)
```

## Vehicle tuning server

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

## Source layout

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
