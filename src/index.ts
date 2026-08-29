/**
 * The package's `exports` entry — one function.
 *
 * `runMain` is what `bin/jup.mjs`, every shim and every embedder already call,
 * and the CLI's own routing (§09) reaches the rest of jup from there. The
 * narrower entry points this file used to re-export — `parseArgs`, `parseSpec`,
 * `findProjectSpec`, `resolveSpec`, `ensureInstalled`, `UsageError` and the
 * types — were each a second contract to hold stable for callers who had not
 * asked for one. They stay internal until someone does: adding an export later
 * is a minor release, taking one back is not.
 *
 * The smaller surface also keeps the module graph honest. A static re-export of
 * `version/resolve.ts` or `cache/install.ts` would put §04's tag lookup and
 * range fan-out, and the whole download-and-verify stack (`http`, `tar`,
 * `integrity`, `registry`, `node:crypto`, `node:zlib`), into the graph of every
 * entry that reaches this file — including the shims, on every invocation
 * (§16, Build shape). Both were wrapped in `await import()` for that reason;
 * not exporting them at all is the same guarantee with nothing to maintain.
 */
export { runMain } from "./main.ts";
