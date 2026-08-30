#!/usr/bin/env node
/**
 * The tool's own entry point, **from a source checkout**.
 *
 * A published install runs `bin/jup.mjs` instead — the static file
 * `package.json`'s `bin` points at, whose body is `cliEntrySource()` and which
 * imports the bundle rather than these sources. This file is what `node
 * src/bin.ts` runs: the test harness, `pnpm dev`, and nothing a user's `PATH`
 * ever reaches. Two entries, so the lines below are duplicated there and the two
 * must not drift.
 */

const nodeModule = process.getBuiltinModule("node:module");

// Reached through the namespace, not a destructured name: `enableCompileCache`
// is optional, and `?.()` on a missing property is a no-op where a missing
// binding would be a crash on runtimes that do not implement it.
nodeModule.enableCompileCache?.();

const { runMain } = await import("./main.ts");

/**
 * `handover: true` — §08.2's in-process handover, which only the *entry point*
 * can decide, because only it knows that nothing follows this call. `runMain`'s
 * own default is the safe one, for the programmatic callers who cannot say that
 * (§08.2, `RunOptions`).
 *
 * Leave `exitCode` undefined after successful in-process handover: package
 * manager hooks run later and may set it only while it remains undefined.
 */
const { code } = await runMain(process.argv.slice(2), { handover: true });
if (code !== 0) process.exitCode = code;
