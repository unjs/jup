/**
 * The shape of the lockfile a package manager keeps for itself, and nothing
 * about what jup does with what is in it.
 *
 * Two rules read one `pnpm-lock.yaml`: §04.4's declared resolution
 * (`lockfile.ts`) and §04.6's inferred default (`lockfile-format.ts`). What
 * they share is here — the file's name per tool, one bounded read, one document
 * boundary, one scalar reader, one switch — and each rule stays where it is
 * decided. Nothing here is written, and every failure answers `null`.
 *
 * Patterns rather than a parser: one program writes this file with a
 * fixed-width emitter, and a YAML parser would be a warm-path dependency for
 * four lines of one document.
 */

const { closeSync, openSync, readSync } = process.getBuiltinModule("node:fs");
const { join } = process.getBuiltinModule("node:path");
import { ENV } from "../config/env-vars.ts";
import { envDisabled } from "./env.ts";

/** The file each package manager records its own resolution in, by tool name. */
const MANAGER_LOCKFILES: Record<string, string> = { pnpm: "pnpm-lock.yaml" };

/**
 * How much of it is ever read: enough for the **first** document, which holds
 * the manager's own resolution and the `lockfileVersion` above it. The
 * project's `importers` and `packages` — the megabytes — are the document after
 * the `---`, so this stays a bounded probe (§01.3) for either question.
 */
const MANAGER_LOCKFILE_BYTES = 64 * 1024;

/** A document break. The file opens with one; that one is a start, not a break. */
const DOCUMENT_BREAK = /^---[ \t]*$/m;

/** `  .:` — the root importer, the only one whose directory is this manifest's. */
const ROOT_IMPORTER = /^ {2}(?:\.|'\.'|"\.")[ \t]*:[ \t]*$/m;

/** `    packageManagerDependencies:`, within it. */
const MANAGER_DEPENDENCIES = /^ {4}packageManagerDependencies:[ \t]*$/m;

/** The first line back out to a given indent closes the block above it. */
const OUT_OF_IMPORTER = /^ {0,2}\S/m;
const OUT_OF_SECTION = /^ {0,4}\S/m;

/** One entry, at pnpm's own fixed indentation and in its own key order. */
const MANAGER_ENTRY =
  /^ {6}(?<name>[^\s:'"]+|'[^'\n]*'|"[^"\n]*")[ \t]*:[ \t]*\n {8}specifier:[ \t]*(?<specifier>\S.*?)[ \t]*\n {8}version:[ \t]*(?<version>\S.*?)[ \t]*$/gm;

/** A lockfile's first document (`\r` stripped, truncated at the budget), and its path. */
export interface ManagerDocument {
  path: string;
  head: string;
}

/** Where a tool would keep its own lockfile in `dir`, if it keeps one (§04.4). */
export function managerLockfilePath(dir: string, name: string): string | null {
  return Object.hasOwn(MANAGER_LOCKFILES, name) ? join(dir, MANAGER_LOCKFILES[name]!) : null;
}

/**
 * The first document of `dir`'s `<tool>` lockfile, or `null`.
 *
 * The gate both rules share is here: `JUP_ENABLE_PM_LOCKFILE=0` means the file
 * is not opened at all, for either question (§11.1). A tool that keeps no
 * lockfile costs no syscall.
 */
export function readManagerDocument(dir: string, name: string): ManagerDocument | null {
  const path = managerLockfilePath(dir, name);
  if (path === null) return null;
  if (envDisabled(ENV.ENABLE_PM_LOCKFILE)) return null;

  const text = readPrefix(path, MANAGER_LOCKFILE_BYTES);
  return text === null ? null : { path, head: firstDocument(text) };
}

/**
 * §04.4 — the root importer's `packageManagerDependencies` entry for `name`,
 * unquoted and otherwise unexamined: whether a version is one, and whether a
 * specifier is the range the project declares, are §04.4's questions.
 */
export function readManagerDependency(
  document: ManagerDocument,
  name: string,
): { specifier: string; version: string } | null {
  const importer = section(document.head, ROOT_IMPORTER, OUT_OF_IMPORTER);
  if (importer === null) return null;
  const body = section(importer, MANAGER_DEPENDENCIES, OUT_OF_SECTION);
  if (body === null) return null;

  for (const match of body.matchAll(MANAGER_ENTRY)) {
    const entry = match.groups!;
    if (unquote(entry.name!) !== name) continue;
    return { specifier: unquote(entry.specifier!), version: unquote(entry.version!) };
  }

  return null;
}

/**
 * The first `bytes` of `path`, or `null`. One `read` at offset 0: `readFileSync`
 * would pull a multi-megabyte lockfile into memory to reach its first dozen
 * lines. `\r` goes at the door, so no pattern carries `\r?`.
 */
function readPrefix(path: string, bytes: number): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(bytes);
    const read = readSync(fd, buffer, 0, bytes, 0);
    return buffer.toString("utf8", 0, read).replaceAll("\r", "");
  } catch {
    // Missing, unreadable, a directory: all "no answer", as every read here is.
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing further to try; the answer above stands either way.
      }
    }
  }
}

/** The text up to the first document break, discounting the opening one. */
function firstDocument(text: string): string {
  const rest = text.startsWith("---") ? text.slice(text.indexOf("\n") + 1) : text;
  const next = DOCUMENT_BREAK.exec(rest);
  return next === null ? rest : rest.slice(0, next.index);
}

/** The block under `heading`, ending where `end` first matches back out of it. */
function section(text: string, heading: RegExp, end: RegExp): string | null {
  const match = heading.exec(text);
  if (match === null) return null;

  const body = text.slice(match.index + match[0].length);
  const close = end.exec(body);
  return close === null ? body : body.slice(0, close.index);
}

/**
 * A scalar as YAML reads it, for the shapes pnpm emits: bare, and quoted
 * (`'>=12 <13'`, where `''` is a quote). A range, a version or a format number
 * has nothing else to escape, and one that did would fail its caller's
 * validation rather than be believed.
 */
export function unquote(value: string): string {
  const quote = value[0];
  if (value.length < 2 || !value.endsWith(quote!)) return value;
  if (quote === "'") return value.slice(1, -1).replaceAll("''", "'");
  return quote === '"' ? value.slice(1, -1) : value;
}
