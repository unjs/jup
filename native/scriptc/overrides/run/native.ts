/**
 * §08.3 for the scriptc build — the process always *becomes* the tool.
 *
 * `execve(2)` through `native/scriptc/jupexec.c`, bound with scriptc's FFI.
 * Same pid, same process group, same descriptors: signals need no relay
 * (§08.5), and an inherited IPC channel — the fd and `NODE_CHANNEL_FD` —
 * reaches the tool untouched (§08.3.2), with no addon involved.
 */

const { spawn } = process.getBuiltinModule("node:child_process");
import { messages } from "../errors-cold.ts";
import { runCwd, runEnv } from "../utils/context.ts";

/** `native/scriptc/jupexec.c` — returns only on failure, with `errno`. */
declare function jupExecve(block: Uint8Array, argc: number, envc: number): number;

/** The `errno` values `execve` reports, by the names §12.8's message prints. */
const ERRNO_NAMES: Record<number, string> = {
  1: "EPERM",
  2: "ENOENT",
  7: "E2BIG",
  8: "ENOEXEC",
  12: "ENOMEM",
  13: "EACCES",
  20: "ENOTDIR",
  21: "EISDIR",
  22: "EINVAL",
  26: "ETXTBSY",
  40: "ELOOP",
};

/**
 * Replace this process with `binPath`. Never resolves: on success the tool is
 * running in our place, and a refusal rejects with §12.8's `cannotExecute`.
 *
 * `argv0` is the name the tool sees — the invoked name for a native artifact
 * (`bun`/`bunx` dispatch on it), the interpreter's path for a script.
 */
export async function execNative(
  binPath: string,
  args: string[],
  env: NodeJS.ProcessEnv = runEnv(),
  argv0?: string,
): Promise<number> {
  const strings: string[] = [binPath, argv0 ?? binPath];
  for (const arg of args) strings.push(arg);
  let envc = 0;
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (value === undefined) continue;
    strings.push(`${key}=${value}`);
    envc += 1;
  }
  for (const value of strings) {
    if (value.includes("\0")) throw new Error(messages.cannotExecute(binPath, "EINVAL"));
  }
  const errno = jupExecve(Buffer.from(`${strings.join("\0")}\0`), args.length + 1, envc);
  throw new Error(messages.cannotExecute(binPath, ERRNO_NAMES[errno] ?? `errno ${errno}`));
}

/** §09.9 — run a tool and read what it printed (`info --store-path`). */
export function captureNative(
  binPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string }> {
  const child = spawn(binPath, args, {
    stdio: ["ignore", "pipe", "ignore"],
    env,
    cwd: runCwd(),
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: null, stdout: "" });
    });
    child.on("close", (code: number | null, signal: string | null) => {
      clearTimeout(timer);
      resolve({ code: signal === null ? code : null, stdout });
    });
  });
}
