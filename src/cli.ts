/**
 * Management-mode commands — §09.
 *
 * This is the complete surface. Anything not here is out of scope (§01.7).
 */

import type { Descriptor } from "./types.ts";

/**
 * §09.1 — shared by `install`, `pack`, `up`, and `use`.
 *
 * With patterns, only the env file is loaded (§03.2 `envOnly`). Without them the
 * project is consulted, and `lookup.range ?? lookup.getSpec()` prefers a
 * declared devEngines range over the exact pin — which is what lets `up` follow
 * a range across majors.
 */
export function resolvePatternsToDescriptors(patterns: string[]): Descriptor[] {
  throw new Error(`TODO(T17): resolvePatternsToDescriptors(${patterns.join(", ")})`);
}

/** §09.2 — cache the project's package manager. Does **not** touch last-known-good. */
export function cmdInstall(args: string[]): Promise<number> {
  throw new Error(`TODO(T17): cmdInstall()`);
}

/** §09.3 — sets last-known-good **unconditionally**, unlike §04.7's guarded bump. */
export function cmdInstallGlobal(args: string[]): Promise<number> {
  throw new Error(`TODO(T17): cmdInstallGlobal()`);
}

/** §09.4 — the two-step resolve is what confines the update to the current major line. */
export function cmdUp(args: string[]): Promise<number> {
  throw new Error(`TODO(T17): cmdUp()`);
}

/** §09.5 — writes the pin, then runs the package manager's `use` command. */
export function cmdUse(args: string[]): Promise<number> {
  throw new Error(`TODO(T17): cmdUse()`);
}

/** §09.6 — a copy of cache subtrees, not a repackaging. Does update last-known-good. */
export function cmdPack(args: string[]): Promise<number> {
  throw new Error(`TODO(T17): cmdPack()`);
}

/** §09.7 — `clean` and `clear` are the same command. */
export function cmdCache(args: string[]): Promise<number> {
  throw new Error(`TODO(T17): cmdCache()`);
}

/** §09.10 — deprecated, retained for compatibility. */
export function cmdHydrate(args: string[]): Promise<number> {
  throw new Error(`TODO(T17): cmdHydrate()`);
}

export function cmdPrepare(args: string[]): Promise<number> {
  throw new Error(`TODO(T17): cmdPrepare()`);
}

export function runManagementCommand(args: string[]): Promise<number> {
  throw new Error(`TODO(T17): runManagementCommand(${args.join(" ")})`);
}
