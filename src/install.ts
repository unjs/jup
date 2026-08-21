/**
 * Download, verify, promote — §06.1, §07.3–§07.6.
 *
 * One streaming pass: socket -> tee -> digest, and -> gunzip -> tar -> disk
 * (§16.5). Caps are checked as the stream flows, not afterwards; by then the
 * disk is full.
 */

import type { InstallSpec, Locator } from "./types.ts";

/**
 * Returns the install spec, downloading only on a `.corepack` miss.
 *
 * Verification follows §06.1's decision table exactly. Two of its consequences
 * are deliberate and must not be "fixed": a user-supplied hash overrides
 * signature verification, and a hash mismatch discards the temp folder so
 * nothing is ever cached — a re-run must fail identically.
 *
 * Per §14.10, the **tarball stream** is hashed even on the single-file
 * (`registry.bin`) path and compared against the signed `dist.integrity`, which
 * closes the hole where Yarn Berry through a corporate mirror arrives unverified.
 */
export function ensureInstalled(
  locator: Locator,
  options?: { cacheOnly?: boolean },
): Promise<InstallSpec> {
  throw new Error(`TODO(T15): ensureInstalled(${locator.name}@${locator.reference})`);
}

/**
 * §05.5 — printed before any **artifact** download, never before metadata.
 *
 * The notice needs `COREPACK_ENABLE_DOWNLOAD_PROMPT=1`; the interactive
 * confirmation additionally needs a TTY stdin and an unset `CI`. Any input other
 * than `n`/`N` — including a bare newline — is yes.
 */
export function confirmDownload(url: string): Promise<void> {
  throw new Error(`TODO(T15): confirmDownload(${url})`);
}
