/**
 * §02.2 — Yarn 6, the one band published outside npm, through the public CLI.
 *
 * `test/unit/install.test.ts` pins the verification rules one call at a time;
 * these rows are the same band reached the way a user reaches it — a project
 * pin, the `yarn` and `yarnpkg` names, the store, `use` — to show that nothing
 * between the proxy and the install assumed an npm package. The mock serves a
 * zip shaped like the real one: `yarn-bin` is the package manager, `yarn` beside
 * it is Yarn Switch, which jup must never run.
 *
 * POSIX only, for `15-21-native-entries.test.ts`'s reason: the artifact is a
 * `#!/bin/sh` probe. Skipped too on a host with no Yarn 6 build.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { embeddedDigest } from "../../src/config/releases.ts";
import { getSpecFor, hostTarget } from "../../src/config/table.ts";
import { zpmZip } from "../_fixtures/zip.ts";
import {
  cleanupFixtures,
  createFixture,
  type Fixture,
  hashOf,
  MockRegistry,
  run,
  withoutDownloadNotices,
} from "./_harness/index.ts";

const TARGET = getSpecFor("yarn", "6.0.0-rc.22").targets?.[hostTarget()];
const SUPPORTED = process.platform !== "win32" && TARGET !== undefined;

const registry = new MockRegistry();

/** Reports the name it ran under, as `15-21`'s probe does. */
const PROBE = `#!/bin/sh\nprintf 'zpm=%s args=%s\\n' "$(basename "$0")" "$*"\n`;
const ARTIFACT = zpmZip(PROBE);
const SHA256 = hashOf(ARTIFACT, "sha256");

/** A release the table does not record, so a pin is what vouches for it. */
const UNKNOWN = "6.0.0-rc.99";
/** One it does, whose compiled-in digest the mock's bytes cannot match. */
const RECORDED = "6.0.0-rc.22";

/** What `releases.ts` recorded for this host's build of {@link RECORDED}. */
const PINNED =
  TARGET === undefined
    ? undefined
    : embeddedDigest({ type: "embedded", releases: "yarnpkg/zpm" }, RECORDED, TARGET)?.hex;

const assetPath = (version: string) =>
  `/yarnpkg/zpm/releases/download/v${version}/yarn-${TARGET}.zip`;

beforeAll(async () => {
  if (!SUPPORTED) return;
  await registry.start();
  registry.publishFile(assetPath(UNKNOWN), ARTIFACT);
  registry.publishFile(assetPath(RECORDED), ARTIFACT);
});

afterAll(async () => {
  cleanupFixtures();
  if (SUPPORTED) await registry.stop();
});

describe.skipIf(!SUPPORTED)("§02.2 Yarn 6 — the embedded band", () => {
  function options(fixture: Fixture, env?: Record<string, string | undefined>) {
    return { cwd: fixture.cwd, home: fixture.home, registry, env: { CI: undefined, ...env } };
  }

  it("runs `yarn-bin` under both names, from GitHub, with one request and then none", async () => {
    const fixture = createFixture({
      name: "app",
      packageManager: `yarn@${UNKNOWN}+sha256.${SHA256}`,
    });
    registry.reset();

    const cold = await run(["yarn", "install", "--immutable"], options(fixture));
    expect(withoutDownloadNotices(cold.stderr)).toBe("");
    expect(cold.exitCode).toBe(0);
    expect(cold.stdout).toBe("zpm=yarn-bin args=install --immutable\n");
    // The artifact and nothing else: no packument, no signature, no keys.
    expect(registry.requests.map((request) => request.original)).toEqual([
      `https://github.com${assetPath(UNKNOWN)}`,
    ]);
    // Sent anonymously, whatever credentials the environment carries (§05.1).
    expect(registry.requests[0]!.authorization).toBeUndefined();

    registry.reset();
    const warm = await run(["yarnpkg", "--version"], options(fixture));
    expect(warm.exitCode).toBe(0);
    expect(warm.stdout).toBe("zpm=yarn-bin args=--version\n");
    expect(registry.requests).toEqual([]);
  });

  it("refuses a recorded release whose bytes are not the ones the table pinned", async () => {
    const fixture = createFixture({ name: "app", packageManager: `yarn@${RECORDED}` });

    const result = await run(["yarn", "--version"], options(fixture));

    expect(result.exitCode).toBe(1);
    // The digest compiled into `releases.ts`, not one any request supplied.
    expect(result.stderr).toContain(`Mismatch hashes. Expected ${PINNED}, got ${SHA256}`);
    expect(result.stdout).toBe("");
    expect(existsSync(join(fixture.home, "v1", "yarn", RECORDED))).toBe(false);
  });

  it("refuses an unrecorded, unpinned release before any request", async () => {
    const fixture = createFixture({ name: "app", packageManager: `yarn@${UNKNOWN}` });
    registry.reset();

    const result = await run(["yarn", "--version"], options(fixture));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      `Refusing to install yarn@${UNKNOWN}: https://github.com provides no signature and no hash was pinned. Pin a hash in the packageManager field, or set JUP_ALLOW_UNVERIFIED=1.\n`,
    );
    expect(registry.requests).toEqual([]);
  });

  it("`use` writes a bare version: this host's digest is no colleague's (§02.4)", async () => {
    const fixture = createFixture({ name: "app" });

    const result = await run(
      ["use", `yarn@${UNKNOWN}`],
      options(fixture, { JUP_ALLOW_UNVERIFIED: "1" }),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("zpm=yarn-bin args=install");
    const manifest = JSON.parse(readFileSync(join(fixture.cwd, "package.json"), "utf8"));
    const pinned = JSON.stringify(manifest);
    expect(pinned).toContain(UNKNOWN);
    expect(pinned).not.toContain(SHA256);
    expect(pinned).not.toContain("sha256");
    expect(pinned).not.toContain("integrity");
  });
});
