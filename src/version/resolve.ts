import { ENV } from "../config/env-vars.ts";
import { getDefinition, isPerHost, isSupportedPackageManager } from "../config/table.ts";
import { envDisabled, envFlag } from "../project/env.ts";
import { messages, UsageError } from "../errors-cold.ts";
import {
  isPrerelease,
  isValidRange,
  isValidVersion,
  major,
  parse,
  rangeNamesPrerelease,
  rcompare,
  satisfiesWithPrereleases,
} from "./semver.ts";
import { findInstalledVersion, readLastKnownGood, writeLastKnownGood } from "../cache/store.ts";
import type { Descriptor, LazyLocator, Locator } from "../types.ts";

export interface ResolveOptions {
  allowTags?: boolean;
  /** `use` and `up` pass `false` so "give me the latest" consults the registry. */
  useCache?: boolean;
}

/**
 * The registry client, loaded only by the branches that talk to it.
 *
 * A warm, exactly-pinned run answers from the store at step 4 and never reaches
 * any of the three call sites below. Importing `registry` statically would still
 * drag `http` and `integrity` — and through them `node:crypto` and `node:zlib` —
 * into every single invocation, which is precisely what §01.3's budget and
 * §16, Build shape's syscall shape rule out.
 */
function loadRegistry(): Promise<typeof import("../net/registry.ts")> {
  return import("../net/registry.ts");
}

/**
 * §04.1 — the six steps, in order.
 *
 * Order matters in ways that are easy to get wrong: the cache probe (step 4)
 * comes **before** the exact-version passthrough (step 5); tags resolve against
 * the **last** range entry's registry, not a per-version one; and the range
 * query fans out over every band **in parallel** and unions, because a range
 * like `>=1` legitimately spans Yarn Classic (npm) and Yarn Berry.
 *
 * Every registry this hands to the client is the band's own `registry`, which
 * §02.2 guarantees is an npm one. Where that package is actually *fetched*
 * from — §05.2's variables, §05.3's `.npmrc` — is resolved inside the fetchers,
 * not here.
 */
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
    if (isSupportedPackageManager(name) && !envFlag(ENV.ENABLE_UNSAFE_CUSTOM_URLS)) {
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

    // A tag the **table** answers is settled here, before any request is made.
    // `node@lts` is the only one, and `ToolDefinition.tags` records why npm's own
    // tags cannot answer it. Two consequences worth naming: the value skips
    // §04.1's age gate, because a compiled-in literal is this table choosing —
    // the same act as `default`, which is likewise never gated — rather than the
    // registry choosing on the user's behalf; and `node@lts` resolves with zero
    // requests, so it works offline and inside §01.3's cold budget.
    //
    // `Object.hasOwn`, not a bare index: `node@constructor` is a tag as far as
    // step 3 is concerned, and an inherited property is not an answer.
    const table = definition.tags;
    if (table !== undefined && Object.hasOwn(table, range)) {
      range = table[range]!;
    } else {
      // §02.3 — dist-tags are a property of the newest distribution channel, so
      // they always resolve against the **last** range entry's registry, never a
      // per-version one.
      const lastEntry = definition.ranges[definition.ranges.length - 1]!;
      const tagRegistry = lastEntry[1].registry;
      const { capToReleaseAge, fetchAvailableTags } = await loadRegistry();
      const tags = await fetchAvailableTags(tagRegistry);
      if (!Object.hasOwn(tags, range)) {
        throw new UsageError(messages.tagNotFound(range));
      }
      // §04.1 — a tag is the registry choosing on the user's behalf, so the
      // minimum-release-age gate applies to it just as it does to step 6's range
      // query; only step 5's exact version is exempt. `capToReleaseAge` returns
      // its argument, and makes no request at all, when the gate is off.
      range = await capToReleaseAge(tagRegistry, tags[range]!);
    }
  }

  // 4 — the cache probe, and it comes **before** step 5. For an exact version
  // both steps return the same reference, so §04.3 makes this a single `stat`
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
  // the user never typed; §04.1 maps that 404 onto a "version does not exist"
  // message in phase 2.
  if (isValidVersion(range)) {
    return { name, reference: range };
  }

  // 6 — fan out over every band in parallel and union the results: a range like
  // `>=1` legitimately spans Yarn Classic (the `yarn` package) and Yarn Berry
  // (`@yarnpkg/cli-dist`), so querying only the matching band would lose half
  // the candidates.
  //
  // Lenient band classification strips prerelease suffixes, but resolution must
  // not select a prerelease unless the range names one or the user opts in.
  const wantsPrereleases = envFlag(ENV.ENABLE_PRERELEASES) || rangeNamesPrerelease(range);

  // §04.1 — `fetchResolvableVersions` is `fetchAvailableVersions` with the
  // minimum-release-age gate applied: same request, same `Accept` header, same
  // answer while `JUP_MINIMUM_RELEASE_AGE` is unset. When it *is* set and a
  // band's source publishes no release dates (a private registry that strips
  // `time`), the band reports that instead of quietly resolving from it — but
  // only a band that actually matches something refuses, so `yarn@^1.22` is
  // unaffected by the Berry band it also fans out over.
  const { fetchResolvableVersions, undatedSourceError } = await loadRegistry();
  const perBand = await Promise.all(
    definition.ranges.map(async ([, spec]) => {
      const candidates = await fetchResolvableVersions(spec.registry);
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
 * §04.6 — the global default, consulted only when the project has no usable spec.
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
    // §02.4 — recorded per-host references cannot carry digests. Treat such an
    // LKG entry as damaged derived state: retain the version and drop the suffix.
    const parsed = parse(recorded);
    if (parsed !== null && parsed.build.length > 0 && isPerHost({ name, reference: recorded })) {
      const healed = parsed.version;
      // Rewrite it, so the repair is paid once rather than on every run and so
      // `info` stops reporting a digest that means nothing. Best-effort for the
      // same reason the write below is (§07.8): an unwritable store must still
      // be able to *run*.
      try {
        writeLastKnownGood({ ...lkg, [name]: healed });
      } catch {
        // Intentionally ignored — the in-memory repair is what this run needs.
      }
      return healed;
    }
    return recorded;
  }

  // 2 — the compiled-in, hash-pinned version. Still no network.
  if (envDisabled(ENV.DEFAULT_TO_LATEST)) {
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
 * §02.1, §04.6 — the fallback locator, whose reference is a **thunk**.
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
    // The transparent default is a major-line floor, not an unconditional
    // override of the user's recorded default.
    return {
      name,
      reference: () => Promise.resolve(transparentFallback(name, transparentDefault)),
    };
  }

  return { name, reference: () => getDefaultVersion(name) };
}

/**
 * The transparent-command floor is major-wise: `4.0.0` meets a `4.2.0` floor, while `3.99.99` does not. This preserves the configured major without forcing minor upgrades.
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
