import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messages, UsageError, VALIDATION_WARNING_PREFIX } from "../../src/errors.ts";
import {
  discoverProjectSpec,
  NODE_MODULES_RE,
  parseSpec,
  readSpecFromManifest,
  reconcile,
  warnOrThrow,
  writePin,
} from "../../src/manifest.ts";
import type { LazyLocator, SpecResult } from "../../src/types.ts";

let root: string;
let originalEnv: NodeJS.ProcessEnv;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  originalEnv = process.env;
  // Work on a copy: `discoverProjectSpec` replaces `process.env` when it applies
  // an env file, and that must not leak between tests.
  process.env = { ...process.env };
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("COREPACK_")) {
      delete process.env[key];
    }
  }
  root = realpathSync(mkdtempSync(join(tmpdir(), "pipack-manifest-")));
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  process.env = originalEnv;
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Write `<root>/<relPath>`, creating parents. Returns the absolute path. */
function write(relPath: string, content: string): string {
  const path = join(root, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** Write a `package.json` in `<root>/<relDir>`. Returns its absolute path. */
function manifest(relDir: string, data: unknown): string {
  return write(join(relDir, "package.json"), `${JSON.stringify(data, undefined, 2)}\n`);
}

function dir(relDir: string): string {
  const path = join(root, relDir);
  mkdirSync(path, { recursive: true });
  return path;
}

/** Exact-message assertion: `toThrow(string)` only does a substring match. */
function expectUsageError(fn: () => unknown, message: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected a UsageError: ${message}`).toBeInstanceOf(UsageError);
  expect((caught as Error).message).toBe(message);
}

function lazyFallback(name = "yarn"): LazyLocator {
  return { name, reference: () => Promise.resolve("9.9.9") };
}

const EXACT = { enforceExactVersion: true };
const LOOSE = { enforceExactVersion: false };

describe("parseSpec — §03.4", () => {
  it("splits on the first @", () => {
    expect(parseSpec("yarn@1.22.4", "package.json", EXACT)).toEqual({
      name: "yarn",
      range: "1.22.4",
    });
  });

  it("rejects a non-string field", () => {
    for (const raw of [42, null, {}, ["yarn@1.22.4"]]) {
      expectUsageError(
        () => parseSpec(raw, "package.json", EXACT),
        messages.invalidSpecNotString("package.json"),
      );
    }
  });

  // Test 2 / test 5.
  it("rejects a name with no version when an exact version is required", () => {
    expectUsageError(
      () => parseSpec("yarn", "package.json", EXACT),
      `No version specified for yarn in "packageManager" of package.json`,
    );
    expectUsageError(
      () => parseSpec("yarn@", "package.json", EXACT),
      `No version specified for yarn@ in "packageManager" of package.json`,
    );
  });

  it("accepts a name with no version as `*` when exactness is not required", () => {
    expect(parseSpec("yarn", "CLI arguments", LOOSE)).toEqual({ name: "yarn", range: "*" });
    expect(parseSpec("yarn@", "CLI arguments", LOOSE)).toEqual({ name: "yarn", range: "*" });
  });

  it("reports the bare name for an unsupported name-only spec", () => {
    expectUsageError(
      () => parseSpec("nope", "CLI arguments", LOOSE),
      messages.unsupportedSpec("nope"),
    );
    expectUsageError(
      () => parseSpec("nope@", "CLI arguments", LOOSE),
      messages.unsupportedSpec("nope"),
    );
  });

  // Test 3 / test 4.
  it("rejects tags and ranges in a pin", () => {
    expectUsageError(
      () => parseSpec("yarn@stable", "package.json", EXACT),
      messages.invalidSpecExpectedVersion("package.json", "yarn@stable"),
    );
    expectUsageError(
      () => parseSpec("yarn@^1.0.0", "package.json", EXACT),
      messages.invalidSpecExpectedVersion("package.json", "yarn@^1.0.0"),
    );
    expect(parseSpec("yarn@^1.0.0", "CLI arguments", LOOSE)).toEqual({
      name: "yarn",
      range: "^1.0.0",
    });
  });

  it("reports the raw string for an unsupported version-bearing spec", () => {
    expectUsageError(
      () => parseSpec("nope@1.0.0", "CLI arguments", LOOSE),
      messages.unsupportedSpec("nope@1.0.0"),
    );
  });

  it("gives a scoped name an empty name, which fails the supported check", () => {
    expectUsageError(
      () => parseSpec("@scope/pkg@1.0.0", "CLI arguments", LOOSE),
      messages.unsupportedSpec("@scope/pkg@1.0.0"),
    );
    expectUsageError(
      () => parseSpec("@scope/pkg@1.0.0", "package.json", EXACT),
      messages.invalidSpecExpectedVersion("package.json", "@scope/pkg@1.0.0"),
    );
  });

  // Tests 17, 18, 19.
  it("refuses a URL for a known package manager without the opt-in", () => {
    const raw = "yarn@https://registry.example.test/yarn-1.22.21.tgz";
    expectUsageError(() => parseSpec(raw, "CLI arguments", LOOSE), messages.illegalUrl(raw));

    process.env.COREPACK_ENABLE_UNSAFE_CUSTOM_URLS = "1";
    expect(parseSpec(raw, "CLI arguments", LOOSE)).toEqual({
      name: "yarn",
      range: "https://registry.example.test/yarn-1.22.21.tgz",
    });
  });

  it("allows a URL for an unknown package manager", () => {
    expect(parseSpec("custom@https://example.test/x.tgz", "CLI arguments", LOOSE)).toEqual({
      name: "custom",
      range: "https://example.test/x.tgz",
    });
  });
});

describe("the upward walk — §03.1", () => {
  it("matches only the last segment pair of a node_modules path", () => {
    expect(NODE_MODULES_RE.test("/a/node_modules/foo")).toBe(true);
    expect(NODE_MODULES_RE.test("/a/node_modules/@scope/foo")).toBe(true);
    expect(NODE_MODULES_RE.test("/a/node_modules/foo/src")).toBe(false);
    expect(NODE_MODULES_RE.test("/a/node_modules")).toBe(false);
  });

  // Test 1.
  it("finds a pin in the current directory", () => {
    const target = manifest(".", { packageManager: "yarn@1.22.4" });
    const result = discoverProjectSpec(root);

    expect(result.type).toBe("Found");
    expect(result.target).toBe(target);
    expect((result as Extract<SpecResult, { type: "Found" }>).getSpec(EXACT)).toEqual({
      name: "yarn",
      range: "1.22.4",
    });
  });

  // Test 6.
  it("ignores a vendored manifest inside node_modules", () => {
    const target = manifest(".", { packageManager: "yarn@1.22.4" });
    manifest("node_modules/foo", { packageManager: "pnpm@6.6.2" });

    const result = discoverProjectSpec(join(root, "node_modules", "foo"));
    expect(result.target).toBe(target);
  });

  // Test 7.
  it("ignores a vendored scoped manifest inside node_modules", () => {
    const target = manifest(".", { packageManager: "yarn@1.22.4" });
    manifest("node_modules/@scope/foo", { packageManager: "pnpm@6.6.2" });

    const result = discoverProjectSpec(join(root, "node_modules", "@scope", "foo"));
    expect(result.target).toBe(target);
  });

  it("does not skip a subdirectory of a vendored package", () => {
    manifest(".", { packageManager: "yarn@1.22.4" });
    const nested = manifest("node_modules/foo/src", { packageManager: "pnpm@6.6.2" });

    const result = discoverProjectSpec(join(root, "node_modules", "foo", "src"));
    expect(result.target).toBe(nested);
  });

  // Test 8.
  it("lets the closest manifest with a pin win", () => {
    manifest(".", { packageManager: "yarn@1.22.4" });
    const closest = manifest("foo", { packageManager: "npm@6.14.2" });

    const result = discoverProjectSpec(join(root, "foo")) as Extract<SpecResult, { type: "Found" }>;
    expect(result.target).toBe(closest);
    expect(result.getSpec(EXACT)).toEqual({ name: "npm", range: "6.14.2" });
  });

  it("climbs past a manifest without a pin", () => {
    const rootManifest = manifest(".", { packageManager: "yarn@1.22.4" });
    manifest("packages/app", { name: "app" });

    const result = discoverProjectSpec(join(root, "packages", "app")) as Extract<
      SpecResult,
      { type: "Found" }
    >;
    expect(result.target).toBe(rootManifest);
    expect(result.getSpec(EXACT)).toEqual({ name: "yarn", range: "1.22.4" });
  });

  it("targets the ROOT manifest when nothing in a monorepo declares a pin", () => {
    const rootManifest = manifest(".", { name: "monorepo" });
    manifest("packages/app", { name: "app" });

    const result = discoverProjectSpec(join(root, "packages", "app"));
    expect(result.type).toBe("NoSpec");
    // The *last* manifest seen is the selection, not the closest one.
    expect(result.target).toBe(rootManifest);
  });

  // Test 9.
  it("reports NoProject when there is no manifest anywhere", () => {
    const cwd = dir("empty");
    const result = discoverProjectSpec(cwd);

    expect(result.type).toBe("NoProject");
    expect(result.target).toBe(join(cwd, "package.json"));
  });

  // Test 10.
  it("reports NoSpec for an empty object manifest", () => {
    const target = manifest(".", {});
    const result = discoverProjectSpec(root);

    expect(result.type).toBe("NoSpec");
    expect(result.target).toBe(target);
  });

  // Test 11.
  it("rejects invalid JSON, naming the path relative to the initial cwd", () => {
    write("package.json", "{ this is not json");
    expectUsageError(() => discoverProjectSpec(root), messages.invalidPackageJson("package.json"));

    const nested = dir("packages/app");
    expectUsageError(
      () => discoverProjectSpec(nested),
      messages.invalidPackageJson(join("..", "..", "package.json")),
    );
  });

  it("rejects a manifest that is not an object", () => {
    write("package.json", `"yarn@1.22.4"`);
    expectUsageError(() => discoverProjectSpec(root), messages.invalidPackageJson("package.json"));
  });

  // Test 12.
  it("parses a manifest carrying a UTF-8 BOM", () => {
    write(
      "package.json",
      `\uFEFF${JSON.stringify({ packageManager: "yarn@1.22.4" }, undefined, 2)}\n`,
    );

    const result = discoverProjectSpec(root) as Extract<SpecResult, { type: "Found" }>;
    expect(result.getSpec(EXACT)).toEqual({ name: "yarn", range: "1.22.4" });
  });

  it("defers spec validation until getSpec is called (test 109)", () => {
    for (const packageManager of ["yarn@^1", "yarn", "yarn@", 42]) {
      manifest(".", { packageManager });
      // Discovery itself must not throw — `use` overwrites this field.
      const result = discoverProjectSpec(root) as Extract<SpecResult, { type: "Found" }>;
      expect(result.type).toBe("Found");
      expect(() => result.getSpec(EXACT)).toThrow(UsageError);
    }
  });

  describe("env files — §03.2", () => {
    it("loads the closest env file before reading the manifest", () => {
      manifest(".", { packageManager: "yarn@1.22.4" });
      write(".corepack.env", "COREPACK_ENABLE_AUTO_PIN=1\n");

      const result = discoverProjectSpec(root);
      expect(result.envFilePath).toBe(join(root, ".corepack.env"));
      expect(process.env.COREPACK_ENABLE_AUTO_PIN).toBe("1");
    });

    it("prefers the closest env file and stops looking", () => {
      manifest(".", { name: "monorepo" });
      write(".corepack.env", "COREPACK_NPM_REGISTRY=https://root.test\n");
      dir("sub");
      write("sub/.corepack.env", "COREPACK_NPM_REGISTRY=https://sub.test\n");

      discoverProjectSpec(join(root, "sub"));
      expect(process.env.COREPACK_NPM_REGISTRY).toBe("https://sub.test");
    });

    it("never reads an env file from inside node_modules", () => {
      manifest(".", { packageManager: "yarn@1.22.4" });
      write("node_modules/foo/.corepack.env", "COREPACK_NPM_REGISTRY=https://vendored.test\n");

      const result = discoverProjectSpec(join(root, "node_modules", "foo"));
      expect(result.envFilePath).toBeUndefined();
      expect(process.env.COREPACK_NPM_REGISTRY).toBeUndefined();
    });

    it("never reaches an env file above the manifest that stopped the walk", () => {
      write(".corepack.env", "COREPACK_NPM_REGISTRY=https://root.test\n");
      manifest("sub", { packageManager: "yarn@1.22.4" });

      const result = discoverProjectSpec(join(root, "sub"));
      expect(result.envFilePath).toBeUndefined();
      expect(process.env.COREPACK_NPM_REGISTRY).toBeUndefined();
    });

    it("skips env files entirely when COREPACK_ENV_FILE=0", () => {
      manifest(".", { packageManager: "yarn@1.22.4" });
      write(".corepack.env", "COREPACK_ENABLE_AUTO_PIN=1\n");
      process.env.COREPACK_ENV_FILE = "0";

      const result = discoverProjectSpec(root);
      expect(result.envFilePath).toBeUndefined();
      expect(process.env.COREPACK_ENABLE_AUTO_PIN).toBeUndefined();
    });

    it("envOnly loads the env file and never reads a manifest", () => {
      manifest(".", { packageManager: "yarn@1.22.4" });
      write(".corepack.env", "COREPACK_ENABLE_AUTO_PIN=1\n");

      const result = discoverProjectSpec(root, { envOnly: true });
      expect(result.type).toBe("NoProject");
      expect(result.envFilePath).toBe(join(root, ".corepack.env"));
      expect(process.env.COREPACK_ENABLE_AUTO_PIN).toBe("1");
    });

    it("envOnly terminates at the filesystem root when no env file exists", () => {
      const result = discoverProjectSpec(dir("deep/nested"), { envOnly: true });
      expect(result.type).toBe("NoProject");
      expect(result.envFilePath).toBeUndefined();
    });
  });
});

describe("devEngines — §03.3", () => {
  const read = (data: unknown) => readSpecFromManifest(data, join(root, "package.json"));

  it("ignores an absent or null devEngines.packageManager", () => {
    expect(read({ packageManager: "yarn@1.22.4" })).toEqual({ raw: "yarn@1.22.4" });
    expect(read({ devEngines: {} })).toEqual({ raw: undefined });
    expect(read({ devEngines: { packageManager: null } })).toEqual({ raw: undefined });
  });

  // Test 22.
  it("derives `<name>@*` when only a name is declared", () => {
    manifest(".", { devEngines: { packageManager: { name: "yarn" } } });

    const result = discoverProjectSpec(root) as Extract<SpecResult, { type: "Found" }>;
    expect(result.range).toBeUndefined();
    expectUsageError(
      () => result.getSpec(EXACT),
      messages.invalidSpecExpectedVersion("package.json", "yarn@*"),
    );
  });

  // Test 23.
  it("derives `<name>@<range>` when a version is declared", () => {
    manifest(".", { devEngines: { packageManager: { name: "pnpm", version: "6.x" } } });

    const result = discoverProjectSpec(root) as Extract<SpecResult, { type: "Found" }>;
    expect(result.range).toEqual({ name: "pnpm", range: "6.x", onFail: undefined });
    expectUsageError(
      () => result.getSpec(EXACT),
      messages.invalidSpecExpectedVersion("package.json", "pnpm@6.x"),
    );
  });

  // Test 24.
  it("lets a matching packageManager win", () => {
    const pm = "pnpm@6.6.2+sha224.1111111111111111111111111111111111111111111111111111111";
    expect(
      read({
        packageManager: pm,
        devEngines: { packageManager: { name: "pnpm", version: "6.x" } },
      }),
    ).toEqual({
      raw: pm,
      range: { name: "pnpm", range: "6.x", onFail: undefined },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  // Test 25.
  it("imposes no constraint when devEngines declares no version", () => {
    const pm = "pnpm@6.6.2+sha224.abc";
    expect(read({ packageManager: pm, devEngines: { packageManager: { name: "pnpm" } } })).toEqual({
      raw: pm,
      range: undefined,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  // Test 26.
  it("rejects a version that is not a semver range", () => {
    expectUsageError(
      () => read({ devEngines: { packageManager: { name: "yarn", version: "yarn@1.x" } } }),
      `The value of devEngines.packageManager.version "yarn@1.x" is not a valid semver range`,
    );
  });

  // Test 21.
  it("rejects a URL as a devEngines version", () => {
    const url = "https://example.test/yarn.tgz";
    expectUsageError(
      () => read({ devEngines: { packageManager: { name: "yarn", version: url } } }),
      messages.devEnginesBadVersion(url),
    );
  });

  it("rejects a non-string version", () => {
    expectUsageError(
      () => read({ devEngines: { packageManager: { name: "yarn", version: 1 } } }),
      messages.devEnginesBadVersion(1),
    );
  });

  it("rejects a name that is not a plain string", () => {
    expectUsageError(
      () => read({ devEngines: { packageManager: { name: 42 } } }),
      messages.devEnginesBadName(42),
    );
    expectUsageError(
      () => read({ devEngines: { packageManager: { name: "yarn@1.22.4" } } }),
      messages.devEnginesBadName("yarn@1.22.4"),
    );
  });

  // Test 27 — always warns, never throws, whatever onFail says.
  it("warns unconditionally on an array value", () => {
    const pm = "pnpm@6.6.2";
    // `onFail: "error"` inside the array is deliberately ignored: this branch
    // never throws, whatever the value says.
    expect(
      read({
        packageManager: pm,
        devEngines: { packageManager: [{ name: "yarn", onFail: "error" }] },
      }),
    ).toEqual({ raw: pm });
    expect(warn).toHaveBeenCalledWith(messages.devEnginesArray());
  });

  // Tests 28, 29 — also unconditional.
  it("warns unconditionally on a non-object value", () => {
    expect(
      read({ packageManager: "pnpm@6.6.2", devEngines: { packageManager: "pnpm@10.x" } }),
    ).toEqual({
      raw: "pnpm@6.6.2",
    });
    expect(warn).toHaveBeenCalledWith(
      `! Corepack only supports objects as valid value for devEngines.packageManager. The current value ("pnpm@10.x") will be ignored.`,
    );

    warn.mockClear();
    expect(read({ devEngines: { packageManager: 10 } })).toEqual({ raw: undefined });
    expect(warn).toHaveBeenCalledWith(
      `! Corepack only supports objects as valid value for devEngines.packageManager. The current value (10) will be ignored.`,
    );
  });

  const nameMismatch = (onFail?: string) => ({
    packageManager: "pnpm@6.6.2",
    devEngines: { packageManager: { name: "yarn", ...(onFail === undefined ? {} : { onFail }) } },
  });
  const nameMismatchMessage = `"packageManager" field is set to "pnpm@6.6.2" which does not match the "devEngines.packageManager" field set to "yarn"`;

  // Test 30.
  it("stays silent on a mismatch with onFail: ignore", () => {
    expect(read(nameMismatch("ignore"))).toEqual({ raw: "pnpm@6.6.2", range: undefined });
    expect(warn).not.toHaveBeenCalled();
  });

  // Test 31.
  it("warns on a name mismatch with onFail: warn", () => {
    expect(read(nameMismatch("warn"))).toEqual({ raw: "pnpm@6.6.2", range: undefined });
    expect(warn).toHaveBeenCalledWith(`${VALIDATION_WARNING_PREFIX}${nameMismatchMessage}`);
  });

  // Tests 32, 33.
  it("throws on a name mismatch with onFail: error and with onFail omitted", () => {
    expectUsageError(() => read(nameMismatch("error")), nameMismatchMessage);
    expectUsageError(() => read(nameMismatch()), nameMismatchMessage);
  });

  it("degrades an unrecognised onFail to a warning", () => {
    expect(read(nameMismatch("explode"))).toEqual({ raw: "pnpm@6.6.2", range: undefined });
    expect(warn).toHaveBeenCalledWith(`${VALIDATION_WARNING_PREFIX}${nameMismatchMessage}`);
  });

  it("treats a non-string packageManager as a name mismatch", () => {
    expectUsageError(
      () => read({ packageManager: 42, devEngines: { packageManager: { name: "yarn" } } }),
      messages.devEnginesNameMismatch(42, "yarn"),
    );
  });

  const versionMismatch = (onFail?: string) => ({
    packageManager: "pnpm@6.6.2",
    devEngines: {
      packageManager: {
        name: "pnpm",
        version: "10.x",
        ...(onFail === undefined ? {} : { onFail }),
      },
    },
  });
  const versionMismatchMessage = `"packageManager" field is set to "pnpm@6.6.2" which does not match the value defined in "devEngines.packageManager" for "pnpm" of "10.x"`;

  // Test 34.
  it("warns on a version mismatch with onFail: warn", () => {
    expect(read(versionMismatch("warn"))).toEqual({
      raw: "pnpm@6.6.2",
      range: { name: "pnpm", range: "10.x", onFail: "warn" },
    });
    expect(warn).toHaveBeenCalledWith(`${VALIDATION_WARNING_PREFIX}${versionMismatchMessage}`);
  });

  // Test 35.
  it("throws on a version mismatch with no onFail", () => {
    expectUsageError(() => read(versionMismatch()), versionMismatchMessage);
  });

  // Test 37 — build metadata is ignored, so conflicting hashes are not a
  // devEngines failure; `packageManager`'s hash stays authoritative.
  it("ignores hash suffixes when cross-checking", () => {
    expect(
      read({
        packageManager: "pnpm@6.6.2+sha1.11111",
        devEngines: { packageManager: { name: "pnpm", version: "6.6.2+sha1.22222" } },
      }),
    ).toEqual({
      raw: "pnpm@6.6.2+sha1.11111",
      range: { name: "pnpm", range: "6.6.2+sha1.22222", onFail: undefined },
    });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("warnOrThrow — §03.3", () => {
  it("ignores, throws, and warns per onFail", () => {
    expect(() => warnOrThrow("boom", "ignore")).not.toThrow();
    expect(warn).not.toHaveBeenCalled();

    expectUsageError(() => warnOrThrow("boom", "error"), "boom");
    expectUsageError(() => warnOrThrow("boom"), "boom");
    expectUsageError(() => warnOrThrow("boom", undefined), "boom");

    warnOrThrow("boom", "warn");
    expect(warn).toHaveBeenCalledWith(`${VALIDATION_WARNING_PREFIX}boom`);

    warn.mockClear();
    warnOrThrow("boom", { nonsense: true });
    expect(warn).toHaveBeenCalledWith(`${VALIDATION_WARNING_PREFIX}boom`);
  });
});

describe("reconcile — §03.5", () => {
  const found = (packageManager: string) => {
    manifest(".", { packageManager });
    return discoverProjectSpec(root);
  };

  it("returns the fallback when there is no project", () => {
    const fallback = lazyFallback();
    const result = discoverProjectSpec(dir("empty"));
    expect(reconcile(result, fallback, { requestedName: "yarn", transparent: false })).toBe(
      fallback,
    );
  });

  it("returns the fallback when the project has no spec", () => {
    manifest(".", {});
    const fallback = lazyFallback();
    expect(
      reconcile(discoverProjectSpec(root), fallback, { requestedName: "yarn", transparent: false }),
    ).toBe(fallback);
  });

  it("returns the project's spec when the names match", () => {
    expect(
      reconcile(found("yarn@1.22.4"), lazyFallback(), {
        requestedName: "yarn",
        transparent: false,
      }),
    ).toEqual({ name: "yarn", range: "1.22.4" });
  });

  // Test 39 — the exact message, with the absolute manifest path.
  it("errors with the project-mismatch message", () => {
    const result = found("yarn@1.0.0");
    expectUsageError(
      () => reconcile(result, lazyFallback("pnpm"), { requestedName: "pnpm", transparent: false }),
      `This project is configured to use yarn because ${join(root, "package.json")} has a "packageManager" field`,
    );
  });

  // Test 40.
  it("falls back instead of erroring for a transparent command", () => {
    const fallback = lazyFallback("pnpm");
    expect(
      reconcile(found("yarn@1.0.0"), fallback, { requestedName: "pnpm", transparent: true }),
    ).toBe(fallback);
  });

  it("treats COREPACK_ENABLE_STRICT=0 as transparent", () => {
    const result = found("yarn@1.0.0");
    const fallback = lazyFallback("pnpm");
    process.env.COREPACK_ENABLE_STRICT = "0";

    expect(reconcile(result, fallback, { requestedName: "pnpm", transparent: false })).toBe(
      fallback,
    );
    // The project's own package manager still honours the pin.
    expect(
      reconcile(result, lazyFallback(), { requestedName: "yarn", transparent: false }),
    ).toEqual({ name: "yarn", range: "1.0.0" });
  });

  // Test 41 — the project is never consulted at all.
  it("short-circuits on COREPACK_ENABLE_PROJECT_SPEC=0", () => {
    const result = found("yarn@1.0.0") as Extract<SpecResult, { type: "Found" }>;
    const getSpec = vi.fn(result.getSpec);
    const fallback = lazyFallback();
    process.env.COREPACK_ENABLE_PROJECT_SPEC = "0";

    expect(
      reconcile({ ...result, getSpec }, fallback, { requestedName: "yarn", transparent: false }),
    ).toBe(fallback);
    expect(getSpec).not.toHaveBeenCalled();
  });

  it("lets an explicit CLI version overwrite the range but not the name", () => {
    expect(
      reconcile(found("yarn@4.0.0"), lazyFallback(), {
        requestedName: "yarn",
        transparent: false,
        binaryVersion: "1.22.4",
      }),
    ).toEqual({ name: "yarn", range: "1.22.4" });

    // …and the name still has to match.
    const result = found("yarn@4.0.0");
    expectUsageError(
      () =>
        reconcile(result, lazyFallback("pnpm"), {
          requestedName: "pnpm",
          transparent: false,
          binaryVersion: "9",
        }),
      `This project is configured to use yarn because ${join(root, "package.json")} has a "packageManager" field`,
    );
  });

  it("applies the CLI version to the fallback too", () => {
    expect(
      reconcile(discoverProjectSpec(dir("empty")), lazyFallback(), {
        requestedName: "yarn",
        transparent: false,
        binaryVersion: "1.22.4",
      }),
    ).toEqual({ name: "yarn", range: "1.22.4" });
  });

  // Test 36 — a CLI version relaxes the exactness requirement on the pin.
  it("does not enforce an exact version when a CLI version is given", () => {
    expect(
      reconcile(found("yarn@^1.0.0"), lazyFallback(), {
        requestedName: "yarn",
        transparent: false,
        binaryVersion: "1.22.4",
      }),
    ).toEqual({ name: "yarn", range: "1.22.4" });
  });
});

describe("writePin — §03.7", () => {
  // Test 116.
  it("preserves tab indentation and CRLF line endings", () => {
    const original = [
      "{",
      `\t"name": "demo",`,
      `\t"packageManager": "yarn@1.22.4",`,
      `\t"scripts": {`,
      `\t\t"build": "tsc"`,
      "\t}",
      "}",
      "",
    ].join("\r\n");
    write("package.json", original);

    const { previousPackageManager } = writePin(root, {
      name: "yarn",
      reference: "3.0.0+sha1.abc",
    });
    expect(previousPackageManager).toBe("yarn@1.22.4");

    const updated = readFileSync(join(root, "package.json"), "utf8");
    expect(updated).toBe(original.replace("yarn@1.22.4", "yarn@3.0.0+sha1.abc"));
    expect(updated).toContain("\r\n");
    expect(updated).toContain(`\t"packageManager"`);
    // Key order is untouched.
    expect(updated.indexOf(`"name"`)).toBeLessThan(updated.indexOf(`"packageManager"`));
  });

  // Test 13 — the BOM survives (§14.7).
  it("preserves a UTF-8 BOM", () => {
    write("package.json", `\uFEFF{\n  "packageManager": "yarn@1.22.4"\n}\n`);

    writePin(root, { name: "yarn", reference: "1.22.21" });
    const updated = readFileSync(join(root, "package.json"), "utf8");

    expect(updated.startsWith("\uFEFF")).toBe(true);
    expect(updated).toContain(`"packageManager": "yarn@1.22.21"`);
  });

  it("inserts the field into a manifest that lacks it", () => {
    manifest(".", { name: "demo" });

    const { previousPackageManager } = writePin(root, { name: "pnpm", reference: "9.0.0" });
    expect(previousPackageManager).toBe("unknown");
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).toEqual({
      name: "demo",
      packageManager: "pnpm@9.0.0",
    });
  });

  // Test 106.
  it("creates package.json in an empty directory", () => {
    const cwd = dir("empty");

    const { previousPackageManager } = writePin(cwd, { name: "yarn", reference: "1.22.4" });
    expect(previousPackageManager).toBe("unknown");
    expect(JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"))).toEqual({
      packageManager: "yarn@1.22.4",
    });
  });

  // Test 107.
  it("updates the ancestor manifest when run from a subfolder", () => {
    manifest(".", { packageManager: "yarn@1.22.4" });
    const nested = dir("packages/app");

    writePin(nested, { name: "yarn", reference: "1.22.21" });

    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager).toBe(
      "yarn@1.22.21",
    );
  });

  // Test 109.
  it("overwrites a malformed existing field", () => {
    for (const packageManager of ["yarn@^1", "yarn", "yarn@", 42]) {
      manifest(".", { packageManager });
      expect(() => writePin(root, { name: "yarn", reference: "1.22.4" })).not.toThrow();
      expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager).toBe(
        "yarn@1.22.4",
      );
    }
  });

  it("reports the devEngines range as the previous package manager", () => {
    manifest(".", { devEngines: { packageManager: { name: "yarn", version: "1.x" } } });

    const { previousPackageManager } = writePin(root, { name: "yarn", reference: "1.22.4" });
    expect(previousPackageManager).toBe("yarn@1.x");
  });

  // Test 110.
  it("throws when the pinned version violates the devEngines range", () => {
    manifest(".", {
      packageManager: "yarn@2.1.0",
      devEngines: { packageManager: { name: "yarn", version: "2.x" } },
    });

    expectUsageError(
      () => writePin(root, { name: "yarn", reference: "1.22.4" }),
      messages.devEnginesPinMismatch("yarn", "1.22.4", "2.x"),
    );
    // Nothing was written.
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager).toBe(
      "yarn@2.1.0",
    );
  });

  // Test 113.
  it("honours onFail: ignore on a devEngines violation", () => {
    manifest(".", {
      packageManager: "yarn@2.1.0",
      devEngines: { packageManager: { name: "yarn", version: "2.x", onFail: "ignore" } },
    });

    writePin(root, { name: "yarn", reference: "1.22.4" });
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager).toBe(
      "yarn@1.22.4",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts a hash-suffixed reference inside the devEngines range", () => {
    manifest(".", { devEngines: { packageManager: { name: "yarn", version: "1.x" } } });

    expect(() => writePin(root, { name: "yarn", reference: "1.22.4+sha1.abc" })).not.toThrow();
  });
});
