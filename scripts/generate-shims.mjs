/**
 * Generate the package-manager shim stubs into `dist/` at build time.
 *
 * `enable` can create these itself, but only if the install directory is
 * writable — and a global npm install, a container image, or an OS package
 * frequently is not (§10.7, §14.18). Shipping them means `enable` finds them
 * already correct and writes nothing but the symlinks.
 *
 * The stub bodies come from `shimSource`, so there is exactly one definition of
 * what a shim is; this script only decides where they land.
 */

import { existsSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFINITIONS, getBinariesFor } from "../src/config/table.ts";
import { ENTRY_CANDIDATES } from "../src/utils/self.ts";
import { shimSource } from "../src/commands/shims.ts";

const dist = join(import.meta.dirname, "..", "dist");

// The same order `enable` uses, so a warm `enable` finds these stubs already
// correct and writes nothing (§10.7). `shim.mjs` is the proxy-only entry.
const entry = ENTRY_CANDIDATES.find((candidate) => existsSync(join(dist, candidate)));
if (entry === undefined) {
  throw new Error(`No entry module in ${dist}; run the bundler first.`);
}

const binNames = Object.keys(DEFINITIONS).flatMap((name) => getBinariesFor(name));

await Promise.all(
  binNames.map(async (binName) => {
    const file = join(dist, `${binName}.js`);
    await writeFile(file, shimSource(`./${entry}`, binName));
    await chmod(file, 0o755);
  }),
);

console.log(`Generated ${binNames.length} shim stubs for ./${entry}: ${binNames.join(", ")}`);
