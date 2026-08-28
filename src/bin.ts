#!/usr/bin/env node
/**
 * The tool's own entry point, **from a source checkout**.
 *
 * A published install runs `bin/jup.mjs` instead — the static file
 * `package.json`'s `bin` points at, whose body is `cliEntrySource()` and which
 * imports the bundle rather than these sources. This file is what `node
 * src/bin.ts` runs: the test harness, `pnpm dev`, and nothing a user's `PATH`
 * ever reaches. Two entries, so the four lines below are duplicated there and
 * the two must not drift; §15.20's rows cover the one that can be observed from
 * outside, which is the download-prompt default.
 *
 * §05.5/§10.1 — the download-prompt default is set by the *entry point*, not by
 * the core: `0` here because the user explicitly asked for us, `1` in a
 * package-manager shim because they did not ask to download anything. Both are
 * `??=` so a real environment variable still wins.
 */

const nodeModule = process.getBuiltinModule("node:module");
import { defaultEnv, ENV } from "./config/env-vars.ts";

// Reached through the namespace, not a destructured name: `enableCompileCache`
// is optional, and `?.()` on a missing property is a no-op where a missing
// binding would be a crash on runtimes that do not implement it.
nodeModule.enableCompileCache?.();

defaultEnv(ENV.ENABLE_DOWNLOAD_PROMPT, "0");

const { runMain } = await import("./main.ts");

/**
 * Leave `exitCode` undefined after successful in-process handover: package
 * manager hooks run later and may set it only while it remains undefined.
 */
const code = await runMain(process.argv.slice(2));
if (code !== 0) process.exitCode = code;
