/**
 * Version resolution — §04.
 *
 * Descriptor in, Locator out (or `null`, meaning "no release matches").
 */

import type { Descriptor, LazyLocator, Locator } from "./types.ts";

export interface ResolveOptions {
  allowTags?: boolean;
  /** `use` and `up` pass `false` so "give me the latest" consults the registry. */
  useCache?: boolean;
}

/**
 * §04.1 — the six steps, in order.
 *
 * Order matters in ways that are easy to get wrong: the cache probe (step 4)
 * comes **before** the exact-version passthrough (step 5); tags resolve against
 * the **last** range entry's registry, not a per-version one; and the range
 * query fans out over every band **in parallel** and unions, because a range
 * like `>=1` legitimately spans Yarn Classic (npm) and Yarn Berry.
 */
export function resolveDescriptor(
  descriptor: Descriptor,
  options?: ResolveOptions,
): Promise<Locator | null> {
  throw new Error(`TODO(T14): resolveDescriptor(${descriptor.name}@${descriptor.range})`);
}

/**
 * §04.5 — the global default, consulted only when the project has no usable spec.
 *
 * Step 1 (a last-known-good hit) returns with **no network**, which is why a
 * machine that has ever run online keeps working offline. `COREPACK_DEFAULT_TO_LATEST=0`
 * returns the compiled-in default, also with no network.
 */
export function getDefaultVersion(name: string): Promise<string> {
  throw new Error(`TODO(T14): getDefaultVersion(${name})`);
}

/**
 * §02.1, §04.5 — the fallback locator, whose reference is a **thunk**.
 *
 * Preserving the laziness is the difference between "an offline project with a
 * pinned version works" and "every invocation hits the network". Transparent
 * commands whose definition declares `transparent.default` use that literal and
 * never consult `getDefaultVersion` at all.
 */
export function getFallbackLocator(name: string, options: { transparent: boolean }): LazyLocator {
  throw new Error(`TODO(T14): getFallbackLocator(${name})`);
}

/**
 * §04.7 — advance the recorded default after a successful install, but only
 * within the same major and only strictly upward. If there is no existing entry,
 * nothing is written.
 */
export function bumpLastKnownGood(locator: Locator): void {
  throw new Error(`TODO(T14): bumpLastKnownGood(${locator.name}@${locator.reference})`);
}
