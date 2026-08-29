/**
 * §13.1's `run()`, wearing upstream Corepack's `runCli` signature.
 *
 * Upstream spawns `dist/corepack.js`; this spawns jup's `src/bin.ts` directly,
 * which Node type-strips, so the suite needs no build step. `COREPACK_HOME` and
 * the rest come from `process.env` — the ported tests set them in `beforeEach`
 * exactly as upstream does.
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { npath, type PortablePath } from "./_fslib.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const BIN = path.join(HERE, `..`, `..`, `src`, `bin.ts`);

const REGISTRY_SERVER = path.join(HERE, `_registryServer.mjs`);
const NOCK = path.join(HERE, `_nock.mjs`);

export interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Compatibility mode (`JUP_COREPACK_COMPAT=1`).
 *
 * A large share of the upstream rows fail against jup only because jup declines
 * to install artifacts Corepack installs without question: the retired npm
 * signing key (§06.5), a registry that publishes no signature (§06.1), and the
 * non-P-256 keys upstream's mock registry mints. All three are deliberate, and
 * all three are switched off by the escape hatches jup already documents. Set
 * this to see what is left once the known-intentional divergences are removed —
 * which is the useful signal when watching for a real regression.
 *
 * A third variable joins them, `JUP_QUIET_ADVISORIES` (§11.3): jup emits `!`
 * advisories corepack has no equivalent for — §05.1's disabled-TLS notice, §06.1's
 * "publishes no signatures", §10.5's shim diagnostics — and a row that asserts
 * stderr exactly fails on the extra text alone. The variable is scoped to the
 * lines jup *adds*, so corepack's own advisories, `devEngines` warnings
 * included, still print and the rows matching their text still hold.
 *
 * A row that sets any of the three itself keeps its own value.
 */
// Read once at load: the setup file scrubs every `JUP_`-prefixed variable out
// of `process.env` before each test.
const COMPAT = process.env.JUP_COREPACK_COMPAT === `1`;

function compatEnv(env: NodeJS.ProcessEnv, withCustomRegistry: boolean): NodeJS.ProcessEnv {
  if (!COMPAT) return env;

  const patched = { ...env };
  patched.JUP_QUIET_ADVISORIES ??= `1`;

  // The two integrity hatches below are scoped away from the mock-registry rows.
  // `_registryServer.mjs` mints its own keypair and sets
  // `COREPACK_INTEGRITY_KEYS` to the public half, so those rows are about
  // verification itself — several assert that it *fails* before turning it off
  // themselves. The hatches answer npm's retired key and `repo.yarnpkg.com`
  // publishing no signature; neither is in play here, and applying them would
  // disable the very thing the row is testing. The advisory mute above is not
  // scoped, because it changes no outcome — only how much jup says about it.
  if (withCustomRegistry) return patched;
  patched.COREPACK_INTEGRITY_KEYS ??= `0`;
  patched.JUP_ALLOW_UNVERIFIED ??= `1`;
  return patched;
}

export async function runCli(
  cwd: PortablePath,
  argv: string[],
  withCustomRegistry?: boolean,
): Promise<CliResult> {
  const out: Buffer[] = [];
  const err: Buffer[] = [];

  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        `--no-warnings`,
        `--import`,
        withCustomRegistry ? pathToImport(REGISTRY_SERVER) : pathToImport(NOCK),
        BIN,
        ...argv,
      ],
      {
        cwd: npath.fromPortablePath(cwd),
        env: compatEnv(process.env, withCustomRegistry === true),
        stdio: `pipe`,
      },
    );

    child.stdout.on(`data`, (chunk) => out.push(chunk));
    child.stderr.on(`data`, (chunk) => err.push(chunk));
    child.on(`error`, reject);
    child.on(`close`, (exitCode) => {
      resolve({
        exitCode,
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
      });
    });
  });
}

function pathToImport(file: string): string {
  return new URL(`file://${file.replaceAll(`\\`, `/`)}`).href;
}
