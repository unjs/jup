/**
 * §04.6 — what the format of a package manager's own lockfile says about which
 * major wrote it, for a project that declares no spec at all.
 *
 * A **cold-path** module: reached only from §04.6's fallback, which a project
 * with a spec never takes, so it stays out of the warm set §16 budgets. Reading
 * the file is `pm-lockfile.ts`'s and is shared with §04.4; here are the table
 * and the rule.
 */

import { readManagerDocument, unquote } from "./pm-lockfile.ts";

/**
 * Which majors write each `lockfileVersion`, as a range — §04.6.
 *
 * A project with no spec still says something about which major it expects:
 * pnpm has changed this format on major boundaries, and running a different one
 * over the file is not benign — the newer major rewrites it in its own format
 * and re-resolves the pins on the way, and `--frozen-lockfile` refuses outright.
 * It stays a *guess*, outranked by every statement a project actually makes.
 *
 * Keyed by the format with a trailing `.0` trimmed, so the spellings one number
 * arrives under (`5`, `'6.0'`, `"9.0"`) collapse to one row. Verified against
 * the `LOCKFILE_VERSION` constant compiled into every pnpm major and against
 * the files those majors write. Two rows are worth their footnotes:
 *
 * * `6.1` was written by 8.6.0 and 8.6.1 only, and reverted in 8.6.2 — the same
 *   major as `6`, so the revert costs nothing here.
 * * **`9` is deliberately absent.** pnpm 9, 10, 11 and 12 all write it, and
 *   their output for one project is byte-identical, so the file says nothing
 *   beyond ">= 9". Its absence is the answer, not an omission.
 *
 * `use-lockfile-v6` (pnpm 7.24 to 8.x) could put a `6.0` file under pnpm 7, or a
 * `5.4` one under pnpm 8. Both are rare, both are one setting away from the
 * default this maps to, and a range admitting them would admit the major that
 * cannot read the file either way.
 */
const LOCKFILE_FORMATS: Record<string, Record<string, string>> = {
  pnpm: {
    "6.1": ">=8.0.0 <9.0.0",
    "6": ">=8.0.0 <9.0.0",
    "5.4": ">=7.0.0 <8.0.0",
    "5.3": ">=6.0.0 <7.0.0",
    "5.2": ">=5.10.0 <6.0.0",
    "5.1": ">=3.5.0 <5.10.0",
    "5": ">=3.0.0 <3.5.0",
  },
};

/** `lockfileVersion: '9.0'` — column zero, in whichever document opens the file. */
const FORMAT_LINE = /^lockfileVersion[ \t]*:[ \t]*(\S.*?)[ \t]*$/m;

/** A format number, held as written: `5`, `5.4`, `6.0`. Anything else is not one. */
const FORMAT_NUMBER = /^\d{1,3}(?:\.\d{1,3})?$/;

/** §04.6 — the format a package manager's own lockfile is written in. */
export interface DeclaredFormat {
  /** `lockfileVersion` as the file spells it, with a trailing `.0` trimmed. */
  format: string;
  /** The range every major that writes {@link format} satisfies. */
  range: string;
  /** The file it came out of, which `info` names and this module never writes. */
  path: string;
}

/**
 * §04.6 — what `dir`'s `<tool>` lockfile says about which major wrote it.
 *
 * `null` for a tool that keeps no lockfile, a file that is missing or
 * unreadable, a `lockfileVersion` this build does not recognise, and for every
 * format more than one current major writes. Each means "no opinion", leaving
 * §04.6's recorded default exactly as it was. `JUP_ENABLE_PM_LOCKFILE` gates it,
 * in the reader shared with §04.4.
 */
export function readDeclaredFormat(dir: string, name: string): DeclaredFormat | null {
  const formats = Object.hasOwn(LOCKFILE_FORMATS, name) ? LOCKFILE_FORMATS[name]! : undefined;
  if (formats === undefined) return null;

  const document = readManagerDocument(dir, name);
  if (document === null) return null;

  const line = FORMAT_LINE.exec(document.head);
  if (line === null) return null;

  const value = unquote(line[1]!);
  if (!FORMAT_NUMBER.test(value)) return null;

  // A trailing `.0` is trimmed rather than the number read, so that `6.0` and
  // `6` are one format and `6.10` — which pnpm has never written — is not `6.1`.
  const format = value.endsWith(".0") ? value.slice(0, -2) : value;
  if (!Object.hasOwn(formats, format)) return null;

  return { format, range: formats[format]!, path: document.path };
}
