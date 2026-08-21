/**
 * Shims and PATH integration — §10.
 *
 * `enable` puts our names on PATH; `disable` takes them off.
 */

export interface ShimOptions {
  installDirectory?: string;
  /** §14.16 — required to replace an entry we did not create. */
  force?: boolean;
}

/**
 * §10.4 + §14.17 — locate where shims go.
 *
 * Prefer our own path over a `PATH` lookup for a binary named `corepack`, which
 * picks the wrong directory when the tool was run by absolute path while another
 * copy sits earlier on PATH. `enable` realpaths the result so relative link
 * targets are correct; `disable` deliberately does not.
 */
export function resolveInstallDirectory(options: ShimOptions, forEnable: boolean): string {
  throw new Error(`TODO(T18): resolveInstallDirectory()`);
}

/**
 * §10.2 — POSIX shims are relative symlinks, created with `lstat` (not `stat`,
 * so a dangling symlink is seen as a symlink) and **idempotent**: an
 * already-correct link is not rewritten and its mtime is unchanged.
 *
 * §14.16: refuse to replace a regular file that is not one of our own shims
 * unless `--force`. Yarn Switch then falls out of the general rule rather than
 * being a hard-coded exception.
 */
export function cmdEnable(args: string[]): Promise<number> {
  throw new Error(`TODO(T18): cmdEnable(${args.join(" ")})`);
}

/** §10.6 — removes only the names it was asked about; `disable yarn` also removes `yarnpkg`. */
export function cmdDisable(args: string[]): Promise<number> {
  throw new Error(`TODO(T18): cmdDisable(${args.join(" ")})`);
}
