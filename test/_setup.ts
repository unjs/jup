/**
 * §13.2 — the isolation the whole default suite depends on, applied once per
 * worker before any test file is imported.
 *
 * Two things reach the tool from the machine it is being tested on, and both
 * have to be taken away here rather than file by file.
 *
 * **The tool's own variables.** §11.6 makes `JUP_X` win over `COREPACK_X`, so a
 * developer whose machine runs jup as its package manager — `JUP_HOME`,
 * `JUP_SHIM_DIRECTORY`, `JUP_NPM_REGISTRY` exported from a login shell — has an
 * ambient value that outranks every `COREPACK_HOME` the fixtures set. The rows
 * do not fail cleanly when that happens: `getHomeFolder` answers with the
 * developer's real store and the install rows promote fixture tarballs into it,
 * `enable` writes shims into the directory their real `jup` is on `PATH` from.
 * A suite must not be able to damage the machine that runs it, so every name
 * this tool answers to under either spelling is removed, and a fixture that
 * wants one sets it itself.
 *
 * **The home directory.** With the variables gone, §07.1's chain falls through
 * to `XDG_CACHE_HOME`, `LOCALAPPDATA` and finally `homedir()` — the same real
 * store by a longer route, for any test that exercises store code without
 * naming a home of its own. Pointing the whole family at an empty directory per
 * worker makes the fallback land somewhere the suite owns, so reaching it is a
 * missing fixture rather than a write to the developer's cache.
 *
 * The ported Corepack suite does its own equivalent scrubbing in
 * `test/corepack/_setup.ts`; it runs under a config of its own and does not
 * load this file.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isToolEnvName } from "../src/config/env-vars.ts";

for (const key of Object.keys(process.env)) {
  if (isToolEnvName(key)) delete process.env[key];
}

/**
 * One per worker, not one per test file: `setupFiles` is evaluated for each
 * file, but the module cache is the worker's, so this runs once and every file
 * in that worker shares the directory. Empty, and nothing in the suite is
 * supposed to find anything in it.
 */
const HOME = mkdtempSync(`${tmpdir()}/jup-test-home-`);

process.on("exit", () => rmSync(HOME, { recursive: true, force: true }));

// `os.homedir()` reads `HOME` on POSIX and `USERPROFILE` on Windows, so the
// pair covers both the variables §07.1 reads directly and the platform default
// it ends on. The two `XDG_*` names and `LOCALAPPDATA` are the rest of that
// chain (§07.1, §10.5).
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.XDG_CACHE_HOME = `${HOME}/.cache`;
process.env.XDG_BIN_HOME = `${HOME}/.local/bin`;
process.env.LOCALAPPDATA = `${HOME}/AppData/Local`;
