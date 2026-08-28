/**
 * Entry point — argv classification and dispatch (§01.2), plus top-level error
 * presentation (§08.4, §12.1).
 */

import { dirname } from "node:path";
import { ENV } from "./config/env-vars.ts";
import {
  getDefinition,
  getPackageManagerFor,
  getTableSpec,
  isPerHost,
  isSupportedPackageManager,
  resolveSpecBin,
} from "./config/table.ts";
import { envDisabled, envFlag } from "./project/env.ts";
import { advisory, messages, UsageError } from "./errors.ts";
import { execPackageManager } from "./run/exec.ts";
import {
  type CachedResolution,
  type KnownResolution,
  readKnownResolution,
  usesLockfile,
  writeCachedResolution,
} from "./project/lockfile.ts";
import { CLI_SOURCE, discoverProjectSpec, parseSpec, reconcile } from "./project/manifest.ts";
import { isValidVersion, parse } from "./version/semver.ts";
import { findInstalledVersion, readInstalledSpec, referenceWithHash } from "./cache/store.ts";
import type {
  Descriptor,
  InstallSpec,
  Invocation,
  LazyLocator,
  Locator,
  SpecResult,
} from "./types.ts";

/** §01.2 — the classification regex. `[^@]*` is deliberate; see below. */
const ARG0_RE = /^([^@]*)(?:@(.*))?$/;

/**
 * §01.2 — match `arg0` against `/^([^@]*)(?:@(.*))?$/`.
 *
 * A known binary name means proxy mode. Otherwise, an `@` in the argument still
 * means proxy mode with an *unknown* package manager — that is how
 * `corepack foo@1.2.3` reaches "Unsupported package manager specification"
 * instead of the CLI's "unknown command". Everything else is management mode.
 *
 * The `[^@]*` is deliberate: `@scope/pkg@1.0.0` never matches as a name.
 */
export function classifyInvocation(argv: string[]): Invocation {
  const arg0 = argv[0];

  // No arguments at all is the CLI's business (`--help`), not the proxy's.
  if (arg0 === undefined || arg0 === "") {
    return { mode: "management", args: argv };
  }

  const match = ARG0_RE.exec(arg0);
  // The regex cannot fail — both groups are optional — but the type says it can.
  const binaryName = match?.[1] ?? arg0;
  const rawVersion = match?.[2];

  const known = getPackageManagerFor(binaryName) !== undefined;
  // `rawVersion !== undefined` means the argument contained an `@`, even when
  // nothing followed it: `corepack foo@` is a proxy invocation for an unknown
  // package manager, exactly as corepack's `packageManager == null &&
  // binaryVersion == null` test decides.
  if (!known && rawVersion === undefined) {
    return { mode: "management", args: argv };
  }

  // Corepack's `binaryVersion || null`: a trailing `@` with nothing after it is
  // not a version override, so `corepack yarn@` behaves exactly like `yarn`.
  const invocation: Invocation = { mode: "proxy", binaryName, args: argv.slice(1) };
  if (rawVersion !== undefined && rawVersion !== "") {
    invocation.binaryVersion = rawVersion;
  }
  return invocation;
}

/**
 * §01.4 — a command is transparent iff `prefix[0] === binaryName` and every
 * remaining prefix segment equals the corresponding argument.
 *
 * Transparent commands are bootstrapping commands: `pnpx foo` inside a Yarn
 * project must not be an error.
 */
export function isTransparentCommand(binaryName: string, args: string[]): boolean {
  const name = getPackageManagerFor(binaryName);
  if (name === undefined) return false;

  // The prefixes belong to the package manager the *binary* resolves to, which
  // is why `pnpx` (a pnpm binary) matches pnpm's `["pnpx"]` prefix.
  const definition = getDefinition(name);
  if (definition === undefined) return false;

  for (const prefix of definition.transparent.commands) {
    if (prefix[0] !== binaryName) continue;
    // `every` over the *leading* segments only; extra arguments are the
    // command's own and are ignored (`yarn dlx foo` is still `yarn dlx`).
    if (prefix.slice(1).every((segment, index) => segment === args[index])) return true;
  }
  return false;
}

/**
 * §15.31 — the spellings of "operate outside this project" that count.
 *
 * `--location=global` is npm's; `--location global` is the same flag written
 * apart and is handled by the scan below.
 */
const GLOBAL_FLAGS = new Set(["-g", "--global", "--location=global"]);

/**
 * §15.31 — does this invocation carry a global flag as a **leading** argument?
 *
 * #690: `npm install -g corepack@latest` inside a yarn-pinned project dies on
 * §03.5's name mismatch, blocking the tool's own documented upgrade path. A
 * global command operates outside the project by definition, so it is treated
 * exactly like a transparent command (§01.4).
 *
 * Where the scan **stops** is the whole argument: a `-g` further along belongs
 * to whatever the package manager is about to run, not to the package manager.
 *
 * * `--` ends it — `npm run build -- -g` passes `-g` to the script.
 * * A *second* operand ends it. The first is the subcommand (`install`, `exec`);
 *   what follows is that subcommand's own argument, and `npm exec foo -g` hands
 *   `-g` to `foo`.
 *
 * The other direction is deliberate: `npm install foo -g`, where npm's own
 * parser would still see the flag, is **not** recognised. That leaves the
 * pre-existing mismatch error standing, which is a refusal to guess rather than
 * a regression — guessing wrong the other way would let an argument the user
 * never wrote bypass the project's pin.
 */
export function isGlobalInvocation(args: string[]): boolean {
  let operands = 0;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") return false;

    // A bare `-` is an operand (stdin), not an option.
    if (arg.length > 1 && arg.startsWith("-")) {
      if (GLOBAL_FLAGS.has(arg)) return true;
      // `--location global`: consume the value so it is not counted as the
      // subcommand it would otherwise displace.
      if (arg === "--location") {
        if (args[index + 1] === "global") return true;
        index++;
      }
      continue;
    }

    if (++operands > 1) return false;
  }

  return false;
}

/** §01.3 — the hot path: classify, resolve, ensure installed, hand over. */
export async function runProxy(
  invocation: Extract<Invocation, { mode: "proxy" }>,
): Promise<number> {
  const { binaryName, binaryVersion, args } = invocation;

  // Step 1–2. Everything here is a pure table lookup; the *reference* stays a
  // thunk, because forcing it reads `lastKnownGood.json` and may hit the
  // network — which the §01.3 budget forbids on a warm, pinned run.
  const name = getPackageManagerFor(binaryName);
  // §15.31 — a global invocation is transparent for the same reason a
  // bootstrapping command is: neither one is asking the project for anything.
  const transparent =
    name !== undefined && (isTransparentCommand(binaryName, args) || isGlobalInvocation(args));
  const requestedName = name ?? binaryName;
  const fallback: LazyLocator =
    name === undefined
      ? {
          name: binaryName,
          // An unknown binary has no default to fall back to. Reaching for one
          // is precisely §12.2's name-only "unsupported specification" case.
          reference: () => Promise.reject(new UsageError(messages.unsupportedSpec(binaryName))),
        }
      : { name, reference: () => fallbackReference(name, transparent) };

  // Step 3 — one `package.json` read plus at most two env-file opens per
  // directory walked. The env file it loads is applied to `process.env` here,
  // before anything reads a `COREPACK_*` variable below.
  const cwd = process.cwd();
  // `projectSpecFlag` — §03.5's "never look at the project at all" has to mean
  // the manifest is never parsed either, or a malformed `package.json` still
  // fails the very run `COREPACK_ENABLE_PROJECT_SPEC=0` was set to rescue. The
  // walk still happens, because the env file it loads is what may set the flag.
  // §15.39 — `tool` is what makes this the spec *for the requested tool*: a
  // runtime reads `devEngines.runtime` and a package manager reads the pair it
  // always read. Passing the resolved name rather than the binary name is what
  // makes `bunx` ask bun's question and `nubx` ask nub's; an unknown binary
  // answers `packageManager`, which is the path it already took to §12.2.
  const specResult = discoverProjectSpec(cwd, { projectSpecFlag: true, tool: requestedName });

  // §03.6 — auto-pin runs *before* reconciliation, and only here: it is a proxy
  // -mode-only behaviour, so `reconcile` deliberately leaves it to this caller.
  if (
    specResult.type === "NoSpec" &&
    envFlag(ENV.ENABLE_AUTO_PIN) &&
    !envDisabled(ENV.ENABLE_PROJECT_SPEC)
  ) {
    await autoPin(specResult, fallback);
  }

  // Step 4 — reconcile. A `Found` spec whose name matches comes back as a plain
  // descriptor, so the fallback thunk is never forced on the fast path.
  const reconciled = reconcile(specResult, fallback, { requestedName, transparent, binaryVersion });
  const descriptor = await materialise(reconciled);

  // A descriptor naming something outside the table cannot be resolved. Routing
  // it back through `parseSpec` reports §12.2's "unsupported specification"
  // rather than §12.4's build-support assertion, and lets a URL reference for an
  // unknown package manager through untouched (§04.1 step 1).
  if (!isSupportedPackageManager(descriptor.name)) {
    parseSpec(`${descriptor.name}@${descriptor.range}`, CLI_SOURCE, {
      requireVersion: false,
    });
  }

  // §15.23 — a project spec that is a range or a tag is answered by the recorded
  // `jup.lock`, then by the cache beside it; an exact pin never touches either.
  const projectDir = resolutionDirFor(specResult, reconciled, descriptor, binaryVersion);

  // Step 5 — resolution, in the order §15.23 fixes: the committed decision, the
  // cached memo, the exact pin, and only then a request. For an exact pin this
  // is answered inline by {@link resolveExactPin}; for a recorded range it is
  // one `jup.lock` read and nothing else.
  // §15.23's order — recorded, then unexpired memo — is `readKnownResolution`,
  // shared with `install` (§09.2) so a warmed layer and the run it warms cannot
  // disagree about which version the files already name.
  const files: KnownResolution =
    projectDir === undefined
      ? { locator: null, cached: null }
      : readKnownResolution(projectDir, descriptor);

  // The memo, expired or not: `resolveWithFallback` needs it as the stale answer
  // of last resort.
  const cached = files.cached;

  // What a file (or the pin itself) already said. `null` here is what marks a
  // run as having had to go out and ask, which is the only kind worth memoing.
  const known = files.locator ?? resolveExactPin(descriptor);

  // {@link Resolved.fromRegistry} is the memo-write condition, decided where the
  // answer is produced rather than inferred back here — see the type.
  const resolved: Resolved =
    known === null
      ? await resolveWithFallback(descriptor, cached)
      : { locator: known, fromRegistry: false };
  const locator = resolved.locator;

  // Step 6 — one `.jup` read on a hit; download, verify and promote on a miss.
  const installSpec = await ensureInstalledLazily(locator, descriptor.range);

  // §15.23 — this path never writes the project's recorded resolution: that file
  // changes only when the user runs `jup use` or `jup up`. What it may write is
  // the memo in `node_modules`, and only when the answer came from the registry
  // — re-stamping an unexpired entry would churn a file for no new fact, and
  // re-stamping an *expired* one that only stood in because the network was down
  // would quietly turn an outage into a pin. The hash comes from the artifact
  // now on disk, so the memo names the same bytes either way.
  if (projectDir !== undefined && resolved.fromRegistry) {
    writeCachedResolution(projectDir, descriptor, locator, installSpec.hash, isPerHost(locator));
  }

  // Step 7 — hand over. Nothing after this point may write to the store: the
  // package manager owns the process from here (§08.2).
  // §08.1 — `installSpec.bin ?? spec.bin`: the embedded table's entry stands in
  // for a marker that carries no `bin` of its own (§07.10).
  const tableSpec = getTableSpec(locator);

  // On the JavaScript path this resolves with 0 immediately and the package
  // manager sets the real exit code from its own module body, which runs
  // strictly after this returns — never wrap that in a catch (§08.4). On
  // §15.28's native path it is the child's own exit code, and awaiting it is the
  // only way to have one.
  return await execPackageManager(
    binaryName,
    installSpec,
    args,
    // §15.28 — `{exe}`-substituted, so a Windows fallback names `bin\\bun.exe`.
    tableSpec === undefined ? undefined : resolveSpecBin(tableSpec),
    tableSpec?.exec,
    // §15.28 — the argv this name needs in front of the user's, where the
    // artifact cannot recover the name it was invoked under (`pnpx` → `dlx`).
    tableSpec?.binArgs?.[binaryName],
  );
}

/**
 * §08.4, §12.1 — a `UsageError` in proxy mode prints bare on stderr; in
 * management mode it prints `Usage Error: …` on **stdout**, then a blank line,
 * then the usage line. Anything else prints with a stack, because a stack trace
 * is the correct output for a bug.
 */
export async function runMain(argv: string[]): Promise<number> {
  const invocation = classifyInvocation(argv);

  try {
    if (invocation.mode === "proxy") {
      return await runProxy(invocation);
    }
    // Loaded lazily: the proxy path is the hot one and must not pay for the
    // command surface it never touches (§16.3).
    const { runManagementCommand } = await import("./commands/cli.ts");
    return await runManagementCommand(invocation.args);
  } catch (error) {
    return await presentError(error, invocation);
  }
}

/**
 * §08.4's error table, isolated so both branches of §12.1 are testable without
 * a process.
 *
 * Returns the exit code rather than exiting, so a caller that still has work to
 * do keeps control.
 *
 * Asynchronous only because of the usage table: the management-mode branch is
 * the *only* thing on the whole warm graph that reads `usage.ts`, and a
 * successful proxy run — the path that runs on every invocation forever — never
 * reaches it. See {@link usageLineFor}.
 */
export async function presentError(error: unknown, invocation: Invocation): Promise<number> {
  if (error instanceof UsageError) {
    if (invocation.mode === "proxy") {
      // Bare, on stderr, no stack: the user typed something the project forbids,
      // and a stack would only bury the sentence that explains it.
      process.stderr.write(`${error.message}\n`);
      return 1;
    }

    // Management mode puts it on **stdout**, with the offending command's usage
    // line underneath. The stream split between the two modes is test-asserted.
    const usage = await usageLineFor(invocation.args[0]);
    process.stdout.write(`Usage Error: ${error.message}\n\n${usage}\n`);
    return 1;
  }

  // Anything else is a bug — ours or the runtime's — and a stack trace is the
  // correct output for a bug (corepack 0.31.0 regressed exactly this).
  process.stderr.write(`${formatUnexpected(error)}\n`);
  return 1;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * §01.3 step 6 — the marker first, the downloader only if it is missing.
 *
 * `install` is the head of the whole cold-path stack (`http`, `tar`,
 * `integrity`, `registry`, and through them `node:crypto` and `node:zlib`), and
 * a warm run executes none of it. Reading the marker here — one `open` either
 * way, exactly as §16.3 budgets — keeps that stack out of the process entirely
 * unless something actually has to be downloaded.
 */
async function ensureInstalledLazily(locator: Locator, range: string): Promise<InstallSpec> {
  const installed = readInstalledSpec(locator);
  if (installed !== null) return installed;

  const { ensureInstalled } = await import("./cache/install.ts");
  try {
    return await ensureInstalled(locator);
  } catch (error) {
    // §15.19 / §15.35j — the download's own message names a URL the user never
    // typed. `parse` is already on the warm path, so recovering the version
    // costs nothing on the path that does not throw.
    const version = parse(locator.reference)?.version;
    const what = { name: locator.name, range, ...(version === undefined ? {} : { version }) };
    // `errors-cold.ts` rather than `errors.ts`: §12's download and network
    // vocabulary is the largest thing the warm chunk was carrying and could
    // never print (§16.3). The import is free here — `install.ts` above already
    // pulled the cold stack in, and this branch only runs when it threw.
    const { explainFetchFailure } = await import("./errors-cold.ts");
    throw explainFetchFailure(error, what) ?? error;
  }
}

/**
 * §04.1 steps 4 and 5, for the one case the fast path exists to serve: an exact
 * pin. It is a transcription of `resolveDescriptor`'s two middle steps, not a
 * shortcut past them — see the ordering note below.
 *
 * Steps 1–3 cannot apply to an exact version (a URL is not one, and neither is a
 * tag), and step 6 is unreachable once step 5 has answered. So for this
 * descriptor the two files agree by construction, and answering here is what
 * keeps `resolve.ts` — the tag lookup, the registry client's entry points, the
 * range fan-out and `lastKnownGood.json` — out of the warm module graph
 * entirely.
 *
 * Everything this declines takes the full {@link resolveOrExplain} path.
 */
function resolveExactPin(descriptor: Descriptor): Locator | null {
  // A name outside the table has no §04.1 step 2 definition, and the error for
  // it belongs to the full path. Step 1's URL branch is unreachable from here,
  // since a URL is never a valid version.
  if (!isSupportedPackageManager(descriptor.name)) return null;
  if (!isValidVersion(descriptor.range)) return null;

  // Step 4 **before** step 5, exactly as §04.1 orders them, and the order is
  // load-bearing rather than incidental: a cache hit answers with the bare
  // version, and shedding the `+<hash>` suffix is what makes §07.2 re-attach the
  // marker's hash instead of demanding a store directory qualified by the pin.
  // Returning `descriptor.range` unconditionally sends every hash-bearing pin
  // back to the registry. One `stat`, which is what §16.3 budgets (§14.1).
  const cached = findInstalledVersion(descriptor.name, descriptor.range);
  return { name: descriptor.name, reference: cached ?? descriptor.range };
}

/** §15.19 — the same diagnostic around resolution, which is where a range fails. */
async function resolveOrExplain(descriptor: Descriptor): Promise<Locator | null> {
  const { resolveDescriptor } = await import("./version/resolve.ts");
  try {
    return await resolveDescriptor(descriptor, { allowTags: true });
  } catch (error) {
    const { explainFetchFailure } = await import("./errors-cold.ts");
    throw explainFetchFailure(error, descriptor) ?? error;
  }
}

/**
 * §04.5's fallback reference, behind the same dynamic import.
 *
 * `getFallbackLocator` is a pure table lookup that hands back a thunk, so moving
 * the lookup *into* the thunk changes nothing observable — the laziness that
 * matters (no `lastKnownGood.json` read, no network) is unchanged, and the
 * module itself now loads only when something actually forces the fallback.
 */
async function fallbackReference(name: string, transparent: boolean): Promise<string> {
  const { getFallbackLocator } = await import("./version/resolve.ts");
  return await getFallbackLocator(name, { transparent }).reference();
}

/**
 * §12.1 — the usage line appended to a management-mode `Usage Error:`.
 *
 * Keyed by the command word, falling back to the generic line for anything
 * unrecognised. Loaded on demand: `usage.ts` also carries `--help`'s full
 * synopsis, and neither string has any business being parsed by a `yarn --version`
 * that succeeds.
 */
async function usageLineFor(command: string | undefined): Promise<string> {
  const { GENERIC_USAGE_LINE, USAGE_LINES } = await import("./commands/usage.ts");
  return command !== undefined && Object.hasOwn(USAGE_LINES, command)
    ? USAGE_LINES[command]!
    : GENERIC_USAGE_LINE;
}

/**
 * What step 5 settled on, and whether the **registry** is what settled it.
 *
 * `fromRegistry` is the memo-write condition, stated on the branch that knows
 * the answer. It replaces an inference made at the call site — `locator !==
 * cached?.locator`, object identity on a value returned three frames away — and
 * the explicit form is not a matter of taste: any normalisation on the way back
 * (a digest re-attached, a reference rebuilt for §15.28's host map) makes that
 * test permanently true, which re-stamps the expired memo the registry never
 * confirmed and turns an outage into a 24-hour pin — the very thing the comment
 * above the write says it is preventing.
 */
interface Resolved {
  locator: Locator;
  fromRegistry: boolean;
}

/**
 * §15.5's availability statuses — `http.ts`'s retry set, for its reason.
 *
 * Everything else in the 4xx range is a statement about the *request* — 401 and
 * 403 about the credential, 404 about the version — and an older answer does not
 * make such a statement less true.
 */
function isAvailabilityStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * A stand-in URL, used to cut §12.6's template at the slot its URL fills.
 *
 * NUL occurs in the template exactly once and survives `redactUserinfo` — it is
 * not a parseable URL and matches no `scheme://userinfo@` — so the text before
 * it is that sentence's literal prefix, read off the one definition of it rather
 * than copied into a second one.
 */
const URL_SLOT = "\u0000";

/**
 * §15.23 — whether an expired memo may answer *for this failure*.
 *
 * §15.23 scopes the fallback to "an unreachable or degraded registry", so this
 * is a positive allowlist of §12.6's two transport shapes and everything else
 * propagates. Failing open here is worse than failing outright, because the
 * stamp is not extended: a swallowed error recurs silently on every run, and the
 * project stays on yesterday's version with no diagnostic ever printed.
 *
 * What must therefore never reach the fallback: `COREPACK_ENABLE_NETWORK=0` and
 * `COREPACK_MINIMUM_RELEASE_AGE`, which are security controls — `net/registry.ts`
 * states the rule for both, that a control reporting success without having been
 * applied is worse than one that stops; **401 and 403**, where a rotated
 * credential is a permanent failure and the fallback would pin the project on it
 * indefinitely; and **404** and §15.4's TLS sentences, which are true about what
 * was asked for however old the memo is.
 */
async function isRegistryUnavailable(error: unknown): Promise<boolean> {
  // A `UsageError` is jup answering "you asked for something that cannot be
  // done", never "the registry is down": §12.4's tag and range failures,
  // §15.19's offline diagnostic (which {@link resolveOrExplain} has already made
  // one through `explainFetchFailure`), §15.35e's two release-age refusals.
  if (!(error instanceof Error) || error instanceof UsageError) return false;

  // Cold, and only on a failure: `errors-cold.ts` must stay off the warm graph
  // (§16.3), which is also why this cannot be a synchronous predicate.
  const { messages: coldMessages, parseBadStatus } = await import("./errors-cold.ts");

  // `parseBadStatus` is `messages.badStatus` read back — an inverse the errors
  // module already maintains and tests — and the prefix below is taken from its
  // template, so neither can drift from the sentence it matches.
  const bad = parseBadStatus(error);
  if (bad !== null) return isAvailabilityStatus(bad.status);

  const [prefix] = coldMessages.requestFailed(URL_SLOT).split(URL_SLOT);
  return prefix !== undefined && prefix.length > 0 && error.message.startsWith(prefix);
}

/** The memo's version as a user would write it: §07.2's digest suffix is ours. */
function versionOf(cached: CachedResolution): string {
  const { reference } = cached.locator;
  return parse(reference)?.version ?? reference;
}

/**
 * Resolve for real, falling back to an expired memo when the **registry** fails.
 *
 * The TTL exists so a range keeps moving, not so a laptop stops working on a
 * train: an entry that has aged out is still the last thing the registry
 * actually said, and answering with it beats failing a run that succeeded an
 * hour ago. This is §04.4's rule for `lastKnownGood.json`, applied to the file
 * that plays the same part for a project.
 *
 * It is a rule about *availability* and nothing else, which is what
 * {@link isRegistryUnavailable} scopes it to, and it says so out loud when it
 * engages. `cached` is non-null here only when expired: an entry inside its
 * window has already answered as `known`.
 */
async function resolveWithFallback(
  descriptor: Descriptor,
  cached: CachedResolution | null,
): Promise<Resolved> {
  let resolved: Locator | null = null;
  try {
    resolved = await resolveOrExplain(descriptor);
  } catch (error) {
    if (cached === null || !(await isRegistryUnavailable(error))) throw error;
    // Cold: the text lives in `errors-cold.ts` for the reason that file exists,
    // and this branch has already taken that import to classify the failure.
    const { messages: coldMessages } = await import("./errors-cold.ts");
    advisory(
      coldMessages.staleResolutionUnreachable(descriptor.name, descriptor.range, versionOf(cached)),
    );
    return { locator: cached.locator, fromRegistry: false };
  }

  if (resolved !== null) return { locator: resolved, fromRegistry: true };

  // `null` is the registry answering with nothing that matches — a truncated
  // packument, a band that lost its releases — which is the "degraded" half of
  // §15.23's condition. The memo is range-gated on the way in, so it still
  // satisfies what the registry no longer offers.
  if (cached !== null) {
    const { messages: coldMessages } = await import("./errors-cold.ts");
    advisory(
      coldMessages.staleResolutionUnmatched(descriptor.name, descriptor.range, versionOf(cached)),
    );
    return { locator: cached.locator, fromRegistry: false };
  }

  throw new UsageError(messages.failedToResolve(descriptor.range, descriptor.name));
}

/**
 * §15.23 — the directory whose `jup.lock` files govern this run, or `undefined`
 * when no lockfile is involved.
 *
 * Three conditions, all necessary:
 *
 * * The spec came from the **project**. A fallback descriptor (`NoProject`,
 *   `NoSpec`, or a transparent-command mismatch) is the machine's default, not
 *   the project's statement, and recording it in the project would pin a version
 *   the project never asked for. `reconcile` returns the manifest's descriptor
 *   as a `Descriptor` and the fallback as a `LazyLocator`, so the `range in`
 *   test distinguishes them exactly.
 * * No CLI version override. `corepack yarn@1.22.4 …` is a one-invocation
 *   override (§04.6) and must leave the project's recorded resolution alone.
 * * The spec is not already exact (or a URL) — {@link usesLockfile}.
 *
 * The directory is the manifest's own, not the cwd: in a monorepo those differ,
 * and §03.7 already places project-level writes beside the selected manifest.
 */
function resolutionDirFor(
  specResult: SpecResult,
  reconciled: Descriptor | LazyLocator,
  descriptor: Descriptor,
  binaryVersion: string | undefined,
): string | undefined {
  if (specResult.type !== "Found" || binaryVersion !== undefined) return undefined;
  if (!("range" in reconciled)) return undefined;
  if (!usesLockfile(descriptor)) return undefined;
  return dirname(specResult.target);
}

/**
 * Force a lazy fallback into a concrete descriptor.
 *
 * This is the *only* place the fallback thunk is forced, which is what keeps the
 * warm path free of `lastKnownGood.json` reads and network requests.
 */
async function materialise(value: Descriptor | LazyLocator): Promise<Descriptor> {
  if ("range" in value) return value;
  return { name: value.name, range: await value.reference() };
}

/**
 * §03.6 — resolve, install, announce, pin. Only reached on `NoSpec`, only in
 * proxy mode, only with `COREPACK_ENABLE_AUTO_PIN=1`.
 *
 * The install happens *before* the notice because it is what produces the hash:
 * the pin this writes is hash-bearing, and therefore verifiable on every later
 * run.
 */
async function autoPin(specResult: SpecResult, fallback: LazyLocator): Promise<void> {
  // The CLI's `binaryVersion` deliberately does not participate: corepack pins
  // the project's *default*, then runs whatever the CLI asked for.
  const descriptor = await materialise(fallback);

  const locator = await resolveOrExplain(descriptor);
  if (locator === null) {
    throw new UsageError(messages.failedToResolve(descriptor.range, descriptor.name));
  }

  const installSpec = await ensureInstalledLazily(locator, descriptor.range);

  // §03.6 — "installing yields the hash, so the written pin is hash-bearing".
  // A download rewrites `locator.reference` itself; a cache hit does not, so the
  // marker's recorded hash supplies the same suffix. Both paths therefore pin
  // exactly the artifact that is on disk.
  const reference = referenceWithHash(locator.name, locator.reference, installSpec.hash);

  process.stderr.write(
    `${messages.autoPinNotice(locator.name, reference)}\n${messages.autoPinDocs()}\n\n`,
  );

  // §03.7 — the pin goes next to the manifest the walk selected, which in a
  // monorepo is the root rather than the directory the user was standing in.
  const { writePin } = await import("./project/pin.ts");
  const { target } = writePin(dirname(specResult.target), {
    name: locator.name,
    reference,
    hash: installSpec.hash,
  });

  // §15.27, §15.35l — "it also covers the auto-pin case in §03.6". On **stderr**:
  // this is proxy mode, and stdout belongs entirely to the package manager
  // (§09.11), so a line on it would corrupt `yarn --version | read`.
  process.stderr.write(`${messages.updatedManifest(target, locator.name, reference)}\n`);
}

/** Everything that is not a `UsageError` keeps its stack (§08.4). */
function formatUnexpected(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}
