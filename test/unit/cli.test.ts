import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

/**
 * §07.9 — `cache clean` asks `shims.ts` what interpreter the installed shims
 * run under. Reproducing that for real would mean a shim directory and a
 * rewritten stub in this process's own package (rows 252 and 253 do exactly
 * that, out of process); here the answer is injected, so the assertions are
 * about what `cache clean` *does* with it. Everything else in the module is the
 * real thing.
 */
const shimState = vi.hoisted(() => ({ interpreter: undefined as string | undefined }));

/**
 * §09.7 — `rm -rf` forgives a missing path but not a refused one: a root-owned
 * tree from an earlier `sudo`, an immutable file, a handle Windows still holds.
 * None of those can be produced portably (the suite runs as root often enough),
 * so exactly one path is made to reject and everything else is the real `rm`.
 */
const rmState = vi.hoisted(() => ({ refuse: new Set<string>() }));

// `cli.ts` reaches `node:fs/promises` through `process.getBuiltinModule`, which
// the module registry cannot intercept — patch the builtin itself, hoisted above
// the imports so the binding it captures is the patched one.
vi.hoisted(() => {
  const actual = process.getBuiltinModule("node:fs/promises");
  const rm: typeof actual.rm = (path, options) =>
    rmState.refuse.has(String(path))
      ? Promise.reject(
          Object.assign(new Error(`EACCES: permission denied, rm '${path}'`), {
            code: "EACCES",
          }),
        )
      : actual.rm(path, options);
  const patched = { ...actual, rm };
  const original = process.getBuiltinModule;
  process.getBuiltinModule = ((id: string) =>
    id === "node:fs/promises"
      ? patched
      : original.call(process, id)) as typeof process.getBuiltinModule;
});

vi.mock("../../src/commands/shims.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/commands/shims.ts")>()),
  bakedInterpreter: async () => shimState.interpreter,
}));

// `exec.ts` hands the process over to the package manager for real — it rewrites
// `process.argv` and imports the entry point on `nextTick`. Every assertion here
// is about *what* would be run, so the handover itself is mocked out.
vi.mock("../../src/run/exec.ts", () => ({
  // `0` mirrors the real JavaScript path (§08.4): the package manager sets the
  // exit code from its own module body afterwards, so handover itself answers 0.
  // §08.3's native path is the one that returns a promise of a real code.
  execPackageManager: vi.fn(() => 0),
  resolveBinPath: vi.fn(),
}));

import {
  cmdCache,
  cmdInstall,
  cmdInstallGlobal,
  cmdPack,
  cmdUp,
  cmdUse,
  resolvePatternsToDescriptors,
  runManagementCommand,
} from "../../src/commands/cli.ts";
import { messages, UsageError } from "../../src/errors-cold.ts";
import { execPackageManager } from "../../src/run/exec.ts";
import { create } from "../../src/cache/tar.ts";
import { readInstalledSpec } from "../../src/cache/store.ts";
import type { CorepackMarker } from "../../src/types.ts";
import { USAGE_LINES } from "../../src/commands/usage.ts";

/* ------------------------------------------------------------------ *
 * Harness
 *
 * A throwaway `COREPACK_HOME` and project directory per test, a `cwd`
 * spy (rather than `process.chdir`, which is unavailable in some
 * pools), captured streams, and a fetch spy that both serves the mock
 * registry and counts requests — so "this command did no network I/O"
 * is an assertion rather than a hope.
 * ------------------------------------------------------------------ */

const ENV_KEYS = [
  "COREPACK_HOME",
  "COREPACK_NPM_REGISTRY",
  "COREPACK_ENABLE_DOWNLOAD_PROMPT",
  "COREPACK_ENABLE_NETWORK",
  "COREPACK_DEFAULT_TO_LATEST",
  "COREPACK_ENABLE_UNSAFE_CUSTOM_URLS",
  "COREPACK_ENV_FILE",
  "COREPACK_MIGRATE_FROM",
  "JUP_ALLOW_UNVERIFIED",
  "JUP_FROZEN_LOCKFILE",
  "JUP_QUIET_ADVISORIES",
] as const;

/** The origins the embedded table points at, all mapped onto `routes`. */
const TABLE_ORIGINS = [
  "https://registry.npmjs.org",
  "https://repo.yarnpkg.com",
  "https://registry.yarnpkg.com",
];

let home: string;
let project: string;
let saved: Record<string, string | undefined>;
let savedEnv: NodeJS.ProcessEnv;
let stdout: string;
let stderr: string;
let routes: Record<string, unknown>;
let requested: string[];
let cwdSpy: MockInstance<() => string>;

/**
 * A throwaway directory, realpathed: macOS puts `$TMPDIR` behind a symlink
 * (`/var` -> `/private/var`) and §10.2's boundary test resolves `<home>` before
 * comparing, so a literal `/var/...` spelling would read as outside the very
 * store it names.
 */
async function tempDir(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

beforeEach(async () => {
  savedEnv = process.env;
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }

  home = await tempDir("jup-cli-home-");
  project = await tempDir("jup-cli-proj-");
  process.env.COREPACK_HOME = home;

  stdout = "";
  stderr = "";
  routes = {};
  requested = [];

  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  // Vitest routes `console` through its own transport, so a `console.warn` in
  // the sources would otherwise slip past the stderr spy above.
  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    stderr += `${args.join(" ")}\n`;
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr += `${args.join(" ")}\n`;
  });

  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(project);

  vi.spyOn(globalThis, "fetch").mockImplementation((input: RequestInfo | URL) => {
    const url = String(input);
    requested.push(url);

    const origin = TABLE_ORIGINS.find((candidate) => url.startsWith(candidate));
    const path = origin === undefined ? url : url.slice(origin.length);
    const body = routes[path];
    if (body === undefined) {
      return Promise.resolve(
        new Response(`{"error":"not found"}`, {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    // §02.5 put every artifact on the npm registry, so a download is a real
    // tarball now rather than the single `.js` a JSON body could stand in for.
    if (body instanceof Uint8Array) {
      return Promise.resolve(
        new Response(Buffer.from(body), {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  // §07.9's injected answer is per-test; anything else would leak a spared
  // version into the next `cache clean`.
  shimState.interpreter = undefined;
  rmState.refuse.clear();
  // `applyEnvFile` replaces `process.env` wholesale (§11.6), so restore the
  // object itself rather than patching keys back onto a replacement.
  process.env = savedEnv;
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(home, { recursive: true, force: true });
  await rm(project, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** A package manager already in the store: the §07.2 warm path, no network. */
async function seed(name: string, version: string, hash?: string): Promise<string> {
  const location = join(home, "v1", name, version);
  // Note the body length follows the version's digit count, so some versions
  // give an odd-length hex that `integrityFromHash` cannot convert. That is
  // deliberate — §03.7's "digest that cannot be spelled as SRI" path is
  // exercised by `yarn@2.4.3` and not by `yarn@1.22.4`.
  const digest = hash ?? `sha512.${version.replaceAll(".", "")}${"0".repeat(32)}`;
  await mkdir(join(location, "bin"), { recursive: true });
  await writeFile(join(location, "bin", `${name}.js`), "// fake package manager\n");
  const marker: CorepackMarker = {
    locator: { name, reference: `${version}+${digest}` },
    bin: { [name]: `./bin/${name}.js` },
    hash: digest,
  };
  await writeFile(join(location, ".jup"), JSON.stringify(marker));
  return location;
}

async function manifest(data: unknown, dir = project): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), `${JSON.stringify(data, null, 2)}\n`);
}

function readManifest(dir = project): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
}

/**
 * §03.7 — the `devEngines.packageManager` member, which is where the pin now
 * lands. The version there is always *clean*, with any digest beside it in
 * `integrity`, so the two are read together to recover the one spec string the
 * old top-level assertions matched against.
 */
function pinnedMember(dir = project): Record<string, unknown> | undefined {
  const devEngines = readManifest(dir).devEngines as
    | { packageManager?: Record<string, unknown> }
    | undefined;
  return devEngines?.packageManager;
}

/** §04.4 — the resolutions the project's committed `jup.lock` holds. */
function lockfile(dir = project): Record<string, unknown> {
  const file = join(dir, "jup.lock");
  if (!existsSync(file)) return {};
  return (JSON.parse(readFileSync(file, "utf8")) as { resolutions: Record<string, unknown> })
    .resolutions;
}

/** §04.4 — the memo an ordinary run leaves in `node_modules/.jup`. */
async function memo(resolutions: Record<string, unknown>, dir = project): Promise<void> {
  await mkdir(join(dir, "node_modules", ".jup"), { recursive: true });
  await writeFile(
    join(dir, "node_modules", ".jup", "jup.lock"),
    `${JSON.stringify({ version: 1, resolutions })}\n`,
  );
}

function lastKnownGood(): Record<string, string> {
  const file = join(home, "lastKnownGood.json");
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
}

async function writeLastKnownGood(value: Record<string, string>): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "lastKnownGood.json"), JSON.stringify(value));
}

/**
 * The two packuments the yarn table entry reads (§05.2, §02.5).
 *
 * Both are npm documents now. Berry's used to be `repo.yarnpkg.com/tags`, a
 * url-type registry with `tags`/`aliases` fields; `/tags` is still registered so
 * that a test asserting nothing reached a vendor host has something to catch.
 */
function mockYarnRegistry(): void {
  routes["/yarn"] = {
    name: "yarn",
    "dist-tags": { latest: "1.22.22" },
    versions: { "1.0.0": {}, "1.22.4": {}, "1.22.22": {} },
  };
  routes["/@yarnpkg/cli-dist"] = {
    name: "@yarnpkg/cli-dist",
    "dist-tags": { stable: "2.4.3", latest: "3.0.0" },
    versions: { "2.1.0": {}, "2.2.2": {}, "2.4.3": {}, "3.0.0": {} },
  };
  routes["/tags"] = {
    tags: ["3.0.0", "2.4.3", "2.2.2", "2.1.0"],
    aliases: { stable: "2.4.3", latest: "3.0.0" },
  };
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the promise to reject");
}

const execMock = vi.mocked(execPackageManager);

/* ------------------------------------------------------------------ *
 * §09.1 — pattern resolution
 * ------------------------------------------------------------------ */

describe("resolvePatternsToDescriptors (§09.1)", () => {
  it("parses CLI patterns without enforcing an exact version", () => {
    expect(resolvePatternsToDescriptors(["yarn@1.x", "pnpm"])).toEqual([
      { name: "yarn", range: "1.x" },
      { name: "pnpm", range: "*" },
    ]);
  });

  it("loads only the env file when patterns are given, never the manifest", async () => {
    // A manifest that would be a hard parse error if it were read at all.
    await writeFile(join(project, "package.json"), "{ not json");
    await writeFile(join(project, ".jup.env"), "COREPACK_ENABLE_NETWORK=0\n");

    expect(resolvePatternsToDescriptors(["yarn@2.2.2"])).toEqual([
      { name: "yarn", range: "2.2.2" },
    ]);
    expect(process.env.COREPACK_ENABLE_NETWORK).toBe("0");
  });

  it("prefers the devEngines range over the exact pin (§09.1, test 112)", async () => {
    await manifest({
      packageManager: "yarn@1.1.0",
      devEngines: { packageManager: { name: "yarn", version: "1.x || 2.x" } },
    });

    expect(resolvePatternsToDescriptors([])).toEqual([
      { name: "yarn", range: "1.x || 2.x", onFail: undefined },
    ]);
  });

  it("falls back to the packageManager pin when no range is declared", async () => {
    await manifest({ packageManager: "yarn@2.2.2" });
    expect(resolvePatternsToDescriptors([])).toEqual([{ name: "yarn", range: "2.2.2" }]);
  });

  it("reports the §12.9 no-project message verbatim (test 142)", async () => {
    const error = await rejection(cmdInstall([]));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toBe(
      `Couldn't find a project in the local directory - please specify the package manager to pack, or run this command from a valid project`,
    );
    expect(error.message).toBe(messages.couldntFindProject());
  });

  it("reports the §12.9 no-spec message verbatim (test 143)", async () => {
    await manifest({ name: "no-spec" });

    const error = await rejection(cmdInstall([]));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toBe(
      `The local project doesn't feature a 'packageManager' field nor a 'devEngines.packageManager' field - please specify the package manager to pack, or update the manifest to reference it`,
    );
  });
});

/* ------------------------------------------------------------------ *
 * §09.2 — install
 * ------------------------------------------------------------------ */

describe("install (§09.2, test 86)", () => {
  it("prints exactly the cache banner and leaves stderr empty", async () => {
    await seed("yarn", "2.2.2");
    await manifest({ packageManager: "yarn@2.2.2" });

    await expect(cmdInstall([])).resolves.toBe(0);

    expect(stdout).toBe(`Adding yarn@2.2.2 to the cache...\n`);
    expect(stderr).toBe("");
    expect(requested).toEqual([]);
  });

  it("does not touch last-known-good", async () => {
    await seed("yarn", "2.2.2");
    await writeLastKnownGood({ yarn: "1.22.22" });
    await manifest({ packageManager: "yarn@2.2.2" });

    await cmdInstall([]);

    expect(lastKnownGood()).toEqual({ yarn: "1.22.22" });
  });

  /*
   * The case above installs from the store, where §04.8's bump is never reached
   * at all. This one downloads, which is where the two rules collide: §04.8
   * bumps after any successful install, §09.2 says this command leaves the file
   * alone. §09.2 is the specific statement and wins — warming a Docker layer
   * must not silently repoint the machine's default.
   */
  it("does not bump last-known-good on a cold install either", async () => {
    // §02.5 — Berry is an `@yarnpkg/cli-dist` tarball on the npm registry, so
    // §06 has a packument to consult for a signature where the old url-type
    // registry offered none. The fixture therefore serves the metadata too.
    mockYarnRegistry();
    const archive = rawArchive(["package/package.json", "package/bin/yarn.js"]);
    routes["/@yarnpkg/cli-dist/2.2.2"] = {
      name: "@yarnpkg/cli-dist",
      version: "2.2.2",
      dist: {
        tarball: "https://registry.npmjs.org/@yarnpkg/cli-dist/-/cli-dist-2.2.2.tgz",
        // §06.1 row 2 needs *something* to compare the stream against; a
        // signature is what it does not have, which is the point below.
        integrity: `sha512-${createHash("sha512").update(archive).digest("base64")}`,
      },
    };
    routes["/@yarnpkg/cli-dist/-/cli-dist-2.2.2.tgz"] = archive;
    // §06.1: this fixture publishes no signature and pins no hash, so the
    // artifact clears no verification tier. The opt-out keeps the row about what
    // it is about — §09.2 not touching `lastKnownGood.json` on a cold install.
    process.env.JUP_ALLOW_UNVERIFIED = "1";
    await writeLastKnownGood({ yarn: "2.1.0" });
    await manifest({ packageManager: "yarn@2.2.2" });

    await expect(cmdInstall([])).resolves.toBe(0);

    // It really did download: the store was empty before this ran.
    expect(existsSync(join(home, "v1", "yarn", "2.2.2", ".jup"))).toBe(true);
    // Same major and strictly upward, so §04.8 alone would have advanced it.
    expect(lastKnownGood()).toEqual({ yarn: "2.1.0" });
  });

  it("refuses positional arguments", async () => {
    await manifest({ packageManager: "yarn@2.2.2" });
    await expect(cmdInstall(["yarn@2.2.2"])).rejects.toBeInstanceOf(UsageError);
  });

  /* §04.4 — what the project's two files already say ------------------- */

  it("warms the cache with the memo's version, not the newest match", async () => {
    mockYarnRegistry();
    await seed("yarn", "2.1.0");
    await seed("yarn", "2.4.3");
    await manifest({ packageManager: "yarn@2.x" });
    // The now-ordinary state: nothing committed, a live memo. Caching 2.4.3 here
    // and then running 2.1.0 offline is the whole failure `install` exists to
    // prevent — and in a `JUP_ENABLE_NETWORK=0` layer it is not a re-download,
    // it is a hard failure.
    await memo({ "yarn@2.x": { resolved: "2.1.0", expires: Date.now() + 60_000 } });

    await expect(cmdInstall([])).resolves.toBe(0);

    expect(stdout).toBe(`Adding yarn@2.1.0 to the cache...\n`);
    expect(requested).toEqual([]);
  });

  it("prefers the recorded resolution to the memo", async () => {
    mockYarnRegistry();
    await seed("yarn", "2.1.0");
    await seed("yarn", "2.2.2");
    await manifest({ packageManager: "yarn@2.x" });
    await writeFile(
      join(project, "jup.lock"),
      `${JSON.stringify({ version: 1, resolutions: { "yarn@2.x": { resolved: "2.2.2" } } })}\n`,
    );
    await memo({ "yarn@2.x": { resolved: "2.1.0", expires: Date.now() + 60_000 } });

    await expect(cmdInstall([])).resolves.toBe(0);

    // A committed decision beats a note about what the registry said yesterday.
    expect(stdout).toBe(`Adding yarn@2.2.2 to the cache...\n`);
    expect(requested).toEqual([]);
  });

  it("ignores an expired memo and resolves afresh", async () => {
    mockYarnRegistry();
    await seed("yarn", "2.4.3");
    await manifest({ packageManager: "yarn@2.x" });
    await memo({ "yarn@2.x": { resolved: "2.1.0", expires: Date.now() - 60_000 } });

    await expect(cmdInstall([])).resolves.toBe(0);

    expect(stdout).toBe(`Adding yarn@2.4.3 to the cache...\n`);
  });
});

/* ------------------------------------------------------------------ *
 * §09.3 — install -g
 * ------------------------------------------------------------------ */

describe("install --global (§09.3, tests 89, 101)", () => {
  it("prints the install banner and records the default (test 89)", async () => {
    await seed("yarn", "2.2.2");

    await expect(runManagementCommand(["install", "--global", "yarn@2.2.2"])).resolves.toBe(0);

    expect(stdout).toBe(`Installing yarn@2.2.2...\n`);
    expect(stderr).toBe("");
    expect(lastKnownGood().yarn).toMatch(/^2\.2\.2\+sha512\./);
  });

  it("sets the default unconditionally, even downgrading a major (test 101)", async () => {
    await seed("yarn", "1.0.0");
    await writeLastKnownGood({ yarn: "4.9.0" });

    await runManagementCommand(["install", "-g", "yarn@1.0.0"]);

    expect(lastKnownGood().yarn).toMatch(/^1\.0\.0\+sha512\./);
  });

  it("--cache-only warms the cache without changing the default", async () => {
    await seed("yarn", "1.0.0");
    await writeLastKnownGood({ yarn: "4.9.0" });

    await runManagementCommand(["install", "-g", "--cache-only", "yarn@1.0.0"]);

    expect(stdout).toBe(`Adding yarn@1.0.0 to the cache...\n`);
    expect(lastKnownGood()).toEqual({ yarn: "4.9.0" });
  });

  it("accepts several specs in one invocation", async () => {
    await seed("yarn", "2.2.2");
    await seed("pnpm", "5.8.0");

    await cmdInstallGlobal(["-g", "yarn@2.2.2", "pnpm@5.8.0"]);

    expect(stdout).toBe(`Installing yarn@2.2.2...\nInstalling pnpm@5.8.0...\n`);
    expect(Object.keys(lastKnownGood()).sort()).toEqual(["pnpm", "yarn"]);
  });

  it("requires at least one target", async () => {
    await expect(cmdInstallGlobal(["-g"])).rejects.toBeInstanceOf(UsageError);
  });

  it("rejects an unknown option rather than ignoring it", async () => {
    await expect(cmdInstallGlobal(["-g", "--nope", "yarn@1.0.0"])).rejects.toThrow(
      `Unsupported option name ("--nope")`,
    );
  });
});

/* ------------------------------------------------------------------ *
 * §07.10 — portable archives
 * ------------------------------------------------------------------ */

/**
 * A gzipped tar built byte by byte, because the entry paths under test — a `.`
 * or an empty component — cannot be produced by walking a real directory.
 */
function rawArchive(paths: string[]): Buffer {
  const blocks: Buffer[] = [];
  for (const path of paths) {
    const body = Buffer.from("{}", "utf8");
    const header = Buffer.alloc(512);
    header.write(path, 0, "utf8");
    header.write("0000644\0", 100, "latin1");
    header.write("0000000\0", 108, "latin1");
    header.write("0000000\0", 116, "latin1");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
    header.write("00000000000\0", 136, "latin1");
    header.fill(0x20, 148, 156);
    header.write("0", 156, "latin1");
    header.write("ustar\u000000", 257, "latin1");
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
    blocks.push(header, body, Buffer.alloc(512 - body.length));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

describe("pack and install -g <file>.tgz (§07.10, tests 90, 92, 93)", () => {
  it("round-trips through a fresh, offline COREPACK_HOME (tests 90, 92)", async () => {
    await seed("yarn", "2.2.2");
    await seed("pnpm", "5.8.0");

    await expect(cmdPack(["yarn@2.2.2", "pnpm@5.8.0"])).resolves.toBe(0);

    const archive = join(project, "jup.tgz");
    expect(existsSync(archive)).toBe(true);
    expect(stdout).toBe(
      `Adding yarn@2.2.2 to the cache...\n` +
        `Adding pnpm@5.8.0 to the cache...\n` +
        `Packing the selected tools in jup.tgz...\n` +
        `All done!\n`,
    );

    // A brand-new home, and the network switched off: the archive is the only
    // possible source of these versions.
    const fresh = await tempDir("jup-cli-home2-");
    process.env.COREPACK_HOME = fresh;
    process.env.COREPACK_ENABLE_NETWORK = "0";
    stdout = "";

    await expect(runManagementCommand(["install", "-g", archive])).resolves.toBe(0);

    expect(existsSync(join(fresh, "v1", "yarn", "2.2.2", ".jup"))).toBe(true);
    expect(existsSync(join(fresh, "v1", "pnpm", "5.8.0", ".jup"))).toBe(true);
    expect(existsSync(join(fresh, "v1", "yarn", "2.2.2", "bin", "yarn.js"))).toBe(true);
    expect(stdout).toContain(`Installing yarn@2.2.2...\n`);
    expect(stdout).toContain(`Installing pnpm@5.8.0...\n`);
    expect(requested).toEqual([]);

    // §07.10 — activation unless `--cache-only`.
    const lkg = JSON.parse(readFileSync(join(fresh, "lastKnownGood.json"), "utf8")) as Record<
      string,
      string
    >;
    expect(lkg).toEqual({ yarn: "2.2.2", pnpm: "5.8.0" });

    // Nothing is left behind in the install folder besides the two subtrees.
    await rm(fresh, { recursive: true, force: true });
  });

  it("recreates a COREPACK_HOME that does not exist yet (test 91)", async () => {
    await seed("yarn", "2.2.2");
    await cmdPack(["yarn@2.2.2"]);
    const archive = join(project, "jup.tgz");

    const fresh = join(tmpdir(), `jup-cli-missing-${process.pid}-${Date.now()}`);
    process.env.COREPACK_HOME = fresh;
    process.env.COREPACK_ENABLE_NETWORK = "0";
    expect(existsSync(fresh)).toBe(false);

    await expect(runManagementCommand(["install", "-g", archive])).resolves.toBe(0);

    expect(existsSync(join(fresh, "v1", "yarn", "2.2.2", ".jup"))).toBe(true);

    await rm(fresh, { recursive: true, force: true });
  });

  it("updates last-known-good as a side effect (§09.6)", async () => {
    await seed("yarn", "2.2.2");
    await writeLastKnownGood({ yarn: "1.0.0" });

    await cmdPack(["yarn@2.2.2"]);

    expect(lastKnownGood().yarn).toMatch(/^2\.2\.2\+sha512\./);
  });

  it("packs the project's own package manager when given no patterns", async () => {
    await seed("yarn", "2.2.2");
    await manifest({ packageManager: "yarn@2.2.2" });

    await cmdPack([]);

    expect(existsSync(join(project, "jup.tgz"))).toBe(true);
  });

  it("--json prints only the output path, and -o redirects it", async () => {
    await seed("yarn", "2.2.2");
    const output = join(project, "nested", "tools.tgz");
    await mkdir(join(project, "nested"), { recursive: true });

    await cmdPack(["--json", "--output", output, "yarn@2.2.2"]);

    expect(stdout).toBe(`${JSON.stringify(output)}\n`);
    expect(JSON.parse(stdout) as string).toBe(output);
    expect(existsSync(output)).toBe(true);
  });

  it("rejects a tarball that did not come from pack (test 93)", async () => {
    const source = await tempDir("jup-cli-other-");
    await mkdir(join(source, "stuff"), { recursive: true });
    await writeFile(join(source, "stuff", "readme.txt"), "not a store subtree\n");
    const archive = join(project, "other.tgz");
    await create(source, ["stuff"], archive);

    const error = await rejection(cmdInstallGlobal(["-g", archive]));
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toBe(`Invalid archive format; did it get generated by 'jup pack'?`);

    await rm(source, { recursive: true, force: true });
  });

  it("rejects an archive whose markers sit too shallow", async () => {
    const source = await tempDir("jup-cli-short-");
    await mkdir(join(source, "yarn"), { recursive: true });
    await writeFile(join(source, "yarn", ".jup"), "{}");
    const archive = join(project, "short.tgz");
    await create(source, ["yarn"], archive);

    await expect(cmdInstallGlobal(["-g", archive])).rejects.toThrow(
      `Invalid archive format; did it get generated by 'jup pack'?`,
    );

    await rm(source, { recursive: true, force: true });
  });

  /*
   * §07.10's algorithm records `segments[0]` and `segments[1]` verbatim and
   * validates neither, and nor does corepack. `.` survives the extractor (a path
   * join folds it away), so `promote` would operate on `<name>` and
   * `setLastKnownGood("yarn", ".")` would record a reference every later
   * spec-less run classifies as a dist-tag — one that `cache clean` spares by
   * design, so only a hand edit undoes it.
   */
  it("refuses an archive whose reference segment is a relative-path marker", async () => {
    for (const path of ["yarn/./.jup", "yarn//.jup"]) {
      const archive = join(project, `poison-${path.length}.tgz`);
      await writeFile(archive, rawArchive([path]));

      const error = await rejection(cmdInstallGlobal(["-g", archive]));
      expect(error, path).toBeInstanceOf(UsageError);
      expect(error.message).toBe(`Invalid archive format; did it get generated by 'jup pack'?`);
      // Nothing was recorded, so a later spec-less run still has no default.
      expect(existsSync(join(home, "lastKnownGood.json"))).toBe(false);
    }
  });

  it("still accepts a well-formed archive built the same way", async () => {
    const archive = join(project, "fine.tgz");
    await writeFile(archive, rawArchive(["yarn/1.22.4/.jup"]));

    await expect(cmdInstallGlobal(["-g", "--cache-only", archive])).resolves.toBe(0);
    expect(existsSync(join(home, "v1", "yarn", "1.22.4", ".jup"))).toBe(true);
  });

  /**
   * §07.10 — a marker that arrived inside somebody else's archive carries a
   * `hash` that nothing in this path ever checked against bytes. Left standing,
   * it is what §06.1's cache-hit check compares a pin against, so an archive
   * could seed arbitrary bytes under a name and version a project pins and have
   * them run with nothing hashed. `pack` ships extracted subtrees rather than
   * the artifact tarball, so there is nothing to re-derive the digest from and
   * §07.10's second clause applies: the claim comes out.
   */
  it("does not let an archive's marker hash stand as a digest claim", async () => {
    // The digest the victim's project pins, which the archive simply asserts is
    // the hash of the payload sitting beside it.
    const claimed = `sha512.${"ab".repeat(64)}`;

    const source = await tempDir("jup-cli-forged-");
    const dir = join(source, "yarn", "1.22.4");
    await mkdir(join(dir, "bin"), { recursive: true });
    await writeFile(join(dir, "bin", "yarn.js"), "// not the real yarn\n");
    const forged: CorepackMarker = {
      locator: { name: "yarn", reference: `1.22.4+${claimed}` },
      bin: { yarn: "./bin/yarn.js" },
      hash: claimed,
    };
    await writeFile(join(dir, ".jup"), JSON.stringify(forged));
    const archive = join(project, "forged.tgz");
    await create(source, ["yarn"], archive);

    await expect(cmdInstallGlobal(["-g", "--cache-only", archive])).resolves.toBe(0);

    // The claim did not survive promotion.
    const promoted = JSON.parse(
      readFileSync(join(home, "v1", "yarn", "1.22.4", ".jup"), "utf8"),
    ) as CorepackMarker;
    expect(promoted.hash).not.toBe(claimed);

    // So the pin it was forged to satisfy is not a cache hit: that reference
    // goes to the download-and-verify path instead of executing these bytes.
    expect(readInstalledSpec({ name: "yarn", reference: `1.22.4+${claimed}` })).toBeNull();

    // The entry is still usable by an unpinned reference, which is exactly what
    // §07.10 says a stripped marker leaves behind.
    expect(readInstalledSpec({ name: "yarn", reference: "1.22.4" })).not.toBeNull();

    await rm(source, { recursive: true, force: true });
  });

  it("refuses an archive naming a package manager this build doesn't support", async () => {
    const source = await tempDir("jup-cli-bogus-");
    await mkdir(join(source, "vlt", "1.0.0"), { recursive: true });
    await writeFile(join(source, "vlt", "1.0.0", ".jup"), "{}");
    const archive = join(project, "bogus.tgz");
    await create(source, ["vlt"], archive);

    await expect(cmdInstallGlobal(["-g", archive])).rejects.toThrow(
      `Unsupported package manager 'vlt'`,
    );
    expect(existsSync(join(home, "v1", "vlt"))).toBe(false);

    await rm(source, { recursive: true, force: true });
  });
});

/* ------------------------------------------------------------------ *
 * §09.7 — cache
 * ------------------------------------------------------------------ */

describe("cache clean / clear (§09.7, test 95)", () => {
  it("removes <home>/v1 and spares lastKnownGood.json, twice", async () => {
    await seed("yarn", "2.2.2");
    await writeLastKnownGood({ yarn: "2.2.2" });

    await expect(cmdCache(["clean"])).resolves.toBe(0);
    expect(existsSync(join(home, "v1"))).toBe(false);
    expect(lastKnownGood()).toEqual({ yarn: "2.2.2" });

    // `clear` is the same command, and a second run is a no-op.
    await expect(runManagementCommand(["cache", "clear"])).resolves.toBe(0);
    expect(existsSync(join(home, "v1"))).toBe(false);
    expect(lastKnownGood()).toEqual({ yarn: "2.2.2" });
    // §12.11 redirected this assertion. It used to require `stdout === ""`,
    // which is precisely #679's complaint: a command whose entire job is
    // deletion left the user unable to tell a clean from a no-op. The two lines
    // below are the first run (one version removed) and the second (nothing).
    expect(stdout).toBe(
      `Removed 1 cached version(s) from ${join(home, "v1")}\nNothing to remove\n`,
    );
    expect(stderr).toBe("");
  });

  it("rejects an unknown subcommand", async () => {
    await expect(cmdCache(["nuke"])).rejects.toBeInstanceOf(UsageError);
  });

  /* §07.9 — the backstop for §10.2 -------------------------------------- */

  it("spares the version holding the shims' interpreter, and says so", async () => {
    const interpreter = join(home, "v1", "node", "22.14.0", "bin", "node");
    shimState.interpreter = interpreter;
    await seed("node", "22.14.0");
    await seed("yarn", "2.2.2");
    await seed("pnpm", "9.0.0");

    await expect(cmdCache(["clean"])).resolves.toBe(0);

    // The count is what was removed, not what was there.
    expect(stdout).toBe(`Removed 2 cached version(s) from ${join(home, "v1")}\n`);
    // One line on stderr: what survived, why, and the way out of the state.
    expect(stderr).toBe(`${messages.interpreterKept("node", "22.14.0", interpreter, home)}\n`);
    expect(existsSync(join(home, "v1", "node", "22.14.0", ".jup"))).toBe(true);
    expect(existsSync(join(home, "v1", "yarn"))).toBe(false);
    expect(existsSync(join(home, "v1", "pnpm"))).toBe(false);
  });

  it("reports `Nothing to remove` when the interpreter was all there was", async () => {
    shimState.interpreter = join(home, "v1", "node", "22.14.0", "bin", "node");
    await seed("node", "22.14.0");

    await expect(cmdCache(["clean"])).resolves.toBe(0);

    expect(stdout).toBe("Nothing to remove\n");
    expect(stderr).toContain("Kept node@22.14.0");
    expect(existsSync(join(home, "v1", "node", "22.14.0", ".jup"))).toBe(true);
  });

  it("`--all` removes it and warns first", async () => {
    const interpreter = join(home, "v1", "node", "22.14.0", "bin", "node");
    shimState.interpreter = interpreter;
    await seed("node", "22.14.0");
    await writeLastKnownGood({ node: "22.14.0" });

    await expect(cmdCache(["clean", "--all"])).resolves.toBe(0);

    expect(stdout).toBe(`Removed 1 cached version(s) and 1 recorded default(s) from ${home}\n`);
    expect(stderr).toBe(`${messages.interpreterRemoved("node", "22.14.0", interpreter, home)}\n`);
    expect(existsSync(join(home, "v1"))).toBe(false);
  });

  it("removes the other versions of the same tool, and the temp folders", async () => {
    shimState.interpreter = join(home, "v1", "node", "22.14.0", "bin", "node");
    await seed("node", "22.14.0");
    await seed("node", "24.0.0");
    // §07.5 leaves one of these behind when a race is lost; sparing one version
    // is not a licence to keep anything else.
    await mkdir(join(home, "v1", "jup-1-abcd"), { recursive: true });

    await expect(cmdCache(["clean"])).resolves.toBe(0);

    expect(existsSync(join(home, "v1", "node", "22.14.0", ".jup"))).toBe(true);
    expect(existsSync(join(home, "v1", "node", "24.0.0"))).toBe(false);
    expect(existsSync(join(home, "v1", "jup-1-abcd"))).toBe(false);
  });

  it("spares nothing for a path that is near the store without being in it", async () => {
    // Three shapes that a `startsWith` would get wrong, and one that is inside
    // the store but is not a file *in* a version directory.
    for (const interpreter of [
      `${home}iter/v1/node/22.14.0/bin/node`,
      join(home, "v1", "node"),
      join(home, "v1", "node", "22.14.0"),
      join(home, "lastKnownGood.json"),
    ]) {
      shimState.interpreter = interpreter;
      await seed("node", "22.14.0");

      await expect(cmdCache(["clean"])).resolves.toBe(0);

      expect(existsSync(join(home, "v1"))).toBe(false);
      expect(stderr).toBe("");
      stdout = "";
    }
  });

  it("spares the interpreter even when the store carries no markers", async () => {
    // §07.2's marker is what `listInstalled` counts, and an interrupted install,
    // a disk cleaner or a hand-edited store loses it — the "shimmed by an older
    // build" case §07.9 exists for most of all. The store then *lists* as empty
    // while still holding the file every shim's shebang names.
    const interpreter = join(home, "v1", "node", "22.14.0", "bin", "node");
    shimState.interpreter = interpreter;
    await mkdir(join(home, "v1", "node", "22.14.0", "bin"), { recursive: true });
    await writeFile(interpreter, "#!/bin/sh\nexit 0\n");
    await mkdir(join(home, "v1", "yarn", "2.2.2"), { recursive: true });

    await expect(cmdCache(["clean"])).resolves.toBe(0);

    // Gated on `listInstalled().length`, the guard was skipped, `<home>/v1` went
    // wholesale, and every shim died with `bad interpreter` behind an `enable`
    // that could no longer start.
    expect(existsSync(interpreter)).toBe(true);
    expect(existsSync(join(home, "v1", "yarn"))).toBe(false);
    // Nothing the store could vouch for was removed, so the count says so.
    expect(stdout).toBe("Nothing to remove\n");
    expect(stderr).toContain("Kept node@22.14.0");
  });

  it("reports what it could not remove, and finishes the clean", async () => {
    const interpreter = join(home, "v1", "node", "22.14.0", "bin", "node");
    shimState.interpreter = interpreter;
    await seed("node", "22.14.0");
    await seed("yarn", "2.2.2");
    await seed("pnpm", "9.0.0");
    // A tree an earlier `sudo` left root-owned, or a handle Windows still holds.
    rmState.refuse.add(join(home, "v1", "yarn"));

    await expect(cmdCache(["clean"])).resolves.toBe(0);

    // One rejection out of `Promise.all` used to abort the command here: no
    // §07.9 line, no count, and a raw error in place of both.
    expect(existsSync(join(home, "v1", "yarn", "2.2.2", ".jup"))).toBe(true);
    expect(existsSync(join(home, "v1", "pnpm"))).toBe(false);
    expect(existsSync(interpreter.replace(join("bin", "node"), ".jup"))).toBe(true);
    // The count is what was *removed*, so the survivor is not in it either.
    expect(stdout).toBe(`Removed 1 cached version(s) from ${join(home, "v1")}\n`);
    expect(stderr).toContain("Kept node@22.14.0");
    expect(stderr).toContain(messages.cacheEntryNotRemoved(join(home, "v1", "yarn")));
  });

  it("routes both §07.9 lines through JUP_QUIET_ADVISORIES", async () => {
    // §11.3 — every `!` line this spec adds is silenced by the flag, and these
    // two were written straight to the stream. The *count* is command output and
    // is unaffected.
    process.env.JUP_QUIET_ADVISORIES = "1";
    shimState.interpreter = join(home, "v1", "node", "22.14.0", "bin", "node");
    await seed("node", "22.14.0");
    await seed("yarn", "2.2.2");

    await expect(cmdCache(["clean"])).resolves.toBe(0);

    expect(stdout).toBe(`Removed 1 cached version(s) from ${join(home, "v1")}\n`);
    expect(stderr).toBe("");

    await seed("yarn", "2.2.2");
    await expect(cmdCache(["clean", "--all"])).resolves.toBe(0);
    expect(stderr).toBe("");
  });

  it("an interpreter outside the store changes nothing at all", async () => {
    // The only state §10.2 now produces, and §12.11's row 206 fixes its
    // output byte for byte: one line on stdout, an empty stderr, `v1` gone.
    shimState.interpreter = process.execPath;
    await seed("yarn", "2.2.2");

    await expect(cmdCache(["clean"])).resolves.toBe(0);

    expect(stdout).toBe(`Removed 1 cached version(s) from ${join(home, "v1")}\n`);
    expect(stderr).toBe("");
    expect(existsSync(join(home, "v1"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * §09.5 — use
 * ------------------------------------------------------------------ */

describe("use (§09.5, tests 105-110)", () => {
  it("writes a hash-bearing pin and runs the package manager (test 105)", async () => {
    await seed("yarn", "1.22.4");
    await manifest({ name: "demo", packageManager: "yarn@1.0.0" });

    await expect(cmdUse(["yarn@1.22.4"])).resolves.toBe(0);

    // §12.11 — the banner, then the path that was modified, then the blank
    // line that separates our output from the package manager's (§09.5).
    expect(stdout).toBe(
      `Installing yarn@1.22.4 in the project...\n` +
        `Updated ${join(project, "package.json")} to use yarn@${(readManifest().packageManager as string).slice("yarn@".length)}\n` +
        `\n`,
    );
    expect(stderr).toBe("");
    expect(readManifest().packageManager).toMatch(/^yarn@1\.22\.4\+sha512\./);

    // §09.5 — `commands.use` runs with the previous value in the environment.
    expect(execMock).toHaveBeenCalledTimes(1);
    const [binName, , args] = execMock.mock.calls[0]!;
    expect(binName).toBe("yarn");
    expect(args).toEqual(["install"]);
    expect(process.env.COREPACK_MIGRATE_FROM).toBe("yarn@1.0.0");
  });

  it("uses the literal 'unknown' when the project had no pin", async () => {
    await seed("yarn", "1.22.4");
    await manifest({ name: "demo" });

    await cmdUse(["yarn@1.22.4"]);

    expect(process.env.COREPACK_MIGRATE_FROM).toBe("unknown");
  });

  it("creates package.json in an empty directory (test 106)", async () => {
    await seed("yarn", "1.22.4");

    await cmdUse(["yarn@1.22.4"]);

    expect(existsSync(join(project, "package.json"))).toBe(true);
    // §03.7 — neither field declared, so the member is the pin and no
    // `packageManager` is created beside it. The default spelling keeps §02.1's
    // digest suffix in the version.
    expect(readManifest().packageManager).toBeUndefined();
    expect(pinnedMember()).toEqual({
      name: "yarn",
      version: expect.stringMatching(/^1\.22\.4\+sha512\./) as unknown as string,
    });
  });

  it("updates the ancestor manifest when run from a subfolder (test 107)", async () => {
    await seed("yarn", "1.22.4");
    await manifest({ name: "root", packageManager: "yarn@1.0.0" });
    const nested = join(project, "packages", "app");
    await mkdir(nested, { recursive: true });
    cwdSpy.mockReturnValue(nested);

    await cmdUse(["yarn@1.22.4"]);

    expect(readManifest().packageManager).toMatch(/^yarn@1\.22\.4\+sha512\./);
    expect(existsSync(join(nested, "package.json"))).toBe(false);
  });

  it("overwrites a malformed existing pin (test 109)", async () => {
    await seed("yarn", "1.22.4");

    for (const malformed of ["yarn@^1", "yarn", "yarn@", 42, null]) {
      await manifest({ name: "demo", packageManager: malformed });

      await expect(cmdUse(["yarn@1.22.4"])).resolves.toBe(0);
      expect(readManifest().packageManager).toMatch(/^yarn@1\.22\.4\+sha512\./);
    }
  });

  // §03.7 — the mismatch that still fails is a *name* mismatch: a member naming
  // another tool is a statement this write cannot make true, where a version
  // outside a declared range is one the write replaces.
  it("surfaces a devEngines mismatch after the banner, on stdout (test 110)", async () => {
    await seed("yarn", "1.22.4");
    await manifest({
      name: "demo",
      devEngines: { packageManager: { name: "pnpm", version: "2.x" } },
    });

    const error = await rejection(cmdUse(["yarn@1.22.4"]));

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toMatch(
      /^The requested version of yarn@1\.22\.4\+sha512\..* does not match the devEngines specification \(pnpm@2\.x\)$/,
    );
    // The banner is already on stdout when the failure happens, and `main.ts`
    // appends the `Usage Error:` block to the same stream (§12.1).
    expect(stdout).toBe(`Installing yarn@1.22.4 in the project...\n`);
    expect(stderr).toBe("");
    expect(USAGE_LINES.use).toBe("$ jup use [--here] [--pin-style=suffix|sidecar] <pattern>");
    expect(readManifest().packageManager).toBeUndefined();
  });

  it("resolves a tag against the registry rather than the cache (test 108)", async () => {
    mockYarnRegistry();
    await seed("yarn", "2.4.3");
    await seed("yarn", "1.22.22");
    await manifest({ name: "demo" });

    await cmdUse(["yarn@stable"]);

    expect(pinnedMember()).toEqual({
      name: "yarn",
      version: expect.stringMatching(/^2\.4\.3\+sha512\./) as unknown as string,
    });
  });

  it("requires exactly one pattern", async () => {
    await expect(cmdUse([])).rejects.toBeInstanceOf(UsageError);
    await expect(cmdUse(["yarn@1", "pnpm@9"])).rejects.toBeInstanceOf(UsageError);
  });

  /* §04.4 — the memo, and what the frozen flag actually governs -------- */

  it("retires the memo for the range it just recorded", async () => {
    mockYarnRegistry();
    await seed("yarn", "2.4.3");
    await manifest({ name: "demo" });
    // A memo from an earlier run under the very range being recorded now.
    await memo({ "yarn@2.x": { resolved: "2.1.0", expires: Date.now() + 60_000 } });

    await expect(cmdUse(["yarn@2.x"])).resolves.toBe(0);

    // §03.7 — the range pin lands in the member; §04.4 keeps its resolution in
    // `jup.lock`, which is unchanged by where the range itself is written.
    expect(readManifest().packageManager).toBeUndefined();
    expect(pinnedMember()).toEqual({ name: "yarn", version: "2.x" });
    expect(lockfile()).toEqual({ "yarn@2.x": { resolved: "2.4.3" } });
    // The superseded memo does not outlive the decision that replaced it: in
    // any state where the recorded file is not visible it would answer alone.
    expect(existsSync(join(project, "node_modules", ".jup", "jup.lock"))).toBe(false);
  });

  it("refuses an exact use that would delete a recorded resolution when frozen", async () => {
    process.env.JUP_FROZEN_LOCKFILE = "1";
    await seed("yarn", "2.4.3");
    await manifest({ name: "demo", packageManager: "yarn@2.x" });
    await writeFile(
      join(project, "jup.lock"),
      `${JSON.stringify({ version: 1, resolutions: { "yarn@2.x": { resolved: "2.1.0" } } })}\n`,
    );

    const error = await rejection(cmdUse(["yarn@2.4.3"]));

    // The flag governs the file, not one syntax of pin: an exact `use` retires
    // the range's entry, and `rm`s `jup.lock` outright when it was the only one.
    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toBe(messages.lockfileUnresolved("yarn", "2.x"));
    // Refused before the resolve, and before anything was written.
    expect(requested).toEqual([]);
    expect(stdout).toBe("");
    expect(readManifest().packageManager).toBe("yarn@2.x");
    expect(lockfile()).toEqual({ "yarn@2.x": { resolved: "2.1.0" } });
  });

  it("still allows an exact use with nothing recorded to lose", async () => {
    process.env.JUP_FROZEN_LOCKFILE = "1";
    await seed("yarn", "2.4.3");
    // A range pin, but no recorded resolution: there is no file to freeze, and
    // refusing here would break every `use` in CI over a file that never
    // existed.
    await manifest({ name: "demo", packageManager: "yarn@2.x" });

    await expect(cmdUse(["yarn@2.4.3"])).resolves.toBe(0);
    expect(readManifest().packageManager).toMatch(/^yarn@2\.4\.3/);
    expect(existsSync(join(project, "jup.lock"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * §09.4 — up
 * ------------------------------------------------------------------ */

describe("up (§09.4, tests 111-115)", () => {
  it("bumps to the highest release of the pinned major (test 111)", async () => {
    mockYarnRegistry();
    await seed("yarn", "2.4.3");
    await manifest({ name: "demo", packageManager: "yarn@2.1.0" });

    await expect(cmdUp([])).resolves.toBe(0);

    expect(stdout).toBe(
      `Installing yarn@2.4.3 in the project...\n` +
        `Updated ${join(project, "package.json")} to use yarn@${(readManifest().packageManager as string).slice("yarn@".length)}\n` +
        `\n`,
    );
    expect(readManifest().packageManager).toMatch(/^yarn@2\.4\.3\+sha512\./);
  });

  // §03.3 redirected test 112. The declared range still carries `up` across the
  // major boundary — `1.1.0` to `2.4.3` — but it is now the *pin*, not a
  // constraint on one, so §09.4's range branch takes it: the resolution is
  // refreshed in `jup.lock` and the fields are left as the user wrote them. The
  // stale `packageManager` beside it is no longer read (§03.3) and no longer
  // rewritten either.
  it("follows a devEngines range across a major boundary (test 112)", async () => {
    mockYarnRegistry();
    await seed("yarn", "2.4.3");
    await manifest({
      name: "demo",
      packageManager: "yarn@1.1.0",
      devEngines: { packageManager: { name: "yarn", version: "1.x || 2.x" } },
    });

    await expect(cmdUp([])).resolves.toBe(0);

    expect(readManifest().packageManager).toBe("yarn@1.1.0");
    expect(lockfile()).toMatchObject({ "yarn@1.x || 2.x": { resolved: "2.4.3" } });
  });

  it("behaves identically with onFail: ignore (test 113)", async () => {
    mockYarnRegistry();
    await seed("yarn", "2.4.3");
    await manifest({
      name: "demo",
      packageManager: "yarn@1.1.0",
      devEngines: {
        packageManager: { name: "yarn", version: "1.x || 2.x", onFail: "ignore" },
      },
    });

    await cmdUp([]);

    expect(readManifest().packageManager).toBe("yarn@1.1.0");
    expect(lockfile()).toMatchObject({ "yarn@1.x || 2.x": { resolved: "2.4.3" } });
  });

  // §03.7 redirected test 114. It used to assert that `up` on a devEngines-only
  // project *creates* a `packageManager` field — which is #874 exactly: the new
  // field then conflicts with the declaration beside it and the next read fails.
  // The pin now goes where the declaration already is.
  //
  // The declaration is an exact version, because that is the half of the row
  // that is still about *where* the pin lands: a devEngines-declared **range**
  // is a §04.4 pin like any other and is now preserved rather than collapsed —
  // the test below this one.
  it("updates devEngines in place for a devEngines-only project (test 114)", async () => {
    mockYarnRegistry();
    await seed("yarn", "2.4.3");
    await manifest({
      name: "demo",
      devEngines: { packageManager: { name: "yarn", version: "2.1.0" } },
    });

    await cmdUp([]);

    const written = readManifest();
    expect(written.packageManager).toBeUndefined();
    // No `integrity`: this store entry is hand-planted with a placeholder digest
    // that is odd-length hex, which §03.7 cannot spell as SRI. It is kept in the
    // version string rather than dropped — the member is the only home the pin
    // has, so losing it here would silently unpin the project.
    // Conformance row 189 covers the real thing, against downloaded bytes.
    expect(written.devEngines).toEqual({
      packageManager: {
        name: "yarn",
        version: expect.stringMatching(/^2\.4\.3\+sha512\./) as unknown as string,
      },
    });
  });

  /* §04.4 — the range `use` writes is the range `up` refreshes -------- */

  it("keeps a devEngines-only range and refreshes jup.lock instead", async () => {
    mockYarnRegistry();
    await seed("yarn", "2.4.3");
    // Exactly what `jup use yarn@2.x` leaves behind on a project with no
    // top-level field (§03.7): the range in `devEngines`, and nothing else.
    await manifest({
      name: "demo",
      devEngines: { packageManager: { name: "yarn", version: "2.x" } },
    });
    await writeFile(
      join(project, "jup.lock"),
      `${JSON.stringify({ version: 1, resolutions: { "yarn@2.x": { resolved: "2.1.0" } } })}\n`,
    );

    await expect(cmdUp([])).resolves.toBe(0);

    const written = readManifest();
    // The user's statement of intent, untouched — and the resolution it stands
    // for, refreshed. Gated on `hasPin` this collapsed to an exact version and
    // deleted the recorded resolution on the way past.
    expect(written.packageManager).toBeUndefined();
    expect(written.devEngines).toEqual({
      packageManager: { name: "yarn", version: "2.x" },
    });
    expect(lockfile()).toEqual({ "yarn@2.x": { resolved: "2.4.3" } });
    expect(stdout).toContain(`Updated ${join(project, "jup.lock")} to use yarn@2.4.3`);
  });

  // §03.3 — two ranges, and the member is the one that answers. Both fields are
  // left exactly as written; what the refreshed resolution is keyed on is the
  // range jup actually read.
  it("refreshes the devEngines range, not the top-level one, when both declare one", async () => {
    mockYarnRegistry();
    await seed("yarn", "3.0.0");
    await manifest({
      name: "demo",
      packageManager: "yarn@2.x",
      devEngines: { packageManager: { name: "yarn", version: ">=2" } },
    });

    await expect(cmdUp([])).resolves.toBe(0);

    const written = readManifest();
    expect(written.packageManager).toBe("yarn@2.x");
    expect(written.devEngines).toEqual({
      packageManager: { name: "yarn", version: ">=2" },
    });
    // `>=2` reaches 3.0.0, which `yarn@2.x` never would: the member's range is
    // the one being refreshed, and it is the key the proxy path will look up.
    expect(lockfile()).toMatchObject({ "yarn@>=2": { resolved: "3.0.0" } });
  });

  it("retires the memo for the key it just refreshed", async () => {
    mockYarnRegistry();
    await seed("yarn", "2.4.3");
    await manifest({ name: "demo", packageManager: "yarn@2.x" });
    // A memo an ordinary run left behind, still well inside its 24-hour window.
    await memo({ "yarn@2.x": { resolved: "2.1.0", expires: Date.now() + 60_000 } });

    await expect(cmdUp([])).resolves.toBe(0);

    expect(lockfile()).toEqual({ "yarn@2.x": { resolved: "2.4.3" } });
    // Left behind, it would answer alone in every state where the recorded file
    // is not visible — an uncommitted `up`, a `git stash`, a CI cache holding
    // `node_modules` but not the lockfile — and the project would go on running
    // the version this command just replaced.
    expect(existsSync(join(project, "node_modules", ".jup", "jup.lock"))).toBe(false);
  });

  it("refreshes on the devEngines range when the pin is too malformed to read", async () => {
    mockYarnRegistry();
    await seed("yarn", "2.4.3");
    // A non-string `packageManager` beside a usable range. §03.3 reads the
    // member, so the unreadable field never has to be interpreted at all, and
    // §09.4 refreshes the range's resolution. `onFail: warn` is what keeps the
    // name mismatch against `42` a warning rather than the error test 110 covers.
    await manifest({
      name: "demo",
      packageManager: 42,
      devEngines: { packageManager: { name: "yarn", version: "2.x", onFail: "warn" } },
    });

    await expect(cmdUp([])).resolves.toBe(0);

    expect(lockfile()).toMatchObject({ "yarn@2.x": { resolved: "2.4.3" } });
    // Untouched: a range pin refreshes `jup.lock` and writes no field (§09.4).
    expect(readManifest().packageManager).toBe(42);
  });

  it("does not consult the cache, or it could never update anything", async () => {
    mockYarnRegistry();
    await seed("yarn", "2.1.0");
    await seed("yarn", "2.4.3");
    await manifest({ name: "demo", packageManager: "yarn@2.1.0" });

    await cmdUp([]);

    // 2.1.0 is installed and satisfies the pin; only `useCache: false` gets past it.
    expect(readManifest().packageManager).toMatch(/^yarn@2\.4\.3\+/);
    expect(requested.length).toBeGreaterThan(0);
  });

  it("refuses a non-semver pin (test 115)", async () => {
    await manifest({ name: "demo", packageManager: "yarn@stable" });

    const error = await rejection(cmdUp([]));

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toBe(
      `The 'jup up' command can only be used when your project's packageManager field is set to a semver version or semver range`,
    );
    expect(stdout).toBe("");
    expect(requested).toEqual([]);
  });

  it("takes no arguments", async () => {
    await expect(cmdUp(["yarn@2"])).rejects.toBeInstanceOf(UsageError);
  });
});

/* ------------------------------------------------------------------ *
 * §09.10 and dispatch
 * ------------------------------------------------------------------ */

describe("--version, --help and dispatch (§09.10, test 146)", () => {
  it("prints the tool's own version", async () => {
    const own = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    await expect(runManagementCommand(["--version"])).resolves.toBe(0);

    expect(stdout).toBe(`${own.version}\n`);
    expect(stderr).toBe("");
  });

  it("prints the command surface for --help, -h, help and no arguments", async () => {
    for (const args of [["--help"], ["-h"], ["help"], []]) {
      stdout = "";
      await expect(runManagementCommand(args)).resolves.toBe(0);
      expect(stdout).toContain(`jup use [--here] [--pin-style=suffix|sidecar] <name[@<version>]>`);
      expect(stdout).toContain(`jup cache clean`);
      expect(stderr).toBe("");
    }
  });

  it("reports an unknown command as a usage error", async () => {
    await expect(runManagementCommand(["frobnicate"])).rejects.toBeInstanceOf(UsageError);
  });

  it("keeps a usage line for every command it dispatches", () => {
    for (const command of ["cache", "install", "pack", "up", "use"]) {
      expect(USAGE_LINES[command]).toMatch(/^\$ jup /);
    }
  });

  it("routes install to the global command only when -g or --global is present", async () => {
    await seed("yarn", "2.2.2");
    await manifest({ packageManager: "yarn@2.2.2" });

    await runManagementCommand(["install"]);
    expect(stdout).toBe(`Adding yarn@2.2.2 to the cache...\n`);
    expect(lastKnownGood()).toEqual({});

    stdout = "";
    await runManagementCommand(["install", "-g", "yarn@2.2.2"]);
    expect(stdout).toBe(`Installing yarn@2.2.2...\n`);
    expect(lastKnownGood().yarn).toMatch(/^2\.2\.2\+sha512\./);
  });
});
