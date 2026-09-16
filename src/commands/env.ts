/**
 * `jup env` — shell integration for the runtimes, §09.18.
 *
 * A shim resolves the tool on every invocation, which is correct and costs a
 * process start each time. This command answers the same resolution once, for
 * the shell, so the runtime's own `bin` directory can be put on `PATH` ahead of
 * the shims and the common case stops paying the trampoline at all (§10.7's
 * "living beside a version manager" is the opt-in this is).
 *
 * The resolution here composes the same primitives the proxy path composes, in
 * §01.3's own order — the same precedent `info`'s report follows — because the
 * one property this command cannot violate is agreement: the `node` a
 * `jup env` puts on `PATH` must be the `node` `jup node` would hand over. Where
 * the two may differ it is documented below, and the difference is always in
 * the direction of the shims staying authoritative.
 */

const { dirname, join } = process.getBuiltinModule("node:path");
import { getTableSpec, isRuntime, resolveSpecBin, SUPPORTED_NAMES } from "../config/table.ts";
import { findProjectSpec, reconcile } from "../project/manifest.ts";
import { getFallbackLocator, resolveSpec } from "../version/resolve.ts";
import { readKnownResolution, usesLockfile } from "../project/lockfile.ts";
import { findInstalledVersion, readInstalledSpec } from "../cache/store.ts";
import { messages, UsageError } from "../errors-cold.ts";
import { parse, isValidVersion } from "../version/semver.ts";
import type { LazyResolvedSpec, ResolvedSpec, Spec } from "../types.ts";

/**
 * What `jup env` resolves for one runtime entry: the reference §01.3 would
 * settle on, and where its executables are, when they are already in the store.
 */
export interface RuntimeEnvironment {
  name: string;
  /** The resolved reference, exactly as a locator carries it (§04.1). */
  reference: string;
  /**
   * The directory holding the runtime's own executables, or `null` when the
   * resolved version is not installed — this command installs nothing, and a
   * missing version is the shims' business, not a failure here.
   */
  binDir: string | null;
  installed: boolean;
}

/**
 * Resolve every runtime the table declares (§02.3 — `node` is the only one
 * today), as a run of that runtime from `cwd` would resolve it.
 *
 * Throws whatever the resolution throws; the caller owns the policy that a
 * failing resolution must never break a shell. Deliberately narrower than the
 * proxy path in the one place it may be: an expired memo does **not** stand in
 * when the registry is unreachable (§04.4's availability fallback). The shim
 * would answer from it, and this command would rather say nothing than guess
 * where the store cannot confirm — a `PATH` that falls back to the shims is
 * slow and correct, which is the failure mode this command already has.
 */
export async function resolveRuntimeEnvironments(cwd: string): Promise<RuntimeEnvironment[]> {
  const resolved: RuntimeEnvironment[] = [];
  for (const name of SUPPORTED_NAMES) {
    if (!isRuntime(name)) continue;
    resolved.push(await resolveRuntimeEnvironment(cwd, name));
  }
  return resolved;
}

/**
 * §01.3 steps 3–6 for one runtime, minus the install and the handover.
 *
 * The mirror is line-for-line where it can be — the same walk options, the same
 * reconcile, the same lockfile-then-memo-then-pin-then-registry order — and the
 * divergences are two, both about writing: nothing is installed on a miss (the
 * shims download on demand), and no memo is recorded when the registry answers
 * (the next shim run records it, from the same resolution this one made). The
 * one derived-state write that can still happen is inside the shared resolver
 * itself (§04.6's default refresh), which is the same write any run makes.
 */
async function resolveRuntimeEnvironment(cwd: string, name: string): Promise<RuntimeEnvironment> {
  // Step 3 — the same walk the proxy makes for this tool: `projectSpecFlag`
  // because §03.5's escape must mean the manifest is never parsed here either,
  // and `tool` because a runtime reads `devEngines.runtime` and the version
  // file, not the package manager's pair (§02.3).
  const specResult = findProjectSpec(cwd, { projectSpecFlag: true, tool: name });

  // The fallback thunk, unforced: forcing it reads `lastKnownGood.json` and
  // may reach the network, and a pinned project never needs it.
  const fallback: LazyResolvedSpec = getFallbackLocator(name, {
    transparent: false,
    project: specResult,
  });

  // Step 4 — reconcile. A runtime is never enforced against (§03.5), so the
  // only inputs that matter are the project's own runtime spec and the
  // fallback; there is no CLI version override to carry.
  const reconciled = reconcile(specResult, fallback, { requestedName: name, transparent: false });
  const descriptor: Spec =
    "range" in reconciled ? reconciled : { name, range: await reconciled.reference() };

  // §04.4 — the directory whose `jup.lock` files govern, under the same three
  // conditions the proxy applies: the spec came from the project (a fallback
  // descriptor is the machine's default, not the project's statement), and the
  // spec is not already exact.
  const projectDir =
    specResult.type === "Found" && "range" in reconciled && usesLockfile(descriptor)
      ? dirname(specResult.target)
      : undefined;

  // Step 5 — recorded resolution, memo, exact pin, in that order. The expired
  // memo is read and deliberately dropped: see {@link resolveRuntimeEnvironments}.
  const files: { locator: ResolvedSpec | null } =
    projectDir === undefined ? { locator: null } : readKnownResolution(projectDir, descriptor);
  const known = files.locator ?? exactPin(descriptor);
  const resolved = known ?? (await resolveSpec(descriptor, { allowTags: true }));
  // `null`, not an error, is §04.1's "the range matches nothing" answer, and
  // the sentence for it is the one the proxy path prints (§12.4) — the caller
  // swallows it, but a swallowed failure should still say what failed.
  if (resolved === null) throw new UsageError(messages.failedToResolve(descriptor.range, name));
  const locator: ResolvedSpec = resolved;

  // Step 6, halved — one `.jup` read to learn what is installed, and no
  // download for what is not.
  //
  // A reference that is not a version — a custom URL pin (§04.1 step 1) — is
  // left unaccelerated rather than probed: the store has no marker keyed by the
  // URL, and the shims already own fetching what a URL names.
  const installed = parse(locator.reference) === null ? null : readInstalledSpec(locator);

  // §08.1 — the marker's own `bin` map, with the table's entry standing in for
  // a marker that carries none (§07.10). `binDir` is the directory of the
  // runtime's own entry, which for a native band is where every name it
  // dispatches on lives.
  const tableSpec = getTableSpec(locator);
  const bin = installed?.bin ?? (tableSpec === undefined ? undefined : resolveSpecBin(tableSpec));
  const entry = bin?.[name];

  return {
    name,
    reference: locator.reference,
    binDir:
      installed !== null && entry !== undefined ? dirname(join(installed.location, entry)) : null,
    installed: installed !== null,
  };
}

/**
 * §04.1 step 4 before step 5, exactly as the proxy's own `resolveExactPin`:
 * the store answers an exact pin with the bare version — shedding any digest
 * suffix, so the marker's hash is re-attached rather than demanded as a
 * directory name — and a miss is the version the user wrote, unchecked.
 */
function exactPin(descriptor: Spec): ResolvedSpec | null {
  if (!isValidVersion(descriptor.range)) return null;
  const cached = findInstalledVersion(descriptor.name, descriptor.range);
  return { name: descriptor.name, reference: cached ?? descriptor.range };
}
