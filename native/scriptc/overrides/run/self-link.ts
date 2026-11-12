/**
 * §10.6 for the scriptc build — what a shim of ours is.
 *
 * The native build's shims are symlinks straight at this executable, which
 * dispatches on the name it was invoked under (`native-bin.ts`). There is no
 * stub to carry `@jup-shim`, so ownership is the link itself: an entry is ours
 * when it is a symlink whose realpath is ours. A name alone still proves
 * nothing, and a copy of the binary, or a link to some other copy of it, is not
 * ours to remove.
 */

const { lstatSync, realpathSync } = process.getBuiltinModule("node:fs");

let self: string | undefined;

/** `realpath(process.execPath)` — the file `enable` links every name at. */
export function selfExecutable(): string {
  self ??= realpathSync(process.execPath);
  return self;
}

/** Is `file` a symlink that resolves to this executable? */
export function isSelfLink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink() && realpathSync(file) === selfExecutable();
  } catch {
    return false;
  }
}
