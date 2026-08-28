/**
 * Native handover — §15.28, §08.3, §08.4, §08.5, §08.6.
 *
 * The reference model (§08.2) loads the package manager's entry module into this
 * process, and every observable in §08.4 and §08.5 falls out of there being only
 * one process. A package manager that is not JavaScript cannot be loaded, so it
 * has to be a child — and this module's whole job is to make that child
 * indistinguishable from the in-process case.
 *
 * §08.3.2's `exec()` model would be exact and is what a native re-implementation
 * MUST use. Node has no `execve`, so the fallback is spawn+wait, and §08.5
 * enumerates precisely what that owes:
 *
 * * **stdio inherited, never piped** — package managers detect TTYs to decide on
 *   colour, progress bars and prompts, and are routinely used in pipelines
 *   (§08.6). `stdio: "inherit"` hands over the real file descriptors, so stdin
 *   is passed through untouched and no byte is speculatively consumed.
 * * **No new process group or session.** Detaching would take the child out of
 *   terminal job control and break Ctrl-C, which is the one thing users notice.
 * * **Signals reflected, not swallowed.** See {@link execNative}.
 *
 * This module is reached only from `exec.ts`'s native branch, so `node:child_process`
 * never enters the module graph of a JavaScript cache hit (§01.3, §16.3).
 */

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { constants } from "node:os";
import { isInsideHome } from "../cache/store.ts";
import { ENV, writeEnvInto } from "../config/env-vars.ts";
import { messages } from "../errors-cold.ts";

/**
 * §08.5 — the signals forwarded to the child when *we* receive them directly.
 *
 * `SIGINT` is deliberately absent. A terminal delivers it to the entire
 * foreground process group, so the child already has it; forwarding would
 * deliver a second one, and the package managers that count Ctrl-C presses would
 * see two. What `SIGINT` gets instead is the no-op listener installed below,
 * whose only purpose is to stop Node's *default* disposition from killing this
 * process before it can reflect the child's status.
 *
 * `SIGKILL` and `SIGSTOP` cannot be caught and so cannot appear here; they reach
 * the child through the process group like any uncatchable signal.
 */
const FORWARDED_SIGNALS: NodeJS.Signals[] = ["SIGTERM", "SIGHUP", "SIGQUIT", "SIGUSR1", "SIGUSR2"];

/**
 * §15.43 — record, in the child's environment, the runtime hosting this chain.
 *
 * `node` is a table entry (§15.39), so our own `node` shim resolves the
 * project's runtime and spawns it *through here*; everything below that point —
 * a nested `jup enable`, above all — sees a `process.execPath` inside the store.
 * `enable` must never bake that into a shebang (§10.1): the store is what
 * `cache clean` deletes, and a shim whose interpreter has been deleted dies with
 * `bad interpreter` before a line of ours runs, `enable` included. So the last
 * process in the chain that was running *outside* the store leaves its realpath
 * here, and `interpreterPath()` reads it back however deep the chain got.
 *
 * Written only when our own runtime is outside the home; when it is inside, the
 * value the caller inherited is passed through untouched. Overwriting it at
 * every level — the `??=` shape — would replace the one path worth carrying with
 * a store path at the first hop.
 */
function forwardHostRuntime(env: NodeJS.ProcessEnv): void {
  let own: string;
  try {
    own = realpathSync(process.execPath);
  } catch {
    own = process.execPath;
  }
  if (!isInsideHome(own)) writeEnvInto(env, ENV.HOST_RUNTIME, own);
}

/**
 * Run a native `bin` target directly and resolve with the exit code it earned.
 *
 * The promise resolves only when the child is gone. When the child was killed by
 * a signal this function normally does **not** resolve at all: §08.4's last row
 * requires the tool to die the same death, so it restores the default
 * disposition for that signal and re-raises it, which terminates this process
 * inside `process.kill`. The `128 + N` return is the spec's stated fallback for
 * a runtime that cannot re-raise — reached here only if the signal turns out to
 * be blocked or ignored, in which case exiting numerically beats hanging.
 *
 * `argv[0]` is the **name the user invoked**, which is what a direct invocation
 * gives it — §08.2's `[execPath, binPath, ...]` rewrite exists only because the
 * JS path runs an interpreter, and a native artifact that inspected `argv[0]`
 * would be misled by it.
 *
 * That the name and the path can differ is not a detail: bun ships one binary
 * and decides between `bun` and `bunx` by looking at `argv[0]`, and its own
 * installer creates `bunx` as a link beside `bun` precisely so that read works.
 * Two `bin` entries pointing at one file is how §02.4 already spells that
 * (Yarn Classic's `yarn`/`yarnpkg`), so passing the invoked name through is what
 * makes the spelling mean the same thing for a native artifact as for a JS one.
 * Absent a name — a `commands.use` handover, where nothing was invoked — the
 * path stands in, which is Node's own default.
 *
 * The caller has already set `COREPACK_ROOT` on `process.env` (§08.7) and hands
 * `env` in as the child's environment: the ambient one wholesale, env-file
 * values included, plus §15.32's `PATH` entry — which is written *here* and
 * never into `process.env`, so it cannot leak into the tool's own process.
 * §15.43's forwarded host runtime is added on the same terms; see
 * {@link forwardHostRuntime}.
 */
export function execNative(
  binPath: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  argv0?: string,
): Promise<number> {
  forwardHostRuntime(env);

  // No `detached`, no `shell`, no `cwd` override: the caller's cwd is the
  // package manager's cwd (§08.3.2), and the child stays in our process group so
  // terminal job control keeps working.
  const child = spawn(binPath, args, { stdio: "inherit", windowsHide: false, env, argv0 });

  const listeners = new Map<NodeJS.Signals, () => void>();

  const forward = (signal: NodeJS.Signals): void => {
    // `kill` on an already-dead child is a no-op in Node (the ESRCH is
    // swallowed), so the race between forwarding and the child exiting is safe.
    child.kill(signal);
  };

  for (const signal of FORWARDED_SIGNALS) {
    const listener = (): void => forward(signal);
    listeners.set(signal, listener);
    process.on(signal, listener);
  }
  // Keeps us alive through a Ctrl-C so we can reflect how the child died.
  const onInterrupt = (): void => {};
  listeners.set("SIGINT", onInterrupt);
  process.on("SIGINT", onInterrupt);

  const release = (): void => {
    for (const [signal, listener] of listeners) process.off(signal, listener);
    listeners.clear();
  };

  return new Promise<number>((resolve, reject) => {
    child.on("error", (error: NodeJS.ErrnoException) => {
      release();
      // `EACCES` here means the executable bit did not survive extraction
      // (§07.4 rule 6); `ENOEXEC` means the artifact is for another platform.
      // Both are worth naming, because neither is the package manager's own
      // failure and neither produces any output of its own.
      reject(new Error(messages.cannotExecute(binPath, error.code ?? error.message)));
    });

    child.on("exit", (code, signal) => {
      release();

      if (signal !== null) {
        // §08.4 / §08.5 — die the child's death rather than translating it into
        // a number, so the parent shell reports a signal and `$?` agrees with
        // what a directly-invoked package manager would have produced.
        process.removeAllListeners(signal);
        process.kill(process.pid, signal);
        // Only reachable if the signal was blocked or ignored for us.
        resolve(128 + (constants.signals[signal] ?? 0));
        return;
      }

      // `exit` always carries one of the two; the `?? 1` is for the type.
      resolve(code ?? 1);
    });
  });
}
