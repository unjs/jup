/**
 * A repository may not both choose the registry and vouch for what it serves
 * (§06.1, §06.6).
 *
 * §06.6's threat model claims "hostile repo pointing a known tool at an
 * arbitrary URL → blocked", and §05.1 already withholds credentials from an
 * origin only the clone named. The verification tiers did not ask the same
 * question: a `.jup.env` or a project `.npmrc` could name a host, serve
 * `dist.integrity` for its own tarball, publish no `signatures`, and take
 * §06.1's soft-fail — one warning, then arbitrary code on `pnpm --version`.
 * Pinning the repository's own hash in `packageManager` took row 1 instead and
 * skipped the signature question altogether.
 *
 * These rows pin both halves: the repository's registry must produce a
 * signature that the *embedded or user* trust store verifies, and the split is
 * on who chose the origin — never on the URL itself. Every refusal here is
 * therefore paired with the same mock, unchanged, named by the person at the
 * keyboard, which must still install.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  createFixture,
  hashOf,
  MockRegistry,
  packageManagerTarball,
  run,
} from "./_harness/index.ts";

const registry = new MockRegistry();

/** The exact bytes the mock serves, so a row can pin them as the repo would. */
const TARBALL = packageManagerTarball("pnpm", "6.6.2");

/** The refusal, built the way `errors-cold.ts` builds it. */
function refusal(version = "6.6.2"): string {
  return `${registry.origin} was chosen by this project and does not publish signatures for pnpm@${version}; set JUP_NPM_REGISTRY in your own environment, or name the registry in your user .npmrc, to trust it`;
}

/** Did anything actually reach the tarball? The refusal must precede the bytes. */
function tarballRequests(): number {
  return registry.requests.filter((request) => request.path.includes(".tgz")).length;
}

beforeAll(async () => {
  await registry.start();
  registry.publish("pnpm", "6.6.2", TARBALL, { distTags: { latest: "6.6.2" } });
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§06.1 — a project-chosen registry gets no soft-fail", () => {
  it("refuses a `.jup.env` registry that publishes no signatures", async () => {
    registry.mode = "no_signatures";
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });
    fixture.write(".jup.env", `JUP_NPM_REGISTRY=${registry.origin}\n`);

    const result = await run(["pnpm", "--version"], { ...fixture });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(refusal());
    // §06.1's soft-fail wording must not also appear: the two are alternatives,
    // and a build that printed both would be warning about what it refused.
    expect(result.stderr).not.toContain("falling back to integrity-only verification");
    expect(tarballRequests()).toBe(0);
    expect(existsSync(join(fixture.home, "v1", "pnpm"))).toBe(false);
  });

  it("refuses the same through the compatibility spelling in `.corepack.env`", async () => {
    registry.mode = "no_signatures";
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });
    fixture.write(".corepack.env", `COREPACK_NPM_REGISTRY=${registry.origin}\n`);

    const result = await run(["pnpm", "--version"], { ...fixture });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(refusal());
    expect(tarballRequests()).toBe(0);
  });

  it("refuses a project `.npmrc` that names the registry", async () => {
    registry.mode = "no_signatures";
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });
    fixture.write(".npmrc", `registry=${registry.origin}\n`);

    const result = await run(["pnpm", "--version"], { ...fixture });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(refusal());
    expect(tarballRequests()).toBe(0);
    expect(existsSync(join(fixture.home, "v1", "pnpm"))).toBe(false);
  });

  it("refuses even when the repository pins its own hash (§06.1 row 1 does not apply)", async () => {
    // The quiet variant, and the reason row 1's exemption had to be narrowed:
    // the pin and the origin came from the same clone, so it vouches for
    // nothing. A build that kept row 1's short-circuit here installs.
    registry.mode = "no_signatures";
    const fixture = createFixture({ packageManager: `pnpm@6.6.2+sha512.${hashOf(TARBALL)}` });
    fixture.write(".jup.env", `JUP_NPM_REGISTRY=${registry.origin}\n`);

    const result = await run(["pnpm", "--version"], { ...fixture });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(refusal());
    expect(tarballRequests()).toBe(0);
    expect(existsSync(join(fixture.home, "v1", "pnpm"))).toBe(false);
  });

  it("still refuses when the project pins a hash the registry never signed", async () => {
    // The pin is not the authority under project trust, but it is not ignored
    // either: with signatures present and a pin that disagrees with the signed
    // `integrity`, the install must not proceed on the pin alone.
    const fixture = createFixture({ packageManager: `pnpm@6.6.2+sha512.${"0".repeat(128)}` });
    fixture.write(".npmrc", `registry=${registry.origin}\n`);

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      env: { COREPACK_INTEGRITY_KEYS: registry.trustStore() },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Mismatch hashes");
    expect(existsSync(join(fixture.home, "v1", "pnpm"))).toBe(false);
  });
});

describe("§05.1 — the split is on who chose the origin, not on the origin", () => {
  it("the same unsigned registry named in the real environment keeps the soft-fail", async () => {
    // The positive control the refusals above are meaningless without: nothing
    // here is a property of the mock, only of who named it.
    registry.mode = "no_signatures";
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      env: { JUP_NPM_REGISTRY: registry.origin },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");
    expect(result.stderr).toContain(
      `⚠ ${registry.origin} does not publish signatures for pnpm@6.6.2; falling back to integrity-only verification`,
    );
    expect(result.stderr).not.toContain("was chosen by this project");
  });

  it("a user `.npmrc` naming it is the user's choice too", async () => {
    registry.mode = "no_signatures";
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });
    // `run` points HOME at the fixture store, so this is the user tier.
    writeFileSync(join(fixture.home, ".npmrc"), `registry=${registry.origin}\n`);

    const result = await run(["pnpm", "--version"], { ...fixture });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");
    expect(result.stderr).toContain("falling back to integrity-only verification");
  });

  it("a project `.npmrc` naming an origin the user already named is the user's", async () => {
    // §05.1's deny-list, stated the other way round: the repository moved
    // nothing, so it withheld nothing.
    registry.mode = "no_signatures";
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });
    fixture.write(".npmrc", `registry=${registry.origin}\n`);

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      env: { JUP_NPM_REGISTRY: registry.origin },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");
  });

  it("a project registry that does sign, against a trust store the user configured, installs", async () => {
    // The requirement is a signature the *embedded or user* store verifies —
    // not a ban on project registries. A signing mirror the user has trusted in
    // their own environment is the supported arrangement, and it still works.
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });
    fixture.write(".npmrc", `registry=${registry.origin}\n`);

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      env: { COREPACK_INTEGRITY_KEYS: registry.trustStore() },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");
    expect(result.stderr).not.toContain("was chosen by this project");
  });

  it("and the repository cannot supply that trust store itself (§03.2)", async () => {
    // The compounding case. If `.jup.env` could carry the keys, the requirement
    // above would be one the attacker satisfies; `env.ts` already denies the
    // variable, and this is that denial seen from §06.1.
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });
    fixture.write(".npmrc", `registry=${registry.origin}\n`);
    fixture.write(".jup.env", `COREPACK_INTEGRITY_KEYS=${registry.trustStore()}\n`);

    const result = await run(["pnpm", "--version"], { ...fixture });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("The package was not signed by any trusted keys");
    expect(existsSync(join(fixture.home, "v1", "pnpm"))).toBe(false);
  });
});
