// Writes dist/build-info.json so a running server can prove which build it is (run before tsc).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
let commit = "unknown";
try {
  const git = (...args) => execFileSync("git", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  commit = git("rev-parse", "--short", "HEAD") || commit;
  // dist/ is gitignored, so only source changes mark the build dirty
  if (commit !== "unknown" && git("status", "--porcelain")) commit += "-dirty";
} catch { /* no git or not a checkout: keep "unknown" */ }

const dist = new URL("../dist/", import.meta.url);
mkdirSync(dist, { recursive: true });
writeFileSync(new URL("build-info.json", dist), JSON.stringify({ version, commit, builtAt: new Date().toISOString() }, null, 2) + "\n");
