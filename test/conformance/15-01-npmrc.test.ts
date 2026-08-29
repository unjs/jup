/**
 * rows 148–150 — the `.npmrc` subset (§05.3).
 *
 * #540 is the single most-upvoted missing capability in corepack's tracker, and
 * the thread reframes it as a supply-chain problem rather than a convenience: a
 * locked-down organisation configures one registry, every other tool honours it,
 * and this one silently reaches the public registry from a machine whose policy
 * forbids exactly that.
 *
 * **Three distinct registries run here, and that is deliberate.** The T21 audit
 * recorded two high-severity bugs the suite could not see because the harness
 * collapsed every registry into one mock: a test asserting "the mirror was used"
 * passed whether or not the substitution happened. Rows 148–150 add a third and
 * fourth configuration source, so each has its own server and every assertion
 * names *which* one answered — and, just as importantly, which one did not.
 *
 * Row 149 is the security row. A cloned repository's `.npmrc` is
 * attacker-controlled and this tool runs before the user has decided to trust
 * it, so its `_authToken` must never reach the wire. That is asserted against
 * the bytes the server received, not against the parsed configuration: a
 * credential that is "dropped" but still sent is the bug.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  createFixture,
  type Fixture,
  MockRegistry,
  packageManagerTarball,
  run,
} from "./_harness/index.ts";

/** Stands in for `registry.npmjs.org` and `repo.yarnpkg.com` (via `intercept.ts`). */
const fallback = new MockRegistry();
/** The organisation's mirror — what `.npmrc` points at. */
const mirror = new MockRegistry();
/** A second mirror, so "the environment won" is distinguishable from "a mirror won". */
const other = new MockRegistry();

const PNPM = packageManagerTarball("pnpm", "6.6.2");
const CLI_DIST = packageManagerTarball("yarn", "4.0.0", {
  // §02.5's `npmRegistry.bin`: the tarball is `@yarnpkg/cli-dist` and only this
  // one entry is extracted (§07.4).
  binPaths: ["bin/yarn.js"],
  packageName: "@yarnpkg/cli-dist",
});

/** Trust the keys of every mock that might answer, so a 401 is the only failure mode left. */
function trustAll(): string {
  const keys = [fallback, mirror, other].flatMap(
    (registry) => (JSON.parse(registry.trustStore()) as { npm: unknown[] }).npm,
  );
  return JSON.stringify({ npm: keys });
}

/** The user-level `.npmrc`. `run()` points `HOME` at the fixture's own directory. */
function userNpmrc(fixture: Fixture, content: string): void {
  writeFileSync(join(fixture.home, ".npmrc"), content);
}

/** The project-level `.npmrc`, i.e. the one a `git clone` brings with it. */
function projectNpmrc(fixture: Fixture, content: string): void {
  writeFileSync(join(fixture.cwd, ".npmrc"), content);
}

const paths = (registry: MockRegistry): string[] =>
  registry.requests.map((request) => request.path);

beforeAll(async () => {
  await Promise.all([fallback.start(), mirror.start(), other.start()]);
  for (const registry of [fallback, mirror, other]) {
    registry.publish("pnpm", "6.6.2", PNPM, { distTags: { latest: "6.6.2" } });
    registry.publish("@yarnpkg/cli-dist", "4.0.0", CLI_DIST, { distTags: { latest: "4.0.0" } });
  }
});

afterAll(async () => {
  cleanupFixtures();
  await Promise.all([fallback.stop(), mirror.stop(), other.stop()]);
});

beforeEach(() => {
  for (const registry of [fallback, mirror, other]) registry.reset();
});

describe("§05.3 — the .npmrc subset", () => {
  it("148: a user-level `registry` is honoured, and COREPACK_NPM_REGISTRY still overrides it", async () => {
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });
    userNpmrc(fixture, `registry=${mirror.origin}\n`);

    const fromNpmrc = await run(["pnpm", "--version"], {
      ...fixture,
      // The default registry is a *different* server, so "nothing reached it" is
      // an observation rather than an assumption.
      registry: fallback,
      env: { COREPACK_INTEGRITY_KEYS: trustAll() },
    });

    expect(fromNpmrc.stderr).toBe("");
    expect(fromNpmrc.exitCode).toBe(0);
    expect(fromNpmrc.stdout).toBe("6.6.2\n");
    expect(paths(mirror)).toEqual(["/pnpm/6.6.2", "/pnpm/-/pnpm-6.6.2.tgz"]);
    expect(fallback.requests).toEqual([]);
    expect(other.requests).toEqual([]);

    // §05.3's precedence: the environment sits above the file.
    const overridden = createFixture({ packageManager: "pnpm@6.6.2" });
    userNpmrc(overridden, `registry=${mirror.origin}\n`);
    mirror.reset();

    const fromEnvironment = await run(["pnpm", "--version"], {
      ...overridden,
      registry: fallback,
      env: { COREPACK_NPM_REGISTRY: other.origin, COREPACK_INTEGRITY_KEYS: trustAll() },
    });

    expect(fromEnvironment.exitCode).toBe(0);
    expect(paths(other)).toEqual(["/pnpm/6.6.2", "/pnpm/-/pnpm-6.6.2.tgz"]);
    expect(mirror.requests).toEqual([]);
    expect(fallback.requests).toEqual([]);
  });

  it("149: a project `.npmrc`'s auth is ignored while the user's is honoured", async () => {
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });
    const host = new URL(mirror.origin).host;

    // The user's own credential, and the only one the mirror will accept.
    userNpmrc(fixture, `//${host}/:_authToken=user-token\n`);
    // What a hostile clone ships: a registry (permitted — it can only redirect
    // us) and a credential (refused — it would be handed our identity).
    projectNpmrc(
      fixture,
      [`registry=${mirror.origin}`, `//${host}/:_authToken=project-token`].join("\n"),
    );
    mirror.requiredAuthorization = "Bearer user-token";

    const result = await run(["pnpm", "--version"], {
      ...fixture,
      registry: fallback,
      env: { COREPACK_INTEGRITY_KEYS: trustAll() },
    });

    // The project file's *registry* was honoured — that is the half a cloned
    // repository is allowed to decide.
    expect(paths(mirror)).toEqual(["/pnpm/6.6.2", "/pnpm/-/pnpm-6.6.2.tgz"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("6.6.2\n");

    // The credential half was not. Asserted on the wire: every request the
    // server saw carried the user's token, and the project's appears in no
    // header the server received, and in nothing the tool printed.
    expect(mirror.requests.map((request) => request.authorization)).toEqual([
      "Bearer user-token",
      "Bearer user-token",
    ]);
    expect(JSON.stringify(mirror.requests)).not.toContain("project-token");
    expect(fallback.requests).toEqual([]);
    expect(`${result.stdout}${result.stderr}`).not.toContain("project-token");

    // Refused out loud, not silently — §03.2's precedent, and the one line that
    // explains a token which "should" have been picked up.
    expect(result.stderr).toContain(
      `! Ignoring //${host}/:_authToken from ${join(fixture.cwd, ".npmrc")}: a project-level .npmrc may only set registry and @scope:registry`,
    );
  });

  it("149: a project `.npmrc` cannot supply a certificate authority or disable TLS either", async () => {
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });
    userNpmrc(fixture, `registry=${mirror.origin}\n`);
    projectNpmrc(fixture, ["cafile=/nonexistent/evil.pem", "strict-ssl=false"].join("\n"));

    const result = await run(["info", "--json"], { ...fixture, registry: fallback });

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as {
      tls: { cafile: string | null; verify: boolean };
      npmrc: { files: Array<{ level: string; refused: string[] }> };
    };
    // A bundle nothing can read would have failed the very next request; §05.3
    // means it never gets that far.
    expect(report.tls.cafile).toBeNull();
    expect(report.tls.verify).toBe(true);
    expect(report.npmrc.files.at(-1)).toMatchObject({
      level: "project",
      refused: ["cafile", "strict-ssl"],
    });
  });

  it("150: `@yarnpkg:registry` alone sends Yarn Berry to @yarnpkg/cli-dist", async () => {
    const fixture = createFixture({ packageManager: "yarn@4.0.0" });
    // Note what is *not* set: no `registry`, no `COREPACK_NPM_REGISTRY`. The
    // scoped key is the whole configuration, and it has to be enough to flip
    // Berry off `repo.yarnpkg.com` (§02.5, §05.2 rewrite 1).
    userNpmrc(fixture, `@yarnpkg:registry=${mirror.origin}\n`);

    const result = await run(["yarn", "--version"], {
      ...fixture,
      registry: fallback,
      env: { COREPACK_INTEGRITY_KEYS: trustAll() },
    });

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("4.0.0\n");
    expect(paths(mirror)).toEqual([
      "/@yarnpkg/cli-dist/4.0.0",
      "/@yarnpkg/cli-dist/-/cli-dist-4.0.0.tgz",
    ]);
    // repo.yarnpkg.com — which `intercept.ts` points at `fallback` — was never
    // asked, which is the difference between "configured" and "honoured".
    expect(fallback.requests).toEqual([]);
    expect(existsSync(join(fixture.home, "v1", "yarn", "4.0.0"))).toBe(true);
  });

  it("150: a plain `registry` does the same, and a scoped one outranks it", async () => {
    const fixture = createFixture({ packageManager: "yarn@4.0.0" });
    userNpmrc(
      fixture,
      [`registry=${other.origin}`, `@yarnpkg:registry=${mirror.origin}`].join("\n"),
    );

    const result = await run(["yarn", "--version"], {
      ...fixture,
      registry: fallback,
      env: { COREPACK_INTEGRITY_KEYS: trustAll() },
    });

    expect(result.exitCode).toBe(0);
    expect(paths(mirror)).toEqual([
      "/@yarnpkg/cli-dist/4.0.0",
      "/@yarnpkg/cli-dist/-/cli-dist-4.0.0.tgz",
    ]);
    expect(other.requests).toEqual([]);
    expect(fallback.requests).toEqual([]);
  });

  it("reports which files were read, in precedence order, and what each supplied", async () => {
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });
    const host = new URL(mirror.origin).host;
    userNpmrc(fixture, [`registry=${other.origin}`, `//${host}/:_authToken=user-token`].join("\n"));
    projectNpmrc(fixture, [`registry=${mirror.origin}`, `//${host}/:_auth=c3RvbGVu`].join("\n"));

    const result = await run(["info", "--json"], { ...fixture, registry: fallback });

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as {
      npmrc: {
        files: Array<{ path: string; level: string; keys: string[]; refused: string[] }>;
        registry: { value: string } | null;
        auth: Array<{ prefix: string; type: string }>;
      };
      packageManagers: Array<{ name: string; registry: string; registrySource: string }>;
    };

    expect(report.npmrc.files).toEqual([
      {
        path: join(fixture.home, ".npmrc"),
        level: "user",
        keys: ["registry", `//${host}/:_authToken`],
        refused: [],
      },
      {
        path: join(fixture.cwd, ".npmrc"),
        level: "project",
        keys: ["registry"],
        refused: [`//${host}/:_auth`],
      },
    ]);
    // Closest wins for `registry`; the project file's auth never became one.
    expect(report.npmrc.registry?.value).toBe(mirror.origin);
    expect(report.npmrc.auth).toEqual([
      { prefix: `//${host}/`, type: "token", source: join(fixture.home, ".npmrc") },
    ]);
    // Never the credential itself: this output is pasted into issue trackers.
    expect(result.stdout).not.toContain("user-token");
    expect(result.stdout).not.toContain("c3RvbGVu");

    // And `registrySource` names the file and key, not just "a registry".
    for (const entry of report.packageManagers) {
      expect(entry.registry).toBe(mirror.origin);
      expect(entry.registrySource).toBe(`.npmrc registry (${join(fixture.cwd, ".npmrc")})`);
    }
  });
});
