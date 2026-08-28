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

// Access the optional compile cache through the default export: a named import
// would fail at link time on runtimes that do not implement it.
nodeModule.enableCompileCache?.();

defaultEnv(ENV.ENABLE_DOWNLOAD_PROMPT, "0");

const { runMain } = await import("./main.ts");

/**
 * Leave `exitCode` undefined after successful in-process handover: package
 * manager hooks run later and may set it only while it remains undefined.
 */
const code = await runMain(process.argv.slice(2));
if (code !== 0) process.exitCode = code;
