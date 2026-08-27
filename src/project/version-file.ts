/**
 * §15.40 — the version file a tool's ecosystem already writes.
 *
 * `devEngines.runtime` is the field §15.39 gave a runtime, and almost nobody has
 * written one yet. `.nvmrc` is in a large share of repositories today, says
 * exactly the same thing, and is read by a program most of those repositories
 * already have installed. Reading it is what makes `jup node` do the right thing
 * in a checkout nobody prepared for jup.
 *
 * Which file, and in which dialect, is a **table** fact ({@link VersionFileSpec},
 * §02.3): the name `.nvmrc` appears in `config/table.ts` and nowhere else, so a
 * second one is the data-only change §15.21 requires. Nothing here knows which
 * tool it is reading for.
 *
 * The file is never *written*. §03.7 writes `devEngines.runtime` and only that,
 * so the manifest is always the file that can be edited and the version file is
 * always the one that is merely believed.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { messages, UsageError } from "../errors.ts";
import { isValidRange } from "../version/semver.ts";
import type { VersionFileSpec } from "../types.ts";

/** One version file, as read off disk. */
export interface VersionFile {
  /** Absolute path, used as the `Found` result's target and in every message. */
  path: string;
  content: string;
  format: VersionFileSpec["format"];
}

/**
 * The nvm aliases that mean "the newest release", and the dist-tag they become.
 *
 * `node` is nvm's own spelling of it (`nvm_version` rewrites the bare tool name
 * to `stable` before resolving, `nvm.sh:721-732`); `stable` is the older one it
 * rewrites *to*. Both are a request for the newest published version, which on
 * the npm side is the `latest` dist-tag and is resolved by §04.1 step 3 like any
 * other tag.
 *
 * The LTS aliases are deliberately absent. See {@link rangeFrom}.
 */
const NVM_NEWEST = new Set(["node", "stable"]);

/**
 * Read the version file in one directory. `null` when it is not there.
 *
 * Called at most once per walk — the *nearest* file is the one that speaks, as
 * it is for nvm (`nvm_find_up`, `nvm.sh:579-593`) and for §03.2's env file —
 * so the cost is one open attempt per directory until the first hit, and none
 * at all for a tool whose table entry declares no version file.
 */
export function loadVersionFile(dir: string, spec: VersionFileSpec): VersionFile | null {
  const path = join(dir, spec.path);
  try {
    return { path, content: readFileSync(path, "utf8"), format: spec.format };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // A directory named `.nvmrc`, a permissions failure: not our business to
    // paper over, and silently ignoring it would run the wrong version.
    throw error;
  }
}

/**
 * §15.40 — the semver range a version file declares.
 *
 * `source` is the file's path relative to the initial cwd, matching what §03.4
 * reports for a manifest. Throws a {@link UsageError} rather than returning
 * `null` for either failure, because both mean the file was written to be obeyed
 * and cannot be: falling back to the compiled-in default would run a version the
 * project explicitly did not ask for.
 */
export function versionFileRange(file: VersionFile, source: string): string {
  const declared = declaredVersion(file.content);
  if (declared === null) {
    throw new UsageError(messages.versionFileInvalid(source));
  }

  const range = rangeFrom(declared);
  if (range === null) {
    throw new UsageError(messages.versionFileUnsupported(declared, source));
  }
  return range;
}

/**
 * What may stand to the left of `=` on a settings line.
 *
 * nvm's own test is "the line contains an `=` anywhere"
 * (`nvm_process_nvmrc_content`), which is exact for nvm's vocabulary and wrong
 * for jup's: `>=18 <21` is a range this reader accepts and is not a setting. So
 * a pair additionally has to have a key shaped like a key, which no comparator
 * range does — and which nvm's own documented keys all are.
 */
const SETTING_KEY_RE = /^[A-Za-z_][\w.-]*$/;

/**
 * The one version-ish line, or `null` if the file does not carry exactly one.
 *
 * nvm's grammar (`nvm_process_nvmrc_content`, `nvm.sh:613-680`): strip `#` to
 * end of line, trim, drop blanks; what remains is any number of `key=value`
 * pairs plus **exactly one** bare line, which is the version. The pairs are a
 * later nvm addition carrying settings jup has no counterpart for, so they are
 * skipped rather than validated — jup is not a linter for someone else's file,
 * and rejecting a key it has not heard of would break on nvm's next release.
 *
 * The empty-key case (`=20`) is nvm's, reproduced rather than tidied: a line
 * whose text before the first `=` is empty is the bare line, not a pair. It
 * costs nothing and it happens to round-trip, since §04's partial-version
 * grammar accepts a leading `=`.
 */
function declaredVersion(content: string): string | null {
  let bare: string | undefined;

  for (const line of content.split(/\r?\n/)) {
    const text = line.replace(/#.*$/, "").trim();
    if (text === "") continue;

    const eq = text.indexOf("=");
    if (eq > 0 && SETTING_KEY_RE.test(text.slice(0, eq).trimEnd())) continue;

    // Two of them is the ambiguity nvm refuses, and so does this.
    if (bare !== undefined) return null;
    bare = text;
  }

  return bare ?? null;
}

/**
 * The declared version-ish as a range §04 can resolve, or `null`.
 *
 * The numeric half of nvm's vocabulary needs **no translation at all**: `20`,
 * `v20`, `20.10`, `v20.10.0` and `20.x` are already ranges under §04.2's
 * grammar, whose partial-version form accepts the `v` prefix. That is the
 * overwhelming majority of `.nvmrc` files in the wild, and it is why this
 * function is as short as it is.
 *
 * What is left is aliases, and only the two "newest" ones survive. The LTS
 * forms — `lts/*` and `lts/<codename>`, which are the ones people miss — have
 * no data source on this side: the `node` launcher package publishes dist-tags
 * `latest` and `v4-lts` … `v20-lts`, and the LTS series tags stop there, so
 * `lts/*` cannot be answered at all and `lts/<codename>` would need a
 * compiled-in codename-to-major table growing by a release per LTS line. That
 * is the shape §15.21 exists to refuse. `iojs`, `system` and `default` name
 * machine state rather than a project's requirement, and `system` in particular
 * asks for a node jup did not install and cannot vouch for (§06).
 *
 * All of them take the same refusal, which names the word and points at
 * `devEngines.runtime` — the field that can say anything this one cannot.
 */
function rangeFrom(declared: string): string | null {
  if (isValidRange(declared)) return declared;
  if (NVM_NEWEST.has(declared)) return "latest";
  return null;
}
