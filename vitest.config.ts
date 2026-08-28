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
    // Most rows here spawn a real `node`, and process creation on Windows costs
    // an order of magnitude more than `fork`/`exec` does on Linux — a row that
    // takes 200 ms on the Linux runner takes seconds on the Windows one, and
    // the 5 s default turns that into a flake rather than a finding.
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
  },
});
