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
import { messages, UsageError } from "../errors.ts";
import {
  detectFormat,
  scanNestedKey,
  setNestedString,
  setTopLevelString,
} from "../utils/json-write.ts";
import { parseManifest } from "../utils/json.ts";
import { getRoles } from "../config/table.ts";
import { integrityFromHash } from "./lockfile.ts";
import {
  discoverProjectSpec,
  type PinFields,
  PIN_FIELDS,
  pinFieldLabel,
  warnOrThrow,
} from "./manifest.ts";
import { isValidVersion, parse, satisfies } from "../version/semver.ts";
import type { DevEnginesDeclaration, Manifest, Role, SpecResult } from "../types.ts";

/**
 * §17.4 R11 — the role an **auto-pin** writes the pin for.
 *
 * R11 resolves a pin-writing command's role in four steps, and auto-pin (§03.6)
 * can reach only two of them: step 1 has no CLI scope word to read, because
 * auto-pin happens in proxy mode where the user typed a package manager's name
 * and nothing else, and step 3 has no declaration to read, because `NoSpec` —
 * the manifest declares nothing — is the only case auto-pin fires in.
 *
 * That leaves step 2, "the role under which the binary was invoked". **With
 * today's table there is nothing that distinguishes a package-manager use of a
 * dual-role binary from a runtime use.** R2 keeps the surface one flat namespace
 * (a user never writes `pm:bun`), R3 keeps roles data, and §02.4's binary map
 * answers a *name* with a *tool* — not with a tool and a role. Building a
 * bin-name-to-role map to answer it would be exactly the role-qualified lookup
 * R2 declines to require and R3 would make code out of.
 *
 * R11's last paragraph settles that case in as many words: "If even the
 * invocation is ambiguous, the `package-manager` role wins, because auto-pin's
 * own verbatim notice is about the `packageManager` field." So §17.9 row 232 —
 * auto-pin for the dual-role fixture with nothing declared, which must write a
 * pin rather than raise R11 step 4's usage error — is satisfied **by this
 * fallback**, and deliberately not by a role-qualified binary lookup.
 *
 * A tool with exactly one role needs none of this: it has one role, and that is
 * the one its pin goes in.
 */
export function autoRoleFor(name: string): Role {
  const roles = getRoles(name) ?? [];
  return roles.length === 1 ? roles[0]! : "package-manager";
}

/** One pin to write, and the role whose fields (§03's `PIN_FIELDS`) receive it. */
export interface PinWrite {
  role: Role;
  name: string;
  reference: string;
  hash?: string;
}

/** What one pin's write did, reported per pin because each names its own field. */
export interface PinWritten {
  role: Role;
  /** §09.5 — what `COREPACK_MIGRATE_FROM` carries; the literal `unknown` when there was none. */
  previousPin: string;
  /** §15.35l — what the field now holds; differs from the reference in §15.12's sidecar form. */
  written: string;
}

/**
 * §03.7, as amended by §15.26, §15.27 and §17.4 R10 — write the project's pins.
 *
 * Preserves indentation, line endings, key order, and (per §14.7) the BOM.
 * Returns the path actually modified so the caller can print it (§15.35l), plus
 * one result per pin.
 *
 * **Every pin lands in one write.** §17.4 R10's third consequence — "`up` writes
 * both pins in one atomic manifest update (§15.26), not one write per role" —
 * is why this takes a list rather than being called twice: the edits compose on
 * one string and there is exactly one `writeFileSync` below, so a manifest is
 * never left half-updated. With one pin, which is every project today, the
 * result is byte-identical to the single-pin write this replaces.
 *
 * **Which field gets written** is §15.26's whole subject, and for the
 * package-manager role the rule has three branches rather than one:
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
 *
 * A role with **no** top-level field (§17.5 R14: "There is no top-level `runtime`
 * field") has none of those branches, because it has nowhere else to go: its pin
 * is always written into its `devEngines` block, which is created when absent.
 */
export function writePin(
  cwd: string,
  pins: readonly PinWrite[],
  options?: { here?: boolean; pinStyle?: PinStyle },
): { target: string; results: PinWritten[] } {
  // 1 — re-run discovery: the file to edit is not necessarily in `cwd`. §15.27's
  // extra stop conditions apply here and only here, because this is the write.
  const lookup = discoverProjectSpec(cwd, { mutating: true, here: options?.here === true });
  const target = lookup.target;

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

  // Each pin edits the text the previous one produced; `data` stays the state on
  // disk, which is what §15.26's checks are about. Two roles never touch the
  // same field, so the order the list arrives in does not change the result.
  let updated = content;
  const results: PinWritten[] = [];
  for (const info of pins) {
    const written = writeOnePin(updated, data, lookup, info, options);
    updated = written.text;
    results.push({ role: info.role, previousPin: written.previousPin, written: written.written });
  }

  // 9 — in the `NoProject` case this creates `<cwd>/package.json`. One call, for
  // however many pins: R10's "not one write per role".
  writeFileSync(target, updated);

  // `target` goes back to the caller because §15.23's `.jup.lock` lives
  // beside *this* file, not beside the cwd — in a monorepo those differ, and a
  // resolution recorded next to the wrong manifest would never be found again.
  // §15.27 also requires it to be *printed*, and printing is the caller's job.
  return { target, results };
}

/** One pin's edit, applied to the text the previous pin left behind. */
function writeOnePin(
  content: string,
  data: Manifest,
  lookup: SpecResult,
  info: PinWrite,
  options: { pinStyle?: PinStyle } | undefined,
): { text: string; previousPin: string; written: string } {
  const fields = PIN_FIELDS[info.role];
  const pin = lookup.type === "Found" ? lookup.pins[info.role] : undefined;
  const declared = pin?.devEngines;
  const range = pin?.range;

  const devEnginesTarget = devEnginesWriteTarget(data, declared, info, fields);

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
  const existing = fields.top === undefined ? undefined : data[fields.top];
  const previousPin =
    typeof existing === "string"
      ? existing
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

  let text = content;
  let wroteDevEngines = false;
  if (devEnginesTarget.write || sidecar) {
    const next = sidecar
      ? writeSidecarPin(text, data, info, fields)
      : writeIntoDevEngines(text, info, fields);
    if (next !== null) {
      text = next;
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
    if (fields.top === undefined) {
      // §17.5 R14 — there is no second field to fall back to, and inventing one
      // is exactly what R14 forbids. A block write that could not be made
      // surgically is a manifest this could not understand, and saying so beats
      // reporting a success that wrote nothing.
      throw new UsageError(messages.pinFieldUnwritable(pinFieldLabel(info.role)));
    }
    text = setTopLevelString(text, fields.top, `${info.name}@${written}`);
  }

  return { text, previousPin, written };
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
  fields: PinFields,
): { write: boolean; exclusive: boolean; replacesDeclaredVersion: boolean } {
  const none = { write: false, exclusive: false, replacesDeclaredVersion: false };
  const declaredExact = declared?.version !== undefined && isValidVersion(declared.version);

  // §17.5 R14 — a role with no top-level field has exactly one place its pin can
  // go, so every branch below (which is about *choosing* between two fields)
  // collapses: the block is written, exclusively, and created if absent. The
  // name mismatch above has already been reported through `onFail`; if it did
  // not throw, the block is rewritten to describe the tool actually being
  // pinned, because a `version` under a `name` that says something else
  // describes nothing.
  if (fields.top === undefined) {
    return { write: true, exclusive: true, replacesDeclaredVersion: declaredExact };
  }

  // A declaration for a *different* package manager does not describe this pin;
  // the mismatch is reported through `onFail` and the pin goes to the top level,
  // where a reader can still see both statements.
  if (declared === undefined || declared.name !== info.name) return none;
  // A URL reference has no semver to record in a semver field.
  if (parse(info.reference) === null) return none;

  // A `packageManager` key that is present but not a string is a spec error the
  // user is about to have overwritten — write it at the top level, as before.
  const hasPin = typeof data[fields.top] === "string";
  const hasBrokenPin = Object.hasOwn(data, fields.top) && !hasPin && data[fields.top] != null;
  if (hasBrokenPin) return none;

  if (!hasPin) {
    // §15.26 bullet 2 — the pin lives where the declaration already is.
    return { write: true, exclusive: true, replacesDeclaredVersion: declaredExact };
  }

  // Both fields. `packageManager` is the one §03.3 reads, so it is always
  // written; `devEngines` is only rewritten when it was itself a pin.
  return {
    write: declaredExact,
    exclusive: false,
    replacesDeclaredVersion: declaredExact,
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
  fields: PinFields,
): string | null {
  const version = parse(info.reference)?.version;
  if (version === undefined || info.hash === undefined) return null;

  const integrity = integrityFromHash(info.hash);
  if (integrity === undefined) return null;

  const block = data.devEngines?.[fields.block];

  // No block yet: create it, name included — §03.3 reads `name` first and a
  // block without one describes nothing.
  if (block === undefined) {
    return createDevEnginesBlock(content, fields.block, info.name, version, integrity);
  }

  // A block that is not an object, or that speaks for a different tool, is not
  // ours to rewrite.
  if (typeof block !== "object" || block === null || Array.isArray(block)) return null;
  const declaredName = (block as { name?: unknown }).name;
  if (declaredName !== undefined && declaredName !== info.name) return null;

  return writeIntoDevEngines(content, info, fields);
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
  block: string,
  name: string,
  version: string,
  integrity?: string,
): string | null {
  // Two shapes, one trick. With no `devEngines` at all the placeholder is the
  // top-level key and the literal is the whole `{ "<block>": {…} }`; with a
  // `devEngines` that simply lacks *this* role's block — a project pinning its
  // package manager there and now pinning a runtime beside it — the placeholder
  // is one level down and the literal is the inner object alone.
  const outer = !Object.hasOwn(parsedOrEmpty(content), "devEngines");
  const path = outer ? ["devEngines"] : ["devEngines", block];

  let seeded: string;
  if (outer) {
    try {
      seeded = setTopLevelString(content, "devEngines", "");
    } catch {
      return null;
    }
  } else {
    const nested = setNestedString(content, path, "");
    if (nested === null) return null;
    seeded = nested;
  }

  const span = scanNestedKey(seeded, path);
  if (span === null) return null;

  // `json.ts` inserts a one-line entry into a one-line object and a
  // freshly-indented one into a multi-line object; the value has to match, or a
  // compact manifest gains a five-line block wedged into its single line.
  const head = seeded.slice(0, span.start);
  const inline = !head.slice(head.lastIndexOf("{")).includes("\n");

  const { indent, eol } = detectFormat(seeded);
  const at = (depth: number): string => indent.repeat(depth);
  const entries: Array<[string, string]> = [
    ["name", name],
    ["version", version],
    ...(integrity === undefined ? [] : ([["integrity", integrity]] as Array<[string, string]>)),
  ];
  const fieldsObject = Object.fromEntries(entries);
  // The block's own depth: 3 inside a freshly created `devEngines`, 2 when the
  // `devEngines` object is already there and only the block is being added.
  const depth = outer ? 3 : 2;
  const members = entries
    .map(([key, value], index) => {
      const comma = index === entries.length - 1 ? "" : ",";
      return `${at(depth)}${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}${eol}`;
    })
    .join("");
  const inner = `{${eol}${members}${at(depth - 1)}}`;
  const literal = inline
    ? JSON.stringify(outer ? { [block]: fieldsObject } : fieldsObject)
    : outer
      ? `{${eol}${at(2)}${JSON.stringify(block)}: ${inner}${eol}${at(1)}}`
      : inner;

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
  fields: PinFields,
): string | null {
  const version = parse(info.reference)?.version;
  if (version === undefined) return null;

  let text = content;
  if (fields.top === undefined) {
    // §17.5 R14 — the block is this role's only home, so it is created when the
    // manifest has none and is made to name the tool being pinned. For the
    // package-manager role neither is needed: `devEngines.packageManager` is
    // only written when §03.3 already read a matching `name` out of it.
    const declared = parsedOrEmpty(text).devEngines?.[fields.block];
    if (declared === undefined) {
      return createDevEnginesBlock(
        text,
        fields.block,
        info.name,
        version,
        info.hash === undefined ? undefined : integrityFromHash(info.hash),
      );
    }
    const named = setNestedString(text, ["devEngines", fields.block, "name"], info.name);
    if (named === null) return null;
    text = named;
  }

  const withVersion = setNestedString(text, ["devEngines", fields.block, "version"], version);
  if (withVersion === null) return null;

  if (info.hash === undefined) return withVersion;
  const integrity = integrityFromHash(info.hash);
  if (integrity === undefined) return withVersion;

  return (
    setNestedString(withVersion, ["devEngines", fields.block, "integrity"], integrity) ??
    withVersion
  );
}

/** `parseManifest`, tolerant: an unparseable or non-object document reads as `{}`. */
function parsedOrEmpty(text: string): Manifest {
  try {
    const parsed = parseManifest(text);
    if (typeof parsed === "object" && parsed !== null) return parsed as Manifest;
  } catch {
    // Falls through to the empty document, exactly as `writePin` does on read.
  }
  return {};
}
