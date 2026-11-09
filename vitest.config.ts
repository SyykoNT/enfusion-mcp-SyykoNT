import { configDefaults, defineConfig } from "vitest/config";

// Tests that run git in temp repos take 1 to 5 s alone and longer in a parallel full run, past vitest's 5 s default
// Stale worktree copies under .worktrees would otherwise be collected as tests
// A free-memory reading on the host would otherwise decide the reply of every test that reaches a launch
// A client built from loadConfig would otherwise run the automatic watch check (netstat, PowerShell) on the test PC
export default defineConfig({ test: { setupFiles: ["tests/setup-memory.ts"], testTimeout: 20_000, exclude: [...configDefaults.exclude, ".worktrees/**"], env: { ENFUSION_WB_AUTOWATCH: "off" } } });
