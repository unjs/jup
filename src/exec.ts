/**
 * Handing over control — §08.
 *
 * Run the package manager so convincingly that neither the user nor the package
 * manager itself can tell a trampoline was involved.
 */

import type { InstallSpec } from "./types.ts";

/**
 * §08.1 — locate the entry point.
 *
 * Per §14.13, when `bin` came from a downloaded `package.json` rather than the
 * embedded table its values are attacker-controlled: resolve the joined path and
 * verify it stays inside `<location>`.
 */
export function resolveBinPath(binName: string, spec: InstallSpec, urlExt: string): string {
  throw new Error(`TODO(T13): resolveBinPath(${binName})`);
}

/**
 * §08.2 — in-process handover.
 *
 * Rewrites the process state to look like a direct invocation, then loads the
 * entry module on `nextTick` so our frames leave any stack trace the package
 * manager prints. `process.argv[1]` is how Yarn locates itself; an undefined
 * `require.main` is how pnpm detects its own version; `execArgv` is cleared so
 * the package manager does not inherit our runtime flags.
 *
 * **Do not wrap the load in a catch that rewrites the exit code.** §08.4's
 * contract is exact: a synchronous `exitCode = 42` exits 42; setting 42 and then
 * throwing exits **1**; setting 42 only in a `beforeExit` hook exits 42.
 */
export function execPackageManager(
  binName: string,
  spec: InstallSpec,
  args: string[],
  urlExt: string,
): void {
  throw new Error(`TODO(T13): execPackageManager(${binName})`);
}
