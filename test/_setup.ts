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
 * **`PATH`.** §10.7's continuity scan walks it looking for shims, so a
 * developer's own shim directory on it is another way the machine answers a
 * question the fixture meant to ask about itself: a row that disables `npm` in
 * its own directory and then scans finds the real `npm` shim one entry further
 * along and reports it as installed. Twenty-odd rows build a child `PATH` by
 * splicing `process.env.PATH`, so the entries come off here rather than at each
 * of them.
 *
 * The ported Corepack suite does its own equivalent scrubbing in
 * `test/corepack/_setup.ts`; it runs under a config of its own and does not
 * load this file.
 */

import { lstatSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { isToolEnvName } from "../src/config/env-vars.ts";

/**
 * Read before the scrub below takes it away: where this machine's own `enable`
 * put its shims, which is the entry §10.7 would find first.
 */
const ambientShimDirectory = process.env.JUP_SHIM_DIRECTORY ?? process.env.COREPACK_SHIM_DIRECTORY;

for (const key of Object.keys(process.env)) {
  if (isToolEnvName(key)) delete process.env[key];
}

/**
 * A directory holding `jup` itself is a jup installation, whether or not
 * `JUP_SHIM_DIRECTORY` named it — the default is a plain `~/.local/bin` that no
 * variable points at.
 *
 * `jup`, and none of the other names `enable` writes. Two of them are traps in
 * opposite directions: Node.js ships a `corepack` beside its own `node`, so
 * testing for that name drops the runtime's directory, and §02.3's table has
 * `node` in it, so a machine whose jup manages its runtime has a `node` shim in
 * the very directory that has to go. `jup` is the one name that means this and
 * nothing else.
 *
 * `lstat`, not `exists`: a shim whose target has gone is still a shim, still on
 * `PATH`, and still something §10.7 reports on. `existsSync` follows the link
 * and would call that directory clean.
 */
function has(entry: string, names: readonly string[]): boolean {
  return names.some(
    (name) => lstatSync(join(entry, name), { throwIfNoEntry: false }) !== undefined,
  );
}

function holdsAnInstallation(entry: string): boolean {
  if (entry === "") return false;
  return entry === ambientShimDirectory || has(entry, ["jup", "jup.cmd", "jup.exe"]);
}

const path = (process.env.PATH ?? "")
  .split(delimiter)
  .filter((entry) => !holdsAnInstallation(entry));

/**
 * One per worker, not one per test file: `setupFiles` is evaluated for each
 * file, but the module cache is the worker's, so this runs once and every file
 * in that worker shares the directory. Empty, and nothing in the suite is
 * supposed to find anything in it.
 */
const HOME = mkdtempSync(`${tmpdir()}/jup-test-home-`);

process.on("exit", () => rmSync(HOME, { recursive: true, force: true }));

/**
 * `node` has to survive the filtering above, and on a machine whose jup manages
 * its runtime the only `node` on `PATH` may well have been in the directory
 * that just went. §10.2 asks whether `#!/usr/bin/env node` reaches anything and
 * bakes an absolute interpreter into every shim when it does not, so losing it
 * silently rewrites what a whole class of row observes.
 *
 * A jup `node` shim does not count as the survivor, which is `envFindsInterpreter`'s
 * own rule rather than one invented here: it discounts our shims when asking
 * that question, so a `PATH` whose only `node` was one is a `PATH` with no
 * interpreter. The runtime running the suite is offered under a directory of
 * its own instead — the same answer `childPath` gives for §10.5 point 8, for
 * the same reason. Its own directory, not `HOME`, which stays empty.
 */
if (!path.some((entry) => entry !== "" && has(entry, ["node", "node.exe"]))) {
  const runtime = mkdtempSync(`${tmpdir()}/jup-test-runtime-`);
  process.on("exit", () => rmSync(runtime, { recursive: true, force: true }));
  symlinkSync(process.execPath, join(runtime, "node"));
  path.push(runtime);
}

process.env.PATH = path.join(delimiter);

// `os.homedir()` reads `HOME` on POSIX and `USERPROFILE` on Windows, so the
// pair covers both the variables §07.1 reads directly and the platform default
// it ends on. The two `XDG_*` names and `LOCALAPPDATA` are the rest of that
// chain (§07.1, §10.5).
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.XDG_CACHE_HOME = `${HOME}/.cache`;
process.env.XDG_BIN_HOME = `${HOME}/.local/bin`;
process.env.LOCALAPPDATA = `${HOME}/AppData/Local`;
