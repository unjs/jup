/**
 * Spawn-and-wait must emulate direct execution. `child_process` remains dynamically isolated from JavaScript cache hits.
 */

const { spawn } = process.getBuiltinModule("node:child_process");
const { realpathSync } = process.getBuiltinModule("node:fs");
const { constants } = process.getBuiltinModule("node:os");
import { isInsideInstallFolder } from "../cache/store.ts";
import { ENV, writeEnvInto } from "../config/env-vars.ts";
import { messages } from "../errors-cold.ts";

/**
 * §09.9 — run a tool and *read* what it printed, instead of handing it the
 * terminal.
 *
 * The one caller is `--store-path`'s probe, and every difference from
 * {@link execNative} below is that caller's contract:
 *
 * * **stdout is a pipe and stderr is discarded.** The answer is one path on our
 *   own stdout, and the probe is allowed to fail — a manager complaining about a
 *   subcommand it does not have (Berry, asked Classic's question) is not the
 *   user's business, which is what the `2>/dev/null` this replaces was saying.
 * * **No signal handling.** Nothing is handed over, so there is no death to die
 *   (§08.5): a Ctrl-C reaches the child through the process group and this
 *   process is free to fail normally.
 * * **A timeout.** `info` is a command people run when something is already
 *   wrong, and a manager that has not answered a one-word question by then is
 *   not going to. The kill lands as a signal, which reads as no answer.
 *
 * Resolves with the exit code, or `null` for a child that never ran or was
 * killed — a caller that cannot tell those apart from "answered nothing" is
 * exactly what §09.9's "print nothing, exit 0" asks for.
 */
export function captureNative(
  binPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  argv0: string | undefined,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string }> {
  const child = spawn(binPath, args, {
    stdio: ["ignore", "pipe", "ignore"],
    // Unlike a handover, nothing here is the user's session: a console window
    // flashing up on Windows for a probe would be noise.
    windowsHide: true,
    env: forwardHostRuntime(env),
    argv0,
    timeout: timeoutMs,
  });

  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));

  return new Promise((resolve) => {
    // `EACCES`, `ENOENT`, `ENOEXEC`: a store entry that cannot be run has not
    // answered, and saying so is `info`'s job elsewhere in the report.
    child.on("error", () => resolve({ code: null, stdout: "" }));
    // `close` rather than `exit`, so the pipe is drained before it is read.
    child.on("close", (code, signal) =>
      resolve({
        code: signal === null ? code : null,
        stdout: Buffer.concat(chunks).toString("utf8"),
      }),
    );
  });
}

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
 * Propagate the original host runtime without mutating the caller’s environment.
 */
function forwardHostRuntime(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let own: string;
  try {
    own = realpathSync(process.execPath);
  } catch {
    own = process.execPath;
  }
  if (isInsideInstallFolder(own)) return env;

  const forwarded = { ...env };
  writeEnvInto(forwarded, ENV.HOST_RUNTIME, own);
  return forwarded;
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
 * `reraise: false` takes that fallback deliberately, and is what
 * {@link RunOptions.handover}`: false` selects. Dying the child's death is the
 * right answer for a shim, whose exit status *is* the tool's, and the wrong one
 * for a host application that called `runMain` mid-script — there the re-raise
 * is an unrecoverable death several frames below code that has more to do. The
 * numeric form is §08.4's own wording for the same outcome, so nothing outside
 * this process can tell the two runs apart except by `$?` versus a signal.
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
 * values included, plus §08.7's `PATH` entry — which is written *here* and
 * never into `process.env`, so it cannot leak into the tool's own process.
 * §08.3's forwarded host runtime is added on the same terms; see
 * {@link forwardHostRuntime}.
 */
export function execNative(
  binPath: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  argv0?: string,
  options?: { reraise?: boolean },
): Promise<number> {
  const childEnv = forwardHostRuntime(env);

  // No `detached`, no `shell`, no `cwd` override: the caller's cwd is the
  // package manager's cwd (§08.3), and the child stays in our process group so
  // terminal job control keeps working.
  const child = spawn(binPath, args, {
    stdio: "inherit",
    windowsHide: false,
    env: childEnv,
    argv0,
  });

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
        if (options?.reraise !== false) {
          process.removeAllListeners(signal);
          process.kill(process.pid, signal);
        }
        // Reachable when the signal was blocked or ignored for us, and always
        // under `reraise: false`.
        resolve(128 + (constants.signals[signal] ?? 0));
        return;
      }

      // `exit` always carries one of the two; the `?? 1` is for the type.
      resolve(code ?? 1);
    });
  });
}
