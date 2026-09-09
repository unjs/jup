const { dirname } = process.getBuiltinModule("node:path");
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
import {
  findInstalledVersion,
  isDefaultFresh,
  readLastKnownGood,
  recordLastKnownGood,
} from "../cache/store.ts";
import { readDeclaredFormat } from "../project/lockfile-format.ts";
import { debugNote } from "../utils/log.ts";
import type { Spec, LazyResolvedSpec, ProjectSpec, ResolvedSpec } from "../types.ts";

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
export async function resolveSpec(
  descriptor: Spec,
  options?: ResolveOptions,
): Promise<ResolvedSpec | null> {
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
 * Step 1 (a fresh last-known-good hit) returns with **no network**, which is why
 * a machine that has ever run online keeps working offline.
 * `COREPACK_DEFAULT_TO_LATEST=0` returns the compiled-in default, also with no
 * network. An entry the TTL has aged out is re-checked but never *discarded*: it
 * stands as the answer whenever the check cannot be made.
 */
export async function getDefaultVersion(name: string): Promise<string> {
  const definition = getDefinition(name);
  if (definition === undefined) {
    throw new UsageError(messages.unsupportedByBuild(name));
  }

  // 1 — the recorded default answers, unless §04.6's TTL has aged it out. The
  // repair happens before the freshness test, not inside it, so a stale entry
  // that fails to refresh still falls back to a *healed* reference.
  const lkg = readLastKnownGood();
  const recorded = healRecordedDefault(name, lkg);
  if (recorded !== undefined && isDefaultFresh(name)) {
    return recorded;
  }

  // 2 — the compiled-in, hash-pinned version. Still no network. A recorded entry
  // outranks it even when stale: turning the TTL's re-check into a silent switch
  // to a different version is the one thing this step was never asked to do.
  if (envDisabled(ENV.DEFAULT_TO_LATEST)) {
    return recorded ?? definition.default;
  }

  // The refresh is the only reason to be here, and it needs the network. Ask
  // before dialling so §11.1's switch reads as "keep what you have", not as a
  // failure this function then has to swallow.
  if (recorded !== undefined && envDisabled(ENV.ENABLE_NETWORK)) {
    return recorded;
  }

  // 3 — the only branch that reaches the registry.
  let reference: string;
  try {
    const { fetchLatestStableVersion } = await loadRegistry();
    reference = await fetchLatestStableVersion(definition.fetchLatestFrom);
  } catch (error) {
    // An entry that is merely *stale* is still an answer, and until §04.6 grew a
    // TTL this path was never even reached for it. Falling back on **any**
    // failure — not just §04.4's availability set — is what keeps that promise:
    // a rotated token, a proxy that 403s, a registry that lost the package must
    // not start failing runs that worked yesterday. With no entry there is
    // nothing to fall back to and the failure is the answer.
    if (recorded === undefined) throw error;
    debugNote(`kept the recorded default ${name}@${recorded}: ${String(error)}`);
    return recorded;
  }

  // Recording is bookkeeping: an unwritable store must degrade (the next run
  // asks the registry again), never fail the run. `writeLastKnownGood` already
  // swallows filesystem errors, so this only guards the unexpected. The
  // reference and its stamp are one `rename`, so no crash can separate them.
  try {
    recordLastKnownGood(name, reference, Date.now());
  } catch {
    // Intentionally ignored — see above.
  }

  return reference;
}

/**
 * §02.4 — recorded per-host references cannot carry digests. Treat such an LKG
 * entry as damaged derived state: retain the version and drop the suffix.
 */
function healRecordedDefault(name: string, lkg: Record<string, string>): string | undefined {
  const recorded = lkg[name];
  if (recorded === undefined) return undefined;

  const parsed = parse(recorded);
  if (parsed === null || parsed.build.length === 0) return recorded;
  if (!isPerHost({ name, reference: recorded })) return recorded;

  const healed = parsed.version;
  // Rewrite it, so the repair is paid once rather than on every run and so
  // `info` stops reporting a digest that means nothing. The stamp is left as it
  // was: this changes the reference's *spelling*, not when it was last checked.
  // Best-effort for the same reason §04.6's own write is (§07.8): an unwritable
  // store must still be able to *run*.
  try {
    recordLastKnownGood(name, healed);
  } catch {
    // Intentionally ignored — the in-memory repair is what this run needs.
  }
  return healed;
}

/**
 * §02.1, §04.6 — the fallback locator, whose reference is a **thunk**.
 *
 * Preserving the laziness is the difference between "an offline project with a
 * pinned version works" and "every invocation hits the network". Transparent
 * commands whose definition declares `transparent.default` use that literal and
 * never consult `getDefaultVersion` at all.
 */
export function getFallbackLocator(
  name: string,
  options: { transparent: boolean; project?: ProjectSpec },
): LazyResolvedSpec {
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

  // §04.6 — a project with no spec is not necessarily silent: the lockfile its
  // package manager committed names the format, and so the major, that wrote it.
  // Only `NoSpec` offers a directory — `NoProject` found no manifest, so a
  // `pnpm-lock.yaml` beside the user is nobody's statement — and a transparent
  // command is not asking the project (§01.4).
  const projectDir =
    options.transparent || options.project?.type !== "NoSpec"
      ? undefined
      : dirname(options.project.target);

  return {
    name,
    reference: async () =>
      (await inferredDefaultVersion(name, projectDir)) ?? (await getDefaultVersion(name)),
  };
}

/**
 * §04.6 — the default a package manager's own lockfile implies, or `null`.
 *
 * `null` means "no opinion" — no file, or a format every current major writes —
 * and §04.6's recorded default then decides as it always did. A resolution
 * failure answers `null` too: this is a better guess than the global default,
 * never a reason to fail a run that would otherwise have had one.
 *
 * The range resolves through {@link resolveSpec}, so an already-installed major
 * answers from the store with no request (§04.1 step 4), and nothing is
 * recorded: what one project's lockfile implies is not this machine's default.
 */
async function inferredDefaultVersion(
  name: string,
  projectDir: string | undefined,
): Promise<string | null> {
  if (projectDir === undefined) return null;
  // §03.5 — "never look at the project at all" has to include this file too.
  if (envDisabled(ENV.ENABLE_PROJECT_SPEC)) return null;

  const declared = readDeclaredFormat(projectDir, name);
  if (declared === null) return null;

  try {
    const locator = await resolveSpec({ name, range: declared.range }, { allowTags: false });
    if (locator === null) return null;
    debugNote(
      `${declared.path} is lockfileVersion ${declared.format}, so ${name} defaults to ` +
        `${locator.reference} (${declared.range}) rather than the recorded default`,
    );
    return locator.reference;
  } catch (error) {
    debugNote(
      `could not resolve ${name}@${declared.range} from ${declared.path}: ${String(error)}`,
    );
    return null;
  }
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
