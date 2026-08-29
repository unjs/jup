/**
 * §13.10 — `use` and `up` (rows 105–116).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  createFixture,
  MockRegistry,
  packageManagerTarball,
  publishBerry,
  run,
} from "./_harness/index.ts";

const registry = new MockRegistry();

/**
 * §06.1 redirected these rows. Half of them resolve Yarn **Berry** from
 * `repo.yarnpkg.com`, a url-type registry that publishes no signatures and no
 * digests, so the artifact clears no verification tier and the install is now
 * refused. The opt-out keeps every row about what it is about — which field
 * `use`/`up` write, and what they write into it — and the refusal itself has
 * its own rows (167). It is harmless on the npm-registry rows here: with a
 * verified signature in hand nothing is downgraded and nothing is printed,
 * which is why the rows asserting an empty stderr still do.
 */
function trusted(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    COREPACK_INTEGRITY_KEYS: registry.trustStore(),
    COREPACK_ALLOW_UNVERIFIED: "1",
    ...extra,
  };
}

function pinOf(fixture: { json(relative: string): unknown }): string | undefined {
  return (fixture.json("package.json") as { packageManager?: string }).packageManager;
}

/** §03.7 — the pin lives here for a project that declares only `devEngines`. */
function devEnginesOf(fixture: { json(relative: string): unknown }): unknown {
  return (fixture.json("package.json") as { devEngines?: { packageManager?: unknown } }).devEngines
    ?.packageManager;
}

beforeAll(async () => {
  await registry.start();

  registry.publish("yarn", "1.22.4", packageManagerTarball("yarn", "1.22.4"), {
    distTags: { latest: "1.22.4" },
  });
  registry.publish(
    "@yarnpkg/cli-dist",
    "4.9.9",
    packageManagerTarball("yarn", "4.9.9", {
      binPaths: ["bin/yarn.js"],
      packageName: "@yarnpkg/cli-dist",
    }),
    // A real mirror carries npm's dist-tags. §05.2 rewrite 1 sends the *tag*
    // lookup here too, not just the download, so without these `yarn@latest`
    // behind a mirror has nowhere to resolve `latest` from.
    { distTags: { latest: "4.9.9", stable: "4.9.9" } },
  );

  // §02.5 — the older Berry lines the `up` rows walk, published the same way.
  // These used to be single `.js` files on `repo.yarnpkg.com`, listed by a
  // `/tags` document; the versions a range can reach are the packument's now.
  for (const version of ["2.1.0", "2.4.3"]) {
    publishBerry(registry, version);
  }
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§13.10 use / up", () => {
  it("105: use yarn@1.22.4 prints the banner, pins a sha512 reference and runs yarn", async () => {
    const fixture = createFixture({ name: "project" });

    const result = await run(["use", "yarn@1.22.4"], { ...fixture, registry, env: trusted() });

    expect(result.exitCode).toBe(0);
    // §12.11 added the middle line: every mutating command names the file it
    // modified, which is the whole of #607 and costs one line of output.
    expect(result.stdout).toBe(
      `Installing yarn@1.22.4 in the project...\n` +
        `Updated ${fixture.path("package.json")} to use ${pinOf(fixture)}\n` +
        `\nyarn@1.22.4 install\n`,
    );
    expect(result.stderr).toBe("");
    expect(pinOf(fixture)).toMatch(/^yarn@1\.22\.4\+sha512\.[\da-f]{128}$/);
  });

  it("106: use in an empty directory creates package.json", async () => {
    const fixture = createFixture();

    const result = await run(["use", "yarn@1.22.4"], { ...fixture, registry, env: trusted() });

    expect(result.exitCode).toBe(0);
    expect(fixture.exists("package.json")).toBe(true);
    expect(pinOf(fixture)).toMatch(/^yarn@1\.22\.4\+sha512\./);
  });

  it("107: use from a subfolder updates the ancestor manifest", async () => {
    const fixture = createFixture({ name: "root" });
    fixture.write("sub/keep.txt", "");

    const result = await run(["use", "yarn@1.22.4"], {
      ...fixture,
      cwd: fixture.path("sub"),
      registry,
      env: trusted(),
    });

    expect(result.exitCode).toBe(0);
    expect(pinOf(fixture)).toMatch(/^yarn@1\.22\.4\+sha512\./);
    expect(fixture.exists("sub/package.json")).toBe(false);
  });

  it("108: use yarn@latest over a mirror resolves through @yarnpkg/cli-dist", async () => {
    const fixture = createFixture({ name: "project" });

    const result = await run(["use", "yarn@latest"], {
      ...fixture,
      registry,
      env: trusted({ COREPACK_NPM_REGISTRY: registry.origin }),
    });

    expect(result.exitCode).toBe(0);
    expect(pinOf(fixture)).toMatch(/^yarn@4\.9\.9\+sha512\./);
    expect(registry.requests.map((request) => request.path)).toContain(
      "/@yarnpkg/cli-dist/-/cli-dist-4.9.9.tgz",
    );
  });

  it("109: use overwrites a malformed existing packageManager field", async () => {
    for (const malformed of ["yarn@^1", "yarn", "yarn@", 42, null]) {
      const fixture = createFixture({ packageManager: malformed });

      const result = await run(["use", "yarn@1.22.4"], { ...fixture, registry, env: trusted() });

      expect(result.exitCode, JSON.stringify(malformed)).toBe(0);
      expect(pinOf(fixture)).toMatch(/^yarn@1\.22\.4\+sha512\./);
    }
  });

  it("110: a devEngines mismatch surfaces after the banner, on stdout", async () => {
    const fixture = createFixture({
      devEngines: { packageManager: { name: "yarn", version: "2.x" } },
    });

    const result = await run(["use", "yarn@1.22.4"], { ...fixture, registry, env: trusted() });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Installing yarn@1.22.4 in the project...");
    expect(result.stdout).toContain("Usage Error:");
    expect(result.stdout).toContain("$ jup use [--here] [--pin-style=suffix|sidecar] <pattern>");
    expect(result.stderr).toBe("");
  });

  it("110: use refuses a package manager the devEngines field does not name", async () => {
    // The *version* satisfies the declared range; only the name is wrong. Left
    // unchecked, this writes a pin that §03.3's name check then rejects on every
    // later run, with nothing but a hand edit to undo it.
    const fixture = createFixture({
      devEngines: { packageManager: { name: "pnpm", version: "1.x" } },
    });

    const result = await run(["use", "yarn@1.22.4"], { ...fixture, registry, env: trusted() });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Usage Error:");
    // §12.3's two name slots are independent: the requested one, then the
    // declared one.
    expect(result.stdout).toMatch(
      /The requested version of yarn@1\.22\.4\+sha512\.[\da-f]+ does not match the devEngines specification \(pnpm@1\.x\)/,
    );
    expect(result.stderr).toBe("");
    // The pin was never written.
    expect(pinOf(fixture)).toBeUndefined();
  });

  it("111: up bumps to the highest release of the pinned major", async () => {
    const fixture = createFixture({ packageManager: "yarn@2.1.0" });

    const result = await run(["up"], { ...fixture, registry, env: trusted() });

    expect(result.exitCode).toBe(0);
    expect(pinOf(fixture)).toMatch(/^yarn@2\.4\.3\+sha512\./);
  });

  it("112: up follows a devEngines range across a major boundary", async () => {
    const fixture = createFixture({
      packageManager: "yarn@1.1.0",
      devEngines: { packageManager: { name: "yarn", version: "1.x || 2.x", onFail: "warn" } },
    });

    const result = await run(["up"], { ...fixture, registry, env: trusted() });

    expect(result.exitCode).toBe(0);
    expect(pinOf(fixture)).toMatch(/^yarn@2\.4\.3\+sha512\./);
  });

  it("113: the same holds with onFail: ignore", async () => {
    const fixture = createFixture({
      packageManager: "yarn@1.1.0",
      devEngines: { packageManager: { name: "yarn", version: "1.x || 2.x", onFail: "ignore" } },
    });

    const result = await run(["up"], { ...fixture, registry, env: trusted() });

    expect(result.exitCode).toBe(0);
    expect(pinOf(fixture)).toMatch(/^yarn@2\.4\.3\+sha512\./);
  });

  // §03.7 redirected row 114. It used to require `up` to *create* a
  // `packageManager` field beside the `devEngines` declaration — which is #874:
  // the two then disagree (a hash-presence difference is enough) and the very
  // next read fails §03.3. The pin is written where the declaration already is,
  // and row 189 covers the same rule for `use`.
  it("114: up on a devEngines-only project updates devEngines in place", async () => {
    const fixture = createFixture({
      devEngines: { packageManager: { name: "yarn", version: "2.1.0" } },
    });

    const result = await run(["up"], { ...fixture, registry, env: trusted() });

    expect(result.exitCode).toBe(0);
    expect(pinOf(fixture)).toBeUndefined();
    expect(devEnginesOf(fixture)).toEqual({
      name: "yarn",
      version: "2.4.3",
      integrity: expect.stringMatching(/^sha512-[\d+/A-Za-z]+=*$/),
    });

    // §03.7's post-write requirement: the project it just edited re-reads
    // cleanly, with no warning and no error.
    const rerun = await run(["yarn", "--version"], { ...fixture, registry, env: trusted() });
    expect(rerun.exitCode).toBe(0);
    expect(rerun.stderr).toBe("");
  });

  // The other half of row 114, once §04.4 landed: a *range* declared in the
  // same place is not a pin to rewrite but a range to keep. `use <name>@<range>`
  // writes exactly this shape on a project with no top-level field (§03.7), so
  // an `up` that read only `packageManager` would collapse the range it had just
  // written and delete its own record along with it.
  it("114: up on a devEngines-only range keeps the range and records the resolution", async () => {
    const fixture = createFixture({
      devEngines: { packageManager: { name: "yarn", version: "2.x" } },
    });

    const result = await run(["up"], { ...fixture, registry, env: trusted() });

    expect(result.exitCode).toBe(0);
    expect(pinOf(fixture)).toBeUndefined();
    expect(devEnginesOf(fixture)).toMatchObject({ name: "yarn", version: "2.x" });
    expect(fixture.json("jup.lock")).toMatchObject({
      resolutions: { "yarn@2.x": { resolved: "2.4.3" } },
    });
  });

  it("115: up refuses a non-semver pin", async () => {
    const fixture = createFixture({ packageManager: "yarn@stable" });

    const result = await run(["up"], { ...fixture, registry, env: trusted() });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      `Usage Error: The 'jup up' command can only be used when your project's packageManager field is set to a semver version or semver range`,
    );
  });

  it("116: use and up preserve tab indentation and CRLF line endings", async () => {
    const original = `{\r\n\t"name": "crlf",\r\n\t"packageManager": "yarn@1.0.0"\r\n}\r\n`;

    const used = createFixture(original);
    expect(
      (await run(["use", "yarn@1.22.4"], { ...used, registry, env: trusted() })).exitCode,
    ).toBe(0);
    const afterUse = used.read("package.json");
    expect(afterUse).toMatch(
      /^\{\r\n\t"name": "crlf",\r\n\t"packageManager": "yarn@1\.22\.4\+sha512\.[\da-f]{128}"\r\n\}\r\n$/,
    );
    expect(afterUse.replaceAll("\r\n", "")).not.toContain("\n");

    const upped = createFixture(
      `{\r\n\t"name": "crlf",\r\n\t"packageManager": "yarn@2.1.0"\r\n}\r\n`,
    );
    expect((await run(["up"], { ...upped, registry, env: trusted() })).exitCode).toBe(0);
    const afterUp = upped.read("package.json");
    expect(afterUp).toMatch(
      /^\{\r\n\t"name": "crlf",\r\n\t"packageManager": "yarn@2\.4\.3\+sha512\.[\da-f]{128}"\r\n\}\r\n$/,
    );
  });
});
