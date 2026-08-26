/**
 * A minimal stand-in for `@yarnpkg/fslib`, the one runtime dependency the
 * upstream Corepack tests carry that jup does not.
 *
 * Only the surface those tests actually touch is implemented, on top of
 * `node:fs`. Portable paths are POSIX-separated; on Windows `npath` converts
 * between the two forms the way fslib does, so the ported tests keep their
 * `npath.fromPortablePath(...)` calls verbatim.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, promises as fsp, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";

export type PortablePath = string & { __portablePath?: true };
export type Filename = string & { __filename?: true };

/* -------------------------------------------------------------------------- */
/* Path flavours                                                              */
/* -------------------------------------------------------------------------- */

const WINDOWS = process.platform === "win32";

/** Portable paths are always POSIX-shaped. */
export const ppath = {
  ...nodePath.posix,
  join: (...segments: string[]): PortablePath => nodePath.posix.join(...segments),
  basename: (p: string, ext?: string): Filename => nodePath.posix.basename(p, ext),
  dirname: (p: string): PortablePath => nodePath.posix.dirname(p),
  resolve: (...segments: string[]): PortablePath => nodePath.posix.resolve(...segments),
  sep: "/" as const,
};

/** Native paths, plus the two conversions fslib exposes. */
export const npath = {
  ...nodePath,
  fromPortablePath(p: string): string {
    if (!WINDOWS) return p;
    const match = /^\/([a-zA-Z]):(.*)$/.exec(p);
    const native = match ? `${match[1]}:${match[2]}` : p;
    return native.replace(/\//g, "\\");
  },
  toPortablePath(p: string): PortablePath {
    if (!WINDOWS) return p;
    const posix = p.replace(/\\/g, "/");
    return /^[a-zA-Z]:/.test(posix) ? `/${posix}` : posix;
  },
};

/* -------------------------------------------------------------------------- */
/* Filesystem                                                                 */
/* -------------------------------------------------------------------------- */

/** Every temp directory handed out, so a global teardown can sweep them. */
const temps: string[] = [];

function toNative(p: string): string {
  return npath.fromPortablePath(p);
}

async function mktempPromise(): Promise<PortablePath>;
async function mktempPromise<T>(cb: (dir: PortablePath) => Promise<T>): Promise<T>;
async function mktempPromise<T>(cb?: (dir: PortablePath) => Promise<T>) {
  const dir = mkdtempSync(nodePath.join(tmpdir(), "jup-cp-"));
  const portable = npath.toPortablePath(dir);

  if (cb === undefined) {
    temps.push(dir);
    return portable;
  }

  try {
    return await cb(portable);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Sweep the temp directories handed out by the callback-less overload. */
export function cleanupTemps(): void {
  while (temps.length > 0) {
    rmSync(temps.pop()!, { recursive: true, force: true });
  }
}

export const xfs = {
  mktempPromise,

  existsSync: (p: string): boolean => existsSync(toNative(p)),

  async mkdirPromise(p: string, options?: { recursive?: boolean }): Promise<void> {
    await fsp.mkdir(toNative(p), options);
  },

  async writeFilePromise(p: string, content: string | Buffer | Uint8Array): Promise<void> {
    mkdirSync(nodePath.dirname(toNative(p)), { recursive: true });
    await fsp.writeFile(toNative(p), content);
  },

  async writeJsonPromise(p: string, value: unknown): Promise<void> {
    // fslib writes JSON with two-space indentation and a trailing newline.
    await xfs.writeFilePromise(p, `${JSON.stringify(value, undefined, 2)}\n`);
  },

  async readFilePromise(p: string, encoding?: BufferEncoding): Promise<any> {
    return encoding === undefined
      ? await fsp.readFile(toNative(p))
      : await fsp.readFile(toNative(p), encoding);
  },

  async readJsonPromise(p: string): Promise<any> {
    return JSON.parse(await fsp.readFile(toNative(p), "utf8"));
  },

  async readdirPromise(p: string): Promise<Filename[]> {
    return (await fsp.readdir(toNative(p))) as Filename[];
  },

  async chmodPromise(p: string, mode: number): Promise<void> {
    await fsp.chmod(toNative(p), mode);
  },

  chmodSync: (p: string, mode: number): void => chmodSync(toNative(p), mode),

  async lstatPromise(p: string) {
    return await fsp.lstat(toNative(p));
  },

  async statPromise(p: string) {
    return await fsp.stat(toNative(p));
  },

  async symlinkPromise(
    target: string,
    path: string,
    type?: "file" | "dir" | "junction",
  ): Promise<void> {
    await fsp.symlink(toNative(target), toNative(path), type);
  },

  async readlinkPromise(p: string): Promise<PortablePath> {
    return npath.toPortablePath(await fsp.readlink(toNative(p)));
  },

  async rmPromise(p: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    await fsp.rm(toNative(p), { force: true, ...options });
  },

  async removePromise(p: string, options?: { recursive?: boolean }): Promise<void> {
    await fsp.rm(toNative(p), { recursive: true, force: true, ...options });
  },

  async movePromise(from: string, to: string): Promise<void> {
    await fsp.rename(toNative(from), toNative(to));
  },
};
