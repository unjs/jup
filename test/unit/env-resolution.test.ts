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
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveRuntimeEnvironments } from "../../src/commands/env.ts";
import { DEFINITIONS } from "../../src/config/table.ts";
import { writeCachedResolution } from "../../src/project/lockfile.ts";
import {
  cleanupFixtures,
  createFixture,
  seedPackageManager,
} from "../conformance/_harness/index.ts";

/** §13.1 — the fresh-store variable every row points at its own fixture. */
const HOME = "COREPACK_HOME";

/**
 * §04.6 — the compiled-in default a project-less directory falls back to. Read
 * from the table rather than pinned here: the table is refreshed by script, and
 * a literal would fail this row on every refresh for no behavioural reason.
 */
const NODE_DEFAULT = DEFINITIONS.node!.default;

let previousHome: string | undefined;
let previousLatest: string | undefined;
let previousNetwork: string | undefined;

beforeEach(() => {
  previousHome = process.env[HOME];
  previousLatest = process.env.COREPACK_DEFAULT_TO_LATEST;
  previousNetwork = process.env.COREPACK_ENABLE_NETWORK;
  // "0" keeps the fallback default offline and deterministic — the compiled-in
  // line, never a registry lookup (§04.6). The conformance harness sets the
  // same variable for the same reason.
  process.env.COREPACK_DEFAULT_TO_LATEST = "0";
});

afterEach(() => {
  for (const [key, value] of [
    [HOME, previousHome],
    ["COREPACK_DEFAULT_TO_LATEST", previousLatest],
    ["COREPACK_ENABLE_NETWORK", previousNetwork],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

afterAll(cleanupFixtures);

/** Point the store at a fresh fixture and return it. */
function fixture(manifest?: unknown) {
  const created = createFixture(manifest);
  process.env[HOME] = created.home;
  return created;
}

describe("resolveRuntimeEnvironments", () => {
  it("answers an exact .nvmrc pin from the store", async () => {
    const created = fixture();
    created.write(".nvmrc", "24.21.0\n");
    const location = seedPackageManager(created.home, "node", "24.21.0");

    await expect(resolveRuntimeEnvironments(created.cwd)).resolves.toEqual([
      { name: "node", reference: "24.21.0", binDir: join(location, "bin"), installed: true },
    ]);
  });

  it("answers an exact pin it has not installed as unaccelerated", async () => {
    const created = fixture();
    created.write(".nvmrc", "22.11.0\n");

    // No request: an exact pin is answered by the store probe alone (§04.1
    // step 4), so this row is offline-safe with the network left on.
    await expect(resolveRuntimeEnvironments(created.cwd)).resolves.toEqual([
      { name: "node", reference: "22.11.0", binDir: null, installed: false },
    ]);
  });

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

  it("reports a failed resolution as a value rather than throwing", async () => {
    const created = fixture({ devEngines: { runtime: { name: "node", version: "^99.0.0" } } });
    process.env.COREPACK_ENABLE_NETWORK = "0";

    // §09.18 — both views of this data degrade rather than die, so the failure
    // is an entry with a null reference, not an exception the caller must
    // remember to catch. The error's own words are not pinned here; they are
    // whichever sentence the registry refusal printed.
    await expect(resolveRuntimeEnvironments(created.cwd)).resolves.toEqual([
      expect.objectContaining({ name: "node", reference: null, binDir: null, installed: false }),
    ]);
  });
});
