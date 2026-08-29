import type { ResolveOptions } from "./version/resolve.ts";
import type { Installation, ResolvedSpec, Spec } from "./types.ts";

export type * from "./types.ts";
export { UsageError } from "./errors.ts";
export { parseArgs, runMain } from "./main.ts";
export { findProjectSpec, parseSpec } from "./project/manifest.ts";

/**
 * §04 — resolve a {@link Spec}'s range to an exact {@link ResolvedSpec}.
 *
 * Wrapped for the same reason as {@link ensureInstalled} below: a static
 * re-export would place `resolve.ts` — and with it §04.1's tag lookup and range
 * fan-out — in the module graph of every entry that reaches this file, which is
 * exactly the warm-chunk merge the proxy path was split to avoid
 * (§16, Build shape).
 */
export async function resolveSpec(
  spec: Spec,
  options?: ResolveOptions,
): Promise<ResolvedSpec | null> {
  const resolve = await import("./version/resolve.ts");
  return await resolve.resolveSpec(spec, options);
}

/**
 * §07 — ensure a {@link ResolvedSpec} is installed, downloading and verifying
 * it if it is not.
 *
 * Re-exported through a wrapper rather than directly, because a static
 * re-export puts the whole download-and-verify stack (`http`, `tar`,
 * `integrity`, `registry`, `node:crypto`, `node:zlib`) into the module graph of
 * anything that imports this entry — including the shims, for whom it is dead
 * weight on every invocation (§16, Build shape).
 */
export async function ensureInstalled(
  resolved: ResolvedSpec,
  options?: { cacheOnly?: boolean },
): Promise<Installation> {
  const install = await import("./cache/install.ts");
  return install.ensureInstalled(resolved, options);
}
