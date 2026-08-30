import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The default suite: jup's own unit and conformance tests.
 *
 * `test/corepack` — the ported upstream Corepack suite — is excluded here
 * because it talks to the real npm registry unless a local recording exists.
 * Run it with `pnpm test:corepack`.
 */

/**
 * Where the spawned tools keep their compiled source, §01.3's cache put
 * somewhere the suite controls.
 *
 * The conformance rows spawn `node src/bin.ts` upwards of a thousand times, and
 * each child type-strips and compiles the whole source tree before it runs a
 * line: 204 ms of CPU per spawn against 46 ms with a warm cache, which across
 * 15 workers is the difference between 336 s and 140 s of CPU for one run.
 *
 * `bin.ts` already asks for the cache, but `enableCompileCache()` with no
 * argument writes to `os.tmpdir()/node-compile-cache` and returns a *status*,
 * not a throw. One root-owned leftover directory in `/tmp` — an earlier run as
 * another user, a container that bakes one in — and every child silently
 * recompiles from scratch for the life of the machine. Naming a directory of
 * our own takes that failure mode off the table. Absolute, because the children
 * run in fixture cwds.
 */
const COMPILE_CACHE = fileURLToPath(
  new URL("node_modules/.cache/node-compile-cache", import.meta.url),
);

/**
 * Emptied once per run, here, because this module is evaluated once per run in
 * the runner's own process — before any worker starts.
 *
 * Node keys a cache entry by the file's absolute path and never evicts one, and
 * `copyTool` gives every copy of the tool a fresh temporary directory. So a run
 * writes some 2,200 entries, ~30 MB, that no later run can ever hit, and left
 * alone the directory grows by that much every time the suite is run. Nothing
 * is lost by dropping them: the whole saving is *within* a run — the children
 * of one run share the entries the first few wrote — and a run starting from an
 * empty directory measures the same as one starting from a full one.
 */
rmSync(COMPILE_CACHE, { recursive: true, force: true });

export default defineConfig({
  test: {
    env: {
      // §09.11 — the writers colour their output when the destination is a
      // terminal, and vitest's own stdout is one when the suite is run by hand.
      // The rows here match §12's text byte for byte, so colour is pinned off
      // rather than left to depend on how the runner was launched.
      NO_COLOR: "1",
      NODE_COMPILE_CACHE: COMPILE_CACHE,
    },
    exclude: ["**/node_modules/**", "**/dist/**", "test/corepack/**"],
    // §13.2 — takes the developer's own `JUP_*`/`COREPACK_*` and home directory
    // away from every worker, so a machine that runs jup as its package manager
    // cannot have its store or shims written to by a test run. See the file.
    setupFiles: ["./test/_setup.ts"],
    // Most rows here spawn a real `node`, and process creation on Windows costs
    // an order of magnitude more than `fork`/`exec` does on Linux — a row that
    // takes 200 ms on the Linux runner takes seconds on the Windows one, and
    // the 5 s default turns that into a flake rather than a finding.
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
  },
});
