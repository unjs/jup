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

import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFINITIONS, getBinariesFor } from "../src/config/table.ts";
import { shimSource } from "../src/shims.ts";

const dist = join(import.meta.dirname, "..", "dist");

const binNames = Object.keys(DEFINITIONS).flatMap((name) => getBinariesFor(name));

await Promise.all(
  binNames.map(async (binName) => {
    const file = join(dist, `${binName}.js`);
    await writeFile(file, shimSource("./index.mjs", binName));
    await chmod(file, 0o755);
  }),
);

console.log(`Generated ${binNames.length} shim stubs: ${binNames.join(", ")}`);
