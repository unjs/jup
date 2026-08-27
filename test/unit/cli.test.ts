import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

// `exec.ts` hands the process over to the package manager for real — it rewrites
// `process.argv` and imports the entry point on `nextTick`. Every assertion here
// is about *what* would be run, so the handover itself is mocked out.
vi.mock("../../src/run/exec.ts", () => ({
  // `0` mirrors the real JavaScript path (§08.4): the package manager sets the
  // exit code from its own module body afterwards, so handover itself answers 0.
  // §15.28's native path is the one that returns a promise of a real code.
  execPackageManager: vi.fn(() => 0),
  resolveBinPath: vi.fn(),
}));

import {
  cmdCache,
  cmdHydrate,
  cmdInstall,
  cmdInstallGlobal,
  cmdPack,
  cmdPrepare,
  cmdUp,
  cmdUse,
  resolvePatternsToDescriptors,
  runManagementCommand,
} from "../../src/commands/cli.ts";
import { messages, UsageError } from "../../src/errors-cold.ts";
import { execPackageManager } from "../../src/run/exec.ts";
import { create } from "../../src/cache/tar.ts";
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
  "COREPACK_ALLOW_UNVERIFIED",
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

beforeEach(async () => {
  savedEnv = process.env;
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }

  home = await mkdtemp(join(tmpdir(), "jup-cli-home-"));
  project = await mkdtemp(join(tmpdir(), "jup-cli-proj-"));
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

function lastKnownGood(): Record<string, string> {
  const file = join(home, "lastKnownGood.json");
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
}

async function writeLastKnownGood(value: Record<string, string>): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "lastKnownGood.json"), JSON.stringify(value));
}

/** The two registry documents the yarn table entry reads (§05.2, §05.3). */
function mockYarnRegistry(): void {
  routes["/yarn"] = {
    name: "yarn",
    "dist-tags": { latest: "1.22.22" },
    versions: { "1.0.0": {}, "1.22.4": {}, "1.22.22": {} },
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

  it("keeps the deprecated prepare wording free of devEngines (§09.10)", async () => {
    await manifest({ name: "no-spec" });

    const error = await rejection(cmdPrepare([]));
    expect(error.message).toBe(
      `The local project doesn't feature a 'packageManager' field - please specify the package manager to pack, or update the manifest to reference it`,
    );
    expect(error.message).toBe(messages.noSpecInProjectLegacy());
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
   * The case above installs from the store, where §04.7's bump is never reached
   * at all. This one downloads, which is where the two rules collide: §04.7
   * bumps after any successful install, §09.2 says this command leaves the file
   * alone. §09.2 is the specific statement and wins — warming a Docker layer
   * must not silently repoint the machine's default.
   */
  it("does not bump last-known-good on a cold install either", async () => {
    routes["/2.2.2/packages/yarnpkg-cli/bin/yarn.js"] = { fake: "yarn" };
    // §15.11 redirected this row: Berry from `repo.yarnpkg.com` has no
    // signature and this fixture pins no hash, so the artifact clears no
    // verification tier. The opt-out keeps the row about what it is about —
    // §09.2 not touching `lastKnownGood.json` on a cold install.
    process.env.COREPACK_ALLOW_UNVERIFIED = "1";
    await writeLastKnownGood({ yarn: "2.1.0" });
    await manifest({ packageManager: "yarn@2.2.2" });

    await expect(cmdInstall([])).resolves.toBe(0);

    // It really did download: the store was empty before this ran.
    expect(existsSync(join(home, "v1", "yarn", "2.2.2", ".jup"))).toBe(true);
    // Same major and strictly upward, so §04.7 alone would have advanced it.
    expect(lastKnownGood()).toEqual({ yarn: "2.1.0" });
  });

  it("refuses positional arguments", async () => {
    await manifest({ packageManager: "yarn@2.2.2" });
    await expect(cmdInstall(["yarn@2.2.2"])).rejects.toBeInstanceOf(UsageError);
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
    const fresh = await mkdtemp(join(tmpdir(), "jup-cli-home2-"));
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
    const source = await mkdtemp(join(tmpdir(), "jup-cli-other-"));
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
    const source = await mkdtemp(join(tmpdir(), "jup-cli-short-"));
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

  it("refuses an archive naming a package manager this build doesn't support", async () => {
    const source = await mkdtemp(join(tmpdir(), "jup-cli-bogus-"));
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
    // §15.35l redirected this assertion. It used to require `stdout === ""`,
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
});

/* ------------------------------------------------------------------ *
 * §09.5 — use
 * ------------------------------------------------------------------ */

describe("use (§09.5, tests 105-110)", () => {
  it("writes a hash-bearing pin and runs the package manager (test 105)", async () => {
    await seed("yarn", "1.22.4");
    await manifest({ name: "demo", packageManager: "yarn@1.0.0" });

    await expect(cmdUse(["yarn@1.22.4"])).resolves.toBe(0);

    // §15.35l — the banner, then the path that was modified, then the blank
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
    expect(readManifest().packageManager).toMatch(/^yarn@1\.22\.4\+sha512\./);
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

  it("surfaces a devEngines mismatch after the banner, on stdout (test 110)", async () => {
    await seed("yarn", "1.22.4");
    await manifest({
      name: "demo",
      devEngines: { packageManager: { name: "yarn", version: "2.x" } },
    });

    const error = await rejection(cmdUse(["yarn@1.22.4"]));

    expect(error).toBeInstanceOf(UsageError);
    expect(error.message).toMatch(
      /^The requested version of yarn@1\.22\.4\+sha512\..* does not match the devEngines specification \(yarn@2\.x\)$/,
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

    expect(readManifest().packageManager).toMatch(/^yarn@2\.4\.3\+sha512\./);
  });

  it("requires exactly one pattern", async () => {
    await expect(cmdUse([])).rejects.toBeInstanceOf(UsageError);
    await expect(cmdUse(["yarn@1", "pnpm@9"])).rejects.toBeInstanceOf(UsageError);
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

  it("follows a devEngines range across a major boundary (test 112)", async () => {
    mockYarnRegistry();
    await seed("yarn", "2.4.3");
    await manifest({
      name: "demo",
      packageManager: "yarn@1.1.0",
      devEngines: { packageManager: { name: "yarn", version: "1.x || 2.x" } },
    });

    await expect(cmdUp([])).resolves.toBe(0);

    expect(readManifest().packageManager).toMatch(/^yarn@2\.4\.3\+sha512\./);
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

    expect(readManifest().packageManager).toMatch(/^yarn@2\.4\.3\+sha512\./);
  });

  // §15.26 redirected test 114. It used to assert that `up` on a devEngines-only
  // project *creates* a `packageManager` field — which is #874 exactly: the new
  // field then conflicts with the declaration beside it and the next read fails.
  // The pin now goes where the declaration already is.
  it("updates devEngines in place for a devEngines-only project (test 114)", async () => {
    mockYarnRegistry();
    await seed("yarn", "2.4.3");
    await manifest({
      name: "demo",
      devEngines: { packageManager: { name: "yarn", version: "2.x" } },
    });

    await cmdUp([]);

    const written = readManifest();
    expect(written.packageManager).toBeUndefined();
    // No `integrity`: this store entry is hand-planted with a placeholder digest
    // that is not valid hex, and an unusable digest is recorded as none at all.
    // Conformance row 189 covers the real thing, against downloaded bytes.
    expect(written.devEngines).toEqual({
      packageManager: { name: "yarn", version: "2.4.3" },
    });
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
 * §09.10 — deprecated commands
 * ------------------------------------------------------------------ */

describe("hydrate and prepare (§09.10)", () => {
  it("hydrate names 'corepack prepare' in its format error", async () => {
    const source = await mkdtemp(join(tmpdir(), "jup-cli-hyd-"));
    await mkdir(join(source, "stuff"), { recursive: true });
    await writeFile(join(source, "stuff", "readme.txt"), "nope\n");
    const archive = join(project, "legacy.tgz");
    await create(source, ["stuff"], archive);

    const error = await rejection(cmdHydrate([archive]));
    expect(error.message).toBe(`Invalid archive format; did it get generated by 'jup prepare'?`);

    await rm(source, { recursive: true, force: true });
  });

  it("hydrate opts in to activation and says All done!", async () => {
    await seed("yarn", "2.2.2");
    await cmdPack(["yarn@2.2.2"]);
    const archive = join(project, "jup.tgz");

    const fresh = await mkdtemp(join(tmpdir(), "jup-cli-home3-"));
    process.env.COREPACK_HOME = fresh;
    process.env.COREPACK_ENABLE_NETWORK = "0";

    // No `--activate`: cached, but not the default. Note there is no `.tgz`
    // extension check on the argument either (§09.10).
    stdout = "";
    await expect(cmdHydrate([archive])).resolves.toBe(0);
    expect(stdout).toBe(`Adding yarn@2.2.2 to the cache...\nAll done!\n`);
    expect(existsSync(join(fresh, "lastKnownGood.json"))).toBe(false);

    // With `--activate` it becomes the recorded default.
    stdout = "";
    await expect(cmdHydrate(["--activate", archive])).resolves.toBe(0);
    expect(stdout).toBe(`Installing yarn@2.2.2...\nAll done!\n`);
    expect(
      JSON.parse(readFileSync(join(fresh, "lastKnownGood.json"), "utf8")) as Record<string, string>,
    ).toEqual({ yarn: "2.2.2" });

    await rm(fresh, { recursive: true, force: true });
  });

  it("prepare tolerates a bare --output flag, defaulting to jup.tgz", async () => {
    await seed("yarn", "2.2.2");

    // Bare: the following token is a spec, not a path, so the default is used.
    await expect(cmdPrepare(["--output", "yarn@2.2.2"])).resolves.toBe(0);

    expect(existsSync(join(project, "jup.tgz"))).toBe(true);
    expect(stdout).toContain(`All done!`);

    // With a value, `=` disambiguates it from the spec list.
    const custom = join(project, "custom.tgz");
    await expect(cmdPrepare([`--output=${custom}`, "yarn@2.2.2"])).resolves.toBe(0);
    expect(existsSync(custom)).toBe(true);
  });

  it("prepare writes no archive when --output is absent, and only activates on demand", async () => {
    await seed("yarn", "2.2.2");

    await cmdPrepare(["yarn@2.2.2"]);
    expect(existsSync(join(project, "jup.tgz"))).toBe(false);
    expect(lastKnownGood()).toEqual({});

    await cmdPrepare(["--activate", "yarn@2.2.2"]);
    expect(lastKnownGood().yarn).toMatch(/^2\.2\.2\+sha512\./);
  });
});

/* ------------------------------------------------------------------ *
 * §09.9 and dispatch
 * ------------------------------------------------------------------ */

describe("--version, --help and dispatch (§09.9, test 146)", () => {
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
    for (const command of ["cache", "install", "pack", "up", "use", "hydrate", "prepare"]) {
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
