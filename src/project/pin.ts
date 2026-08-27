/**
 * Writing the pin — §03.7, as amended by §15.26 and §15.27.
 *
 * Split out of `manifest.ts` because only `use`, `up` and §03.6's auto-pin ever
 * reach it, while `manifest.ts` itself is on the warm path: every `yarn`, `npm`
 * and `pnpm` invocation on the machine reads a manifest, and none of them
 * rewrites one. Statically importing this from there put the rewriter — and,
 * through `json-write.ts`, the format-preserving JSON editor and `node:os` — in
 * every one of those processes (§16.3).
 *
 * The callers keep it out by loading it the way §16.3 asks: `main.ts` behind an
 * `await import` in its auto-pin branch, `cli.ts` directly, since the whole
 * command surface is already cold.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { messages } from "../errors.ts";
import {
  detectFormat,
  scanTopLevelKey,
  setNestedString,
  setTopLevelString,
} from "../utils/json-write.ts";
import { parseManifest } from "../utils/json.ts";
import { integrityFromHash } from "./lockfile.ts";
import { discoverProjectSpec, warnOrThrow } from "./manifest.ts";
import { isValidVersion, parse, satisfies } from "../version/semver.ts";
import type { DevEnginesDeclaration, Manifest } from "../types.ts";

/**
 * §03.7, as amended by §15.26 and §15.27 — write the pin.
 *
 * Preserves indentation, line endings, key order, and (per §14.7) the BOM.
 * Returns the previous value for `COREPACK_MIGRATE_FROM`, and the path actually
 * modified so the caller can print it (§15.35l).
 *
 * **Which field gets written** is §15.26's whole subject, and the rule has three
 * branches rather than one:
 *
 * | Manifest declares | Written |
 * |---|---|
 * | `packageManager` only, or neither | `packageManager` |
 * | `devEngines.packageManager` for **this** package manager, no `packageManager` | `devEngines.packageManager.version` (+ `integrity`) |
 * | both, for this package manager | `packageManager`; `devEngines` left alone |
 *
 * Row two is #874: `corepack use pnpm@latest` on a devEngines-only project
 * writes a top-level `packageManager` that then conflicts with the declaration
 * beside it — a hash-presence difference is enough — so the very next run fails
 * §03.3. The fix is not to create the second field at all.
 *
 * Row three needs no `devEngines` update *because* nothing broke: the value
 * being written already satisfies the declared range, which is exactly what the
 * check above establishes, and rewriting `1.x || 2.x` into `2.4.3` would destroy
 * the statement of intent that §09.4 relies on to carry `up` across a major.
 * §15.26's post-write requirement — "validation MUST run against the state being
 * written" — is met by the check being the same predicate §03.3 applies on read,
 * with the same `onFail`.
 *
 * When the declared name is a *different* package manager, `devEngines` is not
 * describing this pin at all: the mismatch is reported through `onFail` and,
 * if that does not throw, the pin goes to `packageManager` where a reader can
 * still see both statements.
 */
export function writePin(
  cwd: string,
  info: { name: string; reference: string; hash?: string },
  options?: { here?: boolean; pinStyle?: PinStyle },
): { previousPackageManager: string; target: string; written: string } {
  // 1 — re-run discovery: the file to edit is not necessarily in `cwd`. §15.27's
  // extra stop conditions apply here and only here, because this is the write.
  const lookup = discoverProjectSpec(cwd, { mutating: true, here: options?.here === true });
  const target = lookup.target;
  const declared = lookup.type === "Found" ? lookup.devEngines : undefined;
  const range = lookup.type === "Found" ? lookup.range : undefined;

  // 3 — a missing file is an empty document, so `NoProject` creates one. It is
  // read *before* the validation below because §15.26 requires that validation
  // to run against the state being **written**, and what is about to be written
  // depends on which fields the file already has.
  let content = "";
  if (lookup.type !== "NoProject") {
    try {
      content = readFileSync(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  // 4 — tolerant read: BOM stripped for parsing, empty content is `{}`.
  let data: Manifest = {};
  try {
    const parsed = parseManifest(content);
    if (typeof parsed === "object" && parsed !== null) {
      data = parsed as Manifest;
    }
  } catch {
    // `use` must be able to overwrite a manifest it cannot fully parse only as
    // far as the surgical edit allows; `setTopLevelString` re-validates below.
  }

  const devEnginesTarget = devEnginesWriteTarget(data, declared, info);

  // 2 — the package manager being pinned must be the one `devEngines` declares,
  // *and* its version must satisfy the declared range. Checking only the version
  // lets `use pnpm@6.6.2` succeed in a project whose devEngines say `yarn@6.x`,
  // writing a pin that then fails §03.3's name check on every subsequent run —
  // permanently, since nothing but a hand edit can undo it.
  //
  // §15.26 — the name half runs even when no version is declared. Corepack (and
  // this implementation before now) only reached the check through the *range*,
  // so `devEngines: {packageManager: {name: "yarn"}}` imposed nothing at all on
  // `corepack use pnpm@6`, and the resulting manifest was one §03.3 rejects by
  // default on every later run.
  //
  // The version half is skipped for exactly one shape — see
  // {@link devEnginesWriteTarget} — because there is nothing left to violate
  // once the declared value is the value being replaced. That is §15.26's
  // "validation MUST run against the state being written, not the state on disk".
  if (declared !== undefined && info.name !== declared.name) {
    warnOrThrow(
      messages.devEnginesPinMismatch(
        info.name,
        info.reference,
        declared.name,
        declared.version ?? "*",
      ),
      declared.onFail,
    );
  } else if (
    range !== undefined &&
    !devEnginesTarget.replacesDeclaredVersion &&
    !satisfies(info.reference, range.range)
  ) {
    warnOrThrow(
      messages.devEnginesPinMismatch(info.name, info.reference, range.name, range.range),
      range.onFail,
    );
  }

  // 6 — what the package manager's own `use` command is told to migrate from.
  const previousPackageManager =
    typeof data.packageManager === "string"
      ? data.packageManager
      : range === undefined
        ? "unknown"
        : `${range.name}@${range.range}`;

  // 5, 7, 8 — the rewrite preserves indentation, line endings, key order and the
  // BOM; the reference carries its freshly computed hash suffix.
  //
  // §15.26 — "a command that writes a pin MUST update **every** field that
  // encodes it", so the two writes compose rather than choosing between each
  // other. A `devEngines` write that could not be made surgically falls back to
  // the top-level field: writing the pin somewhere is always better than writing
  // it nowhere and reporting success.
  // §15.12 — `--pin-style=sidecar` moves the digest out of the version string
  // and into `devEngines.packageManager.integrity`, creating the block when the
  // manifest has none. The suffixed form stays the default: it is the
  // interoperable spelling and §13 asserts it.
  const sidecar = options?.pinStyle === "sidecar";

  let updated = content;
  let wroteDevEngines = false;
  if (devEnginesTarget.write || sidecar) {
    const next = sidecar
      ? writeSidecarPin(updated, data, info)
      : writeIntoDevEngines(updated, info);
    if (next !== null) {
      updated = next;
      wroteDevEngines = true;
    }
  }
  // What the pin field now holds, which is what the caller reports (§15.35l). It
  // differs from `info.reference` only in §15.12's sidecar form, where the
  // digest moved out of the version string and a line quoting the suffix would
  // name a string that is nowhere in the file.
  let written = info.reference;
  if (!devEnginesTarget.exclusive || !wroteDevEngines) {
    // A sidecar write that landed is what makes the clean version *readable*
    // again (§15.12 reads them as one pin); one that did not must keep the
    // suffix, or the pin would be written nowhere at all.
    if (sidecar && wroteDevEngines) written = parse(info.reference)?.version ?? info.reference;
    updated = setTopLevelString(updated, "packageManager", `${info.name}@${written}`);
  }

  // 9 — in the `NoProject` case this creates `<cwd>/package.json`.
  writeFileSync(target, updated);

  // `target` goes back to the caller because §15.23's `.jup.lock` lives
  // beside *this* file, not beside the cwd — in a monorepo those differ, and a
  // resolution recorded next to the wrong manifest would never be found again.
  // §15.27 also requires it to be *printed*, and printing is the caller's job.
  return { previousPackageManager, target, written };
}

/**
 * §15.26 — which field (or fields) this pin belongs in.
 *
 * `devEngines.packageManager.version` is validated as a semver **range** (§03.3),
 * and the distinction between a range and an exact version is the one that
 * decides everything here:
 *
 * * an **exact** version is a *pin* — it says "this release" — so a mutating
 *   command replaces it, and there is nothing left for the version check to
 *   object to (`replacesDeclaredVersion`). This is #874's shape, where a
 *   hash-presence difference between the two fields is enough to make the next
 *   read fail;
 * * a **range** is a *constraint* — it says "anything in here" — so it is
 *   honoured, never overwritten. Collapsing `1.x || 2.x` into `2.4.3` would
 *   destroy the declaration §09.4 relies on to carry `corepack up` across a
 *   major boundary, and would silently narrow what the project accepts.
 *
 * `exclusive` is §15.26's second bullet: with no top-level `packageManager` the
 * pin goes into `devEngines` and **no** `packageManager` is created. Creating
 * one is what breaks #874.
 */
function devEnginesWriteTarget(
  data: Manifest,
  declared: DevEnginesDeclaration | undefined,
  info: { name: string; reference: string },
): { write: boolean; exclusive: boolean; replacesDeclaredVersion: boolean } {
  const none = { write: false, exclusive: false, replacesDeclaredVersion: false };

  // A declaration for a *different* package manager does not describe this pin;
  // the mismatch is reported through `onFail` and the pin goes to the top level,
  // where a reader can still see both statements.
  if (declared === undefined || declared.name !== info.name) return none;
  // A URL reference has no semver to record in a semver field.
  if (parse(info.reference) === null) return none;

  // A `packageManager` key that is present but not a string is a spec error the
  // user is about to have overwritten — write it at the top level, as before.
  const hasPin = typeof data.packageManager === "string";
  const hasBrokenPin =
    Object.hasOwn(data, "packageManager") && !hasPin && data.packageManager != null;
  if (hasBrokenPin) return none;

  const declaredExactVersion = declared.version !== undefined && isValidVersion(declared.version);

  if (!hasPin) {
    // §15.26 bullet 2 — the pin lives where the declaration already is.
    return { write: true, exclusive: true, replacesDeclaredVersion: declaredExactVersion };
  }

  // Both fields. `packageManager` is the one §03.3 reads, so it is always
  // written; `devEngines` is only rewritten when it was itself a pin.
  return {
    write: declaredExactVersion,
    exclusive: false,
    replacesDeclaredVersion: declaredExactVersion,
  };
}

/** §15.12 — where `use`/`up` put the digest. The suffixed form is the default. */
export type PinStyle = "suffix" | "sidecar";

/**
 * §15.12 — write the pin as a clean version plus a sidecar `integrity`.
 *
 * Returns `null` when the sidecar cannot be written, in which case the caller
 * falls back to the suffixed form: a pin written nowhere is worse than a pin
 * written in the interoperable spelling the user did not ask for.
 */
function writeSidecarPin(
  content: string,
  data: Manifest,
  info: { name: string; reference: string; hash?: string },
): string | null {
  const version = parse(info.reference)?.version;
  if (version === undefined || info.hash === undefined) return null;

  const integrity = integrityFromHash(info.hash);
  if (integrity === undefined) return null;

  const block = (data.devEngines as { packageManager?: unknown } | undefined)?.packageManager;

  // No `devEngines` at all: create the block, name included — §03.3 reads
  // `name` first and a block without one describes nothing.
  if (!Object.hasOwn(data, "devEngines")) {
    return createDevEnginesBlock(content, info.name, version, integrity);
  }

  // A block that is not an object, or that speaks for a different package
  // manager, is not ours to rewrite.
  if (typeof block !== "object" || block === null || Array.isArray(block)) return null;
  const declaredName = (block as { name?: unknown }).name;
  if (declaredName !== undefined && declaredName !== info.name) return null;

  return writeIntoDevEngines(content, info);
}

/**
 * Insert a whole `devEngines.packageManager` block, preserving the document's
 * indentation, line endings and BOM.
 *
 * `json.ts` inserts *string* values only, which is all §15.26 ever needed. The
 * two-step here — insert a placeholder string under the key, then swap its value
 * span for the object literal — reuses that machinery rather than growing a
 * JSON builder for one caller, and re-parses the result before returning it so
 * a manifest is never left in a shape this could not read back.
 */
function createDevEnginesBlock(
  content: string,
  name: string,
  version: string,
  integrity: string,
): string | null {
  let seeded: string;
  try {
    seeded = setTopLevelString(content, "devEngines", "");
  } catch {
    return null;
  }

  const span = scanTopLevelKey(seeded, "devEngines");
  if (span === null) return null;

  // `json.ts` inserts a one-line entry into a one-line object and a
  // freshly-indented one into a multi-line object; the value has to match, or a
  // compact manifest gains a five-line block wedged into its single line.
  const head = seeded.slice(0, span.start);
  const inline = !head.slice(head.lastIndexOf("{")).includes("\n");

  const { indent, eol } = detectFormat(seeded);
  const at = (depth: number): string => indent.repeat(depth);
  const literal = inline
    ? JSON.stringify({ packageManager: { name, version, integrity } })
    : `{${eol}${at(2)}"packageManager": {${eol}` +
      `${at(3)}"name": ${JSON.stringify(name)},${eol}` +
      `${at(3)}"version": ${JSON.stringify(version)},${eol}` +
      `${at(3)}"integrity": ${JSON.stringify(integrity)}${eol}` +
      `${at(2)}}${eol}${at(1)}}`;

  const result = seeded.slice(0, span.start) + literal + seeded.slice(span.end);
  try {
    const parsed = parseManifest(result);
    if (typeof parsed !== "object" || parsed === null) return null;
  } catch {
    return null;
  }
  return result;
}

/**
 * §15.26 — write the pin into `devEngines.packageManager`, or `null` if the
 * surgical edit could not be made.
 *
 * The version written is the **plain** semver version and the digest goes to
 * `integrity` beside it (§15.12's shape), because `devEngines.packageManager.version`
 * is validated as a semver *range* by §03.3 and a `+sha512.…` suffix has no
 * business in one. `integrity` is only written when a usable digest is
 * available, and it is never left behind pointing at a version that has moved,
 * because it is rewritten in the same edit as the version it describes.
 */
function writeIntoDevEngines(
  content: string,
  info: { name: string; reference: string; hash?: string },
): string | null {
  const version = parse(info.reference)?.version;
  if (version === undefined) return null;

  const withVersion = setNestedString(
    content,
    ["devEngines", "packageManager", "version"],
    version,
  );
  if (withVersion === null) return null;

  if (info.hash === undefined) return withVersion;
  const integrity = integrityFromHash(info.hash);
  if (integrity === undefined) return withVersion;

  return (
    setNestedString(withVersion, ["devEngines", "packageManager", "integrity"], integrity) ??
    withVersion
  );
}
