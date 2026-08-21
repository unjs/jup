/**
 * Project spec discovery and parsing — §03.
 *
 * Answers "which package manager, at which version range, does this directory
 * want?" It touches the filesystem only, never the network.
 */

import type { Descriptor, LazyLocator, ParseSpecOptions, SpecResult } from "./types.ts";

/** Directories inside a `node_modules` are skipped, so a dependency cannot hijack its host. */
export const NODE_MODULES_RE = /[\\/]node_modules[\\/](@[^\\/]*[\\/])?([^@\\/][^\\/]*)$/;

/**
 * §03.1 — walk from `cwd` toward the root.
 *
 * At each directory: skip if it is a package dir inside `node_modules`; load the
 * env file if none has been loaded yet; read `package.json`. The walk stops only
 * on a manifest carrying a `packageManager` key, and the **last** manifest seen
 * is what gets recorded — which is why a monorepo with no pin anywhere yields
 * `NoSpec` targeting the *root*.
 *
 * `envOnly` loads the env file and stops at the first one found, never reading
 * manifests: for commands given an explicit package-manager pattern on the CLI.
 */
export function discoverProjectSpec(cwd: string, options?: { envOnly?: boolean }): SpecResult {
  throw new Error(`TODO(T10): discoverProjectSpec(${cwd})`);
}

/**
 * §03.4 — parse a spec string into a descriptor.
 *
 * `source` is `CLI arguments` or the manifest path relative to the initial cwd.
 * Note `name` is the substring before the **first** `@`, so `@scope/pkg@1.0.0`
 * yields an empty name and correctly fails the supported-name check.
 */
export function parseSpec(raw: unknown, source: string, options: ParseSpecOptions): Descriptor {
  throw new Error(`TODO(T10): parseSpec(${String(raw)}, ${source})`);
}

/**
 * §03.3 — resolve `packageManager` against `devEngines.packageManager`.
 *
 * Validation happens in a specific order because each failure has a different
 * outcome, and `packageManager` always wins when present.
 */
export function readSpecFromManifest(
  manifest: unknown,
  manifestPath: string,
): { raw: unknown; range?: { name: string; range: string; onFail?: string } } {
  throw new Error(`TODO(T10): readSpecFromManifest(${manifestPath})`);
}

/**
 * §03.3 — `onFail` routing. Default is **error**; an unrecognised value degrades
 * to a warning rather than being rejected. Both must be preserved.
 */
export function warnOrThrow(message: string, onFail?: unknown): void {
  throw new Error(`TODO(T10): warnOrThrow(${message}, ${String(onFail)})`);
}

/** §03.5 — reconcile the discovered spec with the requested binary. */
export function reconcile(
  result: SpecResult,
  fallback: LazyLocator,
  options: { requestedName: string; transparent: boolean; binaryVersion?: string },
): Descriptor | LazyLocator {
  throw new Error(`TODO(T10): reconcile(${options.requestedName})`);
}

/**
 * §03.7 — write the pin, preserving indentation, line endings, key order, and
 * (per §14.7) the BOM. Returns the previous value for `COREPACK_MIGRATE_FROM`.
 */
export function writePin(
  cwd: string,
  info: { name: string; reference: string },
): { previousPackageManager: string } {
  throw new Error(`TODO(T10): writePin(${info.name}@${info.reference})`);
}
