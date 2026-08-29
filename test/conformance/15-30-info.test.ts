/**
 * §09.9 — `corepack info` (row 196), and §12.6's `cache list` (row 179).
 *
 * Both rows are about a command that has to work when nothing else does, so
 * every case here is asserted through a real process:
 *
 * * **No network, ever.** The mock registry is wired in for every run and its
 *   request log must come back empty — including for a project whose spec could
 *   only be resolved by asking it.
 * * **No failure on a broken project.** Every invalid-spec shape §03 and §12
 *   define is exercised, and each must exit 0 carrying the diagnosis.
 *
 * §07.9's `cache clean --all` rides along (row 177): it is the one other
 * command that touches the recorded defaults.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  copyTool,
  createFixture,
  MockRegistry,
  run,
  seedPackageManager,
} from "./_harness/index.ts";

const registry = new MockRegistry();

/**
 * §09.9 reports the shim a `PATH` lookup actually turns up. On Windows that is
 * §10.4's `.cmd` wrapper: `PATHEXT` never contains the empty extension, so the
 * extensionless `<B>` beside it — the one Git Bash runs — is not what `cmd.exe`
 * or PowerShell would find. Spelled in capitals because `PATHEXT` is: the
 * lookup returns the candidate it built, not the name on disk, and Windows
 * paths are case-insensitive so the two are one file.
 */
const SHIM_ON_PATH = process.platform === "win32" ? ".CMD" : "";

interface Report {
  version: number;
  tool: { name: string; version: string; root: string };
  project: {
    status: string;
    manifest: string | null;
    field: string | null;
    spec: string | null;
    kind: string | null;
    problem: string | null;
  };
  resolution: {
    status: string;
    name: string | null;
    version: string | null;
    hash: string | null;
    source: string | null;
    reason: string | null;
    installed: boolean | null;
  };
  lockfile: {
    path: string;
    present: boolean;
    key: string | null;
    resolution: { resolved: string; integrity?: string } | null;
    frozen: boolean;
    frozenSource: string;
    cache: {
      path: string;
      present: boolean;
      resolution: { resolved: string; expires?: number } | null;
      expired: boolean;
    };
  };
  envFile: {
    path: string;
    applied: string[];
    overridden: string[];
    refused: string[];
    ignored: string[];
  } | null;
  environment: Record<string, string>;
  packageManagers: Array<{
    name: string;
    registry: string;
    registrySource: string;
    recordedDefault: string | null;
    cached: string[];
  }>;
  npmrc: {
    files: Array<{ path: string; level: string; keys: string[]; refused: string[] }>;
    registry: { value: string; source: string } | null;
    scopes: Array<{ scope: string; value: string; source: string }>;
    auth: Array<{ prefix: string; type: string; source: string }>;
  };
  tls: {
    cafile: string | null;
    cafileSource: string | null;
    verify: boolean;
    verifySource: string | null;
  };
  store: { home: string; path: string; writable: boolean; versions: Array<Record<string, string>> };
  defaults: { path: string; entries: Record<string, string> };
  shims: { directory: string | null; entries: Array<Record<string, unknown>> };
}

beforeAll(async () => {
  await registry.start();
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

/** `info --json`, parsed, with the exit code and streams asserted. */
async function info(
  fixture: { cwd: string; home: string },
  options?: { env?: Record<string, string | undefined>; cwd?: string },
): Promise<Report> {
  const result = await run(["info", "--json"], {
    ...fixture,
    ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
    registry,
    env: options?.env,
  });

  expect(result.exitCode).toBe(0);
  // Row 196's load-bearing half: not one request, whatever the project says.
  expect(registry.requests).toEqual([]);
  return JSON.parse(result.stdout) as Report;
}

describe("§09.9 corepack info", () => {
  it("196: reports the file, the field and the resolution, and makes no request", async () => {
    const fixture = createFixture({ packageManager: "pnpm@11.1.2+sha512.abcd" });
    seedPackageManager(fixture.home, "pnpm", "11.1.2");

    const report = await info(fixture);

    expect(report.version).toBe(1);
    expect(report.tool.name).toBe("jup");
    expect(report.project).toMatchObject({
      status: "found",
      // Absolute (§09.9): a relative path is useless in a pasted report.
      manifest: join(fixture.cwd, "package.json"),
      field: "packageManager",
      spec: "pnpm@11.1.2+sha512.abcd",
      kind: "exact",
    });
    expect(report.resolution).toMatchObject({
      status: "pinned",
      name: "pnpm",
      version: "11.1.2",
      hash: "sha512.abcd",
      installed: true,
    });
    expect(report.store.path).toBe(join(fixture.home, "v1"));
    expect(report.store.versions).toEqual([{ name: "pnpm", version: "11.1.2" }]);
  });

  it("196: succeeds and diagnoses every invalid project spec §03/§12 defines", async () => {
    const cases: Array<[label: string, manifest: unknown, expected: RegExp]> = [
      ["a missing version", { packageManager: "pnpm" }, /No version specified/],
      ["a malformed field", { packageManager: "pnpm@" }, /No version specified/],
      ["an unsupported name", { packageManager: "vlt@1.0.0" }, /Unsupported package manager/],
      ["a wrong type", { packageManager: 42 }, /expected a string/],
      ["a null pin", { packageManager: null }, /expected a string/],
      ["unparseable JSON", "{ not json", /Invalid package\.json/],
      [
        "a devEngines name mismatch",
        {
          packageManager: "yarn@1.22.4",
          devEngines: { packageManager: { name: "pnpm", version: "11.x" } },
        },
        /does not match the "devEngines\.packageManager" field/,
      ],
      [
        "a devEngines version mismatch",
        {
          packageManager: "pnpm@11.1.2",
          devEngines: { packageManager: { name: "pnpm", version: "10.x" } },
        },
        /does not match the value defined in "devEngines\.packageManager"/,
      ],
      [
        "an unsupported package manager in devEngines",
        { devEngines: { packageManager: { name: "vlt", version: "1.x" } } },
        /Unsupported package manager/,
      ],
    ];

    for (const [label, manifest, expected] of cases) {
      const fixture = createFixture(manifest);
      registry.reset();

      const result = await run(["info", "--json"], { ...fixture, registry });

      // Exit 0 in every one of them: reporting *why* the project is invalid is
      // the point of the command, and failing the way every other command
      // already fails would make it useless in exactly this case.
      expect(result.exitCode, label).toBe(0);
      expect(registry.requests, label).toEqual([]);

      const report = JSON.parse(result.stdout) as Report;
      expect(report.project.status, label).toBe("invalid");
      expect(report.project.problem ?? "", label).toMatch(expected);
      expect(report.project.manifest, label).toBe(join(fixture.cwd, "package.json"));
      expect(report.resolution.status, label).toBe("unknown");
    }
  });

  it("196: prints the same diagnosis in the human form", async () => {
    const fixture = createFixture({ packageManager: "pnpm" });

    const result = await run(["info"], { ...fixture, registry });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("status          invalid");
    expect(result.stdout).toContain("No version specified");
    expect(result.stdout).toContain(join(fixture.cwd, "package.json"));
    expect(registry.requests).toEqual([]);
  });

  it("196: reports a range as unresolved rather than resolving it (§04.4)", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });

    const report = await info(fixture, { env: { CI: undefined } });

    expect(report.project.kind).toBe("range");
    expect(report.project.spec).toBe("pnpm@^11.0.0");
    expect(report.lockfile).toMatchObject({
      path: join(fixture.cwd, "jup.lock"),
      present: false,
      key: "pnpm@^11.0.0",
      resolution: null,
    });
    expect(report.resolution.status).toBe("network");
    expect(report.resolution.version).toBeNull();
    expect(report.resolution.reason).toContain("needs a registry request");
  });

  it("196: reports the recorded resolution, its integrity, and the lockfile path", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });
    seedPackageManager(fixture.home, "pnpm", "11.1.2");
    fixture.write(
      "jup.lock",
      `${JSON.stringify({
        version: 1,
        resolutions: { "pnpm@^11.0.0": { resolved: "11.1.2", integrity: "sha512-AQI=" } },
      })}\n`,
    );

    const report = await info(fixture);

    expect(report.lockfile).toMatchObject({
      path: join(fixture.cwd, "jup.lock"),
      present: true,
      key: "pnpm@^11.0.0",
      resolution: { resolved: "11.1.2", integrity: "sha512-AQI=" },
    });
    expect(report.resolution).toMatchObject({
      status: "locked",
      version: "11.1.2",
      hash: "sha512.0102",
      source: join(fixture.cwd, "jup.lock"),
      installed: true,
    });
  });

  it("196: reports the frozen-lockfile state and where it came from", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });

    // §04.4 — CI no longer freezes anything on its own: with no implicit write
    // left to guard, the only writers are `use` and `up`, and only an explicit
    // `1` stops them.
    const ci = await info(fixture, { env: { CI: "1" } });
    expect(ci.lockfile).toMatchObject({ frozen: false, frozenSource: "default" });

    const explicit = await info(fixture, { env: { COREPACK_FROZEN_LOCKFILE: "1" } });
    expect(explicit.lockfile).toMatchObject({
      frozen: true,
      frozenSource: "COREPACK_FROZEN_LOCKFILE",
    });
  });

  it("196: reports the memo in node_modules/.jup, and whether it still stands", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });
    seedPackageManager(fixture.home, "pnpm", "11.1.2");
    fixture.write(
      "node_modules/.jup/jup.lock",
      `${JSON.stringify({
        version: 1,
        resolutions: {
          "pnpm@^11.0.0": { resolved: "11.1.2", expires: Date.now() + 60_000 },
        },
      })}\n`,
    );

    const report = await info(fixture);

    expect(report.lockfile.cache).toMatchObject({
      path: join(fixture.cwd, "node_modules", ".jup", "jup.lock"),
      present: true,
      expired: false,
    });
    expect(report.resolution).toMatchObject({
      status: "cached",
      version: "11.1.2",
      source: join(fixture.cwd, "node_modules", ".jup", "jup.lock"),
      installed: true,
    });
  });

  it("196: reports neither file when its entry no longer satisfies the range", async () => {
    // §04.4 — a recorded resolution or a memo that has fallen outside its range
    // is skipped by the run, which resolves around it. `info` reports what the
    // next run would use, so it has to apply the same gate: a hand edit, a bad
    // merge or a restored `node_modules` must not make this command name a
    // version the very next invocation refuses.
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });
    seedPackageManager(fixture.home, "pnpm", "10.0.0");
    fixture.write(
      "jup.lock",
      `${JSON.stringify({
        version: 1,
        resolutions: { "pnpm@^11.0.0": { resolved: "10.0.0" } },
      })}\n`,
    );
    fixture.write(
      "node_modules/.jup/jup.lock",
      `${JSON.stringify({
        version: 1,
        resolutions: {
          "pnpm@^11.0.0": { resolved: "10.0.0", expires: Date.now() + 60_000 },
        },
      })}\n`,
    );

    const report = await info(fixture);

    // Both files are present and both are keyed correctly; neither holds an
    // answer, and the honest report is that resolving needs a request.
    expect(report.lockfile).toMatchObject({ present: true, resolution: null });
    expect(report.lockfile.cache).toMatchObject({ present: true, resolution: null });
    expect(report.resolution.status).toBe("network");
    expect(report.resolution.version).toBeNull();
  });

  it("196: finds the lockfile beside the manifest, from a nested directory", async () => {
    const fixture = createFixture({ packageManager: "pnpm@^11.0.0" });
    fixture.write("packages/app/keep.txt", "");
    fixture.write(
      "jup.lock",
      `${JSON.stringify({ version: 1, resolutions: { "pnpm@^11.0.0": { resolved: "11.1.2" } } })}\n`,
    );

    const report = await info(fixture, { cwd: fixture.path("packages/app") });

    expect(report.project.manifest).toBe(join(fixture.cwd, "package.json"));
    expect(report.lockfile.path).toBe(join(fixture.cwd, "jup.lock"));
    expect(report.resolution.version).toBe("11.1.2");
  });

  it("196: names the env file and the variables it contributed", async () => {
    const fixture = createFixture({ packageManager: "pnpm@11.1.2" });
    fixture.write(
      ".jup.env",
      [
        "COREPACK_ENABLE_STRICT=0",
        "COREPACK_NPM_REGISTRY=https://from-the-file.example.org",
        "COREPACK_NPM_TOKEN=hunter2",
        "SHELL=/bin/false",
        "",
      ].join("\n"),
    );

    const report = await info(fixture, {
      env: { COREPACK_NPM_REGISTRY: "https://from-the-environment.example.org" },
    });

    expect(report.envFile).toMatchObject({
      path: join(fixture.cwd, ".jup.env"),
      applied: ["COREPACK_ENABLE_STRICT"],
      // §11.6 — the real environment wins over the file.
      overridden: ["COREPACK_NPM_REGISTRY"],
      // §03.2 — a project file may never supply a credential.
      refused: ["COREPACK_NPM_TOKEN"],
      ignored: ["SHELL"],
    });
    // And the credential never appears anywhere in the report.
    expect(JSON.stringify(report)).not.toContain("hunter2");
  });

  it("196: reports the effective registry for each package manager and its source", async () => {
    const fixture = createFixture({ packageManager: "pnpm@11.1.2" });

    const builtin = await info(fixture);
    for (const entry of builtin.packageManagers) {
      expect(entry.registry).toBe("https://registry.npmjs.org");
      expect(entry.registrySource).toBe("built-in");
    }
    // §05.3 — no `.npmrc` is in scope for this fixture, and the report says so
    // by listing nothing rather than by implying anything.
    expect(builtin.npmrc.registry).toBeNull();
    expect(builtin.npmrc.auth).toEqual([]);

    const mirrored = await info(fixture, {
      env: { COREPACK_NPM_REGISTRY: "https://mirror.example.org/" },
    });
    for (const entry of mirrored.packageManagers) {
      expect(entry.registry).toBe("https://mirror.example.org");
      expect(entry.registrySource).toBe("COREPACK_NPM_REGISTRY");
    }
  });

  it("196: reports the store, its writability, and the recorded global defaults", async () => {
    const fixture = createFixture({ packageManager: "pnpm@11.1.2" });
    seedPackageManager(fixture.home, "pnpm", "11.1.2");
    seedPackageManager(fixture.home, "yarn", "1.22.4");
    writeFileSync(join(fixture.home, "lastKnownGood.json"), `{"yarn":"1.22.4"}\n`);

    const report = await info(fixture);

    expect(report.store).toMatchObject({ home: fixture.home, writable: true });
    expect(report.store.versions).toEqual([
      { name: "pnpm", version: "11.1.2" },
      { name: "yarn", version: "1.22.4" },
    ]);
    expect(report.defaults).toEqual({
      path: join(fixture.home, "lastKnownGood.json"),
      entries: { yarn: "1.22.4" },
    });
    expect(report.packageManagers.find((entry) => entry.name === "yarn")?.recordedDefault).toBe(
      "1.22.4",
    );
  });

  it("196: reports, for each binary name, the shim and what PATH resolves to", async () => {
    const fixture = createFixture({ packageManager: "pnpm@11.1.2" });
    // A real `enable` against a copy of the tool, so the shims under test are
    // the ones the tool actually writes (§10.1).
    const bin = copyTool();
    const shimDirectory = join(fixture.root, "shims");
    mkdirSync(shimDirectory, { recursive: true });
    expect(
      (await run(["enable", "--install-directory", shimDirectory], { ...fixture, bin })).exitCode,
    ).toBe(0);

    const report = await info(fixture, {
      env: { PATH: `${shimDirectory}${delimiter}${process.env.PATH ?? ""}` },
    });

    expect(report.shims.entries.map((entry) => entry.binary)).toEqual([
      "npm",
      "npx",
      "pnpm",
      "pnpx",
      "yarn",
      "yarnpkg",
      // §02.5 — reported, but not installed by a bare `enable`; the assertions
      // below check exactly that asymmetry.
      "bun",
      "bunx",
      "deno",
      // §03.1's aube is per-host too and is *not* in that group: it is a
      // package manager, so a bare `enable` claims its names like any other.
      "aube",
      "aubr",
      "aubx",
      // §03.1's nub is back in the first group, and is why that group is not
      // "the runtimes": nub is a package manager *and* a runtime, and what
      // decides is that `nub` names something outside a project (§10.7).
      "nub",
      "nubx",
      // §02.3 — a runtime is never in the default set (§10.7 requires it), so
      // `node` joins the reported-but-not-installed group with bun and deno.
      "node",
    ]);

    // §02.5 / §10.7 — `enable` with no names left these alone, so the report
    // shows no shim for them while still showing the name.
    const bun = report.shims.entries.find((entry) => entry.binary === "bun")!;
    expect(bun.shim).toBeNull();
    const aubx = report.shims.entries.find((entry) => entry.binary === "aubx")!;
    expect(aubx.shim).toBe(join(shimDirectory, `aubx${SHIM_ON_PATH}`));
    const nubx = report.shims.entries.find((entry) => entry.binary === "nubx")!;
    expect(nubx.shim).toBeNull();

    const yarn = report.shims.entries.find((entry) => entry.binary === "yarn")!;
    expect(yarn.shim).toBe(join(shimDirectory, `yarn${SHIM_ON_PATH}`));
    expect(yarn.path).toBe(join(shimDirectory, `yarn${SHIM_ON_PATH}`));
    expect(yarn.ours).toBe(true);
    expect(yarn.shadowed).toBe(false);

    // §10.7 redirected this row: `enable` with no names now shims npm too, so
    // the report must show it. `--exclude npm` is what leaves it absent.
    const npm = report.shims.entries.find((entry) => entry.binary === "npm")!;
    expect(npm.shim).toBe(join(shimDirectory, `npm${SHIM_ON_PATH}`));

    expect(
      (
        await run(["disable", "--install-directory", shimDirectory, "--exclude", "yarn"], {
          ...fixture,
          bin,
        })
      ).exitCode,
    ).toBe(0);
    const after = await info(fixture, {
      env: { PATH: `${shimDirectory}${delimiter}${process.env.PATH ?? ""}` },
    });
    expect(after.shims.entries.find((entry) => entry.binary === "npm")!.shim).toBeNull();
    expect(after.shims.entries.find((entry) => entry.binary === "yarn")!.shim).toBe(
      join(shimDirectory, `yarn${SHIM_ON_PATH}`),
    );
  });

  it("196: --json and the human form describe the same run", async () => {
    const fixture = createFixture({ packageManager: "pnpm@11.1.2+sha512.abcd" });

    const human = await run(["info"], { ...fixture, registry });
    const json = await run(["info", "--json"], { ...fixture, registry });

    expect(human.exitCode).toBe(0);
    expect(json.exitCode).toBe(0);
    const report = JSON.parse(json.stdout) as Report;
    expect(human.stdout).toContain(report.project.manifest!);
    expect(human.stdout).toContain("11.1.2");
    expect(human.stdout).toContain("sha512.abcd");
    expect(registry.requests).toEqual([]);
  });

  it("rejects an unrecognised flag", async () => {
    const fixture = createFixture({ packageManager: "pnpm@11.1.2" });

    const result = await run(["info", "--everything"], { ...fixture, registry });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(`Usage Error: The 'jup info' command only accepts --json`);
    expect(result.stdout).toContain(`$ jup info [--json]`);
  });
});

/* -------------------------------------------------------------------------- */
/* §12.6 — cache list, and §07.9 — cache clean --all                         */
/* -------------------------------------------------------------------------- */

describe("§12.6 cache list", () => {
  it("179: --json lists the installed pairs and the recorded defaults", async () => {
    const fixture = createFixture();
    seedPackageManager(fixture.home, "pnpm", "11.1.2");
    seedPackageManager(fixture.home, "yarn", "1.22.4");
    writeFileSync(join(fixture.home, "lastKnownGood.json"), `{"yarn":"1.22.4"}\n`);

    const result = await run(["cache", "list", "--json"], { ...fixture, registry });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      version: 1,
      store: {
        home: fixture.home,
        path: join(fixture.home, "v1"),
        writable: true,
        versions: [
          { name: "pnpm", version: "11.1.2" },
          { name: "yarn", version: "1.22.4" },
        ],
      },
      defaults: {
        path: join(fixture.home, "lastKnownGood.json"),
        entries: { yarn: "1.22.4" },
      },
    });
    expect(registry.requests).toEqual([]);
  });

  it("179: lists the same pairs in the human form, and says so when there are none", async () => {
    const seeded = createFixture();
    seedPackageManager(seeded.home, "pnpm", "11.1.2");

    const listed = await run(["cache", "list"], { ...seeded, registry });
    expect(listed.exitCode).toBe(0);
    expect(listed.stdout).toContain("pnpm@11.1.2");

    const empty = await run(["cache", "list"], { ...createFixture(), registry });
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toContain("(none)");
    expect(empty.stdout).toContain("(none recorded)");
  });
});

describe("§07.9 cache clean --all", () => {
  it("177: the defaults survive a plain clean and are removed by --all", async () => {
    const fixture = createFixture();
    seedPackageManager(fixture.home, "pnpm", "11.1.2");
    writeFileSync(join(fixture.home, "lastKnownGood.json"), `{"pnpm":"11.1.2"}\n`);

    const first = await run(["cache", "clean"], { ...fixture, registry });
    expect(first.exitCode).toBe(0);
    expect(existsSync(join(fixture.home, "v1"))).toBe(false);
    // §06.1 — a recorded default is a preference, not a cache entry.
    expect(existsSync(join(fixture.home, "lastKnownGood.json"))).toBe(true);

    const second = await run(["cache", "clean", "--all"], { ...fixture, registry });
    expect(second.exitCode).toBe(0);
    expect(existsSync(join(fixture.home, "lastKnownGood.json"))).toBe(false);
    // §12.11 — a command that deletes things must say what it deleted.
    expect(second.stdout).toContain("Removed 0 cached version(s) and 1 recorded default(s)");

    const third = await run(["cache", "clean", "--all"], { ...fixture, registry });
    expect(third.exitCode).toBe(0);
    expect(third.stdout).toBe("Nothing to remove\n");
  });

  it("refuses --json on clean rather than ignoring it", async () => {
    const result = await run(["cache", "clean", "--json"], { ...createFixture(), registry });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(
      `Usage Error: The 'jup cache clean' command does not accept --json`,
    );
  });
});
