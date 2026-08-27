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
import { PROXY_STUB_NAME, shimSource } from "../src/commands/shims.ts";

const dist = join(import.meta.dirname, "..", "dist");

// The same order `enable` uses, so a warm `enable` finds these stubs already
// correct and writes nothing (§10.7). `shim.mjs` is the proxy-only entry.
const entry = ENTRY_CANDIDATES.find((candidate) => existsSync(join(dist, candidate)));
if (entry === undefined) {
  throw new Error(`No entry module in ${dist}; run the bundler first.`);
}

const binNames = Object.keys(DEFINITIONS).flatMap((name) => getBinariesFor(name));

async function write(file, source) {
  await writeFile(file, source);
  await chmod(file, 0o755);
}

// The POSIX stub, once: §14.15 has it read its own name from `argv[1]`, so one
// file serves every binary. The per-name stubs are §10.3's, and Windows is the
// only thing that reads them.
await Promise.all([
  write(join(dist, PROXY_STUB_NAME), shimSource(entry)),
  ...binNames.map((binName) => write(join(dist, `${binName}.js`), shimSource(entry, binName))),
]);

console.log(
  `Generated ${PROXY_STUB_NAME} and ${binNames.length} win32 stubs for ${entry}: ${binNames.join(", ")}`,
);
