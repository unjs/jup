#!/usr/bin/env node
/**
 * The tool's own entry point.
 *
 * §05.5/§10.1 — the download-prompt default is set by the *entry point*, not by
 * the core: `0` here because the user explicitly asked for us, `1` in a
 * package-manager shim because they did not ask to download anything. Both are
 * `??=` so a real environment variable still wins.
 */

import { defaultEnv, ENV } from "./config/env-vars.ts";

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
