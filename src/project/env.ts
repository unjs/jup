/**
 * Environment and `.jup.env` — §03.2, §11, §14.5.
 *
 * Reading the environment is the *only* configuration input the tool has. There
 * is no config file, no user profile, no registry of registries.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  COREPACK_PREFIX,
  corepackSpelling,
  ENV,
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
 * §03.2 — corepack's spelling, still read. Unlike `.jup.lock` (§15.23) this file
 * exists in repositories today, so §14.24's rename keeps the read side.
 */
export const LEGACY_ENV_FILE_NAME = ".corepack.env";

/**
 * §03.2 + §14.5 — variables an env file may never supply.
 *
 * `COREPACK_ENV_FILE` is chicken-and-egg; `COREPACK_ENABLE_DOWNLOAD_PROMPT`'s
 * default depends on how the tool was invoked, which a project file must not be
 * able to override. The rest are §14.5's and §15.37's security additions: a
 * hostile repo must not be able to disable signature verification, point at an
 * arbitrary host, pair a token with a hostile registry to exfiltrate it,
 * switch off (or redirect) TLS certificate verification, or nominate any of the
 * three *locations* code is loaded and run from (§14.5, below).
 */
export const ENV_FILE_INELIGIBLE = new Set<string>([
  ENV.ENV_FILE,
  ENV.ENABLE_DOWNLOAD_PROMPT,
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
 * §14.5's additions: variables a project file must never supply because doing so
 * is a security decision, not a preference. Corepack honours all of these from
 * an env file, so a cloned repo can disable signature verification, point
 * downloads at an arbitrary host, or pair a token with a hostile registry to
 * exfiltrate it.
 *
 * These are the ones worth telling the user about; the other two entries in
 * {@link ENV_FILE_INELIGIBLE} are refused silently, as corepack refuses them.
 */
export const SECURITY_ONLY_FROM_ENVIRONMENT = new Set<string>([
  ENV.INTEGRITY_KEYS,
  ENV.ENABLE_UNSAFE_CUSTOM_URLS,
  ENV.NPM_TOKEN,
  ENV.NPM_USERNAME,
  ENV.NPM_PASSWORD,
  // §15.37 marks both TLS variables env-file INELIGIBLE, and for the same
  // reason as the rest of this list: a cloned repository must not be able to
  // switch certificate verification off, or to nominate the certificate
  // authority its downloads are checked against. `COREPACK_NETWORK_TIMEOUT` and
  // `COREPACK_NETWORK_RETRIES` are eligible — they are preferences, not trust
  // decisions.
  ENV.CAFILE,
  ENV.STRICT_SSL,
  // §15.11 / §15.37 — the one opt-out from "every artifact clears a verification
  // tier". A cloned repository that could set it from an env file would be
  // able to turn its own unsigned, unpinned download into a permitted one, which
  // is the whole of what §15.11 refuses; the deny-list is what keeps the opt-out
  // a decision the person running the tool makes.
  ENV.ALLOW_UNVERIFIED,
  // §15.35d / §15.37 — the file that supplies the project spec. Eligibility is a
  // *deny*-list, so a variable is project-settable until it is named here: a
  // cloned repository whose env file set this could point the spec at a
  // file of its own and run a package manager the manifest never names.
  ENV.SPEC_FILE,
  // §11.5 / §14.23 — the advisory mute covers TLS verification being off
  // (§15.4), a registry that publishes no signatures (§15.11), an unverified
  // artifact permitted (§15.11) — and this very warning. A cloned repository
  // able to set it could silence the evidence of what its *other* variables
  // were refused for, so muting stays the caller's decision to make.
  ENV.QUIET_ADVISORIES,
  // §14.5 — the store root, and with it the trusted-key cache. Corepack (and
  // §11.1 until this entry) treats this as a preference: where the cache lives.
  // It is not. It is the answer to "which bytes have already been verified":
  // an install directory carrying the `.jup` marker is returned by
  // `resolveInstallTarget` with no digest check at all whenever the project
  // spec is unpinned — the common `"packageManager": "yarn@1.22.22"` case — so
  // a cloned repository able to point this at a tree it ships would be handing
  // itself arbitrary code execution on the first run, with no network, no
  // prompt and no warning. The same directory holds the cached npm signing
  // keys (§06), so the second reading of it is "which publishers are trusted".
  // Relocating the store stays the decision of whoever runs the tool.
  ENV.HOME,
  // §15.13 / §15.37 — the shim directory is prepended to the `PATH` the package
  // manager and every process it spawns inherits (§08.4), which makes it the
  // first place the *system* looks for `git`, `node`, and every other helper —
  // not merely where this tool's own shims are written. A repository that could
  // name it from its env file could ship the directory too, and the first
  // helper the package manager shells out to would be its own. What runs ahead
  // of the user's `PATH` is a trust decision, not a layout preference.
  ENV.SHIM_DIRECTORY,
  // §08.3.1 — the interpreter package managers are executed *with*. Nothing in
  // this host reads it yet, so the entry is here before the hazard is: whoever
  // implements §08.3.1's "if COREPACK_NODE_EXECPATH is set, use it" would
  // otherwise be giving a cloned repository the ability to name the binary that
  // runs on `git clone && yarn`. Choosing the interpreter is choosing what
  // executes; it can never come from the project.
  ENV.NODE_EXECPATH,
  // §15.43 — the runtime `enable` bakes into the shim shebang when its own
  // `process.execPath` is in the store. A project able to supply it would name
  // the interpreter every shimmed `npm`, `yarn` and `pnpm` runs under from then
  // on: `COREPACK_NODE_EXECPATH`'s decision, persisted.
  ENV.HOST_RUNTIME,
]);

/**
 * Warned-about `<path>\0<NAME>` pairs.
 *
 * §14.5 asks for one warning per offending variable. Only the closest env file
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
 * §03.2, §16.2 — dotenv parse, reproducing `node:util`'s `parseEnv`.
 *
 * Written out by hand rather than delegating, because `node:util` is ~40 kB of
 * JavaScript and 3 native modules loaded on **every** invocation to serve a file
 * that, for almost every project, does not exist: `parseEnvFile` runs only when
 * an env file is actually there. `await import` cannot help — the walk in
 * §03.1 is synchronous — so the ~80 lines §16.2 budgets are what buys it back
 * (measured: −0.85 ms on a warm run, out of ~10 ms of our own).
 *
 * The behaviour is `parseEnv`'s, quirks included, and
 * `test/unit/env.test.ts` holds a differential test that runs both over a corpus
 * of generated files and asserts they agree — importing `node:util` in a *test*
 * costs nothing, and it is what stops the two drifting. The quirks worth naming,
 * since none of them is what a reader would guess:
 *
 * * **Every** `\r` is deleted first, not just the ones in `\r\n` pairs.
 * * A value may be `'`, `"` or `` ` `` quoted, and the quoted run may span lines.
 *   Only a **double**-quoted value expands `\n`; nothing else is an escape, so
 *   `"a\"b"` ends at the middle quote. An **unterminated** quote is not a quote
 *   at all: the value is the rest of the line, including the quote character,
 *   and `#` does not start a comment in it.
 * * In an unquoted value `#` starts a comment anywhere, no space required.
 * * Leading blanks after `=` are skipped *across newlines* — `A= \nB=2` sets `A`
 *   to `B=2` — but only when the first character is a space or tab, which is why
 *   `A=\nB=2` sets `A` to `""` and `B` to `2`.
 * * `export ` is stripped from a key, once, and only with that single space.
 * * An empty key keeps its line's value out of the result (`=1` yields nothing),
 *   except when the value is empty, where `""` is stored under `""` — one
 *   consequence of `parseEnv`'s ordering, reproduced rather than tidied because
 *   the differential test would otherwise have to paper over it.
 * * The document itself is trimmed once up front, which is the *only* thing that
 *   ever trims an unterminated-quote value: `A='x \nB=2` keeps the space,
 *   `A='x \n` does not, because there the space is at the end of the file.
 */
export function parseEnvFile(content: string): Record<string, string> {
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
    // A comment line: everything up to the break, and no more.
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
      assign(vars, trimmed, "");
      break;
    }
    if (text.charCodeAt(i) === CH_LF) {
      assign(vars, trimmed, "");
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
        assign(vars, key, quote === CH_DOUBLE_QUOTE ? raw.replaceAll(String.raw`\n`, "\n") : raw);
        // Whatever follows the closing quote on that line is discarded.
        i = endOfLine(text, close + 1) + 1;
        continue;
      }
      // Unterminated: a plain value that happens to start with a quote — one in
      // which `#` is an ordinary character and trailing blanks are kept.
      const lineEnd = endOfLine(text, i);
      assign(vars, key, text.slice(i, lineEnd));
      i = lineEnd;
      continue;
    }

    const lineEnd = endOfLine(text, i);
    const hash = indexWithin(text, CH_HASH, i, lineEnd);
    assign(vars, key, trimBlanks(text, i, hash === -1 ? lineEnd : hash));
    i = lineEnd;
  }

  return vars;
}

/**
 * `parseEnv` has no `__proto__` key in its output, so neither does this.
 *
 * Nothing behavioural rides on it — the key cannot carry the `COREPACK_` prefix
 * §03.2 filters on — but matching it keeps the differential test exact.
 */
function assign(vars: Record<string, string>, key: string, value: string): void {
  if (key !== "__proto__") vars[key] = value;
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
 * With the variable unset, `.corepack.env` is tried second (§03.2, §14.24) — per
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
 * Filter to `COREPACK_`-prefixed, drop the ineligible set (warning once each),
 * then merge as `{...fileVars, ...process.env}` — the real environment wins —
 * and assign the result to `process.env` for the remainder of the run.
 */
export function applyEnvFile(vars: Record<string, string>, path: string): void {
  const eligible: Record<string, string> = {};

  for (const name of Object.keys(vars)) {
    // §03.2 security note: the prefix filter runs *before* anything is merged.
    if (!isToolEnvName(name)) {
      continue;
    }

    if (!isEnvFileEligible(name)) {
      // Warn only for the §14.5 / §15.37 adds. Corepack already refuses
      // COREPACK_ENV_FILE and COREPACK_ENABLE_DOWNLOAD_PROMPT silently, and
      // conformance row 48 asserts stderr is empty when a project's env file
      // tries to turn the download prompt on — so announcing those two would
      // break a row while telling the user nothing they can act on.
      if (SECURITY_ONLY_FROM_ENVIRONMENT.has(corepackSpelling(name))) {
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
    // variable has two spellings, so the *pair* is what has to be checked. The
    // spread below only shadows a file value with the same key; without this, a
    // file's `JUP_HOME` would out-rank a real `COREPACK_HOME`, because `readEnv`
    // prefers `JUP_` and cannot tell which of the two came from the file.
    if (isSetInEnvironment(name)) continue;

    eligible[name] = value;
  }

  process.env = { ...eligible, ...process.env };
}

/** Whether either spelling of `name` is set in the real process environment. */
function isSetInEnvironment(name: string): boolean {
  const corepack = corepackSpelling(name);
  return process.env[corepack] !== undefined || process.env[jupSpelling(corepack)] !== undefined;
}

export function isEnvFileEligible(name: string): boolean {
  // The deny-lists are keyed by the `COREPACK_` spelling, so `JUP_NPM_TOKEN` is
  // canonicalised before it is checked: a variable that a project file may not
  // supply may not be supplied under its other name either.
  return isToolEnvName(name) && !ENV_FILE_INELIGIBLE.has(corepackSpelling(name));
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
 * §08.6 — "an unset `CI`", the way every other tool spells it: any non-empty
 * value means a non-interactive automated environment.
 *
 * It gates two unrelated things, which is why it lives here rather than in
 * either caller: the interactive half of the download prompt (§05.5), and
 * §15.23's frozen-lockfile default.
 */
export function isCI(): boolean {
  const ci = process.env[SYSTEM_ENV.CI];
  return ci !== undefined && ci !== "";
}

/**
 * §15.23 / §15.37 — whether `.jup.lock` may be written or refreshed.
 *
 * `COREPACK_FROZEN_LOCKFILE` wins in **both** directions when it is set: `1`
 * freezes, anything else thaws, including inside CI. With it unset, CI defaults
 * to frozen — the convention every package manager's own `--frozen-lockfile`
 * follows, and the behaviour that makes a CI run fail loudly instead of quietly
 * resolving a range to something the developer never saw.
 *
 * @param options `refresh` marks a command the user ran *in order to* update the
 * resolution (`corepack up`). The CI default must not block that — it exists to
 * stop an *implicit* update — but an explicit `COREPACK_FROZEN_LOCKFILE=1` still
 * does, because §15.37 defines it as "refuse to write/refresh".
 */
export function isFrozenLockfile(options?: { refresh?: boolean }): boolean {
  const raw = readEnv(ENV.FROZEN_LOCKFILE);
  if (raw !== undefined && raw !== "") return raw === "1";
  return options?.refresh === true ? false : isCI();
}
