/**
 * Entry point — argv classification and dispatch (§01.2), plus top-level error
 * presentation (§08.4, §12.1).
 */

import type { Invocation } from "./types.ts";

/**
 * §01.2 — match `arg0` against `/^([^@]*)(?:@(.*))?$/`.
 *
 * A known binary name means proxy mode. Otherwise, an `@` in the argument still
 * means proxy mode with an *unknown* package manager — that is how
 * `corepack foo@1.2.3` reaches "Unsupported package manager specification"
 * instead of the CLI's "unknown command". Everything else is management mode.
 *
 * The `[^@]*` is deliberate: `@scope/pkg@1.0.0` never matches as a name.
 */
export function classifyInvocation(argv: string[]): Invocation {
  throw new Error(`TODO(T16): classifyInvocation(${argv.join(" ")})`);
}

/**
 * §01.4 — a command is transparent iff `prefix[0] === binaryName` and every
 * remaining prefix segment equals the corresponding argument.
 *
 * Transparent commands are bootstrapping commands: `pnpx foo` inside a Yarn
 * project must not be an error.
 */
export function isTransparentCommand(binaryName: string, args: string[]): boolean {
  throw new Error(`TODO(T16): isTransparentCommand(${binaryName})`);
}

/** §01.3 — the hot path: classify, resolve, ensure installed, hand over. */
export function runProxy(invocation: Extract<Invocation, { mode: "proxy" }>): Promise<number> {
  throw new Error(`TODO(T16): runProxy(${invocation.binaryName})`);
}

/**
 * §08.4, §12.1 — a `UsageError` in proxy mode prints bare on stderr; in
 * management mode it prints `Usage Error: …` on **stdout**, then a blank line,
 * then the usage line. Anything else prints with a stack, because a stack trace
 * is the correct output for a bug.
 */
export function runMain(argv: string[]): Promise<number> {
  throw new Error(`TODO(T16): runMain(${argv.join(" ")})`);
}
