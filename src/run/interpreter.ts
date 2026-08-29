/**
 * §08.3.1 — choosing an interpreter for a JavaScript entry point that has to be
 * **spawned** rather than loaded.
 *
 * §08.2's in-process handover needs no interpreter: the entry point is loaded
 * into the runtime already executing, which is why this file went unwritten for
 * as long as that was the only JavaScript path. {@link RunOptions.handover} is
 * what created the second one — a caller with work left to do cannot give its
 * process away, so the entry point is spawned, and spawning one means naming the
 * runtime to spawn it under.
 *
 * Cold by construction: nothing statically imports this module, so §16, Build
 * shape's warm set is unchanged and a shim's in-process handover never parses a
 * line of it.
 */

import { ENV, readEnv } from "../config/env-vars.ts";

/**
 * §08.3.1 — `JUP_NODE_EXECPATH`, else the runtime hosting jup, else `node` on
 * `PATH`; failing all three, §12.8's error naming the variable.
 *
 * The second and third tiers are {@link interpreterPath}'s, not a second
 * implementation of them: §10.2 asks the same question — "which runtime here is
 * durable enough to name?" — and answers it with `realpath(process.execPath)`
 * when that is outside the install folder, then `JUP_HOST_RUNTIME`, then the
 * first non-shim `node` on `PATH`. A copy of that ordering would be a copy of
 * §10.2's exec loop and of its `cache clean` hazard, so there is one.
 *
 * `JUP_NODE_EXECPATH` goes first and is taken at its word. It is refused from
 * project env files (§03.2) for the reason this function exists — it names a
 * place code is *run from* — so a value reaching here came from the real
 * environment, and a path that does not execute is reported by §12.8's
 * `Unable to execute` from the spawn itself rather than pre-judged by a `stat`
 * that a race could invalidate anyway.
 *
 * `shims.ts` is reached by `import()` rather than statically for the reason the
 * whole module is cold: §10's shim machinery is large, and a native handover —
 * which never asks this question — must not pay to parse it (§16, Build shape).
 */
export async function resolveInterpreter(binName: string): Promise<string> {
  const configured = readEnv(ENV.NODE_EXECPATH);
  if (configured !== undefined && configured !== "") return configured;

  const { interpreterPath } = await import("../commands/shims.ts");
  const own = interpreterPath();
  if (own !== undefined) return own;

  // Cold, like every other sentence that only a failure can print.
  const { messages } = await import("../errors-cold.ts");
  throw new Error(messages.noNodeRuntime(binName));
}
