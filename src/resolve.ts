/**
 * Version resolution — §04.
 *
 * Descriptor in, Locator out (or `null`, meaning "no release matches").
 */

import { getDefinition, isSupportedPackageManager } from "./config/table.ts";
import { envDisabled, envFlag } from "./env.ts";
import { messages, UsageError } from "./errors.ts";
import {
  fetchAvailableTags,
  fetchAvailableVersions,
  fetchLatestStableVersion,
} from "./registry.ts";
import {
  isValidRange,
  isValidVersion,
  lt,
  major,
  rcompare,
  satisfiesWithPrereleases,
} from "./semver.ts";
import { findInstalledVersion, readLastKnownGood, writeLastKnownGood } from "./store.ts";
import type {
  Descriptor,
  LazyLocator,
  Locator,
  PackageManagerSpec,
  RegistrySpec,
} from "./types.ts";

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
/**
 * §05.2 rewrite 1 — with a custom npm registry configured, a band's
 * `npmRegistry` replaces its `registry` **everywhere**, not only on the download
 * path.
 *
 * This is what makes Yarn Berry usable behind a corporate mirror at all:
 * repo.yarnpkg.com is not an npm registry and cannot be mirrored, so §02.5 gives
 * Berry an `@yarnpkg/cli-dist` fallback. Consulting it only when downloading
 * meant `yarn@latest` still resolved its tag from the public internet — which
 * fails outright behind a firewall, and leaks traffic the user asked to keep
 * internal everywhere else.
 */
function registryFor(spec: PackageManagerSpec): RegistrySpec {
  return hasRegistryOverride() && spec.npmRegistry !== undefined ? spec.npmRegistry : spec.registry;
}

/** Whether the user pointed us at a registry other than the built-in default. */
function hasRegistryOverride(): boolean {
  const configured = process.env.COREPACK_NPM_REGISTRY;
  return configured !== undefined && configured !== "";
}

export async function resolveDescriptor(
  descriptor: Descriptor,
  options?: ResolveOptions,
): Promise<Locator | null> {
  const allowTags = options?.allowTags ?? false;
  const useCache = options?.useCache ?? true;
  const { name } = descriptor;
  let range = descriptor.range;

  // 1 — a URL reference passes through untouched. For a *known* package manager
  // that is a supply-chain hole (the table's pinned, signed artifact is swapped
  // for whatever the field points at), so it takes an explicit opt-in. An
  // unknown name has no table entry to subvert and is always allowed through.
  if (URL.canParse(range)) {
    if (isSupportedPackageManager(name) && !envFlag("COREPACK_ENABLE_UNSAFE_CUSTOM_URLS")) {
      throw new UsageError(messages.illegalUrl(`${name}@${range}`));
    }
    return { name, reference: range };
  }

  // 2 — everything below needs the definition, so the unknown-name check is
  // here rather than at the top: step 1 must run first for an unknown name.
  const definition = getDefinition(name);
  if (definition === undefined) {
    throw new UsageError(messages.unsupportedByBuild(name));
  }

  // 3 — anything that is neither an exact version nor a range is a tag.
  if (!isValidVersion(range) && !isValidRange(range)) {
    if (!allowTags) {
      throw new UsageError(messages.tagsNotAllowed());
    }

    // §02.3 — dist-tags are a property of the newest distribution channel, so
    // they always resolve against the **last** range entry's registry, never a
    // per-version one. This is why `yarn@latest` consults repo.yarnpkg.com even
    // though `yarn@1.22.22` would come from npm.
    const lastEntry = definition.ranges[definition.ranges.length - 1]!;
    const tags = await fetchAvailableTags(registryFor(lastEntry[1]));
    if (!Object.hasOwn(tags, range)) {
      throw new UsageError(messages.tagNotFound(range));
    }
    range = tags[range]!;
  }

  // 4 — the cache probe, and it comes **before** step 5. For an exact version
  // both steps return the same reference, so §14.1 makes this a single `stat`
  // rather than a directory scan; for a range this is the whole fast path, and
  // the budget in §01.3 requires it to complete with zero network requests.
  if (useCache) {
    const cached = findInstalledVersion(name, range);
    if (cached !== null) {
      return { name, reference: cached };
    }
  }

  // 5 — an exact version is returned **without** verifying that it exists. A
  // typo therefore surfaces much later as a bare HTTP 404 naming a tarball URL
  // the user never typed; §15.35j maps that 404 onto a "version does not exist"
  // message in phase 2.
  if (isValidVersion(range)) {
    return { name, reference: range };
  }

  // 6 — fan out over every band in parallel and union the results: a range like
  // `>=1` legitimately spans Yarn Classic (npm) and Yarn Berry
  // (repo.yarnpkg.com), so querying only the matching band would lose half the
  // candidates.
  //
  // §15.24 (phase 2): `satisfiesWithPrereleases` strips the prerelease tag
  // before testing, so a published `11.0.0-dev.1005` satisfies `*` and then
  // sorts above every stable release. Phase 2 discards prerelease candidates
  // from *implicit* resolution unless the range itself names one.
  const perBand = await Promise.all(
    definition.ranges.map(async ([, spec]) => {
      const versions = await fetchAvailableVersions(registryFor(spec));
      return versions.filter((version) => satisfiesWithPrereleases(version, range));
    }),
  );

  const candidates = [...new Set(perBand.flat())].sort(rcompare);
  // `null`, not an error: the caller decides whether this is fatal, and formats
  // `messages.failedToResolve` with the range the *user* wrote.
  return candidates.length > 0 ? { name, reference: candidates[0]! } : null;
}

/**
 * §04.5 — the global default, consulted only when the project has no usable spec.
 *
 * Step 1 (a last-known-good hit) returns with **no network**, which is why a
 * machine that has ever run online keeps working offline. `COREPACK_DEFAULT_TO_LATEST=0`
 * returns the compiled-in default, also with no network.
 */
export async function getDefaultVersion(name: string): Promise<string> {
  const definition = getDefinition(name);
  if (definition === undefined) {
    throw new UsageError(messages.unsupportedByBuild(name));
  }

  // 1 — the recorded default wins outright, and reading it is the only I/O on
  // this path.
  const lkg = readLastKnownGood();
  const recorded = lkg[name];
  if (recorded !== undefined) {
    return recorded;
  }

  // 2 — the compiled-in, hash-pinned version. Still no network.
  if (envDisabled("COREPACK_DEFAULT_TO_LATEST")) {
    return definition.default;
  }

  // 3 — the only branch that reaches the registry.
  const reference = await fetchLatestStableVersion(definition.fetchLatestFrom);

  // Recording is bookkeeping: an unwritable store must degrade (the next run
  // asks the registry again), never fail the run. `writeLastKnownGood` already
  // swallows filesystem errors, so this only guards the unexpected.
  try {
    writeLastKnownGood({ ...lkg, [name]: reference });
  } catch {
    // Intentionally ignored — see above.
  }

  return reference;
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
  // Table lookups are pure, so doing this eagerly costs nothing; everything
  // that touches the disk or the network stays inside the thunk.
  const transparentDefault = options.transparent
    ? getDefinition(name)?.transparent.default
    : undefined;

  if (transparentDefault !== undefined) {
    // §15.33 (phase 2): corepack's `transparent.default ?? defaultVersion` makes
    // a compile-time constant unconditionally outrank the user's own recorded
    // default, so `install -g yarn@4.9.0` still leaves `yarn dlx` on the table's
    // pin. Phase 2 makes this literal a *floor*: use the last-known-good when
    // one exists and is at least as new. Phase 1 reproduces the override, and
    // that is exactly why this branch reads neither the LKG file nor the
    // network.
    return { name, reference: () => Promise.resolve(transparentDefault) };
  }

  return { name, reference: () => getDefaultVersion(name) };
}

/**
 * §04.7 — advance the recorded default after a successful install, but only
 * within the same major and only strictly upward. If there is no existing entry,
 * nothing is written.
 */
export function bumpLastKnownGood(locator: Locator): void {
  if (envDisabled("COREPACK_DEFAULT_TO_LATEST")) {
    return;
  }

  // "Supported (non-URL)": an unknown name has no default to advance, and a URL
  // reference is not a version at all.
  if (!isSupportedPackageManager(locator.name) || !isValidVersion(locator.reference)) {
    return;
  }

  const lkg = readLastKnownGood();
  const current = lkg[locator.name];

  // The entry is only ever *created* by §04.5 step 3 or by `install -g`. A
  // one-off `corepack yarn@4.9.0 …` must not silently become the global default.
  if (current === undefined || !isValidVersion(current)) {
    return;
  }

  // Major bumps are never automatic, and the comparison ignores build metadata,
  // so re-installing the same version with a different hash suffix writes
  // nothing.
  if (major(current) !== major(locator.reference) || !lt(current, locator.reference)) {
    return;
  }

  lkg[locator.name] = locator.reference;
  writeLastKnownGood(lkg);
}
