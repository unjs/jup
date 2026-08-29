import { defineConfig } from "vitest/config";

/** Upstream's `vitest.config.mts`, for the ported suite only. */
export default defineConfig({
  test: {
    include: ["test/corepack/**/*.test.ts"],
    // As in the root config: upstream's rows match text, so colour stays off.
    env: { NO_COLOR: "1" },
    setupFiles: ["./test/corepack/_setup.ts"],
    testTimeout: 120_000,
    retry: 2,
  },
});
