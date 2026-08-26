import { defineConfig } from "vitest/config";

/** Upstream's `vitest.config.mts`, for the ported suite only. */
export default defineConfig({
  test: {
    include: ["test/corepack/**/*.test.ts"],
    setupFiles: ["./test/corepack/_setup.ts"],
    testTimeout: 120_000,
    retry: 2,
  },
});
