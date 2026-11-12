/** §09.9 for the scriptc build — `info --store-path`'s probe. */

const { dirname } = process.getBuiltinModule("node:path");
import { childEnvironment, resolveBinPath, shimDirectoryFor } from "./exec.ts";
import { resolveInterpreter } from "./interpreter.ts";
import { captureNative } from "./native.ts";
import type { BinSpec, Installation } from "../types.ts";

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
    return captureNative(binPath, argv, childEnvironment(dirname(binPath), false), timeoutMs);
  }
  const env = childEnvironment(shimDirectoryFor(binName), false);
  return captureNative(resolveInterpreter(binName), [binPath, ...argv], env, timeoutMs);
}
