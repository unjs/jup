/**
 * §08.3.3 — the `execve` addon: where it lives, putting it there, and loading it.
 *
 * `native/execve.zig` builds one small Node-API library per host, and
 * `scripts/build-addon.mjs` embeds all of them in {@link ADDON_BINARIES}. Nothing
 * is shipped beside the bundle: `enable` and `self-install` write this host's
 * file into `<home>` ({@link extractAddon}), and a replacing run loads it from
 * there ({@link loadAddon}) — writing it first when a caller's IPC channel is
 * waiting on it and it is missing, which is how an upgrade that ran neither
 * command still gets its own. A run that finds no addon, and cannot write one,
 * falls back to `process.execve` and §08.3.2's relay, which is what it did
 * before there was one.
 */

const { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } =
  process.getBuiltinModule("node:fs");
const { join } = process.getBuiltinModule("node:path");
import { getHomeFolder } from "../cache/store.ts";
import { ADDON_BINARIES } from "./addon-binaries.ts";

/** §07.2 — beside `v1`, so `cache clean` does not take it from every shim. */
const ADDON_FOLDER_NAME = "addon";

/** `native/execve.zig`'s `ABI`: a file answering anything else is not called. */
const ADDON_ABI = 1;

export interface ExecAddon {
  /**
   * Replace the process. `block` is {@link encodeExecBlock}'s; `keepFd` is a
   * descriptor to hand through with its close-on-exec flag cleared, or `-1`.
   * Returns the errno, and only when the kernel refused.
   */
  execve(block: Buffer, argc: number, envc: number, keepFd: number): number;
}

/** This host's entry in {@link ADDON_BINARIES}, if the addon is built for it. */
function hostBinary(): (typeof ADDON_BINARIES)[string] | undefined {
  return Object.hasOwn(ADDON_BINARIES, `${process.platform}-${process.arch}`)
    ? ADDON_BINARIES[`${process.platform}-${process.arch}`]
    : undefined;
}

/**
 * `<home>/addon/execve-<digest>.node`. Named by content, so two jup versions
 * sharing a home each find their own bytes, and a file that exists under the
 * name is the one written for it.
 */
export function addonPath(): string | undefined {
  const binary = hostBinary();
  if (binary === undefined) return undefined;
  return join(getHomeFolder(), ADDON_FOLDER_NAME, `execve-${binary.sha256.slice(0, 16)}.node`);
}

/** `undefined` until asked; `null` once asked and there was none. */
let loaded: ExecAddon | null | undefined;
let extracted = false;

function open(): ExecAddon | null {
  const file = addonPath();
  if (file === undefined) return null;
  const module = { exports: {} as Partial<ExecAddon> & { abi?: number } };
  try {
    process.dlopen(module, file);
  } catch {
    return null;
  }
  return module.exports.abi === ADDON_ABI && typeof module.exports.execve === "function"
    ? (module.exports as ExecAddon)
    : null;
}

/**
 * The addon, or `undefined` when there is none to use: no build for this host,
 * never extracted, a runtime without `process.dlopen` or with the permission
 * model forbidding it, or a file answering another ABI. Never throws.
 *
 * `extract` writes the file first when it is missing or damaged — once per
 * process, and only for a caller that needs it: decompressing and hashing it is
 * cold-path work a run without a channel has `process.execve` to spare it.
 */
export function loadAddon(options?: { extract?: boolean }): ExecAddon | undefined {
  if (loaded === undefined) loaded = open();
  if (loaded === null && options?.extract === true && !extracted) {
    extracted = true;
    // A file of the right size that would not load is refused by the host — a
    // `noexec` mount, the permission model — and rewriting it changes nothing
    // but the cost of every run that asks.
    if (!presentAtSize() && extractAddon() !== undefined) loaded = open();
  }
  return loaded ?? undefined;
}

function presentAtSize(): boolean {
  const file = addonPath();
  try {
    return file !== undefined && statSync(file).size === hostBinary()?.size;
  } catch {
    return false;
  }
}

/**
 * §10 — write this host's addon into `<home>`, for the shims `enable` is
 * installing. Best-effort: an unwritable `<home>` costs the shims their
 * replacement under an IPC channel and nothing else, which is no reason to fail
 * the `enable` that asked. Returns the path when the file is in place.
 *
 * The bytes are decompressed and checked against the digest the build recorded
 * before anything is written, and land by rename, so no reader ever loads half
 * a library. A file already under the name is kept only when it hashes to that
 * digest, so a damaged one is replaced rather than handed to `dlopen` again.
 * Other `execve-*.node` files are left: another jup sharing this `<home>` may be
 * the one using them.
 */
export function extractAddon(): string | undefined {
  const binary = hostBinary();
  const file = addonPath();
  if (binary === undefined || file === undefined) return undefined;
  const folder = join(getHomeFolder(), ADDON_FOLDER_NAME);
  try {
    // First, so a home that will not take the file costs no decompressing or hashing.
    mkdirSync(folder, { recursive: true, mode: 0o755 });
  } catch {
    return undefined;
  }

  const { zstdDecompressSync } = process.getBuiltinModule("node:zlib");
  const { createHash, randomBytes } = process.getBuiltinModule("node:crypto");
  try {
    if (createHash("sha256").update(readFileSync(file)).digest("hex") === binary.sha256) {
      return file;
    }
  } catch {
    // Not there yet.
  }

  const bytes = zstdDecompressSync(Buffer.from(binary.zstd, "base64"));
  if (
    bytes.length !== binary.size ||
    createHash("sha256").update(bytes).digest("hex") !== binary.sha256
  ) {
    return undefined;
  }

  const temp = join(folder, `.execve-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    writeFileSync(temp, bytes, { mode: 0o644 });
    chmodSync(temp, 0o644);
    renameSync(temp, file);
    return file;
  } catch {
    try {
      rmSync(temp, { force: true });
    } catch {
      // The folder itself could not be made.
    }
    return undefined;
  }
}

/**
 * The single buffer {@link ExecAddon.execve} reads: every string NUL-terminated
 * — path, arguments, `KEY=value` entries — then zeroed room for the two pointer
 * arrays the addon builds in place: a word per string but the path, one per
 * terminator, and one of alignment slack, counted in 8-byte words.
 *
 * `undefined` for a string holding a NUL, which no `execve` can carry and which
 * the spawn that stands in reports as the error it is.
 */
export function encodeExecBlock(
  path: string,
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
): { block: Buffer; argc: number; envc: number } | undefined {
  const strings = [path, ...argv];
  for (const [key, value] of Object.entries(env)) strings.push(`${key}=${value}`);
  if (strings.some((value) => value.includes("\0"))) return undefined;
  const text = Buffer.from(`${strings.join("\0")}\0`);
  const block = Buffer.alloc(text.length + (strings.length + 3) * 8);
  text.copy(block);
  return { block, argc: argv.length, envc: strings.length - 1 - argv.length };
}
