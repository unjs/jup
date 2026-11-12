/**
 * §08.3.1 for the scriptc build — the runtime a JavaScript entry point is
 * exec'd under: `JUP_NODE_EXECPATH`, else the first executable `node` on `PATH`.
 *
 * Unlike the Node-hosted build, our own shim is an acceptable answer. Shims
 * are symlinks to this executable and a jup-managed `node` is a native exec,
 * so the chain ends one hop later instead of looping — and that hop is how a
 * JavaScript package manager runs on the project's `devEngines.runtime`,
 * installed by jup itself.
 */

const { statSync } = process.getBuiltinModule("node:fs");
const { delimiter, isAbsolute, join } = process.getBuiltinModule("node:path");
import { ENV, readEnv, SYSTEM_ENV } from "../config/env-vars.ts";
import { messages } from "../errors-cold.ts";
import { runEnv } from "../utils/context.ts";

function isExecutable(file: string): boolean {
  try {
    const stats = statSync(file);
    return stats.isFile() && (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

export function resolveInterpreter(binName: string): string {
  const configured = readEnv(ENV.NODE_EXECPATH);
  if (configured !== undefined && configured !== "") return configured;

  const path = runEnv()[SYSTEM_ENV.PATH] ?? "";
  for (const directory of path.split(delimiter)) {
    if (directory === "" || !isAbsolute(directory)) continue;
    const candidate = join(directory, "node");
    if (isExecutable(candidate)) return candidate;
  }
  throw new Error(messages.noNodeRuntime(binName));
}
