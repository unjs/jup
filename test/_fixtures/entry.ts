/**
 * §13.1, §17.6 C1′ — spawn the tool under one of its two entry-point names.
 *
 * The tool ships as one executable with two names, and it knows which one it was
 * invoked as from `basename(process.argv[1])`. §13.1 requires rows 1–147 to run
 * through the **`corepack`** entry point, because they assert corepack's
 * verbatim spellings; §17.9's rows opt into `jup`. Both harnesses spawn
 * `src/bin.ts`, whose basename is neither name, so without this they would run
 * everything as `jup` (§17.6 C1′: an unrecognised name defaults to `jup`).
 *
 * The mechanism is a **symlink** named `corepack.ts` or `jup.ts` pointing at the
 * bin, which is faithful to how the two names exist in a real install — npm
 * writes `node_modules/.bin/corepack` as a link to the same file. Node resolves
 * the symlink for module identity, so `import.meta.url` still lands in `src/`
 * and `utils/self.ts`'s upward walk is unaffected, while `process.argv[1]` — not
 * realpathed — keeps the link's name. Verified against Node 24; Node's type
 * stripping follows the link and strips the target exactly as it would directly.
 *
 * A launcher file is the fallback, for a platform where an unprivileged symlink
 * is refused (Windows without developer mode). It costs one extra module load
 * and is otherwise indistinguishable, since `import.meta.url` inside the tool
 * resolves to the real file either way.
 */

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** §17.6 C1′ — the tool's own entry-point names. */
export type EntryName = "jup" | "corepack";

/** One alias per (bin, name); building it twice would race on the same path. */
const aliases = new Map<string, string>();
const roots: string[] = [];
let cleanupRegistered = false;

/**
 * A path that runs `bin` but is *named* `as`.
 *
 * Memoised per bin, so a suite that spawns hundreds of times creates one link.
 */
export function entryPath(bin: string, as: EntryName): string {
  const key = `${as}\0${bin}`;
  const existing = aliases.get(key);
  if (existing !== undefined) return existing;

  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.once("exit", () => {
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    });
  }

  const root = mkdtempSync(join(tmpdir(), "jup-entry-"));
  roots.push(root);
  const alias = join(root, `${as}.ts`);

  try {
    symlinkSync(bin, alias);
  } catch {
    writeFileSync(alias, `await import(${JSON.stringify(pathToFileURL(bin).href)});\n`);
  }

  aliases.set(key, alias);
  return alias;
}
