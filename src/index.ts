/**
 * Library surface.
 *
 * The CLI is the product; this export exists so the resolution engine can be
 * embedded (and so the package has a meaningful `exports` entry).
 */

import type { ResolveOptions } from "./resolve.ts";
import type { Descriptor, InstallSpec, Locator } from "./types.ts";

export type * from "./types.ts";
export { UsageError } from "./errors.ts";
export { classifyInvocation, runMain } from "./main.ts";
export { discoverProjectSpec, parseSpec } from "./manifest.ts";

/**
 * §04 — resolve a descriptor to a locator.
 *
 * Wrapped for the same reason as {@link ensureInstalled} below: a static
 * re-export would place `resolve.ts` — and with it §04.1's tag lookup and range
 * fan-out — in the module graph of every entry that reaches this file, which is
 * exactly the warm-chunk merge the proxy path was split to avoid (§16.3).
 */
export async function resolveDescriptor(
  descriptor: Descriptor,
  options?: ResolveOptions,
): Promise<Locator | null> {
  const resolve = await import("./resolve.ts");
  return await resolve.resolveDescriptor(descriptor, options);
}

/**
 * §07 — ensure a locator is installed, downloading and verifying it if not.
 *
 * Re-exported through a wrapper rather than directly, because a static
 * re-export puts the whole download-and-verify stack (`http`, `tar`,
 * `integrity`, `registry`, `node:crypto`, `node:zlib`) into the module graph of
 * anything that imports this entry — including the shims, for whom it is dead
 * weight on every invocation (§16.3).
 */
export async function ensureInstalled(
  locator: Locator,
  options?: { cacheOnly?: boolean },
): Promise<InstallSpec> {
  const install = await import("./install.ts");
  return install.ensureInstalled(locator, options);
}
