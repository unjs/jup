import { defineConfig } from "vitest/config";

/**
 * The default suite: jup's own unit and conformance tests.
 *
 * `test/corepack` — the ported upstream Corepack suite — is excluded here
 * because it talks to the real npm registry unless a local recording exists.
 * Run it with `pnpm test:corepack`.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "test/corepack/**"],
  },
});
