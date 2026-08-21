/**
 * The embedded registry table — §02.5, §14.20.
 *
 * This is the only "configuration" the tool has, and it is compiled in: there is
 * deliberately no mechanism for a user to supply a different one at runtime.
 * Static structures, not a JSON blob parsed at startup.
 *
 * `ranges` is an **ordered list** and is matched in **reverse** — last declared
 * wins (§02.3). Dist-tags always resolve against the **last** entry's registry,
 * which is why `yarn@latest` consults repo.yarnpkg.com even though `yarn@1.22.22`
 * comes from npm.
 */

import type { PackageManagerDefinition } from "../types.ts";

export const DEFINITIONS: Record<string, PackageManagerDefinition> = {
  // TODO(T2): transcribe §02.5 exactly — npm, pnpm, yarn.
};

export const SUPPORTED_NAMES: readonly string[] = Object.keys(DEFINITIONS);

export function getDefinition(name: string): PackageManagerDefinition | undefined {
  throw new Error(`TODO(T2): getDefinition(${name})`);
}

export function isSupportedPackageManager(name: string): boolean {
  throw new Error(`TODO(T2): isSupportedPackageManager(${name})`);
}

/**
 * §02.3 — reverse the ordered range list and return the first spec whose range
 * the version satisfies, using prerelease-tolerant satisfaction. No match is an
 * internal assertion failure, not a user error.
 */
export function getSpecFor(name: string, version: string) {
  throw new Error(`TODO(T2): getSpecFor(${name}, ${version})`);
}

/** Every binary name this package manager declares, across all range entries, deduped. */
export function getBinariesFor(name: string): string[] {
  throw new Error(`TODO(T2): getBinariesFor(${name})`);
}

/** Reverse lookup: which package manager answers to this binary name? */
export function getPackageManagerFor(binName: string): string | undefined {
  throw new Error(`TODO(T2): getPackageManagerFor(${binName})`);
}
