# Contributing to enfusion-mcp-SyykoNT

Thanks for helping. Bug reports, fixes, new mod patterns and better docs are all welcome, from COALITION members
and anyone else who mods Arma Reforger.

## Where this comes from

This server is a fork of [steffenbk/enfusion-mcp-BK](https://github.com/steffenbk/enfusion-mcp-BK) by steffenbk
and Articulated7, with the Arma Reforger 1.8 update from
[MyckaelAutier/enfusion-mcp-ma](https://github.com/MyckaelAutier/enfusion-mcp-ma) by MyckaelAutier. Most of the
code is theirs. If you fix something that is also broken in enfusion-mcp-BK, please send the fix there too, so
everyone using it gets it.

## Before you start

For anything bigger than a small fix, open an issue first:
https://github.com/SyykoNT/enfusion-mcp-SyykoNT/issues

Say what you want to change and why. That way we can agree on the approach before you spend time on code.

For a bug report, include your OS, Node version, the game and Tools versions, the tool you called with its
arguments, what you expected and what happened. Modding setups differ a lot, so the more detail the better.

## Getting the code

```bash
git clone https://github.com/SyykoNT/enfusion-mcp-SyykoNT.git
cd enfusion-mcp-SyykoNT
git checkout syyko/dev
git checkout -b my-change
npm ci
```

Work on a branch made from `syyko/dev`, and open your pull request into `syyko/dev`.

You need the Node.js version in `package.json` under `engines` (CI tests the versions listed in
`.github/workflows/ci.yml`; today Node 20 and 22). The live Workbench tools (`wb_*`) also need Arma Reforger
Tools from Steam; everything else runs without them.

If your shell sets `NODE_ENV=production`, npm skips the dev dependencies (TypeScript, vitest). Use
`npm ci --include=dev` instead.

## Building and testing

```bash
node scripts/build-info.mjs && npx tsc -p tsconfig.build.json
npx vitest run
```

Why not `npm run build`: it starts by deleting `dist`. If an MCP client is running the server from this folder, it
runs the files in `dist`, and deleting them breaks every session that uses it until the build finishes. The
command above compiles over `dist` instead. The same goes for `npm ci`, which runs the full build through the
`prepare` script: in a folder a client is using, run `npm ci --ignore-scripts`, then the build command above.

Some tests need things that are not on every PC (the game install, git, `sh`). They skip themselves when those
are missing, so a few skipped tests are normal.

CI runs the same build and tests on Linux for every pull request into `syyko/dev`. A test that only works on
Windows (Win32 paths, junctions, PowerShell) needs an explicit skip, for example
`it.skipIf(process.platform !== "win32")`.

## Pull requests

- Keep each pull request small and about one thing.
- New logic comes with a test. A bug fix comes with a test that fails without the fix.
- Make sure `npx tsc --noEmit` and `npx vitest run` pass before you open it.
- Match the style of the code around your change. TypeScript strict mode is on.
- Tools that write files must refuse to write into the game install, the Workbench install or the Workshop
  download folder. Keep that guard when you change a writing tool.
- Say in the description what you tested and how, including anything you checked by hand in Workbench.

## License

By contributing you agree that your work is released under the [MIT License](LICENSE), like the rest of the
project.
