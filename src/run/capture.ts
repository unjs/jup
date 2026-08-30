/**
 * Running a tool to *read* what it prints — §09.9's `--store-path` probe, and
 * nothing else so far.
 *
 * Cold, deliberately. Everything here exists for one management command, and a
 * `yarn --version` must not parse a byte of it (§16, Build shape); `exec.ts` is
 * warm and stays the size it was. What it borrows from there —
 * `resolveBinPath`, `childEnvironment`, `shimDirectoryFor` — is machinery a
 * proxy run already needs, and a second copy of §08.1's containment check or
 * §08.7's child environment would be the kind of drift those functions exist to
 * prevent.
 */

const { dirname } = process.getBuiltinModule("node:path");
import { childEnvironment, resolveBinPath, shimDirectoryFor } from "./exec.ts";
import type { BinSpec, Installation } from "../types.ts";

/**
 * §09.9 — {@link import("./exec.ts").execPackageManager} for a caller that wants
 * the tool's *output* rather than the terminal.
 *
 * The child is built exactly as it is there — same entry point, same §08.3 argv,
 * same `PATH` entry and `COREPACK_ROOT`, same cwd — so the answer is the one an
 * ordinary `jup <manager> <command>` would have printed. What differs is that it
 * is captured, and that neither handover model applies: this process has work
 * left to do, which is `RunOptions.handover`'s own distinction, so both branches
 * spawn.
 */
export function capturePackageManager(
  binName: string,
  spec: Installation,
  args: string[],
  fallbackBin: BinSpec | undefined,
  execMode: "js" | "native" | undefined,
  binArgs: readonly string[] | undefined,
  timeoutMs: number,
): Promise<{ code: number | null; stdout: string }> {
  const binPath = resolveBinPath(binName, spec, fallbackBin);
  const argv = binArgs === undefined || binArgs.length === 0 ? args : [...binArgs, ...args];

  if (execMode === "native") {
    const env = childEnvironment(dirname(binPath), false);
    // `binName`, not `binPath`: §08.3's artifacts dispatch on `argv[0]`.
    return import("./native.ts").then((native) =>
      native.captureNative(binPath, argv, env, binName, timeoutMs),
    );
  }

  const env = childEnvironment(shimDirectoryFor(binName), false);
  return import("./interpreter.ts").then(async ({ resolveInterpreter }) => {
    const interpreter = await resolveInterpreter(binName);
    const { captureNative } = await import("./native.ts");
    // §08.3.1's argv, and no `argv0`: `argv[0]` is the interpreter here, as it is
    // for any directly-run script.
    return await captureNative(interpreter, [binPath, ...argv], env, undefined, timeoutMs);
  });
}
