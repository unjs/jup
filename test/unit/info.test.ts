/**
 * §15.30 — the report builder behind `corepack info`.
 *
 * The conformance rows (`test/conformance/15-30-info.test.ts`) assert the
 * command's observable contract through a real process; these assert the shape
 * of the report itself, which is what the `--json` consumers actually depend on.
 */

import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import { DEFINITIONS } from "../../src/config/table.ts";
import { UsageError } from "../../src/errors.ts";
import {
  buildReport,
  cacheListView,
  classifySpec,
  cmdCacheList,
  cmdInfo,
  effectiveRegistry,
  formatCacheList,
  formatReport,
  INFO_REPORT_VERSION,
  type InfoReport,
} from "../../src/commands/info.ts";
import { discoverProjectSpec } from "../../src/project/manifest.ts";
import { getRegistryUrl } from "../../src/net/registry.ts";
import { resetNpmrcCache } from "../../src/net/npmrc.ts";
import { SHIM_MARKER } from "../../src/commands/shims.ts";
import type { CorepackMarker } from "../../src/types.ts";

const ENV_KEYS = [
  "COREPACK_HOME",
  // §15.1 — the report reads the user and global `.npmrc`, so both tiers are
  // pointed at the fixture. Left alone, every assertion about them would be an
  // assertion about whoever happens to be running the suite.
  "HOME",
  "USERPROFILE",
  "npm_config_prefix",
  "PREFIX",
  // §15.13 — the shim directory is now configurable, so it has to be scrubbed
  // like every other input.
  "COREPACK_SHIM_DIRECTORY",
  "COREPACK_NPM_REGISTRY",
  "COREPACK_NPM_TOKEN",
  "COREPACK_FROZEN_LOCKFILE",
  "COREPACK_ENABLE_STRICT",
  "COREPACK_ENV_FILE",
  "CI",
] as const;

let home: string;
let project: string;
let saved: Record<string, string | undefined>;
let savedEnv: NodeJS.ProcessEnv;
let stdout: string;
let cwdSpy: MockInstance<() => string>;
let fetchSpy: MockInstance<typeof fetch>;

beforeEach(async () => {
  savedEnv = process.env;
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }

  home = await mkdtemp(join(tmpdir(), "jup-info-home-"));
  project = await mkdtemp(join(tmpdir(), "jup-info-proj-"));
  process.env.COREPACK_HOME = home;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.npm_config_prefix = home;
  // The `.npmrc` load is memoised, and its key is the working directory alone —
  // a redirected home does not invalidate it (§15.1).
  resetNpmrcCache();

  stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});

  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(project);

  // Nothing in this module may reach the network (§15.30); every test therefore
  // runs against a `fetch` that fails loudly if it is called at all.
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("info must not perform a network request");
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetNpmrcCache();
  // `applyEnvFile` replaces `process.env` wholesale (§11.6).
  process.env = savedEnv;
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

async function manifest(data: unknown, dir = project): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`,
  );
}

/** A complete install (§07.2): a marker is the whole of what makes one real. */
function seed(name: string, version: string, hash = "sha512.seeded"): string {
  const location = join(home, "v1", name, version);
  mkdirSync(location, { recursive: true });
  const marker: CorepackMarker = {
    locator: { name, reference: `${version}+${hash}` },
    bin: { [name]: `./bin/${name}.js` },
    hash,
  };
  writeFileSync(join(location, ".jup"), JSON.stringify(marker));
  return location;
}

function report(): InfoReport {
  return buildReport();
}

/* ------------------------------------------------------------------ *
 * The project spec
 * ------------------------------------------------------------------ */

describe("buildReport — the project spec (§15.30)", () => {
  it("names the manifest, the field and the spec, with an absolute path", async () => {
    await manifest({ packageManager: "pnpm@11.1.2+sha512.abcd" });
    seed("pnpm", "11.1.2");

    const info = report().project;

    expect(info.status).toBe("found");
    // Absolute, because "which file" is useless as a relative path in a
    // support paste from a directory nobody else has.
    expect(info.manifest).toBe(join(project, "package.json"));
    expect(info.field).toBe("packageManager");
    expect(info.spec).toBe("pnpm@11.1.2+sha512.abcd");
    expect(info.name).toBe("pnpm");
    expect(info.kind).toBe("exact");
    expect(info.problem).toBeNull();
  });

  it("attributes a devEngines-only project to the devEngines field", async () => {
    await manifest({
      devEngines: { packageManager: { name: "pnpm", version: "11.x", onFail: "error" } },
    });

    const info = report().project;

    expect(info.field).toBe("devEngines.packageManager");
    expect(info.spec).toBe("pnpm@11.x");
    expect(info.kind).toBe("range");
    expect(info.devEngines).toEqual({ name: "pnpm", version: "11.x", onFail: "error" });
  });

  it("attributes a non-string packageManager to packageManager, not to devEngines", async () => {
    // `hasPin` is `typeof pm === "string"`, so deriving the field from it names
    // devEngines here — the wrong field, in the report whose job is to name the
    // right one.
    await manifest({
      packageManager: 42,
      devEngines: { packageManager: { name: "pnpm", version: "11.x", onFail: "warn" } },
    });

    const info = report().project;

    expect(info.field).toBe("packageManager");
    expect(info.spec).toBe("42");
    expect(info.status).toBe("invalid");
    expect(info.problem).toContain("expected a string");
  });

  it("reports a project with no spec, and one with no manifest at all", async () => {
    await manifest({ name: "demo" });
    expect(report().project.status).toBe("no-spec");
    expect(report().project.manifest).toBe(join(project, "package.json"));

    await rm(join(project, "package.json"));
    expect(report().project.status).toBe("no-project");
    expect(report().project.manifest).toBeNull();
    expect(report().resolution.status).toBe("fallback");
  });

  it("names the same manifest the real walk selects, from a nested directory", async () => {
    // The error path recomputes §03.1's selection; this pins the recomputation
    // against the walk it mirrors.
    await manifest({ packageManager: "pnpm@11.1.2" });
    const nested = join(project, "packages", "app");
    mkdirSync(nested, { recursive: true });
    await manifest({ name: "app" }, nested);
    cwdSpy.mockReturnValue(nested);

    const lookup = discoverProjectSpec(nested);
    expect(lookup.type).toBe("Found");
    expect(report().project.manifest).toBe(lookup.target);
  });
});

/* ------------------------------------------------------------------ *
 * Every invalid shape §03/§12 defines
 * ------------------------------------------------------------------ */

describe("buildReport — an invalid spec is diagnosed, never thrown (§15.30)", () => {
  const cases: Array<[label: string, manifest: unknown, expected: RegExp]> = [
    ["a missing version", { packageManager: "yarn" }, /No version specified/],
    ["a trailing @", { packageManager: "yarn@" }, /No version specified/],
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
      /does not match the "devEngines.packageManager" field/,
    ],
    [
      "a devEngines version mismatch",
      {
        packageManager: "yarn@1.22.4",
        devEngines: { packageManager: { name: "yarn", version: "2.x" } },
      },
      /does not match the value defined in "devEngines.packageManager"/,
    ],
  ];

  it.for(cases)("diagnoses %s", async ([, data, expected]) => {
    await manifest(data);

    const info = report();

    expect(info.project.status).toBe("invalid");
    expect(info.project.problem).toMatch(expected as RegExp);
    // The manifest is still named: knowing *which* file is broken is half the
    // diagnosis.
    expect(info.project.manifest).toBe(join(project, "package.json"));
    expect(info.resolution.status).toBe("unknown");
    expect(info.resolution.reason).toMatch(expected as RegExp);
  });

  it.for(cases)("exits 0 for %s", async ([, data]) => {
    await manifest(data);

    await expect(cmdInfo([])).resolves.toBe(0);
    await expect(cmdInfo(["--json"])).resolves.toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * Resolution, without a network
 * ------------------------------------------------------------------ */

describe("buildReport — resolution (§15.23, §15.30)", () => {
  it("reads the version and hash straight off an exact pin", async () => {
    await manifest({ packageManager: "pnpm@11.1.2+sha512.abcd" });
    seed("pnpm", "11.1.2");

    const info = report().resolution;

    expect(info).toMatchObject({
      status: "pinned",
      name: "pnpm",
      version: "11.1.2",
      hash: "sha512.abcd",
      installed: true,
    });
    expect(info.source).toBe(`packageManager in ${join(project, "package.json")}`);
    // An exact pin never involves the lockfile at all (§15.23).
    expect(report().lockfile.key).toBeNull();
  });

  it("reports a range as unresolved-without-network rather than resolving it", async () => {
    await manifest({ packageManager: "pnpm@^11.0.0" });

    const info = report();

    expect(info.resolution.status).toBe("network");
    expect(info.resolution.version).toBeNull();
    expect(info.resolution.reason).toContain("needs a registry request");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses a recorded resolution, its integrity, and the lockfile's absolute path", async () => {
    await manifest({ packageManager: "pnpm@^11.0.0" });
    seed("pnpm", "11.1.2");
    await writeFile(
      join(project, ".jup.lock"),
      `${JSON.stringify({
        version: 1,
        // `sha512-AQI=` is the SRI spelling of the bytes `01 02`.
        resolutions: { "pnpm@^11.0.0": { resolved: "11.1.2", integrity: "sha512-AQI=" } },
      })}\n`,
    );

    const info = report();

    expect(info.lockfile).toMatchObject({
      path: join(project, ".jup.lock"),
      present: true,
      key: "pnpm@^11.0.0",
      resolution: { resolved: "11.1.2", integrity: "sha512-AQI=" },
    });
    expect(info.resolution).toMatchObject({
      status: "locked",
      version: "11.1.2",
      hash: "sha512.0102",
      source: join(project, ".jup.lock"),
      installed: true,
    });
  });

  it("says so plainly when the range is frozen and nothing is recorded", async () => {
    await manifest({ packageManager: "pnpm@^11.0.0" });
    process.env.COREPACK_FROZEN_LOCKFILE = "1";

    const info = report();

    expect(info.lockfile.frozen).toBe(true);
    expect(info.lockfile.frozenSource).toBe("COREPACK_FROZEN_LOCKFILE");
    expect(info.resolution.status).toBe("frozen");
    expect(info.resolution.reason).toContain("lockfile updates are disabled");
  });

  it("attributes the CI default, and honours an explicit thaw inside CI", async () => {
    await manifest({ packageManager: "pnpm@^11.0.0" });
    process.env.CI = "1";
    expect(report().lockfile).toMatchObject({ frozen: true, frozenSource: "CI" });

    process.env.COREPACK_FROZEN_LOCKFILE = "0";
    expect(report().lockfile).toMatchObject({
      frozen: false,
      frozenSource: "COREPACK_FROZEN_LOCKFILE",
    });
  });

  it("falls back to the cache probe, which is what a real run would do next", async () => {
    // §04.1 step 4 runs before the registry, so an installed version satisfying
    // the range still answers offline even with nothing recorded.
    await manifest({ packageManager: "pnpm@^11.0.0" });
    seed("pnpm", "11.0.5");

    const info = report().resolution;

    expect(info.status).toBe("cache");
    expect(info.version).toBe("11.0.5");
    expect(info.installed).toBe(true);
  });

  it("classifies every spec form", () => {
    expect(classifySpec({ name: "pnpm", range: "11.1.2" })).toBe("exact");
    expect(classifySpec({ name: "pnpm", range: "^11.0.0" })).toBe("range");
    expect(classifySpec({ name: "pnpm", range: "latest" })).toBe("tag");
    expect(classifySpec({ name: "pnpm", range: "https://example.org/p.tgz" })).toBe("url");
  });

  it("treats a dist-tag pin as lockfile-governed", async () => {
    await manifest({ packageManager: "pnpm@latest" });

    const info = report();

    expect(info.project.kind).toBe("tag");
    expect(info.lockfile.key).toBe("pnpm@latest");
    expect(info.resolution.status).toBe("network");
  });
});

/* ------------------------------------------------------------------ *
 * The env file and the environment
 * ------------------------------------------------------------------ */

describe("buildReport — the env file (§03.2, §15.30)", () => {
  it("sorts every line into applied, overridden, refused and ignored", async () => {
    await manifest({ packageManager: "pnpm@11.1.2" });
    await writeFile(
      join(project, ".jup.env"),
      [
        "COREPACK_ENABLE_STRICT=0",
        "COREPACK_NPM_REGISTRY=https://mirror.example.org",
        "COREPACK_NPM_TOKEN=hunter2",
        "PATH=/nope",
        "",
      ].join("\n"),
    );
    // Already set in the real environment, so the file cannot win (§11.6).
    process.env.COREPACK_NPM_REGISTRY = "https://real.example.org";

    const info = report().envFile!;

    expect(info.path).toBe(join(project, ".jup.env"));
    expect(info.applied).toEqual(["COREPACK_ENABLE_STRICT"]);
    expect(info.overridden).toEqual(["COREPACK_NPM_REGISTRY"]);
    // §14.5 — a project file may never supply a credential.
    expect(info.refused).toEqual(["COREPACK_NPM_TOKEN"]);
    expect(info.ignored).toEqual(["PATH"]);
  });

  it("reports no env file when there is none", async () => {
    await manifest({ packageManager: "pnpm@11.1.2" });
    expect(report().envFile).toBeNull();
  });

  it("masks credentials and redacts userinfo", async () => {
    await manifest({ packageManager: "pnpm@11.1.2" });
    process.env.COREPACK_NPM_TOKEN = "hunter2";
    process.env.COREPACK_NPM_REGISTRY = "https://user:pass@mirror.example.org";

    const info = report();

    expect(info.environment.COREPACK_NPM_TOKEN).toBe("<set>");
    expect(JSON.stringify(info)).not.toContain("hunter2");
    expect(JSON.stringify(info)).not.toContain("pass@");
    expect(info.environment.COREPACK_NPM_REGISTRY).toBe("https://mirror.example.org/");
  });
});

/* ------------------------------------------------------------------ *
 * Registries, store, defaults
 * ------------------------------------------------------------------ */

describe("buildReport — registries (§15.30, §15.1 seam)", () => {
  it("agrees with the real registry resolver in both directions", () => {
    // `effectiveRegistry` deliberately mirrors `registry.getRegistryUrl` rather
    // than importing it; this is the guard that keeps the mirror honest.
    expect(effectiveRegistry().registry).toBe(getRegistryUrl());

    for (const value of ["https://mirror.example.org", "https://mirror.example.org//", ""]) {
      process.env.COREPACK_NPM_REGISTRY = value;
      expect(effectiveRegistry().registry).toBe(getRegistryUrl());
    }
  });

  it("names the source of the setting", () => {
    expect(effectiveRegistry().source).toBe("built-in");
    process.env.COREPACK_NPM_REGISTRY = "https://mirror.example.org";
    expect(effectiveRegistry().source).toBe("COREPACK_NPM_REGISTRY");
  });

  it("reports the registry for every supported package manager", () => {
    const names = report().packageManagers.map((entry) => entry.name);
    expect(names).toEqual(["npm", "pnpm", "yarn", "bun", "deno", "aube", "nub", "node"]);

    const yarn = report().packageManagers.find((entry) => entry.name === "yarn")!;
    expect(yarn.binaries).toEqual(["yarn", "yarnpkg"]);
    // §15.41 — there is no surprise left to report. Every band is an npm
    // registry, so the notes that explained Berry's odd one out are empty, for
    // yarn and for everything else.
    expect(yarn.notes).toEqual([]);
    for (const entry of report().packageManagers) expect(entry.notes).toEqual([]);

    // And it mirrors like any other package: no fallback package, no switch.
    process.env.COREPACK_NPM_REGISTRY = "https://mirror.example.org";
    const mirrored = report().packageManagers.find((entry) => entry.name === "yarn")!;
    expect(mirrored.registry).toBe("https://mirror.example.org");
    expect(mirrored.notes).toEqual([]);
  });

  it("reports no .npmrc files when the machine has none in scope", () => {
    // The fixture home has no `.npmrc`, and §15.1's report says so with an empty
    // list rather than a note about an unimplemented feature.
    expect(report().npmrc.registry).toBeNull();
    expect(report().npmrc.auth).toEqual([]);
  });
});

describe("buildReport — the store and the recorded defaults (§15.19, §15.30)", () => {
  it("lists the cached versions, the store path, and whether it is writable", () => {
    seed("yarn", "1.22.4");
    seed("pnpm", "11.1.2");
    seed("pnpm", "10.5.0");
    // Neither of these is a complete install, and neither may be listed.
    mkdirSync(join(home, "v1", "pnpm", "9.0.0"), { recursive: true });
    mkdirSync(join(home, "v1", "corepack-123-abcd"), { recursive: true });

    const info = report().store;

    expect(info.path).toBe(join(home, "v1"));
    expect(info.writable).toBe(true);
    expect(info.versions).toEqual([
      { name: "pnpm", version: "10.5.0" },
      { name: "pnpm", version: "11.1.2" },
      { name: "yarn", version: "1.22.4" },
    ]);
  });

  it("reports a store that does not exist yet as writable", () => {
    process.env.COREPACK_HOME = join(home, "not", "created", "yet");
    expect(report().store.writable).toBe(true);
    expect(report().store.versions).toEqual([]);
  });

  it("reports the recorded global defaults", () => {
    writeFileSync(join(home, "lastKnownGood.json"), JSON.stringify({ yarn: "1.22.4" }));

    const info = report();

    expect(info.defaults.path).toBe(join(home, "lastKnownGood.json"));
    expect(info.defaults.entries).toEqual({ yarn: "1.22.4" });
    const yarn = info.packageManagers.find((entry) => entry.name === "yarn")!;
    expect(yarn.recordedDefault).toBe("1.22.4");
    expect(yarn.builtinDefault).toBe(DEFINITIONS.yarn!.default);
    expect(info.packageManagers.find((entry) => entry.name === "pnpm")!.recordedDefault).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Shims
 * ------------------------------------------------------------------ */

describe("buildReport — shims (§10, §15.29, §15.30)", () => {
  it("reports every binary name, and what PATH resolves it to", () => {
    const info = report().shims;

    // §15.28's entries are here even though a bare `enable` does not install
    // them: §15.30 asks what each binary name *currently resolves to*, and for
    // `bun` that question is the interesting one precisely because the answer is
    // usually somebody else's install.
    expect(info.entries.map((entry) => entry.binary)).toEqual([
      "npm",
      "npx",
      "pnpm",
      "pnpx",
      "yarn",
      "yarnpkg",
      "bun",
      "bunx",
      "deno",
      "aube",
      "aubr",
      "aubx",
      "nub",
      "nubx",
      // §15.39 — a runtime is reported for exactly the reason `bun` is: what the
      // name currently resolves to is the interesting question, and for `node`
      // the answer is somebody else's install on essentially every machine.
      "node",
    ]);
    for (const entry of info.entries) {
      expect(entry.packageManager).toMatch(/^(npm|pnpm|yarn|bun|deno|aube|nub|node)$/);
    }
  });

  it("recognises one of our own stubs, and something else's binary", () => {
    const bin = join(home, "bin");
    mkdirSync(bin, { recursive: true });
    // §15.13 replaced §14.17's "wherever our own binary lives" with an explicit
    // per-user chain, so the fixture names the directory instead of planting a
    // `jup` beside it.
    process.env.COREPACK_SHIM_DIRECTORY = bin;

    // A stub carrying the marker, plus the relative symlink `enable` writes.
    writeFileSync(join(bin, "yarn.js"), `// ${SHIM_MARKER} — generated\n`, { mode: 0o755 });
    symlinkSync("yarn.js", join(bin, "yarn"));
    // Somebody else's yarn, earlier on PATH.
    const other = join(home, "other");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "yarn"), `#!/bin/sh\nexec /usr/bin/true\n`, { mode: 0o755 });

    process.env.PATH = `${other}:${bin}`;
    const info = buildReport();
    const yarn = info.shims.entries.find((entry) => entry.binary === "yarn")!;

    expect(info.shims.directory).toBe(bin);
    expect(yarn.shim).toBe(join(bin, "yarn"));
    expect(yarn.path).toBe(join(other, "yarn"));
    expect(yarn.ours).toBe(false);
    // The whole point of #686: a perfectly installed shim that loses on PATH.
    expect(yarn.shadowed).toBe(true);

    process.env.PATH = `${bin}:${other}`;
    const winning = buildReport().shims.entries.find((entry) => entry.binary === "yarn")!;
    expect(winning.ours).toBe(true);
    expect(winning.shadowed).toBe(false);
  });

  // §15.13 redirected this row: the shim directory is now always determinable —
  // that is the whole of #71 — so the case this asserted no longer arises. What
  // survives is the promise underneath it: the report is complete either way.
  it("names the per-user directory even with an empty PATH", () => {
    process.env.PATH = "";
    const info = buildReport().shims;

    expect(info.directory).not.toBeNull();
    expect(info.problem).toBeNull();
    // And the rest of the report is still there.
    expect(info.entries).toHaveLength(15);
  });
});

/* ------------------------------------------------------------------ *
 * The commands and their output
 * ------------------------------------------------------------------ */

describe("cmdInfo / cmdCacheList (§15.19, §15.30)", () => {
  it("emits parseable JSON carrying the schema version", async () => {
    await manifest({ packageManager: "pnpm@11.1.2+sha512.abcd" });

    await expect(cmdInfo(["--json"])).resolves.toBe(0);

    const parsed = JSON.parse(stdout) as InfoReport;
    expect(parsed.version).toBe(INFO_REPORT_VERSION);
    expect(parsed.project.manifest).toBe(join(project, "package.json"));
    expect(parsed.resolution.version).toBe("11.1.2");
    expect(stdout.endsWith("\n")).toBe(true);
  });

  it("renders every section in the human form", async () => {
    await manifest({ packageManager: "pnpm@11.1.2+sha512.abcd" });
    seed("pnpm", "11.1.2");

    const text = formatReport(report());

    for (const heading of [
      "Project",
      "Resolution",
      "Lockfile",
      "Environment",
      "Package managers",
      "Store",
      "Shims",
    ]) {
      expect(text).toContain(`\n${heading}\n`);
    }
    expect(text).toContain(join(project, "package.json"));
    expect(text).toContain("sha512.abcd");
    // A label wider than the column keeps a separating space.
    process.env.COREPACK_ENABLE_STRICT = "0";
    expect(formatReport(report())).toContain("COREPACK_ENABLE_STRICT=0");
  });

  it("refuses an unknown flag rather than ignoring it", async () => {
    await expect(cmdInfo(["--verbose"])).rejects.toBeInstanceOf(UsageError);
    await expect(cmdCacheList(["-j"])).rejects.toBeInstanceOf(UsageError);
  });

  it("cache list is the store half of the same report", async () => {
    seed("pnpm", "11.1.2");
    writeFileSync(join(home, "lastKnownGood.json"), JSON.stringify({ pnpm: "11.1.2" }));

    await expect(cmdCacheList(["--json"])).resolves.toBe(0);

    const parsed = JSON.parse(stdout) as ReturnType<typeof cacheListView>;
    expect(parsed).toEqual(cacheListView(report()));
    expect(parsed.store.versions).toEqual([{ name: "pnpm", version: "11.1.2" }]);
    expect(parsed.defaults.entries).toEqual({ pnpm: "11.1.2" });
    // A strict subset: no project, no shims, no environment.
    expect(Object.keys(parsed).sort()).toEqual(["defaults", "store", "version"]);

    expect(formatCacheList(report())).toContain("pnpm@11.1.2");
  });

  it("makes no network request, ever", async () => {
    await manifest({ packageManager: "pnpm@latest" });

    await expect(cmdInfo([])).resolves.toBe(0);
    await expect(cmdCacheList([])).resolves.toBe(0);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports the tool's own version and root", () => {
    const info = report().tool;
    expect(info.name).toBe("jup");
    expect(info.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(existsSync(join(info.root, "package.json"))).toBe(true);
  });
});
