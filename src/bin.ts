#!/usr/bin/env node
/**
 * The tool's own entry point.
 *
 * §05.5/§10.1 — the download-prompt default is set by the *entry point*, not by
 * the core: `0` here because the user explicitly asked for us, `1` in a
 * package-manager shim because they did not ask to download anything. Both are
 * `??=` so a real environment variable still wins.
 */

process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT ??= "0";

const { runMain } = await import("./main.ts");

process.exitCode = await runMain(process.argv.slice(2));
