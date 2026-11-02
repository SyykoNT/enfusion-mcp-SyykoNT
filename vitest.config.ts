import { defineConfig } from "vitest/config";

// Tests that run git in temp repos take 1 to 5 s alone and longer in a parallel full run, past vitest's 5 s default
export default defineConfig({ test: { testTimeout: 20_000 } });
