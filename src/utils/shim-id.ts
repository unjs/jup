/**
 * Recognising one of our own shims — §17.6 C7, §14.16, §15.15.
 *
 * Three commands ask this question and they must all get the same answer:
 * `enable` (is this name mine to replace?), `disable` (is this name mine to
 * remove?), `info` (is the thing on `PATH` mine?) — and, as of §17.6 C7, every
 * lookup that picks a **JavaScript interpreter**, because once `node` is a name
 * this tool can shim, a lookup that finds the shim re-enters the tool and looks
 * up `node` again. The recursion is unbounded and its symptom is a hang or a
 * fork bomb, not an error.
 *
 * **The rule is content, not identity.** C7 is explicit that the test must not
 * be identity with the tool's own executable: that only holds for §14.15's
 * link-based model, where a shim *is* the tool under another name. Under §10.1's
 * generated-script model — the one this implementation uses — a shim is a
 * different file with a different inode, and an identity comparison never fires.
 *
 * C7 names §15.15's record as the instrument. It is the wrong one, and this is
 * worth writing down rather than discovering twice: §15.15's record is of what
 * `enable` **displaced**, not of what it **wrote**. `enable` records nothing at
 * all for a name that was free, which is the overwhelmingly common case and
 * exactly the case a `node` shim will be in. So the record cannot answer "is
 * this file mine"; what can is {@link SHIM_MARKER}, which every artifact
 * `enable` writes carries in its first two lines — the generated stub, the three
 * §10.3 wrappers, and (through the symlink) a POSIX shim.
 *
 * The rule, in order, is therefore:
 *
 * 1. the marker in the head of the file, following symlinks — this covers
 *    §10.1's stub, a POSIX shim pointing at one, and all three §10.3 wrappers;
 * 2. a §10.3 wrapper written by an older build, which predates the marker and is
 *    recognised by its shebang plus the `<binName>.js` stub it invokes;
 * 3. identity with the tool's own entry module — C7's "fall back to the identity
 *    test for a shim the record does not cover", which is what a §14.15
 *    hardlink or symlink would need. It cannot fire under §10.1 and is here so
 *    that a distribution that switches models does not silently lose the guard.
 *
 * Note what step 3 must *not* compare against: `process.execPath`. In a
 * JavaScript implementation that is the **runtime**, so comparing an interpreter
 * candidate with it would classify the real `node` as a shim and exclude it.
 */

import { closeSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { findEntryModule } from "./self.ts";

/** The banner every artifact `enable` writes carries in its first two lines. */
export const SHIM_MARKER = "@jup-shim";

/**
 * The first line of each §10.3 wrapper as older builds wrote it, before C7 put
 * the marker in all three.
 *
 * Kept as a fallback so that `enable` and `disable` still recognise — and so
 * still replace and remove — wrappers a previous build left behind. Nothing is
 * published, so this covers development installs only; it is three strings.
 */
const WIN32_WRAPPER_HEADS = ["@SETLOCAL", "#!/bin/sh", "#!/usr/bin/env pwsh"];

/** How much of a file has to be read to answer the question. */
export const HEAD_BYTES = 1024;

/**
 * Steps 1 and 2 of the rule, given a head somebody else read.
 *
 * Separated from the I/O because `shims.ts` reads heads asynchronously (it
 * processes every binary name concurrently) and `info.ts` reads them
 * synchronously, and the *rule* must not be written twice.
 */
export function headIsShim(head: string | undefined, binName: string): boolean {
  if (head === undefined) return false;
  if (head.includes(SHIM_MARKER)) return true;
  return (
    WIN32_WRAPPER_HEADS.some((start) => head.startsWith(start)) && head.includes(`${binName}.js`)
  );
}

/** The first `length` bytes of a file as UTF-8, or `undefined` if unreadable. */
export function readHeadSync(file: string, length = HEAD_BYTES): string | undefined {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return undefined;
  }
  try {
    const buffer = Buffer.allocUnsafe(length);
    const bytes = readSync(fd, buffer, 0, length, 0);
    return buffer.toString("utf8", 0, bytes);
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/**
 * Step 3 — the tool's own entry module, resolved once.
 *
 * `findEntryModule` walks up to `src/` or `dist/`, which is where a §14.15 link
 * would point; `undefined` when the walk fails, which simply skips the step.
 */
let ownEntry: string | null | undefined;
function ownEntryPath(): string | null {
  if (ownEntry === undefined) {
    const found = findEntryModule(import.meta.url);
    ownEntry = found === undefined ? null : realpathOr(join(found.directory, found.entry));
  }
  return ownEntry;
}

function realpathOr(file: string): string | null {
  try {
    return realpathSync(file);
  } catch {
    return null;
  }
}

/**
 * The whole rule, for a file on disk. Follows symlinks, so a POSIX shim is
 * answered by the stub it points at.
 */
export function isShimFile(file: string, binName: string): boolean {
  if (headIsShim(readHeadSync(file), binName)) return true;

  // §14.15's model — see the module comment for why this is a fallback and not
  // the test itself, and for why `process.execPath` is not in it.
  const entry = ownEntryPath();
  return entry !== null && realpathOr(file) === entry;
}
