/**
 * The scriptc build's entry: one executable for the CLI and every shim.
 *
 * Shims are symlinks to it, so the invoked name picks the mode — `jup` and
 * `corepack` are the CLI (§09), any other name is a proxy run for that binary
 * name (§10.1's stub, without a stub). `process.argv0` keeps the name a
 * symlink was invoked under; `process.argv` is Node-shaped, so the user's
 * arguments start at index 2.
 */

const { basename } = process.getBuiltinModule("node:path");
import { runMain } from "./main.ts";

async function main(): Promise<void> {
  const invoked = basename(process.argv0);
  const rest = process.argv.slice(2);
  const cli = invoked === "jup" || invoked.startsWith("jup-") || invoked === "corepack";
  const { code } = await runMain(cli ? rest : [invoked, ...rest], {
    handover: true,
    corepackCompat: invoked === "corepack",
  });
  if (code !== 0) process.exitCode = code;
}

main();
