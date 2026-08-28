#!/usr/bin/env node
/**
 * The tool's own entry point.
 *
 * §05.5/§10.1 — the download-prompt default is set by the *entry point*, not by
 * the core: `0` here because the user explicitly asked for us, `1` in a
 * package-manager shim because they did not ask to download anything. Both are
 * `??=` so a real environment variable still wins.
 */

import nodeModule from "node:module";
import { defaultEnv, ENV } from "./config/env-vars.ts";

// §08.2's optional compile cache, asked for before the `import()` below so the
// core is covered too. Worth ~2 ms of a ~40 ms `jup --version`; a no-op, by its
// own return value rather than by throwing, where the cache directory is not
// writable. The shim stubs do the same thing — see `shimSource`.
//
// Reached through the default export and called optionally, which is §10.1's
// `?.()` and not a style choice: a *named* import of an export the runtime does
// not have is a link-time `SyntaxError`, thrown before any line of this file
// runs and catchable by nobody. Deno 2.8 is that runtime today — `node:module`
// there has no `enableCompileCache` — so the named form would trade an optional
// 2 ms for total failure on a host that merely happens to run us.
nodeModule.enableCompileCache?.();

defaultEnv(ENV.ENABLE_DOWNLOAD_PROMPT, "0");

const { runMain } = await import("./main.ts");

/**
 * §08.4 — a failure only. The in-process handover returns `0` *before* the
 * package manager's module body runs, so assigning it would turn
 * `process.exitCode` from `undefined` into `0` and a hook guarding on
 * `process.exitCode === undefined` would then decline to set its own code: the
 * corepack 0.18.1 regression, arriving through the entry point instead of a
 * `catch`. Node exits 0 when nothing is ever assigned, so every success — a
 * handover, a management command, a native child that exited 0 — is unchanged,
 * and the exit code is written only to report a failure.
 */
const code = await runMain(process.argv.slice(2));
if (code !== 0) process.exitCode = code;
