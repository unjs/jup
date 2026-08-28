/** Pin writing remains outside the warm manifest-reading module graph. */

const { lstatSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } =
  process.getBuiltinModule("node:fs");
const { basename, dirname, join } = process.getBuiltinModule("node:path");
import { messages } from "../errors-cold.ts";
import {
  detectFormat,
  scanTopLevelKey,
  setNestedString,
  setTopLevelString,
} from "../utils/json-write.ts";
import {
  BOM,
  CH_BACKSLASH,
  CH_COLON,
  CH_COMMA,
  CH_LBRACE,
  CH_QUOTE,
  isWhitespace,
  parseManifest,
  skipWhitespace,
  stripBom,
} from "../utils/json.ts";
import { devEnginesFieldFor } from "../config/table.ts";
import { integrityFromHash } from "./lockfile.ts";
import { discoverProjectSpec, warnOrThrow } from "./manifest.ts";
import { isValidRange, isValidVersion, parse, satisfies } from "../version/semver.ts";
import type { DevEnginesDeclaration, DevEnginesField, Manifest } from "../types.ts";

/**
 * What to write, and what it resolved to.
 *
 * `reference` is the text that lands in the field. Usually that is an exact
 * version, optionally carrying §02.1's digest suffix — but §15.23 lets `jup use`
 * pin a **semver range**, and then the two halves come apart: the field holds
 * `^11.0.0` while every check that asks "is this pin allowed here?" has to ask it
 * of the version the range actually resolved to. `resolved` carries that version
 * for those checks; when absent, `reference` answers both questions.
 */
export interface PinInfo {
  name: string;
  reference: string;
  resolved?: string;
  hash?: string;
}

/**
 * The semver text a field may hold: an exact version (digest suffix stripped),
 * or §15.23's range. `undefined` for anything a semver field cannot record —
 * a URL, or a dist-tag.
 */
function pinText(reference: string): string | undefined {
  const parsed = parse(reference);
  if (parsed !== null) return parsed.version;
  return isValidRange(reference) ? reference : undefined;
}

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
 * | anything, and the pin is a **runtime** (§15.39) | `devEngines.runtime`, created if absent |
 *
 * The last row is one row because a runtime has exactly one home: there is no
 * top-level field for it (§03.4 refuses one), so the three-way question above
 * — which of two fields, or both — does not arise. What replaces it is that the
 * member may have to be *created*, which the package-manager path only ever had
 * to do for §15.12's sidecar.
 *
 * Row three needs no `devEngines` update because the value being written already
 * satisfies the declared range. Rewriting `1.x || 2.x` into `2.4.3` would destroy
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
  info: PinInfo,
  options?: { here?: boolean; pinStyle?: PinStyle },
): { previousPackageManager: string; target: string; written: string } {
  // §15.39 — which field encodes this pin, decided by the tool's kind and by
  // nothing the manifest says. It steers the discovery walk too: `use node@22`
  // must find the manifest that speaks about the *runtime*, which is not
  // necessarily the one carrying `packageManager`.
  const field = devEnginesFieldFor(info.name);

  // 1 — re-run discovery: the file to edit is not necessarily in `cwd`. §15.27's
  // extra stop conditions apply here and only here, because this is the write.
  const lookup = discoverProjectSpec(cwd, {
    mutating: true,
    here: options?.here === true,
    tool: info.name,
  });
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

  const devEnginesTarget = devEnginesWriteTarget(data, declared, info, field);

  // 2 — the package manager being pinned must be the one `devEngines` declares,
  // *and* its version must satisfy the declared range. Checking only the version
  // lets `use pnpm@6.6.2` succeed in a project whose devEngines say `yarn@6.x`,
  // writing a pin that then fails §03.3's name check on every subsequent run —
  // permanently, since nothing but a hand edit can undo it.
  //
  // §15.26 — validate the declared name even when no version is present, so the
  // written manifest remains acceptable to §03.3.
  //
  // The version half is skipped for exactly one shape — see
  // {@link devEnginesWriteTarget} — because there is nothing left to violate
  // once the declared value is the value being replaced. That is §15.26's
  // "validation MUST run against the state being written, not the state on disk".
  if (declared !== undefined && info.name !== declared.name) {
    warnOrThrow(
      messages.devEnginesPinMismatch(
        info.name,
        info.resolved ?? info.reference,
        declared.name,
        declared.version ?? "*",
      ),
      declared.onFail,
    );
  } else if (
    range !== undefined &&
    !devEnginesTarget.replacesDeclaredVersion &&
    !satisfies(info.resolved ?? info.reference, range.range)
  ) {
    warnOrThrow(
      messages.devEnginesPinMismatch(
        info.name,
        info.resolved ?? info.reference,
        range.name,
        range.range,
      ),
      range.onFail,
    );
  }

  // 6 — what the package manager's own `use` command is told to migrate from.
  // A runtime declares no `commands.use` (§02.3), so nothing reads this for one;
  // it is still computed from the member that spoke, so the value is never a
  // statement about some other tool.
  const previousPackageManager =
    field === "packageManager" && typeof data.packageManager === "string"
      ? data.packageManager
      : range === undefined
        ? declared === undefined
          ? "unknown"
          : `${declared.name}@${declared.version ?? "*"}`
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
    // The sidecar form needs a digest to move out of the version string, and a
    // per-host tool has none to move (§15.23) - every runtime included. That is
    // not a reason to write no pin at all, so the ordinary member write is the
    // fallback: it lands the same clean version, just without an `integrity`
    // line there is no hash for.
    //
    // The fallback is gated on the *target*, not on `sidecar`. When
    // `devEnginesWriteTarget` said not to write — a member that speaks for
    // another tool, a URL reference with no semver to record, a broken
    // top-level pin — `--pin-style=sidecar` is a request about the digest's
    // spelling, not permission to overwrite a declaration this pin does not
    // describe. `writeSidecarPin` may still create a member where there is
    // none, which is what §15.12 says the flag does.
    const next =
      (sidecar ? writeSidecarPin(updated, data, info, field) : null) ??
      (devEnginesTarget.write ? writeIntoDevEngines(updated, data, info, field) : null);
    if (next !== null) {
      updated = next;
      wroteDevEngines = true;
    }
  }
  // What the pin field now holds, which is what the caller reports (§15.35l).
  //
  // A `devEngines` member always carries the *clean* version, with any digest
  // beside it in `integrity`. So whenever that member is the only place the pin
  // landed, quoting `info.reference` would name a suffixed string that is
  // nowhere in the file. The top-level field is the one that keeps the suffix,
  // and only while it is still being written.
  // §15.23 — a range has no digest suffix to strip, so it passes through whole.
  const cleanReference = (): string => parse(info.reference)?.version ?? info.reference;
  let written = info.reference;
  // §15.39 — the fallback below is `packageManager`, and a runtime may not go
  // there (§03.4). Its write is therefore not best-effort: a member that could
  // not be written is a pin written nowhere, and saying so beats reporting a
  // success the next run will not see.
  if (field === "runtime") {
    if (!wroteDevEngines) {
      throw new Error(`Failed to set "devEngines.runtime" in package.json`);
    }
    written = cleanReference();
  } else if (!devEnginesTarget.exclusive || !wroteDevEngines) {
    // A sidecar write that landed is what makes the clean version *readable*
    // again (§15.12 reads them as one pin); one that did not must keep the
    // suffix, or the pin would be written nowhere at all.
    if (sidecar && wroteDevEngines) written = cleanReference();
    updated = setTopLevelString(updated, "packageManager", `${info.name}@${written}`);
  } else {
    // Exclusively `devEngines`, and it took the write: no top-level field is
    // left to carry the suffix.
    written = cleanReference();
  }

  // 9 — in the `NoProject` case this creates `<cwd>/package.json`.
  writeManifest(target, updated);

  // `target` goes back to the caller because §15.23's `jup.lock` lives
  // beside *this* file, not beside the cwd — in a monorepo those differ, and a
  // resolution recorded next to the wrong manifest would never be found again.
  // §15.27 also requires it to be *printed*, and printing is the caller's job.
  return { previousPackageManager, target, written };
}

/**
 * Write the manifest back **atomically**, the way `lockfile.ts` writes the file
 * it derives (§14.3).
 *
 * A plain `writeFileSync` truncates first and writes second, so an interrupt in
 * between — Ctrl-C, an OOM kill, a full disk, or two `jup use` runs racing in a
 * monorepo — leaves the user's `package.json` empty and the original gone. That
 * is somebody's source file, not a cache entry we can rebuild: it deserves at
 * least the care the derived lockfile already gets. Temp-then-rename makes the
 * replacement a single step, so a reader sees either the old file or the new one.
 *
 * The temp file is opened `wx` (`O_CREAT | O_EXCL`) under an unguessable name,
 * so a symlink planted beside the manifest is not something we write through;
 * and a symlinked `package.json` — legal, if rare, in a workspace — is resolved
 * first so the rename replaces the file rather than the link. The mode is
 * carried across, or a manifest the user had made read-only-ish would come back
 * as whatever the umask says.
 */
function writeManifest(target: string, content: string): void {
  const link = lstatSync(target, { throwIfNoEntry: false });
  // Absent: nothing to replace and no link to resolve — §03.7 step 9 creates it.
  if (link === undefined) {
    writeFileSync(target, content);
    return;
  }

  // A symlinked `package.json` is legal, if rare, in a workspace; resolve it so
  // the rename replaces the file it names rather than the link itself.
  const file = link.isSymbolicLink() ? realpathSync(target) : target;
  const stats = link.isSymbolicLink() ? statSync(file, { throwIfNoEntry: false }) : link;
  // Not a regular file — a directory, a fifo, a dangling link. Let the write
  // fail exactly as it did before rather than renaming something over it.
  if (stats === undefined || !stats.isFile()) {
    writeFileSync(target, content);
    return;
  }

  const suffix = process.getBuiltinModule("node:crypto").randomBytes(6).toString("hex");
  const tmp = join(dirname(file), `.${basename(file)}.${suffix}.tmp`);
  try {
    writeFileSync(tmp, content, { flag: "wx", mode: stats.mode & 0o777 });
    renameSync(tmp, file);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * §15.26 — exact declarations may be replaced; range constraints are preserved.
 * With no top-level `packageManager`, `exclusive` writes only to `devEngines`.
 */
function devEnginesWriteTarget(
  data: Manifest,
  declared: DevEnginesDeclaration | undefined,
  info: PinInfo,
  field: DevEnginesField = "packageManager",
): { write: boolean; exclusive: boolean; replacesDeclaredVersion: boolean } {
  const none = { write: false, exclusive: false, replacesDeclaredVersion: false };

  // §15.39 — a runtime's pin has one home and no alternative, so none of the
  // three-way reasoning below applies: there is no top-level field to prefer, to
  // be shadowed by, or to fall back to. The member is written whether or not it
  // exists yet, and `name` goes in beside `version` because a `devEngines`
  // member without one describes nothing (§03.3 reads `name` first).
  //
  // A URL reference is still the one thing that cannot be recorded — the field
  // is validated as a semver range — and it is `writePin`'s error rather than a
  // silent fallback, because for a runtime there is nowhere to fall back to.
  if (field === "runtime") {
    if (pinText(info.reference) === undefined) return none;
    return {
      write: true,
      exclusive: true,
      replacesDeclaredVersion: declared?.version !== undefined && isValidVersion(declared.version),
    };
  }

  // A declaration for a *different* package manager does not describe this pin;
  // the mismatch is reported through `onFail` and the pin goes to the top level,
  // where a reader can still see both statements.
  if (declared === undefined || declared.name !== info.name) return none;
  // A URL reference has no semver to record in a semver field; §15.23's range
  // does, and goes in as written.
  if (pinText(info.reference) === undefined) return none;

  // A present non-string `packageManager` is overwritten at the top level.
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
  info: PinInfo,
  field: DevEnginesField = "packageManager",
): string | null {
  // A range pin carries no digest to move out of the version string (§15.23
  // keeps its digest in `jup.lock`), so there is no sidecar to write and the
  // ordinary member write below lands the range instead.
  const version = parse(info.reference)?.version;
  if (version === undefined || info.hash === undefined) return null;

  const integrity = integrityFromHash(info.hash);
  if (integrity === undefined) return null;

  const block = memberOf(data, field);

  // A block that is not an object, or that speaks for a different tool, is not
  // ours to rewrite.
  if (block !== undefined) {
    if (typeof block !== "object" || block === null || Array.isArray(block)) return null;
    const declaredName = (block as { name?: unknown }).name;
    if (declaredName !== undefined && declaredName !== info.name) return null;
  }

  return writeIntoDevEngines(content, data, info, field);
}

/** The `devEngines` member, or `undefined` when the block or the member is absent. */
function memberOf(data: Manifest, field: DevEnginesField): unknown {
  const devEngines = data.devEngines;
  if (typeof devEngines !== "object" || devEngines === null) return undefined;
  return Object.hasOwn(devEngines, field) ? devEngines[field] : undefined;
}

/**
 * Create a `devEngines` member that does not exist yet, preserving the
 * document's indentation, line endings and BOM.
 *
 * `json.ts` inserts *string* values only, which is all §15.26 ever needed. The
 * two-step here — insert a placeholder string under the key, then swap its value
 * span for the object literal — reuses that machinery rather than growing a
 * JSON builder for one caller, and re-parses the result before returning it so
 * a manifest is never left in a shape this could not read back.
 *
 * §15.39 turned one case into two, because a runtime's member routinely has to
 * be created in a manifest that already has a `devEngines` block for its package
 * manager. The two differ only in *what* is being inserted and one level of
 * nesting: the whole block (`{"<field>": {…}}`) when there is none, or the
 * member alone (`{…}`) into the block that is there. `depth` is that level, and
 * the members are rendered at `depth + 1` in both.
 */
function createDevEnginesMember(
  content: string,
  present: boolean,
  field: DevEnginesField,
  members: ReadonlyArray<readonly [key: string, value: string]>,
): string | null {
  // Seed a placeholder the scanner can find, then swap its value span. When the
  // block exists the placeholder is the member; when it does not it is the
  // block, and the member is written inside the literal below.
  let seeded: string | null;
  try {
    seeded = present
      ? setNestedString(content, ["devEngines", field], "")
      : setTopLevelString(content, "devEngines", "");
  } catch {
    return null;
  }
  if (seeded === null) return null;

  const outer = scanTopLevelKey(seeded, "devEngines");
  if (outer === null) return null;

  let span = outer;
  if (present) {
    const inner = scanTopLevelKey(seeded.slice(outer.start, outer.end), field);
    if (inner === null) return null;
    span = { start: outer.start + inner.start, end: outer.start + inner.end };
  }

  // `json.ts` inserts a one-line entry into a one-line object and a
  // freshly-indented one into a multi-line object; the value has to match, or a
  // compact manifest gains a five-line block wedged into its single line.
  const head = seeded.slice(0, span.start);
  const inline = !head.slice(head.lastIndexOf("{")).includes("\n");

  const { indent, eol } = detectFormat(seeded);
  const at = (level: number): string => indent.repeat(level);
  // The member's key always sits at level 2 — `devEngines` at 1, the member
  // inside it — so its own keys are at 3 and its closing brace at 2, whether the
  // block was already there or is being created around it. Only the *wrapping*
  // differs between the two cases, below.
  const depth = 3;

  const object = Object.fromEntries(members);
  let literal: string;
  if (inline) {
    literal = JSON.stringify(present ? object : { [field]: object });
  } else {
    const body = members
      .map(([key, value]) => `${at(depth)}${JSON.stringify(key)}: ${JSON.stringify(value)}`)
      .join(`,${eol}`);
    const member = `{${eol}${body}${eol}${at(depth - 1)}}`;
    literal = present
      ? member
      : `{${eol}${at(2)}${JSON.stringify(field)}: ${member}${eol}${at(1)}}`;
  }

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
 * §15.26 — write the pin into the `devEngines` member, or `null` if the surgical
 * edit could not be made.
 *
 * The version written is the **plain** semver version and the digest goes to
 * `integrity` beside it (§15.12's shape), because a `devEngines` member's
 * `version` is validated as a semver *range* by §03.3 and a `+sha512.…` suffix
 * has no business in one.
 *
 * Write a usable digest with its version. Without one, preserve integrity only
 * when re-pinning the same exact version; ranges, per-host tools, and changed
 * versions remove it. Missing members are created with `name`.
 */
function writeIntoDevEngines(
  content: string,
  data: Manifest,
  info: PinInfo,
  field: DevEnginesField = "packageManager",
): string | null {
  const version = pinText(info.reference);
  if (version === undefined) return null;

  const integrity = info.hash === undefined ? undefined : integrityFromHash(info.hash);

  // Absent member — create it, `name` included: §03.3 reads `name` first, and a
  // member without one describes nothing.
  const member = memberOf(data, field);
  if (member === undefined) {
    const members: Array<readonly [string, string]> = [
      ["name", info.name],
      ["version", version],
    ];
    if (integrity !== undefined) members.push(["integrity", integrity]);
    return createDevEnginesMember(content, Object.hasOwn(data, "devEngines"), field, members);
  }

  let updated = setNestedString(content, ["devEngines", field, "version"], version);
  if (updated === null) return null;

  // A name mismatch is normally an error, but `onFail: "warn"` lets the write
  // proceed — and for a runtime there is no second field for the pin to land in
  // instead (§15.39). Correcting the name is therefore part of writing the pin:
  // leaving it would produce a member whose `version` describes a tool its
  // `name` does not, which §03.3 would then read as the *other* tool's pin.
  // The package-manager path never gets here with a mismatched name, because
  // `devEnginesWriteTarget` sends that case to the top-level field.
  if ((member as { name?: unknown }).name !== info.name) {
    updated = setNestedString(updated, ["devEngines", field, "name"], info.name) ?? updated;
  }

  if (integrity !== undefined) {
    return setNestedString(updated, ["devEngines", field, "integrity"], integrity) ?? updated;
  }

  // No digest to write. One already there describes the version it sat beside,
  // so it survives only when that version has not moved — and only when what is
  // being written is an exact version, since a digest beside a range describes
  // nothing §15.12 can read back. Anything else is stale and comes out.
  const stale =
    Object.hasOwn(member as object, "integrity") &&
    !(isValidVersion(version) && (member as { version?: unknown }).version === version);
  if (!stale) return updated;

  // A member left half-corrected is the trap this branch exists to defuse, so a
  // removal that cannot be made surgically is a failed edit like any other: the
  // caller falls back to the top-level field (§15.26) or reports the failure
  // (§15.39), and `devEngines` keeps a version and a digest that still agree.
  return removeDevEnginesKey(updated, field, "integrity");
}

/**
 * Delete one key from a `devEngines` member, preserving indentation, line
 * endings, key order and the BOM — the removal half of `json-write.ts`'s
 * surgical edit, which has only ever needed to *set* keys (§16.4).
 *
 * The entry is taken together with one separator so what is left is still one
 * object: the comma that follows it when there is one — which keeps the leading
 * whitespace of the next entry, so the survivors do not shift — and the comma
 * that precedes it otherwise.
 *
 * Returns `null` when the edit cannot be made, including when it produced
 * something that does not parse or that still carries the key, so a caller can
 * fall back rather than write back a manifest this did not understand.
 */
function removeDevEnginesKey(content: string, field: DevEnginesField, key: string): string | null {
  const prefix = content.startsWith(BOM) ? BOM : "";
  const body = stripBom(content);

  // Walk to the member's text span, exactly as `createDevEnginesMember` does.
  const outer = scanTopLevelKey(body, "devEngines");
  if (outer === null) return null;
  const inner = scanTopLevelKey(body.slice(outer.start, outer.end), field);
  if (inner === null) return null;
  const start = outer.start + inner.start;
  const end = outer.start + inner.end;

  const member = body.slice(start, end);
  const value = scanTopLevelKey(member, key);
  if (value === null) return content; // Absent: already in the desired state.

  // `scanTopLevelKey` reports the *value*; the entry starts at its key, which is
  // the string literal behind the colon.
  const colon = lastNonSpace(member, value.start);
  if (member.charCodeAt(colon) !== CH_COLON) return null;
  const close = lastNonSpace(member, colon);
  if (member.charCodeAt(close) !== CH_QUOTE) return null;
  const keyStart = openingQuote(member, close);
  if (keyStart < 0) return null;

  let from = keyStart;
  let to = value.end;
  const next = skipWhitespace(member, value.end);
  if (member.charCodeAt(next) === CH_COMMA) {
    to = skipWhitespace(member, next + 1);
  } else {
    const previous = lastNonSpace(member, keyStart);
    const code = member.charCodeAt(previous);
    // The last entry takes the comma before it; the *only* entry takes nothing
    // and leaves an empty object behind.
    if (code === CH_COMMA) from = previous;
    else if (code !== CH_LBRACE) return null;
  }

  const result =
    prefix + body.slice(0, start) + member.slice(0, from) + member.slice(to) + body.slice(end);

  // §16.4 — validate by re-reading our own output: it has to parse, and the key
  // the next reader looks for has to be gone.
  try {
    const parsed = parseManifest(result);
    if (typeof parsed !== "object" || parsed === null) return null;
    const rewritten = memberOf(parsed as Manifest, field);
    if (typeof rewritten !== "object" || rewritten === null) return null;
    if (Object.hasOwn(rewritten, key)) return null;
  } catch {
    return null;
  }
  return result;
}

/** Index of the last non-whitespace byte before `index`, or -1. */
function lastNonSpace(text: string, index: number): number {
  let i = index - 1;
  while (i >= 0 && isWhitespace(text.charCodeAt(i))) i--;
  return i;
}

/**
 * Index of the quote that opens the string literal closed at `close`, or -1.
 *
 * The nearest preceding quote is the opening one — nothing but the key's own
 * bytes lie between them — as long as it is not itself escaped, which an odd
 * run of backslashes in front of it is what says.
 */
function openingQuote(text: string, close: number): number {
  for (let i = close - 1; i >= 0; i--) {
    if (text.charCodeAt(i) !== CH_QUOTE) continue;
    let slashes = 0;
    while (i - slashes - 1 >= 0 && text.charCodeAt(i - slashes - 1) === CH_BACKSLASH) slashes++;
    if (slashes % 2 === 0) return i;
  }
  return -1;
}
