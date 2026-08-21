/**
 * Library surface.
 *
 * The CLI is the product; this export exists so the resolution engine can be
 * embedded (and so the package has a meaningful `exports` entry).
 */

export type * from "./types.ts";
export { UsageError } from "./errors.ts";
export { classifyInvocation, runMain } from "./main.ts";
export { discoverProjectSpec, parseSpec } from "./manifest.ts";
export { resolveDescriptor } from "./resolve.ts";
export { ensureInstalled } from "./install.ts";
