/**
 * Rows for `resolveRuntimeEnvironments` — the §01.3-order resolution behind
 * `jup env` (§09.18).
 *
 * The resolver is the command's one agreement with the proxy path: the runtime
 * it names must be the runtime a shim would hand over. These rows pin that
 * order — `devEngines.runtime` over the version file, the lockfile tiers, the
 * exact pin, the fallback default — against the same primitives, with the store
 * seeded the way the conformance rows seed it.
 */

import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimeEnvironments } from "../../src/commands/env.ts";
import { DEFINITIONS } from "../../src/config/table.ts";
import { writeCachedResolution } from "../../src/project/lockfile.ts";
import {
  cleanupFixtures,
  createFixture,
  seedPackageManager,
} from "../conformance/_harness/index.ts";

/**
 * §04.6 — the compiled-in default a project-less directory falls back to. Read
 * from the table rather than pinned here: the table is refreshed by script, and
 * a literal would fail this row on every refresh for no behavioural reason.
 */
const NODE_DEFAULT = DEFINITIONS.node!.default;

// "0" keeps the fallback default offline and deterministic — the compiled-in
// line, never a registry lookup (§04.6), as the conformance harness does.
beforeEach(() => vi.stubEnv("COREPACK_DEFAULT_TO_LATEST", "0"));
afterEach(() => vi.unstubAllEnvs());
afterAll(cleanupFixtures);

/**
 * Point the store at a fresh fixture and return it. `HOME`/`USERPROFILE` come
 * along (§05.3): these rows run in the worker, so without this the developer's
 * own `~/.npmrc` would be an input to every resolution.
 */
function fixture(manifest?: unknown) {
  const created = createFixture(manifest);
  for (const name of ["COREPACK_HOME", "HOME", "USERPROFILE"]) vi.stubEnv(name, created.home);
  return created;
}

describe("resolveRuntimeEnvironments", () => {
  it("lets devEngines.runtime outrank the version file", async () => {
    const created = fixture({ devEngines: { runtime: { name: "node", version: "22.11.0" } } });
    created.write(".nvmrc", "24.21.0\n");

    await expect(resolveRuntimeEnvironments(created.cwd)).resolves.toEqual([
      { name: "node", reference: "22.11.0", binDir: null, installed: false },
    ]);
  });

  it("answers a declared range from the memo under node_modules", async () => {
    const created = fixture({ devEngines: { runtime: { name: "node", version: "^24.0.0" } } });
    const location = seedPackageManager(created.home, "node", "24.21.0");
    writeCachedResolution(
      created.cwd,
      { name: "node", range: "^24.0.0" },
      { name: "node", reference: "24.21.0" },
      "sha512.seeded",
      true,
    );

    await expect(resolveRuntimeEnvironments(created.cwd)).resolves.toEqual([
      { name: "node", reference: "24.21.0", binDir: join(location, "bin"), installed: true },
    ]);
  });

  it("falls back to the built-in default outside any project", async () => {
    const created = fixture();

    await expect(resolveRuntimeEnvironments(created.cwd)).resolves.toEqual([
      { name: "node", reference: NODE_DEFAULT, binDir: null, installed: false },
    ]);
  });
});
