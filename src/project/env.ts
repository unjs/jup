/**
 * Environment variables and `.jup.env` are the configuration inputs.
 */

const { readFileSync } = process.getBuiltinModule("node:fs");
const { resolve } = process.getBuiltinModule("node:path");
import {
  COREPACK_PREFIX,
  corepackSpelling,
  ENV,
  envSpellings,
  isToolEnvName,
  jupSpelling,
  readEnv,
  SYSTEM_ENV,
} from "../config/env-vars.ts";
import { advisory, messages } from "../errors.ts";

/**
 * §03.2 — the prefix filter is the entire sandbox against a hostile repository.
 * Keys without it (`HTTP_PROXY`, `PATH`, `NODE_OPTIONS`, …) are dropped before
 * anything is merged. Every name it admits is inventoried in `config/env-vars.ts`.
 *
 * `JUP_` is admitted on the same terms — `isToolEnvName` is the filter actually
 * applied, and this constant remains the §03.2 spelling of it.
 */
export const ENV_FILE_PREFIX = COREPACK_PREFIX;

/** §03.2 — the file looked for when `COREPACK_ENV_FILE` is unset. */
export const DEFAULT_ENV_FILE_NAME = ".jup.env";

/**
 * §03.2 — `.corepack.env` remains a supported compatibility filename.
 */
export const LEGACY_ENV_FILE_NAME = ".corepack.env";

/**
 * Every spelling of every denied name, so the sets below can be asked about a
 * name exactly as the env file spelled it.
 *
 * Both prefixes go in, including the `COREPACK_` spelling of a variable that is
 * `JUP_`-only (§11) and that jup therefore never reads back. The deny-lists
 * govern what a cloned repository may *inject* into the environment, not only
 * what this tool consumes: `applyEnvFile` merges into `process.env`, which every
 * child process inherits, so admitting `COREPACK_CAFILE` because jup ignores it
 * would let a hostile repo launder a refused variable into a sibling tool that
 * does not. The refusal is unconditional, and it stays that way.
 */
function deniedSpellings(names: readonly string[]): ReadonlySet<string> {
  return new Set(names.flatMap((name) => [jupSpelling(name), corepackSpelling(name)]));
}

/**
 * §03.2 — variables an env file may never supply.
 *
 * `COREPACK_ENV_FILE` is chicken-and-egg. The rest are §03.2's security
 * additions: a hostile repo must not be able to disable signature verification,
 * point at an arbitrary host, pair a token with a hostile registry to exfiltrate
 * it, switch off (or redirect) TLS certificate verification, or nominate any of
 * the three *locations* code is loaded and run from, below.
 */
export const ENV_FILE_INELIGIBLE = deniedSpellings([
  ENV.ENV_FILE,
  ENV.INTEGRITY_KEYS,
  ENV.ENABLE_UNSAFE_CUSTOM_URLS,
  ENV.NPM_TOKEN,
  ENV.NPM_USERNAME,
  ENV.NPM_PASSWORD,
  ENV.CAFILE,
  ENV.STRICT_SSL,
  ENV.ALLOW_UNVERIFIED,
  ENV.SPEC_FILE,
  ENV.QUIET_ADVISORIES,
  ENV.HOME,
  ENV.SHIM_DIRECTORY,
  ENV.NODE_EXECPATH,
  ENV.HOST_RUNTIME,
]);

/**
 * This set controls which denied variables emit an advisory; compatibility-denied variables remain silent.
 */
export const SECURITY_ONLY_FROM_ENVIRONMENT = deniedSpellings([
  ENV.INTEGRITY_KEYS,
  ENV.ENABLE_UNSAFE_CUSTOM_URLS,
  ENV.NPM_TOKEN,
  ENV.NPM_USERNAME,
  ENV.NPM_PASSWORD,
  // §03.2 marks both TLS variables env-file INELIGIBLE, and for the same
  // reason as the rest of this list: a cloned repository must not be able to
  // switch certificate verification off, or to nominate the certificate
  // authority its downloads are checked against. `JUP_NETWORK_TIMEOUT` and
  // `JUP_NETWORK_RETRIES` are eligible — they are preferences, not trust
  // decisions.
  ENV.CAFILE,
  ENV.STRICT_SSL,
  // §06.1 / §03.2 — the one opt-out from "every artifact clears a verification
  // tier". A cloned repository that could set it from an env file would be
  // able to turn its own unsigned, unpinned download into a permitted one, which
  // is the whole of what §06.1 refuses; the deny-list is what keeps the opt-out
  // a decision the person running the tool makes.
  ENV.ALLOW_UNVERIFIED,
  // §03.1 / §03.2 — the file that supplies the project spec. Eligibility is a
  // *deny*-list, so a variable is project-settable until it is named here: a
  // cloned repository whose env file set this could point the spec at a
  // file of its own and run a package manager the manifest never names.
  ENV.SPEC_FILE,
  // §11.3 — the advisory mute covers TLS verification being off
  // (§05.1), a registry that publishes no signatures (§06.1), an unverified
  // artifact permitted (§06.1) — and this very warning. A cloned repository
  // able to set it could silence the evidence of what its *other* variables
  // were refused for, so muting stays the caller's decision to make.
  ENV.QUIET_ADVISORIES,
  // The store root also selects the trusted-key cache and therefore the bytes
  // considered already verified:
  // an install directory carrying the `.jup` marker is returned by
  // `resolveInstallTarget` with no digest check at all whenever the project
  // spec is unpinned — the common `"packageManager": "yarn@1.22.22"` case — so
  // a cloned repository able to point this at a tree it ships would be handing
  // itself arbitrary code execution on the first run, with no network, no
  // prompt and no warning. The same directory holds the cached npm signing
  // keys (§06), so the second reading of it is "which publishers are trusted".
  // Relocating the store stays the decision of whoever runs the tool.
  ENV.HOME,
  // §10.5 / §03.2 — the shim directory is prepended to the `PATH` the package
  // manager and every process it spawns inherits (§08.7), which makes it the
  // first place the *system* looks for `git`, `node`, and every other helper —
  // not merely where this tool's own shims are written. A repository that could
  // name it from its env file could ship the directory too, and the first
  // helper the package manager shells out to would be its own. What runs ahead
  // of the user's `PATH` is a trust decision, not a layout preference.
  ENV.SHIM_DIRECTORY,
  // §08.3 — the interpreter package managers are executed *with*. Nothing in
  // this host reads it yet, so the entry is here before the hazard is: whoever
  // implements §08.3's "if JUP_NODE_EXECPATH is set, use it" would
  // otherwise be giving a cloned repository the ability to name the binary that
  // runs on `git clone && yarn`. Choosing the interpreter is choosing what
  // executes; it can never come from the project.
  ENV.NODE_EXECPATH,
  // §10.2 — the runtime `enable` bakes into the shim shebang when its own
  // `process.execPath` is in the store. A project able to supply it would name
  // the interpreter every shimmed `npm`, `yarn` and `pnpm` runs under from then
  // on: `JUP_NODE_EXECPATH`'s decision, persisted.
  ENV.HOST_RUNTIME,
]);

/**
 * Warned-about `<path>\0<NAME>` pairs.
 *
 * §03.2 asks for one warning per offending variable. Only the closest env file
 * is ever loaded (§03.2), so a run applies at most one file and keying by path
 * as well as name costs nothing while keeping repeated applications of *the same*
 * file quiet.
 */
const warnedIneligible = new Set<string>();

const CH_TAB = 0x09;
const CH_LF = 0x0a;
const CH_SPACE = 0x20;
const CH_HASH = 0x23;
const CH_EQUAL = 0x3d;
const CH_DOUBLE_QUOTE = 0x22;
const CH_SINGLE_QUOTE = 0x27;
const CH_BACKTICK = 0x60;

/**
 * Handwritten parsing keeps `node:util` off the synchronous warm path.
 * Differential tests enforce `parseEnv` compatibility: quote-specific escapes
 * and unterminated quotes, `#` handling, cross-line whitespace, `export` and
 * empty-key ordering, CR removal, and whole-document trimming. Branch comments
 * below document the corresponding mechanics.
 */
export function parseEnvFile(content: string): Record<string, string> {
  // Null-prototype, which is what makes a `__proto__=` line a plain own key
  // rather than a write to a prototype — the same thing `parseEnv` does with it.
  const vars: Record<string, string> = Object.create(null) as Record<string, string>;
  const text = trimDocument(content.includes("\r") ? content.replaceAll("\r", "") : content);

  let i = 0;
  // `parseEnv` reads an *indented* `#` as a key when the line before it was a
  // comment (`#c\n\n\t#K=2` -> `#K`) and as a comment otherwise; re-testing
  // after the blank-line skip lost the first case.
  let afterComment = false;
  let indented = false;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    // A blank line, and with it the blanks opening the next one: how
    // `A=1\n\t#=2` is a comment while `#c\n\t#=2` is the key `#`.
    if (code === CH_LF) {
      const next = skipBlanks(text, i + 1);
      indented = next !== i + 1;
      i = next;
      continue;
    }
    if (code === CH_HASH && !(indented && afterComment)) {
      i = endOfLine(text, i) + 1;
      afterComment = true;
      indented = false;
      continue;
    }
    afterComment = false;
    indented = false;

    // A line with no `=` on it is skipped, blanks and all. The search stops at
    // the line break rather than running to the next `=` anywhere in the file,
    // which keeps a file of prose linear instead of quadratic.
    const eol = endOfLine(text, i);
    const equal = indexWithin(text, CH_EQUAL, i, eol);
    if (equal === -1) {
      i = skipBlanks(text, eol + 1);
      continue;
    }

    const trimmed = trimBlanks(text, i, equal);
    i = skipBlanks(text, equal + 1);

    // An empty value is recorded before the key is finished, which is why
    // `export A=` keeps its prefix while `export A=1` loses it, and why an empty
    // key reaches the result here and nowhere else.
    if (i >= text.length) {
      vars[trimmed] = "";
      break;
    }
    if (text.charCodeAt(i) === CH_LF) {
      vars[trimmed] = "";
      i++;
      continue;
    }

    const key = withoutExport(trimmed);
    // `=1`: the value is dropped and re-scanned as if it were its own line, so
    // `=1 B=2` still leaves nothing behind but `A=1\n=2\nB=3` still sets `B`.
    if (key === "") continue;

    const quote = text.charCodeAt(i);
    if (quote === CH_DOUBLE_QUOTE || quote === CH_SINGLE_QUOTE || quote === CH_BACKTICK) {
      const close = text.indexOf(text[i]!, i + 1);
      if (close !== -1) {
        const raw = text.slice(i + 1, close);
        vars[key] = quote === CH_DOUBLE_QUOTE ? raw.replaceAll(String.raw`\n`, "\n") : raw;
        // Whatever follows the closing quote on that line is discarded.
        i = endOfLine(text, close + 1) + 1;
        continue;
      }
      // Unterminated: a plain value that happens to start with a quote — one in
      // which `#` is an ordinary character and trailing blanks are kept.
      const lineEnd = endOfLine(text, i);
      vars[key] = text.slice(i, lineEnd);
      i = lineEnd;
      continue;
    }

    const lineEnd = endOfLine(text, i);
    const hash = indexWithin(text, CH_HASH, i, lineEnd);
    vars[key] = trimBlanks(text, i, hash === -1 ? lineEnd : hash);
    i = lineEnd;
  }

  return vars;
}

/**
 * The whole document's own leading and trailing blanks.
 *
 * The two ends are not symmetric, and both halves are load-bearing: the leading
 * run follows {@link skipBlanks}, while the trailing run also eats newlines
 * unconditionally, which is what trims a file's last value when it is an
 * unterminated quote.
 */
function trimDocument(text: string): string {
  let end = text.length;
  while (end > 0) {
    const code = text.charCodeAt(end - 1);
    if (!isBlank(code) && code !== CH_LF) break;
    end--;
  }
  return text.slice(skipBlanks(text, 0), end);
}

/** The first `code` in `text[from, to)`, or -1: an `indexOf` that cannot leave the line. */
function indexWithin(text: string, code: number, from: number, to: number): number {
  for (let i = from; i < to; i++) {
    if (text.charCodeAt(i) === code) return i;
  }
  return -1;
}

/** The `\n` ending the line `index` is on, or the end of the text. */
function endOfLine(text: string, index: number): number {
  const eol = text.indexOf("\n", index);
  return eol === -1 ? text.length : eol;
}

/**
 * Skip spaces and tabs — and, once skipping has started, newlines too.
 *
 * The asymmetry is `parseEnv`'s: the run is only entered when the first
 * character is a space or tab, but it then runs over line breaks as well.
 */
function skipBlanks(text: string, index: number): number {
  const first = text.charCodeAt(index);
  if (first !== CH_SPACE && first !== CH_TAB) return index;

  let i = index + 1;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code !== CH_SPACE && code !== CH_TAB && code !== CH_LF) return i;
    i++;
  }
  return i;
}

/** `text[start, end)` without its surrounding spaces and tabs. */
function trimBlanks(text: string, start: number, end: number): string {
  let from = start;
  let to = end;
  while (from < to && isBlank(text.charCodeAt(from))) from++;
  while (to > from && isBlank(text.charCodeAt(to - 1))) to--;
  return text.slice(from, to);
}

function isBlank(code: number): boolean {
  return code === CH_SPACE || code === CH_TAB;
}

/**
 * One `export ` prefix removed from an already-trimmed key.
 *
 * Once only — `export export A` is the key `export A` — and only with that
 * exact single space, so `export\tA` is a key that begins with the word.
 */
function withoutExport(key: string): string {
  if (!key.startsWith("export ")) return key;

  let from = "export ".length;
  while (from < key.length && isBlank(key.charCodeAt(from))) from++;
  return key.slice(from);
}

/** Read a file, mapping `ENOENT` to `null` and propagating everything else. */
function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Load the env file for one directory, if any.
 *
 * Path is `resolve(dir, COREPACK_ENV_FILE ?? ".jup.env")`; `COREPACK_ENV_FILE === "0"`
 * disables env files entirely. `ENOENT` is not an error. Only the **closest**
 * file is ever loaded.
 *
 * With the variable unset, `.corepack.env` is tried second (§03.2) — per
 * directory, which is what keeps a parent's `.jup.env` from out-ranking a child's
 * `.corepack.env`: closest still wins, whichever name it carries. A *configured*
 * path gets no fallback — naming a file that is not there is worth surfacing.
 * Costs one extra `openat` per walked directory when neither exists (§01.3).
 */
export function loadEnvFileFrom(
  dir: string,
): { vars: Record<string, string>; path: string } | null {
  const configured = readEnv(ENV.ENV_FILE);
  if (configured === "0") {
    return null;
  }

  const names =
    configured === undefined ? [DEFAULT_ENV_FILE_NAME, LEGACY_ENV_FILE_NAME] : [configured];

  for (const name of names) {
    const path = resolve(dir, name);
    const content = readIfPresent(path);
    if (content !== null) return { vars: parseEnvFile(content), path };
  }

  return null;
}

/**
 * Filter project variables before merging; process environment values win, and denied security variables warn once.
 */
export function applyEnvFile(vars: Record<string, string>, path: string): void {
  const eligible: Record<string, string> = {};

  for (const name of Object.keys(vars)) {
    // §03.2 security note: the prefix filter runs *before* anything is merged.
    if (!isToolEnvName(name)) {
      continue;
    }

    if (!isEnvFileEligible(name)) {
      // Compatibility-denied variables remain silent; security-denied variables
      // emit an advisory.
      if (SECURITY_ONLY_FROM_ENVIRONMENT.has(name)) {
        const seen = `${path}\0${name}`;
        if (!warnedIneligible.has(seen)) {
          warnedIneligible.add(seen);
          advisory(messages.ignoringEnvVar(name, path));
        }
      }
      continue;
    }

    const value = vars[name];
    if (value === undefined) continue;

    // §11.6 — the real process environment always wins over the file, and a
    // compatibility setting has two spellings, so every spelling it answers to
    // has to be checked. The spread below only shadows a file value with the
    // same key; without this, a file's `JUP_HOME` would out-rank a real
    // `COREPACK_HOME`, because `readEnv` prefers `JUP_` and cannot tell which of
    // the two came from the file.
    if (isSetInEnvironment(name)) continue;

    eligible[name] = value;
  }

  process.env = { ...eligible, ...process.env };
}

/** Whether any spelling `name` answers to is set in the real process environment. */
function isSetInEnvironment(name: string): boolean {
  return envSpellings(name).some((spelling) => process.env[spelling] !== undefined);
}

export function isEnvFileEligible(name: string): boolean {
  // §11 — the deny-list carries both spellings of every entry, so a variable a
  // project file may not supply may not be supplied under its other name
  // either, and the name is checked exactly as the file spelled it.
  return isToolEnvName(name) && !ENV_FILE_INELIGIBLE.has(name);
}

/** `true` only for the exact string `"1"`, matching the spec's value tables. */
export function envFlag(name: string): boolean {
  return readEnv(name) === "1";
}

/** `true` only for the exact string `"0"`. */
export function envDisabled(name: string): boolean {
  return readEnv(name) === "0";
}

/**
 * §04.4 — whether the project's `jup.lock` may be written.
 *
 * Only `JUP_FROZEN_LOCKFILE=1` freezes it. Package-manager runs never edit
 * the recorded file; `use` and `up` are its writers.
 *
 * The cache in `node_modules` is outside this entirely (§04.4). It is not a
 * committed record, freezing it would only cost a request per run, and a job
 * that wants no writes at all has a read-only filesystem for that.
 */
export function isFrozenLockfile(): boolean {
  return readEnv(ENV.FROZEN_LOCKFILE) === "1";
}
