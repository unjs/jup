/**
 * §03.1 / §02.4 — bun, deno, aube and nub as built-in entries (rows 212–218,
 * 220, 221 and 222–229).
 *
 * §02.4 and §08.3 required the *architecture* to admit a native package manager;
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
 * (§02.4's `artifactRegistry`). Everything downstream of "which digest?" then
 * has to stop assuming there is one.
 *
 * aube is the third, and is here for what it does *not* share with the other
 * two: it is a package manager rather than a runtime, so it takes part in a bare
 * `jup enable`, and its per-host packages declare a `bin` of their own, so §07.7
 * has something to read for once.
 *
 * nub is the fourth, and it is here because it is both at once — `nub install`
 * is a package manager's command and `nub server.ts` is a runtime's — which is
 * what settles what `shimByDefault` is actually about. Its two names are one
 * file, as bun's are, and its per-host packages declare no `bin`, as bun's and
 * deno's do not.
 *
 * pnpm 12 is the fifth (rows 264 and 265), and the only one that was not born
 * native: it shipped JavaScript through 11 and a Rust binary from 12, so it is
 * the entry where §02.3's per-band `exec` earns its keep rather than describing
 * a whole tool. It also has the one thing the four above do not — a second name
 * its artifact cannot recognise. `bunx`, `aubx` and `nubx` read `argv[0]`;
 * pnpm's binary reads its own **file name**, which a spawn cannot set, so `pnpx`
 * is §02.4's `binArgs` instead: the `dlx` its own POSIX `pnpx` script injects.
 *
 * The mock publishes under `hostTarget()`, so the suite asserts about whatever
 * host it is running on rather than about Linux.
 *
 * POSIX only, for the reason `15-28-native.test.ts` gives: the artifact has to
 * be a real executable, a `#!/bin/sh` script is one on a POSIX host and is
 * nothing on Windows, and a committed `.exe` is not worth carrying.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

const AUBE_VERSION = "2.2.0";
const NUB_VERSION = "0.7.5";
const PNPM_VERSION = "12.0.0";

const BUN_PACKAGE = `@oven/bun-${BUN_TARGETS[hostTarget()]}`;
const DENO_PACKAGE = `@deno/${DENO_TARGETS[hostTarget()]}`;
/** aube publishes under `hostTarget()` verbatim, musl suffix included. */
const AUBE_PACKAGE = `@endevco/aube-${hostTarget()}`;
/**
 * So does nub, and for a less coincidental reason: its launcher computes
 * `${process.platform}-${process.arch}` and appends `-musl` on a musl Linux,
 * which is `hostTarget()`'s own rule.
 */
const NUB_PACKAGE = `@nubjs/nub-${hostTarget()}`;
/**
 * pnpm's per-host packages are `hostTarget()` verbatim as well, behind a dot
 * rather than a dash: `@pnpm/exe.linux-x64-musl`, not `@pnpm/exe-linux-x64-musl`.
 */
const PNPM_PACKAGE = `@pnpm/exe.${hostTarget()}`;

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

/**
 * aube's per-host packages are the exception to the note above: they *do*
 * declare a `bin`, three names over three hardlinks of one executable. So §07.7
 * reads it, the table's copy is the fallback it is everywhere else, and the two
 * agreeing is part of what row 222 checks.
 */
const AUBE_TARBALL = makeTarball([
  {
    path: "package/package.json",
    content: `${JSON.stringify({
      name: AUBE_PACKAGE,
      version: AUBE_VERSION,
      bin: { aube: "bin/aube", aubr: "bin/aubr", aubx: "bin/aubx" },
    })}\n`,
    mode: 0o644,
  },
  { path: "package/bin/aube", content: PROBE, mode: 0o755 },
  { path: "package/bin/aubr", content: PROBE, mode: 0o755 },
  { path: "package/bin/aubx", content: PROBE, mode: 0o755 },
]);

/**
 * nub's per-host packages are shaped like bun's: no `bin` field, and — since
 * 0.7.0 — one executable rather than one per name. The second copy was dropped
 * because it doubled a ~50 MB artifact, so `bin/nub` is what both `nub` and
 * `nubx` have to reach, under their own `argv[0]`.
 *
 * **Mode 0644, which is what nub really publishes**, and the reason this fixture
 * does not use `artifact()`. npm normalises an extracted file to 0755 only when
 * the package's `bin` names it, and these packages declare no `bin`; nub's own
 * `postinstall` chmods the binary back. jup runs no lifecycle scripts, so §07.4
 * rule 6 — which takes the executable bit *from the tar header* — would cache a
 * file that cannot be executed. Row 227 is where that is not allowed to happen.
 */
/** pnpm's binary sits at the package root, as deno's does, and declares no `bin`. */
const PNPM_TARBALL = artifact(PNPM_PACKAGE, PNPM_VERSION, "pnpm");

const NUB_TARBALL = makeTarball([
  {
    path: "package/package.json",
    content: `${JSON.stringify({ name: NUB_PACKAGE, version: NUB_VERSION })}\n`,
    mode: 0o644,
  },
  { path: "package/bin/nub", content: PROBE, mode: 0o644 },
]);

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
  registry.publish("@endevco/aube", AUBE_VERSION, npmTarball({ "package.json": "{}\n" }), {
    distTags: { latest: AUBE_VERSION },
  });
  registry.publish("@nubjs/nub", NUB_VERSION, npmTarball({ "package.json": "{}\n" }), {
    distTags: { latest: NUB_VERSION },
  });
  // pnpm's launcher is a wrapper package rather than a stub — it carries a
  // `bin` of four placeholder files its `preinstall` overwrites — so it is
  // published here with the `bin` the real one has, to make row 264's assertion
  // that nothing reads it mean something.
  registry.publish(
    "pnpm",
    PNPM_VERSION,
    npmTarball({
      "package.json": `${JSON.stringify({
        name: "pnpm",
        version: PNPM_VERSION,
        bin: { pnpm: "pnpm", pn: "pn", pnpx: "pnpx", pnx: "pnx" },
      })}\n`,
      pnpm: "This is a placeholder.\n",
    }),
    { distTags: { latest: PNPM_VERSION } },
  );

  // The artifacts, which is where §06 asks what the bytes should be.
  registry.publish(BUN_PACKAGE, BUN_VERSION, BUN_TARBALL);
  registry.publish(DENO_PACKAGE, DENO_VERSION, DENO_TARBALL);
  registry.publish(AUBE_PACKAGE, AUBE_VERSION, AUBE_TARBALL);
  registry.publish(NUB_PACKAGE, NUB_VERSION, NUB_TARBALL);
  registry.publish(PNPM_PACKAGE, PNPM_VERSION, PNPM_TARBALL);
});

afterAll(async () => {
  cleanupFixtures();
  if (POSIX) await registry.stop();
});

describe.skipIf(!POSIX)("§03.1 bun, deno, aube, nub and pnpm 12", () => {
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

    // §06.1's strict mode: a signature must exist and verify, or the install
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
      "jup.lock",
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

    const before = fixture.read("jup.lock");

    // An ordinary run takes the recorded version, verifies its own download
    // through npm's signature (§06.3) — the tier a native artifact always has —
    // and writes nothing: §04.4 leaves the project's file to `use` and `up`.
    expect((await run(["bun", "--version"], options(fixture))).exitCode).toBe(0);
    expect(fixture.read("jup.lock")).toBe(before);

    // Recording this host's digest is what `use` is for, and it is additive.
    expect((await run(["use", "bun@^1.4.0"], options(fixture))).exitCode).toBe(0);

    const lock = fixture.json("jup.lock") as {
      resolutions: Record<string, { resolved: string; integrity: Record<string, string> }>;
    };
    const entry = lock.resolutions["bun@^1.4.0"]!;
    expect(entry.resolved).toBe(BUN_VERSION);
    // Ours added, theirs untouched: the version is a shared decision, the digest
    // is not, and a run on one host must not invalidate the record for another.
    expect(entry.integrity["some-other-host"]).toBe("sha512-theirs");
    expect(entry.integrity[hostTarget()]).toMatch(/^sha512-/);
    // And the field keeps the range it declared.
    expect((fixture.json("package.json") as { packageManager: string }).packageManager).toBe(
      "bun@^1.4.0",
    );
  });

  it("220: the default-version lookup pins no digest, because the launcher's is the wrong one", async () => {
    // No project at all, so §04.6 decides — the one path that asks the registry
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

  it("221: a recorded default carrying a digest heals on read, offline", async () => {
    // The other end of row 220. That row proves a *fresh* record never gains a
    // digest; this one is about the records an earlier build already wrote —
    // `lastKnownGood.json` is derived state that outlives a release, and the
    // entry it left is returned by §04.6 step 1 with no network, ahead of every
    // guard downstream. So a machine that ran the broken build stays broken
    // forever unless the read itself repairs it.
    const fixture = createFixture();

    // Warm the store first, so what follows is about resolution rather than
    // download: step 1 is the offline path, and the row's claim is that it
    // stays offline.
    expect(
      (await run(["deno", "task", "warm"], options(fixture, { COREPACK_DEFAULT_TO_LATEST: "1" })))
        .exitCode,
    ).toBe(0);

    // Now the file the broken build would have left: the launcher package's
    // digest, pinned onto a per-host reference it does not describe.
    writeFileSync(
      join(fixture.home, "lastKnownGood.json"),
      `${JSON.stringify(
        {
          deno: `${DENO_VERSION}+sha512.26dfc0709884aed516f64ac6c25c140ec9b572836d99fb61890e09b52085f893`,
          // Untouched: pnpm ships one tarball for every host, so its digest is
          // true everywhere. The repair is per-host or it is a blanket suffix
          // strip that breaks the entries that were right.
          pnpm: "10.0.0+sha512.abcd",
        },
        undefined,
        2,
      )}\n`,
    );
    registry.reset();

    // No `COREPACK_DEFAULT_TO_LATEST` this time: the record is what answers.
    const result = await run(["deno", "task", "build"], options(fixture));

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ran=deno args=task build");
    // Healing must not turn the offline path into an online one, which is the
    // whole point of step 1.
    expect(registry.requests).toEqual([]);

    // Paid once, not on every run — and `info` stops reporting a digest that
    // means nothing.
    expect(JSON.parse(readFileSync(join(fixture.home, "lastKnownGood.json"), "utf8"))).toEqual({
      deno: DENO_VERSION,
      pnpm: "10.0.0+sha512.abcd",
    });
  });

  it("218: a bare `enable` leaves the bun and deno names alone; naming them takes them", async () => {
    const fixture = createFixture({ name: "app" });
    const shims = join(fixture.root, "shims");

    expect((await run(["enable", "--install-directory", shims], options(fixture))).exitCode).toBe(
      0,
    );
    // §10.7 still shims everything else, npm included.
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

  it("222: installs aube's host package, whose own `bin` the table agrees with", async () => {
    const fixture = createFixture({ name: "app", packageManager: `aube@${AUBE_VERSION}` });
    registry.reset();

    const result = await run(["aube", "install", "--prod"], options(fixture));

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ran=aube args=install --prod");

    // The launcher is a `preinstall` stub that shells out to `npm install`; jup
    // runs no lifecycle scripts, so caching it would cache something inert.
    const fetched = registry.requests.map((request) => request.path);
    expect(fetched.some((path) => path.includes(`${AUBE_PACKAGE}/-/`))).toBe(true);
    expect(fetched.some((path) => path.includes("/@endevco/aube/-/"))).toBe(false);

    // §07.7 — unlike bun's and deno's, this package declares its own `bin`, so
    // the marker records what the *package* said, and the table's copy did not
    // have to be right for the run to work. It is anyway.
    expect(JSON.parse(readMarker(fixture, "aube", AUBE_VERSION)).bin).toEqual({
      aube: "bin/aube",
      aubr: "bin/aubr",
      aubx: "bin/aubx",
    });
  });

  it("223: `aubr` and `aubx` reach the same install under their own argv[0]", async () => {
    const fixture = createFixture({ name: "app", packageManager: `aube@${AUBE_VERSION}` });

    // `aubr` is `aube run` and needs the project; `aubx` is `aube dlx` and is
    // transparent (§01.4). Both are the same executable three hardlinks over,
    // and both must arrive with the name the user typed.
    expect((await run(["aubr", "build"], options(fixture))).stdout.trim()).toBe(
      "ran=aubr args=build",
    );
    expect((await run(["aubx", "cowsay", "hi"], options(fixture))).stdout.trim()).toBe(
      "ran=aubx args=cowsay hi",
    );
  });

  it("224: a bare `enable` claims aube's names, because aube is not a runtime", async () => {
    const fixture = createFixture({ name: "app" });
    const shims = join(fixture.root, "shims");

    expect((await run(["enable", "--install-directory", shims], options(fixture))).exitCode).toBe(
      0,
    );
    // The line §03.1 draws is runtime-versus-package-manager, not old-versus-new:
    // `aube`, `aubr` and `aubx` mean nothing outside a project, so they belong to
    // the default set exactly as `pnpm` and `pnpx` do.
    expect(exists(join(shims, "aube"))).toBe(true);
    expect(exists(join(shims, "aubr"))).toBe(true);
    expect(exists(join(shims, "aubx"))).toBe(true);
    expect(exists(join(shims, "bun"))).toBe(false);
    expect(exists(join(shims, "deno"))).toBe(false);
  });

  it("227, 229: runs nub's host package, whose one 0644 executable answers to both names", async () => {
    const fixture = createFixture({ name: "app", packageManager: `nub@${NUB_VERSION}` });
    registry.reset();

    expect((await run(["nub", "install"], options(fixture))).stdout.trim()).toBe(
      "ran=nub args=install",
    );

    // `@nubjs/nub` is a Node launcher that resolves an `optionalDependencies`
    // entry and spawns what is inside it; jup resolves no dependency graph, so
    // it goes to the per-host package and never fetches the launcher.
    const fetched = registry.requests.map((request) => request.path);
    expect(fetched.some((path) => path.includes(`${NUB_PACKAGE}/-/`))).toBe(true);
    expect(fetched.some((path) => path.includes("/@nubjs/nub/-/"))).toBe(false);

    // One file, two names — the artifact declares no `bin`, so §07.7 has nothing
    // to read and the marker records the table's answer, which points both names
    // at the single executable the package actually ships.
    expect(JSON.parse(readMarker(fixture, "nub", NUB_VERSION)).bin).toEqual({
      nub: "./bin/nub",
      nubx: "./bin/nub",
    });

    // The run above already proves it, but this is the assertion that names the
    // reason: the tarball ships `bin/nub` at 0644 and a native band's declared
    // entry points are made executable on the way into the store (§07.4 rule 6).
    // Nothing else in the archive is: `package.json` keeps the mode it came with
    // — it is not in `bin`, and it does not begin like a program either, which
    // is the bound `15-28-native.test.ts` row 193 depends on.
    const installed = join(fixture.home, "v1", "nub", NUB_VERSION);
    expect(statSync(join(installed, "bin", "nub")).mode & 0o111).not.toBe(0);
    expect(statSync(join(installed, "package.json")).mode & 0o111).toBe(0);
    // `nubx` reaches that same file. The probe reports `nub` because `$0` in a
    // `#!/bin/sh` artifact is the script path rather than `argv[0]` — which is
    // the point: there is only one script, and the real `argv[0]` handover is
    // asserted in `test/unit/exec.test.ts` against an artifact that can see it.
    expect((await run(["nubx", "vitest", "--run"], options(fixture))).stdout.trim()).toBe(
      "ran=nub args=vitest --run",
    );
  });

  it("228: a bare `enable` leaves nub alone; naming it installs both names", async () => {
    const fixture = createFixture({ name: "app" });
    const shims = join(fixture.root, "shims");

    expect((await run(["enable", "--install-directory", shims], options(fixture))).exitCode).toBe(
      0,
    );
    // nub is a package manager — `nub install` is pnpm-compatible — and is still
    // out of the default set, which is what pins down what §10.7's flag means.
    // It is not category and not recency: `nub server.ts` runs a file, so the
    // name means something outside a project and usually belongs to an install
    // the user chose. aube, in the same bare `enable`, is claimed.
    expect(exists(join(shims, "nub"))).toBe(false);
    expect(exists(join(shims, "nubx"))).toBe(false);
    expect(exists(join(shims, "aube"))).toBe(true);

    expect(
      (await run(["enable", "nub", "--install-directory", shims], options(fixture))).exitCode,
    ).toBe(0);
    expect(exists(join(shims, "nub"))).toBe(true);
    expect(exists(join(shims, "nubx"))).toBe(true);

    // And a bare `disable` covers the opt-out, as it does for bun (row 218).
    expect((await run(["disable", "--install-directory", shims], options(fixture))).exitCode).toBe(
      0,
    );
    expect(exists(join(shims, "nub"))).toBe(false);
  });

  it("264: pnpm 12 comes from `@pnpm/exe.<host>`, never from the wrapper it publishes", async () => {
    const fixture = createFixture({ name: "app", packageManager: `pnpm@${PNPM_VERSION}` });
    registry.reset();

    const result = await run(["pnpm", "install", "--frozen-lockfile"], options(fixture));

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("ran=pnpm args=install --frozen-lockfile");

    // The `pnpm` package is fetched for its versions and never for its bytes.
    // What it ships under its own `bin` is a placeholder its `preinstall`
    // overwrites, and jup runs no lifecycle scripts: installing it would cache
    // the sentence "This is a placeholder" and hand it to the runtime.
    const fetched = registry.requests.map((request) => request.path);
    expect(fetched.some((path) => path.includes(`${PNPM_PACKAGE}/-/`))).toBe(true);
    expect(fetched.some((path) => path.includes("/pnpm/-/"))).toBe(false);

    // The marker records the table's `bin`, because the artifact declares none —
    // and both names point at the one executable the package ships.
    expect(JSON.parse(readMarker(fixture, "pnpm", PNPM_VERSION)).bin).toEqual({
      pnpm: "./pnpm",
      pnpx: "./pnpm",
    });
  });

  it("265: `pnpx` reaches that same binary with `dlx` in front (§02.4 `binArgs`)", async () => {
    const fixture = createFixture({ name: "app", packageManager: `pnpm@${PNPM_VERSION}` });

    const result = await run(["pnpx", "cowsay", "moo"], options(fixture));

    expect(result.exitCode).toBe(0);
    // `bunx` and `nubx` get this from `argv[0]`; pnpm's binary reads its own file
    // name instead, which is why its own installer hardlinks a second file on
    // Windows and ships `exec pnpm dlx "$@"` on POSIX. The band says the same
    // thing in the table, so the subcommand arrives in the argv and the probe
    // reports the one file it was.
    expect(result.stdout.trim()).toBe("ran=pnpm args=dlx cowsay moo");
  });
});

/* -------------------------------------------------------------------------- */

function readMarker(fixture: Fixture, name: string, version: string): string {
  return readFileSync(join(fixture.home, "v1", name, version, ".jup"), "utf8");
}

function exists(path: string): boolean {
  return existsSync(path);
}
