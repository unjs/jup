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
 * version, optionally carrying §02.1's digest suffix — but §04.4 lets `jup use`
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
 * §03.7 — the digest to record beside the version, as SRI, or `undefined` when
 * there is none to record.
 *
 * `info.hash` is the caller's own answer and is preferred, but it is not the
 * only place the digest lives: `referenceWithHash` has already folded one into
 * `info.reference` as §02.1's build suffix, and not every path through §09.5
 * plumbs the two alike. That did not matter while `packageManager` carried the
 * reference verbatim and the sidecar was an opt-in second spelling. Now that
 * the member is the pin and its `version` is always the *clean* one (§03.3
 * validates it as a semver range, where a `+sha512.…` has no business), a
 * digest that reached us only through the suffix would be dropped on the floor
 * — turning a hash-pinned project into an unpinned one without saying so.
 *
 * §02.4 — a per-host locator is *not* an exception that needs handling here.
 * `referenceWithHash` declines to attach its digest in the first place, so the
 * suffix this reads is empty for exactly the tools whose digest must never be
 * committed.
 */
function sidecarDigest(info: PinInfo): string | undefined {
  if (info.hash !== undefined) return integrityFromHash(info.hash);
  const build = parse(info.reference)?.build ?? [];
  return build.length === 0 ? undefined : integrityFromHash(build.join("."));
}

/**
 * The semver text a field may hold: an exact version (digest suffix stripped),
 * or §04.4's range. `undefined` for anything a semver field cannot record —
 * a URL, or a dist-tag.
 */
function pinText(reference: string): string | undefined {
  const parsed = parse(reference);
  if (parsed !== null) return parsed.version;
  return isValidRange(reference) ? reference : undefined;
}

/**
 * §03.7 — the text to put in the member's `version`, per pin style.
 *
 * `sidecar` wants the clean version, because the digest is going into
 * `integrity` beside it. `suffix` — the default — keeps §02.1's build suffix in
 * the version itself, which is the interoperable spelling and the one a
 * hand-written pin has always had. §03.3 validates the field as a semver
 * *range* and build metadata is part of a valid semver, so both read back as
 * the same hash-bearing exact pin.
 *
 * The style is a preference, not a guarantee, in one direction: `sidecar` falls
 * back to the suffix when the digest cannot be spelled as SRI — the SRI
 * conversion wants a lowercase algorithm name and an even-length hex body, and
 * §02.1's suffix is not otherwise constrained to give it one. Dropping the
 * digest instead would quietly demote a hash-pinned project to an unpinned one,
 * and the member is now the only field the pin is guaranteed to reach, so there
 * is no top-level string left to carry it. A pin written in the spelling the
 * user did not ask for beats a pin written without its hash.
 */
function versionToRecord(info: PinInfo, integrity: string | undefined): string | undefined {
  const clean = pinText(info.reference);
  if (clean === undefined || integrity !== undefined) return clean;

  const parsed = parse(info.reference);
  if (parsed === null || parsed.build.length === 0) return clean;
  return `${parsed.version}+${parsed.build.join(".")}`;
}

/**
 * §03.7, per §03.1's write-mode stop conditions — write the pin.
 *
 * Preserves indentation, line endings, key order, and (per §03.7) the BOM.
 * Returns the previous value for `COREPACK_MIGRATE_FROM`, and the path actually
 * modified so the caller can print it (§12.11).
 *
 * **Which field gets written** is §03.7's whole subject. The pin goes to
 * `devEngines` — the field §03.3 reads first, and the only one that can carry a
 * name, a version and a digest together:
 *
 * | Manifest declares | Written |
 * |---|---|
 * | neither field | `devEngines.packageManager`, created |
 * | `devEngines.packageManager` for **this** package manager, no `packageManager` | `devEngines.packageManager.version` (+ `integrity`) |
 * | `packageManager` only | `devEngines.packageManager`, created; `packageManager` refreshed |
 * | both, for this package manager | both refreshed |
 * | `devEngines.packageManager` for a **different** package manager | `packageManager`; the mismatch reported |
 * | anything, and the pin is a **runtime** (§02.3) | `devEngines.runtime`, created if absent |
 *
 * Rows one and two write one field because that is the whole pin: §03.3 reads
 * the member, so nothing is served by minting a second, thinner copy of the
 * same statement in `packageManager`. Rows three and four refresh the top-level
 * field only because it is *already there*, and a `packageManager` left holding
 * the version before last is a false statement about what will run — to jup,
 * and to every other tool that reads only that field.
 *
 * A declared range is replaced, not preserved; {@link devEnginesWriteTarget}
 * carries the reasoning, along with why §09.4's cross-major `up` still works.
 * §03.7's post-write requirement — "validation MUST run against the state being
 * written" — is met by the check being the same predicate §03.3 applies on read,
 * with the same `onFail`.
 *
 * The runtime row is separate because a runtime has exactly one home: there is
 * no top-level field for it (§03.4 refuses one), so the question of refreshing a
 * second field never arises.
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
  // §02.3 — which field encodes this pin, decided by the tool's kind and by
  // nothing the manifest says. It steers the discovery walk too: `use node@22`
  // must find the manifest that speaks about the *runtime*, which is not
  // necessarily the one carrying `packageManager`.
  const field = devEnginesFieldFor(info.name);

  // 1 — re-run discovery: the file to edit is not necessarily in `cwd`. §03.1's
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
  // read *before* the validation below because §03.7 requires that validation
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
  // §03.7 — validate the declared name even when no version is present, so the
  // written manifest remains acceptable to §03.3.
  //
  // The version half is skipped for exactly one shape — see
  // {@link devEnginesWriteTarget} — because there is nothing left to violate
  // once the declared value is the value being replaced. That is §03.7's
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
  // The order mirrors §03.3's, because this has to name the pin that was *in
  // effect* before the write, not whichever field happened to be present: a
  // versioned `devEngines` member outranks `packageManager` on read, so it is
  // what the tool is migrating from. A member naming no version falls through
  // to the top-level field for the same reason §03.3 does.
  const previousPackageManager =
    range !== undefined
      ? `${range.name}@${range.range}`
      : field === "packageManager" && typeof data.packageManager === "string"
        ? data.packageManager
        : declared === undefined
          ? "unknown"
          : `${declared.name}@${declared.version ?? "*"}`;

  // 5, 7, 8 — the rewrite preserves indentation, line endings, key order and the
  // BOM; the reference carries its freshly computed hash suffix.
  //
  // §03.7 — "a command that writes a pin MUST update **every** field that
  // encodes it", so the two writes compose rather than choosing between each
  // other. A `devEngines` write that could not be made surgically falls back to
  // the top-level field: writing the pin somewhere is always better than writing
  // it nowhere and reporting success.
  // §03.7 — `--pin-style=sidecar` moves the digest out of the version string
  // and into `devEngines.packageManager.integrity`, creating the block when the
  // manifest has none. The suffixed form stays the default: it is the
  // interoperable spelling and §13 asserts it.
  const sidecar = options?.pinStyle === "sidecar";

  let updated = content;
  let wroteDevEngines = false;
  if (devEnginesTarget.write) {
    const next = writeIntoDevEngines(updated, data, info, field, sidecar);
    if (next !== null) {
      updated = next;
      wroteDevEngines = true;
    }
  }
  // What the pin field now holds, which is what the caller reports (§12.11).
  //
  // Whenever the member is the only place the pin landed — which §03.7 makes
  // the common case, not the exception — the string to quote is the member's
  // own `version`, not `info.reference`: under `--pin-style=sidecar` the digest
  // has moved to `integrity` and the suffixed reference is nowhere in the file.
  // {@link versionToRecord} is asked rather than re-derived, so the line cannot
  // drift from the bytes. The top-level field, when the manifest has one to
  // refresh, always keeps the full reference.
  //
  // §04.4 — a range has no digest suffix either way, so it passes through whole.
  const memberVersion = (): string =>
    versionToRecord(info, sidecar ? sidecarDigest(info) : undefined) ?? info.reference;
  let written = info.reference;
  // §02.3 — the fallback below is `packageManager`, and a runtime may not go
  // there (§03.4). Its write is therefore not best-effort: a member that could
  // not be written is a pin written nowhere, and saying so beats reporting a
  // success the next run will not see.
  if (field === "runtime") {
    if (!wroteDevEngines) {
      throw new Error(`Failed to set "devEngines.runtime" in package.json`);
    }
    written = memberVersion();
  } else if (!devEnginesTarget.exclusive || !wroteDevEngines) {
    updated = setTopLevelString(updated, "packageManager", `${info.name}@${written}`);
  } else {
    // Exclusively `devEngines`, and it took the write.
    written = memberVersion();
  }

  // 9 — in the `NoProject` case this creates `<cwd>/package.json`.
  writeManifest(target, updated);

  // `target` goes back to the caller because §04.4's `jup.lock` lives
  // beside *this* file, not beside the cwd — in a monorepo those differ, and a
  // resolution recorded next to the wrong manifest would never be found again.
  // §03.7 also requires it to be *printed*, and printing is the caller's job.
  return { previousPackageManager, target, written };
}

/**
 * Write the manifest back **atomically**, the way `lockfile.ts` writes the file
 * it derives (§04.4).
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
  // Absent: nothing to replace and no link to resolve — §03.7 creates it.
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
 * §03.7 — `devEngines` is where the pin goes.
 *
 * It is the field §03.3 reads first, and the only one of the two that can hold
 * a name, a version, a digest and an `onFail` policy at once, so a pin written
 * anywhere else is a pin the next run does not honour. The member is therefore
 * written whenever the pin has semver text to record, created if it is not
 * there yet — the runtime path (§02.3) generalised to both members.
 *
 * `exclusive` is what is left of the old three-way question, and it now asks
 * only whether the manifest *already* has a top-level `packageManager`. If it
 * does, that field is refreshed alongside, because a stale
 * `packageManager: "pnpm@9"` sitting beside a fresh `devEngines` member is a
 * statement about what will run that is no longer true — for jup, and for every
 * other tool that reads only that field. If it does not, none is created: §03.7
 * writes one home for the pin, not two.
 *
 * A declared *range* is replaced rather than preserved, which reverses what
 * this function used to do. `1.x || 2.x` beside an exact `packageManager` was a
 * statement of intent worth keeping while the top-level field carried the pin
 * and won the read; now that the member is the pin, leaving the range there
 * would mean `jup use pnpm@1.9.0` resolved `1.x` on the next run and the pin
 * never took. §09.4's cross-major `up` is unaffected: it refreshes `jup.lock`
 * and does not call `writePin` when the descriptor is a range.
 */
function devEnginesWriteTarget(
  data: Manifest,
  declared: DevEnginesDeclaration | undefined,
  info: PinInfo,
  field: DevEnginesField = "packageManager",
): { write: boolean; exclusive: boolean; replacesDeclaredVersion: boolean } {
  const none = { write: false, exclusive: false, replacesDeclaredVersion: false };

  // §02.3 — a runtime's pin has one home and no alternative, so none of the
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

  // A declaration for a *different* package manager does not describe this pin.
  // The mismatch is reported through `onFail` and, if that does not throw, the
  // pin goes to the top level rather than overwriting a statement about another
  // tool — the one case where `packageManager` is still the pin's only home, and
  // the one §03.3 still reads, since a member naming another tool is not a
  // declaration about this one.
  if (declared !== undefined && declared.name !== info.name) return none;
  // A URL reference has no semver to record in a semver field; §04.4's range
  // does, and goes in as written.
  if (pinText(info.reference) === undefined) return none;

  // Only the *presence* of the key matters, not whether it holds a usable pin:
  // a `packageManager: 42` is refreshed for the same reason a stale string is,
  // and leaving it would keep §12.2's error in a manifest jup had just written.
  const hasTopLevelField = Object.hasOwn(data, "packageManager");

  // §03.7 — "validation MUST run against the state being written, not the state
  // on disk". The member's version is now always replaced by this write, so
  // there is never a declared version left for the pin to violate, and
  // `writePin`'s range cross-check is skipped for every package-manager pin.
  //
  // That check used to fire here, and dropping it is deliberate rather than
  // incidental. `jup use pnpm@^10.0.0` writes `^10.0.0` into the member; with
  // the check still armed, the very next `jup use pnpm@11.1.2` would be refused
  // by the range its own predecessor had just written, and nothing short of a
  // hand edit would get the project out. A declared range was a pure constraint
  // only while `packageManager` carried the pin — now it *is* the pin, and
  // replacing a pin is what `use` is for.
  //
  // What still guards the declaration is the **name** check above, which is the
  // half that was always about a statement this pin contradicts rather than
  // replaces: `use pnpm@6.6.2` in a project whose member says `yarn` writes a
  // pin §03.3 would reject on every later run, and no write can make that true.
  return {
    write: true,
    exclusive: !hasTopLevelField,
    replacesDeclaredVersion: true,
  };
}

/** §03.7 — where `use`/`up` put the digest. The suffixed form is the default. */
export type PinStyle = "suffix" | "sidecar";

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
 * `json.ts` inserts *string* values only, which is all §03.7 ever needed. The
 * two-step here — insert a placeholder string under the key, then swap its value
 * span for the object literal — reuses that machinery rather than growing a
 * JSON builder for one caller, and re-parses the result before returning it so
 * a manifest is never left in a shape this could not read back.
 *
 * §02.3 turned one case into two, because a runtime's member routinely has to
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
 * §03.7 — write the pin into the `devEngines` member, or `null` if the surgical
 * edit could not be made.
 *
 * `sidecar` selects §03.7's two spellings of the digest: the clean version with
 * an SRI `integrity` beside it, or — the default — §02.1's build suffix carried
 * in the version itself. {@link versionToRecord} owns that choice and its one
 * fallback. Both read back identically (§03.3).
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
  sidecar = false,
): string | null {
  const integrity = sidecar ? sidecarDigest(info) : undefined;
  const version = versionToRecord(info, integrity);
  if (version === undefined) return null;

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
  // instead (§02.3). Correcting the name is therefore part of writing the pin:
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
  // nothing §03.7 can read back. Anything else is stale and comes out.
  const stale =
    Object.hasOwn(member as object, "integrity") &&
    !(isValidVersion(version) && (member as { version?: unknown }).version === version);
  if (!stale) return updated;

  // A member left half-corrected is the trap this branch exists to defuse, so a
  // removal that cannot be made surgically is a failed edit like any other: the
  // caller falls back to the top-level field (§03.7) or reports the failure
  // (§02.3), and `devEngines` keeps a version and a digest that still agree.
  return removeDevEnginesKey(updated, field, "integrity");
}

/**
 * Delete one key from a `devEngines` member, preserving indentation, line
 * endings, key order and the BOM — the removal half of `json-write.ts`'s
 * surgical edit, which has only ever needed to *set* keys (§16).
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

  // §16 — validate by re-reading our own output: it has to parse, and the key
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
