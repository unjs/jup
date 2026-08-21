/**
 * gzip + tar, reader and writer — §07.4, §07.10.
 *
 * A tarball is attacker-controlled input and we do not have a vendored library
 * to hide behind, so §07.4's nine safety rules are enforced here in full. They
 * are not optional.
 *
 * Format subset: ustar with GNU/PAX long-name extensions, gzip-compressed. No
 * sparse files, no other compressors.
 */

export interface ExtractOptions {
  /** npm tarballs wrap everything in `package/`; exactly one component is removed. */
  strip: number;
  /** When set, extract only the entry whose post-strip path equals this (§07.4). */
  filter?: string;
  limits?: { maxBytes?: number; maxEntries?: number; maxRatio?: number };
}

export interface TarEntry {
  path: string;
  type: "file" | "directory" | "link" | "other";
  size: number;
  mode: number;
}

/**
 * Extract into `destDir`, enforcing every §07.4 rule: no absolute/drive/UNC
 * paths, no path escaping the root, link entries skipped, non file/dir types
 * rejected, `O_NOFOLLOW` on create, mode masked to `mode & 0o777 & ~umask` with
 * no setuid/setgid/sticky, and byte/entry/ratio caps checked **as you go**
 * rather than afterwards.
 */
export function extract(
  stream: ReadableStream<Uint8Array>,
  destDir: string,
  options: ExtractOptions,
): Promise<void> {
  throw new Error(`TODO(T6): extract(${destDir})`);
}

/** Entry listing without writing anything — used to validate `pack` archives (§07.10). */
export function listEntries(stream: ReadableStream<Uint8Array>): Promise<TarEntry[]> {
  throw new Error(`TODO(T6): listEntries()`);
}

/** gzip tar rooted at `cwd`, containing `paths`. Used by `corepack pack`. */
export function create(cwd: string, paths: string[], outPath: string): Promise<void> {
  throw new Error(`TODO(T6): create(${cwd}, ${paths.join(", ")}, ${outPath})`);
}
