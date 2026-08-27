/**
 * §15.21 / §15.28 — bun and deno as built-in entries (rows 212–218 and 220).
 *
 * §15.28 required the *architecture* to admit a native package manager;
 * `15-28-native.test.ts` proves that with a fixture manager and adds nothing to
 * the table. This file is the other half: the two entries the table now ships,
 * exercised through the same public surface a user reaches.
 *
 * What makes them different from every other entry, and what each row here is
 * about, is that **one version is many artifacts**. `bun` and `deno` on npm are
 * ~15 kB launcher packages whose `postinstall` downloads a binary from an
 * `optionalDependencies` entry named after the host; jup runs no lifecycle
 * scripts, so it goes to those per-host packages directly. The version line and
 * the dist-tags still come from the launcher (§02.3's `registry`), the bytes and
 * npm's signature over them from `@oven/bun-<target>` / `@deno/<target>`
 * (§15.28's `artifactRegistry`). Everything downstream of "which digest?" then
 * has to stop assuming there is one.
 *
 * The mock publishes under `hostTarget()`, so the suite asserts about whatever
 * host it is running on rather than about Linux.
 *
 * POSIX only, for the reason `15-28-native.test.ts` gives: the artifact has to
 * be a real executable, a `#!/bin/sh` script is one on a POSIX host and is
 * nothing on Windows, and a committed `.exe` is not worth carrying.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hostTarget } from "../../src/config/table.ts";
import {
  cleanupFixtures,
  createFixture,
  type Fixture,
  makeTarball,
  MockRegistry,
  npmTarball,
  run,
} from "./_harness/index.ts";

const POSIX = process.platform !== "win32";

const registry = new MockRegistry();

const BUN_VERSION = "1.4.0";
const DENO_VERSION = "2.9.5";

/** The per-host package each entry's `{target}` resolves to on *this* machine. */
const BUN_TARGETS: Record<string, string> = {
  "darwin-arm64": "darwin-aarch64",
  "darwin-x64": "darwin-x64",
  "linux-arm64": "linux-aarch64",
  "linux-x64": "linux-x64",
  "win32-arm64": "windows-aarch64",
  "win32-x64": "windows-x64",
};
const DENO_TARGETS: Record<string, string> = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-arm64": "linux-arm64-glibc",
  "linux-x64": "linux-x64-glibc",
  "win32-arm64": "win32-arm64",
  "win32-x64": "win32-x64",
};

const BUN_PACKAGE = `@oven/bun-${BUN_TARGETS[hostTarget()]}`;
const DENO_PACKAGE = `@deno/${DENO_TARGETS[hostTarget()]}`;

/**
 * A stand-in for the real binary: it reports the name it was invoked under and
 * its arguments, which is all any row here needs to read.
 *
 * `$0` is the script path for a `#!/bin/sh` artifact, so the name is taken from
 * `basename` — enough to tell `bun` from `bunx`, which is the distinction bun
 * itself draws from `argv[0]` and the reason its two `bin` entries name one
 * file. The real `argv[0]` handover is asserted in `test/unit/exec.test.ts`,
 * where the fixture is an executable that can see it.
 */
const PROBE = `#!/bin/sh\nprintf 'ran=%s args=%s\\n' "$(basename "$0")" "$*"\n`;

/**
 * The per-host packages carry the executable and **no `bin` field**, exactly as
 * the published ones do — so §07.7 finds nothing to read and the embedded table
 * is the authority for where the entry points are. That is the inverse of every
 * other entry, and it is why `{exe}` lives in the table at all.
 */
function artifact(name: string, version: string, binPath: string): Uint8Array {
  return makeTarball([
    {
      path: "package/package.json",
      content: `${JSON.stringify({ name, version })}\n`,
      mode: 0o644,
    },
    // §07.4 rule 6 — the executable bit is declared here and must survive
    // extraction; `makeTarball` rather than `npmTarball` because deno's entry
    // point is at the package root, where the latter's `bin/` heuristic would
    // quietly hand back a 0644 file and turn this suite into an EACCES test.
    { path: `package/${binPath}`, content: PROBE, mode: 0o755 },
  ]);
}

const BUN_TARBALL = artifact(BUN_PACKAGE, BUN_VERSION, "bin/bun");
// Deno's executable sits at the package root, not under `bin/`.
const DENO_TARBALL = artifact(DENO_PACKAGE, DENO_VERSION, "deno");

beforeAll(async () => {
  if (!POSIX) return;
  await registry.start();

  // The launchers, which is where §04 asks what versions exist.
  registry.publish("bun", BUN_VERSION, npmTarball({ "package.json": "{}\n" }), {
    distTags: { latest: BUN_VERSION },
  });
  registry.publish("deno", DENO_VERSION, npmTarball({ "package.json": "{}\n" }), {
    distTags: { latest: DENO_VERSION },
  });

  // The artifacts, which is where §06 asks what the bytes should be.
  registry.publish(BUN_PACKAGE, BUN_VERSION, BUN_TARBALL);
  registry.publish(DENO_PACKAGE, DENO_VERSION, DENO_TARBALL);
});

afterAll(async () => {
  cleanupFixtures();
  if (POSIX) await registry.stop();
});

describe.skipIf(!POSIX)("§15.21 bun and deno", () => {
  function options(fixture: Fixture, env?: Record<string, string | undefined>) {
    return {
      cwd: fixture.cwd,
      home: fixture.home,
      registry,
      // §06.3 — the mock signs with its own key, so the rows verify a real
      // signature rather than skipping the check.
      env: { COREPACK_INTEGRITY_KEYS: registry.trustStore(), CI: undefined, ...env },
    };
  }

  it("212: installs the host's artifact package, not the launcher, and runs it directly", async () => {
    const fixture = createFixture({ name: "app", packageManager: `bun@${BUN_VERSION}` });
    registry.reset();

    const result = await run(["bun", "install", "--frozen"], options(fixture));

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ran=bun args=install --frozen");

    // The launcher's own tarball is never fetched: it is a `postinstall` stub,
    // and caching it would mean caching something that cannot run.
    const fetched = registry.requests.map((request) => request.path);
    expect(fetched.some((path) => path.includes(`${BUN_PACKAGE}/-/`))).toBe(true);
    expect(fetched.some((path) => path.includes("/bun/-/"))).toBe(false);
  });

  it("213: verifies against the artifact package's own signature, not the launcher's", async () => {
    const fixture = createFixture({ name: "app", packageManager: `bun@${BUN_VERSION}` });

    // §15.7's strict mode: a signature must exist and verify, or the install
    // fails. It is the launcher that carries the version, so a build that read
    // `dist.integrity` from *there* would be checking the wrong bytes — and
    // would fail here rather than quietly install something unverified.
    const result = await run(
      ["bun", "--version"],
      options(fixture, { COREPACK_REQUIRE_SIGNATURES: "1" }),
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readMarker(fixture, "bun", BUN_VERSION)).hash).toMatch(/^sha512\./);
  });

  it("214: `bunx` and `bun` are one cached file, reached under two names", async () => {
    const fixture = createFixture({ name: "app", packageManager: `bun@${BUN_VERSION}` });

    // §01.4 — `bunx` is a transparent command, so it runs in a bare directory
    // too; here it runs in the project, which is the simpler assertion.
    const result = await run(["bunx", "cowsay"], options(fixture));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ran=bun args=cowsay");

    const marker = JSON.parse(readMarker(fixture, "bun", BUN_VERSION)) as {
      bin: Record<string, string>;
    };
    // §02.4 already spells "two names, one file" this way (Yarn Classic's
    // `yarn`/`yarnpkg`); what makes it work for a native artifact is the
    // invoked name reaching the child as `argv[0]`.
    expect(marker.bin.bunx).toBe(marker.bin.bun);
  });

  it("215: deno's executable is at the package root, and the table says so", async () => {
    const fixture = createFixture({ name: "app", packageManager: `deno@${DENO_VERSION}` });

    const result = await run(["deno", "task", "build"], options(fixture));

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ran=deno args=task build");
    expect(JSON.parse(readMarker(fixture, "deno", DENO_VERSION)).bin).toEqual({
      deno: "./deno",
    });
  });

  it("216: `use` pins the version and never the digest", async () => {
    const fixture = createFixture({ name: "app" });

    const result = await run(["use", `bun@${BUN_VERSION}`], options(fixture));
    expect(result.exitCode).toBe(0);

    // A digest here would be this host's. Committed, it fails every colleague on
    // another platform with a hash mismatch — the one outcome a pin exists to
    // prevent. What stands in for it is npm's signature over the host's own
    // artifact, checked on every install.
    expect((fixture.json("package.json") as { packageManager: string }).packageManager).toBe(
      `bun@${BUN_VERSION}`,
    );
  });

  it("217: a range records one digest per host, and leaves the others alone", async () => {
    const fixture = createFixture({ name: "app", packageManager: "bun@^1.4.0" });
    // A colleague's machine got here first.
    fixture.write(
      ".jup.lock",
      `${JSON.stringify(
        {
          version: 1,
          resolutions: {
            "bun@^1.4.0": {
              resolved: BUN_VERSION,
              integrity: { "some-other-host": "sha512-theirs" },
            },
          },
        },
        undefined,
        2,
      )}\n`,
    );

    expect((await run(["bun", "--version"], options(fixture))).exitCode).toBe(0);

    const lock = fixture.json(".jup.lock") as {
      resolutions: Record<string, { resolved: string; integrity: Record<string, string> }>;
    };
    const entry = lock.resolutions["bun@^1.4.0"]!;
    expect(entry.resolved).toBe(BUN_VERSION);
    // Ours added, theirs untouched: the version is a shared decision, the digest
    // is not, and a run on one host must not invalidate the record for another.
    expect(entry.integrity["some-other-host"]).toBe("sha512-theirs");
    expect(entry.integrity[hostTarget()]).toMatch(/^sha512-/);
  });

  it("220: the default-version lookup pins no digest, because the launcher's is the wrong one", async () => {
    // No project at all, so §04.5 decides — the one path that asks the registry
    // what `latest` is rather than being told a version. `fetchLatestFrom` names
    // the **launcher**, whose `dist.integrity` describes a stub nobody
    // downloads; attaching it as a build suffix put a ~15 kB package's digest on
    // a 40–90 MB binary and failed every bare `deno` with a hash mismatch
    // naming neither package. The two tarballs differ here for exactly that
    // reason: a build that reintroduces the pin cannot pass this row.
    const fixture = createFixture();
    registry.reset();

    const result = await run(
      ["deno", "task", "build"],
      options(fixture, { COREPACK_DEFAULT_TO_LATEST: "1" }),
    );

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ran=deno args=task build");

    // The recorded default carries the version and no digest, so the next run —
    // which does not reach the registry at all — is not pinned to it either.
    const recorded = JSON.parse(
      readFileSync(join(fixture.home, "lastKnownGood.json"), "utf8"),
    ) as Record<string, string>;
    expect(recorded.deno).toBe(DENO_VERSION);
  });

  it("218: a bare `enable` leaves the bun and deno names alone; naming them takes them", async () => {
    const fixture = createFixture({ name: "app" });
    const shims = join(fixture.root, "shims");

    expect((await run(["enable", "--install-directory", shims], options(fixture))).exitCode).toBe(
      0,
    );
    // §10.5 still shims everything else, npm included (§15.16).
    expect(exists(join(shims, "yarn"))).toBe(true);
    expect(exists(join(shims, "pnpm"))).toBe(true);
    expect(exists(join(shims, "bun"))).toBe(false);
    expect(exists(join(shims, "deno"))).toBe(false);

    expect(
      (await run(["enable", "--install-directory", shims, "bun"], options(fixture))).exitCode,
    ).toBe(0);
    expect(exists(join(shims, "bun"))).toBe(true);
    expect(exists(join(shims, "bunx"))).toBe(true);

    // Removal has no such hazard, so a bare `disable` undoes it.
    expect((await run(["disable", "--install-directory", shims], options(fixture))).exitCode).toBe(
      0,
    );
    expect(exists(join(shims, "bun"))).toBe(false);
    expect(exists(join(shims, "yarn"))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

function readMarker(fixture: Fixture, name: string, version: string): string {
  return readFileSync(join(fixture.home, "v1", name, version, ".jup"), "utf8");
}

function exists(path: string): boolean {
  return existsSync(path);
}
