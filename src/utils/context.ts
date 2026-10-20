/**
 * The per-run view of process state: what a run reads in place of
 * `process.cwd()`, `process.env` and the two output streams.
 *
 * A run without handover is one tenant of a process it does not own, and may
 * share it with a concurrent run, so it works on its own copy of all three in an
 * `AsyncLocalStorage` scope (`run/scoped.ts`). Under handover there is no scope
 * and every accessor answers with the process itself; the storage is built by
 * the first scoped run, which a shim never makes (§16, Build shape).
 */

import type { AsyncLocalStorage } from "node:async_hooks";
const { isAbsolute, resolve } = process.getBuiltinModule("node:path");
import type { StdioMode } from "../types.ts";

/** One output stream of a run: `undefined` is ours, `null` is nowhere, an array collects. */
export type Sink = undefined | null | Array<string | Buffer>;

export interface RunContext {
  cwd: string;
  /** The run's own copy, replaced wholesale by §03.2's merge as `process.env` is. */
  env: NodeJS.ProcessEnv;
  stdio: [StdioMode, StdioMode, StdioMode];
  stdout: Sink;
  stderr: Sink;
  /** `net/npmrc.ts`'s memo, scoped with the environment its files expand against. */
  npmrc: Map<string, unknown>;
}

let storage: AsyncLocalStorage<RunContext> | undefined;

/** The scope this call runs in, or `undefined` under handover. */
export function runContext(): RunContext | undefined {
  return storage?.getStore();
}

export function runCwd(): string {
  return runContext()?.cwd ?? process.cwd();
}

export function runEnv(): NodeJS.ProcessEnv {
  return runContext()?.env ?? process.env;
}

/** Replace the run's environment with a new object, as §03.2's merge does. */
export function setRunEnv(env: NodeJS.ProcessEnv): void {
  const context = runContext();
  if (context === undefined) process.env = env;
  else context.env = env;
}

/** An environment-supplied path, made absolute against the run's cwd inside a scope. */
export function runPath(path: string): string {
  const context = runContext();
  return context === undefined || isAbsolute(path) ? path : resolve(context.cwd, path);
}

export function withRunContext<T>(context: RunContext, fn: () => T): T {
  storage ??= new (process.getBuiltinModule("node:async_hooks").AsyncLocalStorage)();
  return storage.run(context, fn);
}
