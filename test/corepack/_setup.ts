/**
 * Upstream's `tests/setupTests.ts`, plus the extra scrubbing jup's own
 * conformance harness does: a developer's proxy, CA bundle, or `npm_config_*`
 * would otherwise reach the spawned tool and change what these rows observe.
 */

import process from "node:process";
import { afterAll, beforeEach } from "vitest";
import { cleanupTemps } from "./_fslib.ts";

const OLD_ENV = process.env;

const SCRUBBED = new Set([
  `FORCE_COLOR`,
  `DEBUG`,
  `HTTP_PROXY`,
  `http_proxy`,
  `HTTPS_PROXY`,
  `https_proxy`,
  `ALL_PROXY`,
  `all_proxy`,
  `NO_PROXY`,
  `no_proxy`,
  `NODE_USE_ENV_PROXY`,
  `NODE_EXTRA_CA_CERTS`,
  `NODE_OPTIONS`,
  `CI`,
]);

/**
 * A package manager reads its own configuration out of the environment, and a
 * developer machine (or a CI image) commonly has some set — `YARN_*`,
 * `npm_config_*`, `NPM_CONFIG_*`. Yarn 2.x aborts outright on a setting it does
 * not recognise, so a single `YARN_NPM_MINIMAL_AGE_GATE` inherited from the
 * shell fails every row that runs an older Yarn. These belong to the package
 * manager, not to the tool, so they are scrubbed like the rest.
 */
function isPackageManagerConfig(key: string): boolean {
  return (
    key.startsWith(`YARN_`) ||
    key.startsWith(`NPM_CONFIG_`) ||
    key.startsWith(`npm_config_`) ||
    key.startsWith(`PNPM_`)
  );
}

const processEnv = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !SCRUBBED.has(key) &&
      !key.startsWith(`COREPACK_`) &&
      !key.startsWith(`JUP_`) &&
      !isPackageManagerConfig(key),
  ),
);

beforeEach(() => {
  process.env = { ...processEnv };
});

afterAll(() => {
  process.env = OLD_ENV;
  cleanupTemps();
});
