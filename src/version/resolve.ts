/**
 * Version resolution — §04.
 *
 * Descriptor in, Locator out (or `null`, meaning "no release matches").
 */

import { getDefinition, isSupportedPackageManager } from "../config/table.ts";
import { envDisabled, envFlag } from "../project/env.ts";
import { messages, UsageError } from "../errors.ts";
import {
  isPrerelease,
  isValidRange,
  isValidVersion,
  major,
  rangeNamesPrerelease,
  rcompare,
  satisfiesWithPrereleases,
} from "./semver.ts";
import { findInstalledVersion, readLastKnownGood, writeLastKnownGood } from "../cache/store.ts";
import type {
  Descriptor,
  LazyLocator,
  Locator,
  PackageManagerSpec,
  RegistrySpec,
} from "../types.ts";

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

/**
 * The registry client, loaded only by the branches that talk to it.
 *
 * A warm, exactly-pinned run answers from the store at step 4 and never reaches
 * any of the three call sites below. Importing `registry` statically would still
 * drag `http` and `integrity` — and through them `node:crypto` and `node:zlib` —
 * into every single invocation, which is precisely what §01.3's budget and
 * §16.3's syscall shape rule out.
 */
function loadRegistry(): Promise<typeof import("../net/registry.ts")> {
  return import("../net/registry.ts");
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
    const tagRegistry = registryFor(lastEntry[1]);
    const { capToReleaseAge, fetchAvailableTags } = await loadRegistry();
    const tags = await fetchAvailableTags(tagRegistry);
    if (!Object.prototype.hasOwnProperty.call(tags, range)) {
      throw new UsageError(messages.tagNotFound(range));
    }
    // §15.35e — a tag is the registry choosing on the user's behalf, so the
    // minimum-release-age gate applies to it just as it does to step 6's range
    // query; only step 5's exact version is exempt. `capToReleaseAge` returns
    // its argument, and makes no request at all, when the gate is off.
    range = await capToReleaseAge(tagRegistry, tags[range]!);
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
  // §15.24 — `satisfiesWithPrereleases` strips the prerelease tag before
  // testing, so a published `11.0.0-dev.1005` satisfies `*` and then sorts above
  // every stable release: `corepack use pnpm` installs a dev build whenever one
  // is the semver maximum. That lenient rule is right where it *classifies a
  // version the user already chose* — the band lookup of §02.3, the cache probe
  // of §14.2 — and wrong here, where nobody chose anything.
  //
  // So the leniency stays and the **candidate set** narrows instead: a
  // prerelease is admitted only when the range names one, or when the user opted
  // in. That keeps `yarn@4.0.0-rc.1` resolving (step 5 returns it before this
  // code runs) and `>=4.0.0-rc.1` matching, while `*` no longer does.
  const wantsPrereleases = envFlag("COREPACK_ENABLE_PRERELEASES") || rangeNamesPrerelease(range);

  // §15.35e — `fetchResolvableVersions` is `fetchAvailableVersions` with the
  // minimum-release-age gate applied: same request, same `Accept` header, same
  // answer while `COREPACK_MINIMUM_RELEASE_AGE` is unset. When it *is* set and a
  // band's source publishes no release dates (§05.3's tags document), the band
  // reports that instead of quietly resolving from it — but only a band that
  // actually matches something refuses, so `yarn@^1.22` is unaffected by the
  // Berry band it also fans out over.
  const { fetchResolvableVersions, undatedSourceError } = await loadRegistry();
  const perBand = await Promise.all(
    definition.ranges.map(async ([, spec]) => {
      const candidates = await fetchResolvableVersions(registryFor(spec));
      const matched = candidates.versions.filter(
        (version) =>
          satisfiesWithPrereleases(version, range) && (wantsPrereleases || !isPrerelease(version)),
      );
      if (candidates.undatedSource !== undefined && matched.length > 0) {
        throw undatedSourceError(candidates.undatedSource);
      }
      return matched;
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
  const { fetchLatestStableVersion } = await loadRegistry();
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
    // §15.33 — corepack's `definition.transparent.default ?? defaultVersion`
    // makes a compile-time constant unconditionally outrank the user's own
    // recorded default, so `corepack install -g yarn@4.9.0` still leaves
    // `yarn dlx` on the table's pin with no way to override it (#202, #812).
    // The literal is a **floor**, not an override.
    return {
      name,
      reference: () => Promise.resolve(transparentFallback(name, transparentDefault)),
    };
  }

  return { name, reference: () => getDefaultVersion(name) };
}

/**
 * §15.33 — the recorded default, floored at `transparent.default`.
 *
 * **What "at least as new" means here is the major line, not the exact version**,
 * and the two readings genuinely differ: §15.33's own example has a user record
 * `yarn@4.9.0` against a table whose `transparent.default` is `4.14.1`, and row
 * 199 requires `yarn dlx` to run `4.9.0`. A literal version-wise floor answers
 * `4.14.1` there and fails the row. A major-wise floor satisfies both halves and
 * — decisively — is what the driving issue actually asks for: #812 is
 * `yarn create` reaching for Yarn **Classic** 1.22.22, unsupported since 2020,
 * because the recorded default is from an older *major line* than the modern
 * Yarn transparent commands need. Within the current line the user's own choice
 * is respected; below it, the table's floor applies.
 *
 * No network on either branch. A recorded default is read (one `readFileSync`,
 * still zero requests); with none, or with an unparseable one, the literal
 * stands.
 */
function transparentFallback(name: string, transparentDefault: string): string {
  const recorded = readLastKnownGood()[name];
  if (recorded === undefined) return transparentDefault;

  const recordedMajor = major(recorded);
  const floorMajor = major(transparentDefault);
  // `major` answers `NaN` for a reference it cannot parse — a URL, or a
  // hand-edited `lastKnownGood.json`. Neither is comparable, so the floor wins.
  if (Number.isNaN(recordedMajor) || Number.isNaN(floorMajor)) return transparentDefault;

  return recordedMajor >= floorMajor ? recorded : transparentDefault;
}
