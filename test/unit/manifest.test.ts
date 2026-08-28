import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messages, UsageError, VALIDATION_WARNING_PREFIX } from "../../src/errors-cold.ts";
import {
  discoverProjectSpec,
  isValidToolName,
  NODE_MODULES_RE,
  parseSpec,
  readSpecFromManifest,
  reconcile,
  warnOrThrow,
} from "../../src/project/manifest.ts";
import { writePin } from "../../src/project/pin.ts";
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
  root = realpathSync(mkdtempSync(join(tmpdir(), "jup-manifest-")));
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

/** A manifest pin in proxy mode: it must name a version, but §15.23 lets that version be a range. */
const PINNED = { requireVersion: true };
/** A CLI pattern, or a pin with a CLI version override: a bare name is allowed too. */
const LOOSE = { requireVersion: false };

describe("parseSpec — §03.4", () => {
  it("splits on the first @", () => {
    expect(parseSpec("yarn@1.22.4", "package.json", PINNED)).toEqual({
      name: "yarn",
      range: "1.22.4",
    });
  });

  it("rejects a non-string field", () => {
    for (const raw of [42, null, {}, ["yarn@1.22.4"]]) {
      expectUsageError(
        () => parseSpec(raw, "package.json", PINNED),
        messages.invalidSpecNotString("package.json"),
      );
    }
  });

  // Test 2 / test 5.
  it("rejects a name with no version when an exact version is required", () => {
    expectUsageError(
      () => parseSpec("yarn", "package.json", PINNED),
      `No version specified for yarn in "packageManager" of package.json`,
    );
    expectUsageError(
      () => parseSpec("yarn@", "package.json", PINNED),
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

  // Tests 3 / 4, rewritten by §15.23: a pin may now be a range or a dist-tag, and
  // only the *absence* of a version is still an error. `requireVersion` is
  // therefore the only thing separating the two modes.
  it("accepts tags and ranges in a pin", () => {
    for (const options of [PINNED, LOOSE]) {
      expect(parseSpec("yarn@stable", "package.json", options)).toEqual({
        name: "yarn",
        range: "stable",
      });
      expect(parseSpec("yarn@^1.0.0", "package.json", options)).toEqual({
        name: "yarn",
        range: "^1.0.0",
      });
    }
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
    // §15.23 removed the exact-version check that used to fire first here, so
    // both modes now reach the same unsupported-name error.
    expectUsageError(
      () => parseSpec("@scope/pkg@1.0.0", "package.json", PINNED),
      messages.unsupportedSpec("@scope/pkg@1.0.0"),
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

  /* §03.4 / §07.2 — the name is a store directory segment, and nothing between
   * `parseSpec` and `join(getInstallFolder(), name)` escapes it. The URL branch
   * used to be the hole: it refuses a URL for a *known* name, so an unknown one
   * was never examined at all, and `../../../../tmp/pwn@https://host/x.tgz#sha512.…`
   * installed attacker-served bytes outside the store. */
  describe("the name has to be a name", () => {
    const NUL = String.fromCodePoint(0);

    const REJECTED = [
      "../../../../tmp/pwn",
      "../x",
      "a/b",
      "..",
      ".",
      "@scope/..",
      "",
      "yarn x",
      String.raw`a\b`,
      String.raw`..\..\tmp`,
      "a:b",
      `a${NUL}b`,
    ];

    it("refuses a traversing name with a URL reference", () => {
      for (const name of REJECTED) {
        const raw = `${name}@https://evil.test/x.tgz#sha512.aa`;
        // The existing §12 string, not a new one.
        expectUsageError(
          () => parseSpec(raw, "package.json", LOOSE),
          messages.unsupportedSpec(raw),
        );
      }
    });

    it("refuses it with a version reference too, in both modes", () => {
      for (const name of REJECTED) {
        for (const options of [PINNED, LOOSE]) {
          const raw = `${name}@1.0.0`;
          expectUsageError(
            () => parseSpec(raw, "package.json", options),
            messages.unsupportedSpec(raw),
          );
        }
      }
    });

    it("keeps accepting the names a custom tool plausibly has", () => {
      for (const name of ["custom", "my-tool", "my_tool", "tool.js", "Tool2"]) {
        expect(parseSpec(`${name}@https://example.test/x.tgz`, "CLI arguments", LOOSE)).toEqual({
          name,
          range: "https://example.test/x.tgz",
        });
      }
    });

    // The predicate is checked directly for the scoped shape: `parseSpec` splits
    // on the *first* `@`, so a scoped name cannot reach it, and the rule must
    // still be npm's rather than one that happens to hold for this caller.
    it("accepts a scoped name and refuses the shapes that are not one", () => {
      expect(isValidToolName("@scope/ok")).toBe(true);
      expect(isValidToolName("@oven/bun-linux-x64")).toBe(true);
      expect(isValidToolName("yarn")).toBe(true);

      for (const name of [...REJECTED, "@scope/a/b", "@/x", "@scope/", `@${NUL}/x`]) {
        expect(isValidToolName(name), name).toBe(false);
      }
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
    expect((result as Extract<SpecResult, { type: "Found" }>).getSpec(PINNED)).toEqual({
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
    expect(result.getSpec(PINNED)).toEqual({ name: "npm", range: "6.14.2" });
  });

  it("climbs past a manifest without a pin", () => {
    const rootManifest = manifest(".", { packageManager: "yarn@1.22.4" });
    manifest("packages/app", { name: "app" });

    const result = discoverProjectSpec(join(root, "packages", "app")) as Extract<
      SpecResult,
      { type: "Found" }
    >;
    expect(result.target).toBe(rootManifest);
    expect(result.getSpec(PINNED)).toEqual({ name: "yarn", range: "1.22.4" });
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
  it("rejects invalid JSON, naming the path relative to the directory examined", () => {
    write("package.json", "{ this is not json");
    expectUsageError(() => discoverProjectSpec(root), messages.invalidPackageJson("package.json"));

    // §03.1 says "relative to `d`" — the directory the walk is standing in when
    // it reads the file, not the initial cwd — so a malformed manifest two
    // levels up is still named `package.json`, never `../../package.json`.
    const nested = dir("packages/app");
    expectUsageError(
      () => discoverProjectSpec(nested),
      messages.invalidPackageJson("package.json"),
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
    expect(result.getSpec(PINNED)).toEqual({ name: "yarn", range: "1.22.4" });
  });

  it("defers spec validation until getSpec is called (test 109)", () => {
    // `yarn@^1` is no longer among these: §15.23 makes a range a valid pin.
    for (const packageManager of ["yarn", "yarn@", 42]) {
      manifest(".", { packageManager });
      // Discovery itself must not throw — `use` overwrites this field.
      const result = discoverProjectSpec(root) as Extract<SpecResult, { type: "Found" }>;
      expect(result.type).toBe("Found");
      expect(() => result.getSpec(PINNED)).toThrow(UsageError);
    }
  });

  describe("env files — §03.2", () => {
    it("loads the closest env file before reading the manifest", () => {
      manifest(".", { packageManager: "yarn@1.22.4" });
      write(".jup.env", "COREPACK_ENABLE_AUTO_PIN=1\n");

      const result = discoverProjectSpec(root);
      expect(result.envFilePath).toBe(join(root, ".jup.env"));
      expect(process.env.COREPACK_ENABLE_AUTO_PIN).toBe("1");
    });

    it("prefers the closest env file and stops looking", () => {
      manifest(".", { name: "monorepo" });
      write(".jup.env", "COREPACK_NPM_REGISTRY=https://root.test\n");
      dir("sub");
      write("sub/.jup.env", "COREPACK_NPM_REGISTRY=https://sub.test\n");

      discoverProjectSpec(join(root, "sub"));
      expect(process.env.COREPACK_NPM_REGISTRY).toBe("https://sub.test");
    });

    it("never reads an env file from inside node_modules", () => {
      manifest(".", { packageManager: "yarn@1.22.4" });
      write("node_modules/foo/.jup.env", "COREPACK_NPM_REGISTRY=https://vendored.test\n");

      const result = discoverProjectSpec(join(root, "node_modules", "foo"));
      expect(result.envFilePath).toBeUndefined();
      expect(process.env.COREPACK_NPM_REGISTRY).toBeUndefined();
    });

    it("never reaches an env file above the manifest that stopped the walk", () => {
      write(".jup.env", "COREPACK_NPM_REGISTRY=https://root.test\n");
      manifest("sub", { packageManager: "yarn@1.22.4" });

      const result = discoverProjectSpec(join(root, "sub"));
      expect(result.envFilePath).toBeUndefined();
      expect(process.env.COREPACK_NPM_REGISTRY).toBeUndefined();
    });

    /* §03.2 — the search stops at the project boundary. Without this an
     * unpinned project (no `packageManager` anywhere, the common case) climbed
     * to `/`, so a `/tmp/.jup.env` any user can write governed every build run
     * under `/tmp` by every other user on the host. */
    it("never reads an env file above a project that declares no pin", () => {
      write(".jup.env", "COREPACK_NPM_REGISTRY=https://ancestor.test\n");
      manifest("project", { name: "unpinned" });

      const result = discoverProjectSpec(join(root, "project"));
      // The manifest walk still climbs — reading a pin from an ancestor is
      // §03.1's documented monorepo behaviour — and finds nothing here.
      expect(result.type).toBe("NoSpec");
      expect(result.envFilePath).toBeUndefined();
      expect(process.env.COREPACK_NPM_REGISTRY).toBeUndefined();
    });

    it("stops at a `.git` checkout with no manifest of its own", () => {
      write(".jup.env", "COREPACK_NPM_REGISTRY=https://ancestor.test\n");
      dir("checkout/.git");
      dir("checkout/src");

      const result = discoverProjectSpec(join(root, "checkout", "src"));
      expect(result.type).toBe("NoProject");
      expect(result.envFilePath).toBeUndefined();
      expect(process.env.COREPACK_NPM_REGISTRY).toBeUndefined();
    });

    it("still applies the boundary directory's own env file, and a nested one", () => {
      manifest("project", { name: "unpinned" });
      write("project/.jup.env", "COREPACK_NPM_REGISTRY=https://project.test\n");

      // From the project root itself.
      discoverProjectSpec(join(root, "project"));
      expect(process.env.COREPACK_NPM_REGISTRY).toBe("https://project.test");

      // And from a plain subdirectory of it, which is not its own project.
      delete process.env.COREPACK_NPM_REGISTRY;
      dir("project/src");
      expect(discoverProjectSpec(join(root, "project", "src")).envFilePath).toBe(
        join(root, "project", ".jup.env"),
      );
      expect(process.env.COREPACK_NPM_REGISTRY).toBe("https://project.test");
    });

    it("does not let envOnly climb past the boundary either", () => {
      write(".jup.env", "COREPACK_NPM_REGISTRY=https://ancestor.test\n");
      manifest("project", { name: "unpinned" });

      const result = discoverProjectSpec(join(root, "project"), { envOnly: true });
      expect(result.envFilePath).toBeUndefined();
      expect(process.env.COREPACK_NPM_REGISTRY).toBeUndefined();
    });

    // §03.2 — the env file is skipped for *anything* under a `node_modules`,
    // not just the package directory §03.1's tail match names: a dependency
    // planting `node_modules/foo/src/.jup.env` supplies a whole environment,
    // and the host's own file is what must apply instead.
    it("never reads an env file from a subdirectory of a vendored package", () => {
      manifest(".", { packageManager: "yarn@1.22.4" });
      write(".jup.env", "COREPACK_NPM_REGISTRY=https://host.test\n");
      write("node_modules/foo/src/.jup.env", "COREPACK_NPM_REGISTRY=https://vendored.test\n");

      const result = discoverProjectSpec(join(root, "node_modules", "foo", "src"));
      expect(result.envFilePath).toBe(join(root, ".jup.env"));
      expect(process.env.COREPACK_NPM_REGISTRY).toBe("https://host.test");
    });

    it("never reads an env file from the node_modules directory itself", () => {
      manifest(".", { packageManager: "yarn@1.22.4" });
      write("node_modules/.jup.env", "COREPACK_NPM_REGISTRY=https://vendored.test\n");

      const result = discoverProjectSpec(join(root, "node_modules", "foo", "src"));
      expect(result.envFilePath).toBeUndefined();
      expect(process.env.COREPACK_NPM_REGISTRY).toBeUndefined();
    });

    it("skips env files entirely when COREPACK_ENV_FILE=0", () => {
      manifest(".", { packageManager: "yarn@1.22.4" });
      write(".jup.env", "COREPACK_ENABLE_AUTO_PIN=1\n");
      process.env.COREPACK_ENV_FILE = "0";

      const result = discoverProjectSpec(root);
      expect(result.envFilePath).toBeUndefined();
      expect(process.env.COREPACK_ENABLE_AUTO_PIN).toBeUndefined();
    });

    it("envOnly loads the env file and never reads a manifest", () => {
      manifest(".", { packageManager: "yarn@1.22.4" });
      write(".jup.env", "COREPACK_ENABLE_AUTO_PIN=1\n");

      const result = discoverProjectSpec(root, { envOnly: true });
      expect(result.type).toBe("NoProject");
      expect(result.envFilePath).toBe(join(root, ".jup.env"));
      expect(process.env.COREPACK_ENABLE_AUTO_PIN).toBe("1");
    });

    it("envOnly terminates at the filesystem root when no env file exists", () => {
      const result = discoverProjectSpec(dir("deep/nested"), { envOnly: true });
      expect(result.type).toBe("NoProject");
      expect(result.envFilePath).toBeUndefined();
    });
  });

  /* §03.5 / §11.1 — "never look at the project at all". */
  describe("COREPACK_ENABLE_PROJECT_SPEC=0 with projectSpecFlag", () => {
    it("does not parse a malformed manifest", () => {
      write("package.json", "{ this is not json");
      process.env.COREPACK_ENABLE_PROJECT_SPEC = "0";

      const result = discoverProjectSpec(root, { projectSpecFlag: true });
      expect(result.type).toBe("NoProject");
    });

    it("does not validate devEngines, whatever onFail says", () => {
      manifest(".", {
        packageManager: "pnpm@10.0.0",
        devEngines: { packageManager: { name: "yarn", version: "1.x", onFail: "error" } },
      });
      process.env.COREPACK_ENABLE_PROJECT_SPEC = "0";

      const result = discoverProjectSpec(root, { projectSpecFlag: true });
      expect(result.type).toBe("NoProject");
      expect(warn).not.toHaveBeenCalled();
    });

    it("still loads the env file, which is what may set the variable", () => {
      write("package.json", "{ this is not json");
      write(".jup.env", "COREPACK_ENABLE_PROJECT_SPEC=0\n");

      const result = discoverProjectSpec(root, { projectSpecFlag: true });
      expect(result.type).toBe("NoProject");
      expect(result.envFilePath).toBe(join(root, ".jup.env"));
      expect(process.env.COREPACK_ENABLE_PROJECT_SPEC).toBe("0");
    });

    it("discards a manifest read before a parent env file disabled the spec", () => {
      // The vendored subdirectory is read first (no `packageManager`, so the
      // walk continues); the env file that disables the spec only turns up
      // three directories later.
      //
      // It has to be a vendored one now that §03.2 stops the env-file search at
      // the project boundary: a directory with its own `package.json` is that
      // boundary, so the only way a manifest is still read *before* an env file
      // is found is from inside a `node_modules`, which §03.2 skips for the env
      // file and §03.1 does not skip for a manifest below the package dir.
      manifest("node_modules/foo/src", {});
      manifest(".", { packageManager: "pnpm@10.0.0" });
      write(".jup.env", "COREPACK_ENABLE_PROJECT_SPEC=0\n");

      const result = discoverProjectSpec(join(root, "node_modules", "foo", "src"), {
        projectSpecFlag: true,
      });
      expect(result.type).toBe("NoProject");
    });

    it("is opt-in: without the option the manifest is still read", () => {
      write("package.json", "{ this is not json");
      process.env.COREPACK_ENABLE_PROJECT_SPEC = "0";

      expectUsageError(
        () => discoverProjectSpec(root),
        messages.invalidPackageJson("package.json"),
      );
    });
  });
});

describe("devEngines — §03.3", () => {
  const read = (data: unknown) => readSpecFromManifest(data, join(root, "package.json"));

  it("ignores an absent or null devEngines.packageManager", () => {
    // `hasPin` reports whether the manifest declares `packageManager` itself:
    // §15.23's `up` refreshes a declared range in place, but still creates a pin
    // from a spec synthesised out of `devEngines`.
    expect(read({ packageManager: "yarn@1.22.4" })).toEqual({
      raw: "yarn@1.22.4",
      hasPin: true,
    });
    expect(read({ devEngines: {} })).toEqual({ raw: undefined, hasPin: false });
    expect(read({ devEngines: { packageManager: null } })).toEqual({
      raw: undefined,
      hasPin: false,
    });
  });

  // Test 22, as §15.23 leaves it: the derived spec is a range, and a range is a
  // valid pin, so it parses instead of failing.
  it("derives `<name>@*` when only a name is declared", () => {
    manifest(".", { devEngines: { packageManager: { name: "yarn" } } });

    const result = discoverProjectSpec(root) as Extract<SpecResult, { type: "Found" }>;
    expect(result.range).toBeUndefined();
    expect(result.hasPin).toBe(false);
    expect(result.getSpec(PINNED)).toEqual({ name: "yarn", range: "*" });
  });

  // Test 23.
  it("derives `<name>@<range>` when a version is declared", () => {
    manifest(".", { devEngines: { packageManager: { name: "pnpm", version: "6.x" } } });

    const result = discoverProjectSpec(root) as Extract<SpecResult, { type: "Found" }>;
    expect(result.range).toEqual({ name: "pnpm", range: "6.x", onFail: undefined });
    expect(result.hasPin).toBe(false);
    expect(result.getSpec(PINNED)).toEqual({ name: "pnpm", range: "6.x" });
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
      // §15.26 — the declaration is reported alongside the Descriptor-shaped
      // view of it, because `writePin` has to honour it even with no version.
      devEngines: { name: "pnpm", version: "6.x", onFail: undefined },
      hasPin: true,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  // Test 25.
  it("imposes no constraint when devEngines declares no version", () => {
    const pm = "pnpm@6.6.2+sha224.abc";
    expect(read({ packageManager: pm, devEngines: { packageManager: { name: "pnpm" } } })).toEqual({
      raw: pm,
      range: undefined,
      // §15.26 — no version declared, but the *name* still is, and that alone
      // constrains what `writePin` may write.
      devEngines: { name: "pnpm", onFail: undefined },
      hasPin: true,
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
    ).toEqual({ raw: pm, hasPin: true });
    expect(warn).toHaveBeenCalledWith(messages.devEnginesArray());
  });

  // Tests 28, 29 — also unconditional.
  it("warns unconditionally on a non-object value", () => {
    expect(
      read({ packageManager: "pnpm@6.6.2", devEngines: { packageManager: "pnpm@10.x" } }),
    ).toEqual({
      raw: "pnpm@6.6.2",
      hasPin: true,
    });
    expect(warn).toHaveBeenCalledWith(
      `! jup only supports objects as valid value for devEngines.packageManager. The current value ("pnpm@10.x") will be ignored.`,
    );

    warn.mockClear();
    expect(read({ devEngines: { packageManager: 10 } })).toEqual({
      raw: undefined,
      hasPin: false,
    });
    expect(warn).toHaveBeenCalledWith(
      `! jup only supports objects as valid value for devEngines.packageManager. The current value (10) will be ignored.`,
    );
  });

  // §11.5 / §14.23 — the mute is scoped by *origin*. All three warnings in this
  // block are ones corepack prints too, and §13 rows 27–29 match their text byte
  // for byte, so `COREPACK_QUIET_ADVISORIES` must not reach any of them.
  it("keeps printing corepack's own devEngines warnings when advisories are quiet", () => {
    process.env.COREPACK_QUIET_ADVISORIES = "1";

    read({ devEngines: { packageManager: [{ name: "yarn" }] } });
    expect(warn).toHaveBeenCalledWith(messages.devEnginesArray());

    warn.mockClear();
    read({ devEngines: { packageManager: "pnpm@10.x" } });
    expect(warn).toHaveBeenCalledWith(messages.devEnginesNotObject("pnpm@10.x"));

    warn.mockClear();
    read({ devEngines: { packageManager: { name: "yarn", version: "!", onFail: "warn" } } });
    expect(warn).toHaveBeenCalledWith(
      `${VALIDATION_WARNING_PREFIX}${messages.devEnginesBadVersion("!")}`,
    );
  });

  const nameMismatch = (onFail?: string) => ({
    packageManager: "pnpm@6.6.2",
    devEngines: { packageManager: { name: "yarn", ...(onFail === undefined ? {} : { onFail }) } },
  });
  const nameMismatchMessage = `"packageManager" field is set to "pnpm@6.6.2" which does not match the "devEngines.packageManager" field set to "yarn"`;

  // Test 30.
  it("stays silent on a mismatch with onFail: ignore", () => {
    expect(read(nameMismatch("ignore"))).toEqual({
      raw: "pnpm@6.6.2",
      range: undefined,
      devEngines: { name: "yarn", onFail: "ignore" },
      hasPin: true,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  // Test 31.
  it("warns on a name mismatch with onFail: warn", () => {
    expect(read(nameMismatch("warn"))).toEqual({
      raw: "pnpm@6.6.2",
      range: undefined,
      devEngines: { name: "yarn", onFail: "warn" },
      hasPin: true,
    });
    expect(warn).toHaveBeenCalledWith(`${VALIDATION_WARNING_PREFIX}${nameMismatchMessage}`);
  });

  // Tests 32, 33.
  it("throws on a name mismatch with onFail: error and with onFail omitted", () => {
    expectUsageError(() => read(nameMismatch("error")), nameMismatchMessage);
    expectUsageError(() => read(nameMismatch()), nameMismatchMessage);
  });

  it("degrades an unrecognised onFail to a warning", () => {
    expect(read(nameMismatch("explode"))).toEqual({
      raw: "pnpm@6.6.2",
      range: undefined,
      devEngines: { name: "yarn", onFail: "explode" },
      hasPin: true,
    });
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
      devEngines: { name: "pnpm", version: "10.x", onFail: "warn" },
      hasPin: true,
    });
    expect(warn).toHaveBeenCalledWith(`${VALIDATION_WARNING_PREFIX}${versionMismatchMessage}`);
  });

  // Test 35.
  it("throws on a version mismatch with no onFail", () => {
    expectUsageError(() => read(versionMismatch()), versionMismatchMessage);
  });

  // §15.23 — the shape pnpm 11.21 generates: a range in `packageManager` beside
  // a range in `devEngines`. `satisfies` takes a *version* on its left, so
  // comparing the two ranges answers `false` for every input; the check is
  // skipped rather than turned into a hard error on a perfectly ordinary
  // manifest. Range containment is what would be needed, and no section defines
  // it.
  it("skips the version cross-check when the pin is itself a range", () => {
    expect(
      read({
        packageManager: "pnpm@^11.0.0",
        devEngines: { packageManager: { name: "pnpm", version: ">=11" } },
      }),
    ).toEqual({
      raw: "pnpm@^11.0.0",
      range: { name: "pnpm", range: ">=11", onFail: undefined },
      devEngines: { name: "pnpm", version: ">=11", onFail: undefined },
      hasPin: true,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("still applies the name check to a range pin", () => {
    expectUsageError(
      () =>
        read({
          packageManager: "yarn@^1.0.0",
          devEngines: { packageManager: { name: "pnpm", version: ">=11" } },
        }),
      messages.devEnginesNameMismatch("yarn@^1.0.0", "pnpm"),
    );
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
      devEngines: { name: "pnpm", version: "6.6.2+sha1.22222", onFail: undefined },
      hasPin: true,
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
      messages.devEnginesPinMismatch("yarn", "1.22.4", "yarn", "2.x"),
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

  // §03.3/§03.7 — the *name* is checked too, not only the version. Without it,
  // pinning pnpm in a yarn-declaring project succeeds and every later run then
  // fails §03.3's name check, with nothing but a hand edit to undo it.
  it("throws when the pinned name differs from the devEngines name", () => {
    manifest(".", { devEngines: { packageManager: { name: "yarn", version: "6.x" } } });

    expectUsageError(
      // The version satisfies the range: only the name is wrong.
      () => writePin(root, { name: "pnpm", reference: "6.6.2" }),
      messages.devEnginesPinMismatch("pnpm", "6.6.2", "yarn", "6.x"),
    );
    // Nothing was written: the manifest still has no `packageManager` field.
    expect(
      JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager,
    ).toBeUndefined();
  });

  // §12.3's two name slots are independent, so the rendered message names both
  // the requested package manager and the declared one.
  it("names both package managers in the mismatch message", () => {
    expect(messages.devEnginesPinMismatch("pnpm", "6.6.2", "yarn", "6.x")).toBe(
      "The requested version of pnpm@6.6.2 does not match the devEngines specification (yarn@6.x)",
    );
  });

  it("routes a name mismatch through onFail like any other violation", () => {
    manifest(".", {
      devEngines: { packageManager: { name: "yarn", version: "6.x", onFail: "warn" } },
    });

    writePin(root, { name: "pnpm", reference: "6.6.2" });
    expect(warn).toHaveBeenCalledWith(
      `${VALIDATION_WARNING_PREFIX}${messages.devEnginesPinMismatch("pnpm", "6.6.2", "yarn", "6.x")}`,
    );
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager).toBe(
      "pnpm@6.6.2",
    );
  });
});

/* ------------------------------------------------------------------ *
 * §15.25 — symmetric walk stop conditions
 * ------------------------------------------------------------------ */

describe("discoverProjectSpec — §15.25 stop conditions", () => {
  it("stops on a devEngines-only manifest instead of climbing past it", () => {
    manifest(".", { packageManager: "yarn@1.22.4" });
    manifest("nested", { devEngines: { packageManager: { name: "pnpm", version: "11.1.2" } } });

    const result = discoverProjectSpec(join(root, "nested")) as Extract<
      SpecResult,
      { type: "Found" }
    >;

    expect(result.type).toBe("Found");
    expect(result.target).toBe(join(root, "nested", "package.json"));
    expect(result.getSpec({ requireVersion: true })).toEqual({ name: "pnpm", range: "11.1.2" });
  });

  it("treats a declared-but-invalid packageManager as a stop, not as absent", () => {
    manifest(".", { packageManager: "yarn@1.22.4" });
    for (const value of [null, 42, ""]) {
      manifest("nested", { packageManager: value });

      const result = discoverProjectSpec(join(root, "nested")) as Extract<
        SpecResult,
        { type: "Found" }
      >;

      expect(result.type, JSON.stringify(value)).toBe("Found");
      expect(result.target).toBe(join(root, "nested", "package.json"));
    }
  });

  it("keeps climbing for a manifest that declares neither field", () => {
    manifest(".", { packageManager: "yarn@1.22.4" });
    manifest("nested", { name: "nested" });

    const result = discoverProjectSpec(join(root, "nested")) as Extract<
      SpecResult,
      { type: "Found" }
    >;

    expect(result.target).toBe(join(root, "package.json"));
  });

  it("keeps climbing for an empty or null devEngines.packageManager", () => {
    manifest(".", { packageManager: "yarn@1.22.4" });
    for (const devEngines of [{}, { packageManager: null }]) {
      manifest("nested", { devEngines });

      expect(discoverProjectSpec(join(root, "nested")).target).toBe(join(root, "package.json"));
    }
  });
});

/* ------------------------------------------------------------------ *
 * §15.27 — write targets
 * ------------------------------------------------------------------ */

describe("discoverProjectSpec — §15.27 mutating walks", () => {
  it("stops a mutating walk at a `workspaces` root", () => {
    manifest(".", { packageManager: "yarn@1.22.4" });
    manifest("repo", { workspaces: ["packages/*"] });
    dir("repo/packages/app");

    const from = join(root, "repo/packages/app");
    // Reading still climbs to the ancestor pin (§03.1); only writing stops.
    expect(discoverProjectSpec(from).target).toBe(join(root, "package.json"));
    expect(discoverProjectSpec(from, { mutating: true }).target).toBe(
      join(root, "repo", "package.json"),
    );
  });

  it("stops a mutating walk beside a pnpm-workspace.yaml", () => {
    manifest(".", { packageManager: "yarn@1.22.4" });
    manifest("repo", { name: "repo" });
    write("repo/pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    dir("repo/packages/app");

    expect(discoverProjectSpec(join(root, "repo/packages/app"), { mutating: true }).target).toBe(
      join(root, "repo", "package.json"),
    );
  });

  it("does not stop at a workspace file with no manifest beside it", () => {
    // The boundary is a *selection*, so a stray marker in a directory with no
    // `package.json` cannot strand the walk on a file that does not exist.
    manifest(".", { packageManager: "yarn@1.22.4" });
    write("repo/pnpm-workspace.yaml", "packages: []\n");
    dir("repo/packages/app");

    expect(discoverProjectSpec(join(root, "repo/packages/app"), { mutating: true }).target).toBe(
      join(root, "package.json"),
    );
  });

  it("`here` selects the cwd's own manifest and nothing above it", () => {
    manifest(".", { packageManager: "yarn@1.22.4" });
    manifest("nested", { name: "nested" });

    const result = discoverProjectSpec(join(root, "nested"), { mutating: true, here: true });

    expect(result.type).toBe("NoSpec");
    expect(result.target).toBe(join(root, "nested", "package.json"));
  });

  it("`here` still reports NoProject — and the right target — with no manifest", () => {
    manifest(".", { packageManager: "yarn@1.22.4" });
    dir("nested");

    const result = discoverProjectSpec(join(root, "nested"), { mutating: true, here: true });

    expect(result.type).toBe("NoProject");
    expect(result.target).toBe(join(root, "nested", "package.json"));
  });

  it("`here` still loads an ancestor's env file", () => {
    // §03.2's walk is about configuration, not about which manifest to edit, so
    // confining the write must not also cut off the registry settings.
    write(".jup.env", "COREPACK_ENABLE_PRERELEASES=1\n");
    dir("nested");

    const result = discoverProjectSpec(join(root, "nested"), { mutating: true, here: true });

    expect(result.envFilePath).toBe(join(root, ".jup.env"));
    expect(process.env.COREPACK_ENABLE_PRERELEASES).toBe("1");
  });
});

/* ------------------------------------------------------------------ *
 * §15.26 — one logical pin
 * ------------------------------------------------------------------ */

describe("writePin — §15.26", () => {
  const read = () =>
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      packageManager?: string;
      devEngines?: { packageManager?: Record<string, unknown> };
    };

  it("writes into devEngines and creates no packageManager when only devEngines exists", () => {
    manifest(".", { devEngines: { packageManager: { name: "yarn", version: "^1.0.0" } } });

    writePin(root, {
      name: "yarn",
      reference: "1.22.4+sha512.abcdef",
      hash: "sha512.abcdef",
    });

    expect(read().packageManager).toBeUndefined();
    expect(read().devEngines?.packageManager).toEqual({
      name: "yarn",
      version: "1.22.4",
      integrity: "sha512-q83v",
    });
  });

  // §15.12 — the sidecar describes the version beside it. Declared beside a
  // *range* it describes no single release, so it may not be folded into a
  // `packageManager` pin that outranks it: the two would name different versions.
  it("ignores a sidecar integrity declared beside a range (§15.12)", () => {
    const spec = readSpecFromManifest(
      {
        packageManager: "yarn@1.22.4",
        devEngines: { packageManager: { name: "yarn", version: "^1", integrity: "sha512-q83v" } },
      },
      join(root, "package.json"),
    );

    expect(spec.raw).toBe("yarn@1.22.4");
  });

  it("still folds a sidecar integrity declared beside the exact version (§15.12)", () => {
    const spec = readSpecFromManifest(
      {
        packageManager: "yarn@1.22.4",
        devEngines: {
          packageManager: { name: "yarn", version: "1.22.4", integrity: "sha512-q83v" },
        },
      },
      join(root, "package.json"),
    );

    expect(spec.raw).toBe("yarn@1.22.4+sha512.abcdef");
  });

  // `--pin-style=sidecar` is a request about how the digest is spelled, not
  // permission to overwrite a member that speaks for another tool.
  it("sidecar style does not write into another tool's devEngines member", () => {
    manifest(".", {
      packageManager: "yarn@1.22.0",
      devEngines: {
        packageManager: { name: "pnpm", version: "10.5.0", onFail: "ignore" },
      },
    });

    writePin(
      root,
      { name: "yarn", reference: "1.22.4+sha512.abcdef", hash: "sha512.abcdef" },
      { pinStyle: "sidecar" },
    );

    expect(read().packageManager).toBe("yarn@1.22.4+sha512.abcdef");
    expect(read().devEngines?.packageManager).toEqual({
      name: "pnpm",
      version: "10.5.0",
      onFail: "ignore",
    });
  });

  it("updates both fields when devEngines names an exact version", () => {
    manifest(".", {
      packageManager: "yarn@1.22.0",
      devEngines: { packageManager: { name: "yarn", version: "1.22.0" } },
    });

    writePin(root, { name: "yarn", reference: "1.22.4+sha512.abcdef", hash: "sha512.abcdef" });

    expect(read().packageManager).toBe("yarn@1.22.4+sha512.abcdef");
    expect(read().devEngines?.packageManager).toMatchObject({ version: "1.22.4" });
  });

  it("leaves a declared range alone when both fields exist", () => {
    manifest(".", {
      packageManager: "yarn@1.1.0",
      devEngines: { packageManager: { name: "yarn", version: "1.x || 2.x" } },
    });

    writePin(root, { name: "yarn", reference: "2.4.3" });

    expect(read().packageManager).toBe("yarn@2.4.3");
    // §09.4 needs this range intact to carry the *next* `up` across a major.
    expect(read().devEngines?.packageManager).toEqual({ name: "yarn", version: "1.x || 2.x" });
  });

  it("checks the name even when devEngines declares no version", () => {
    // The gap §15.26 closes here: `writePin` only ever reached the devEngines
    // check through a declared *range*, so a name-only block imposed nothing and
    // the resulting manifest was one §03.3 rejects by default on every run.
    manifest(".", { devEngines: { packageManager: { name: "yarn" } } });

    expectUsageError(
      () => writePin(root, { name: "pnpm", reference: "11.1.2" }),
      messages.devEnginesPinMismatch("pnpm", "11.1.2", "yarn", "*"),
    );
    expect(read().packageManager).toBeUndefined();
  });

  it("omits integrity when no usable digest is available", () => {
    manifest(".", { devEngines: { packageManager: { name: "yarn", version: "^1.0.0" } } });

    writePin(root, { name: "yarn", reference: "1.22.4", hash: "sha512.not-hex" });

    expect(read().devEngines?.packageManager).toEqual({ name: "yarn", version: "1.22.4" });
  });

  // §15.12 — the sidecar digest describes the version beside it, so a pin that
  // moves the version must settle the digest in the same edit. Skipping the
  // write instead leaves a digest for a release the project no longer uses; it
  // is inert while the field holds a range, and turns into a hash mismatch on
  // every install the moment anyone narrows the version back to one release.
  it("removes a stale integrity when the pin becomes a range (§15.23)", () => {
    manifest(".", {
      devEngines: {
        packageManager: { name: "pnpm", version: "10.5.0", integrity: "sha512-q83v" },
      },
    });

    // §15.28 — a range pin carries no digest: the resolved one lives in `jup.lock`.
    writePin(root, { name: "pnpm", reference: "^11.0.0", resolved: "11.1.2" });

    expect(read().devEngines?.packageManager).toEqual({ name: "pnpm", version: "^11.0.0" });
    // Not merely absent from the parse — gone from the text, so no later reader,
    // human or tool, can fold it back in.
    expect(readFileSync(join(root, "package.json"), "utf8")).not.toContain("integrity");
  });

  it("removes a stale integrity when the version moves and no digest is available", () => {
    manifest(".", {
      devEngines: {
        packageManager: { name: "pnpm", version: "10.5.0", integrity: "sha512-q83v" },
      },
    });

    // §15.28 — a per-host tool's digest never reaches the manifest.
    writePin(root, { name: "pnpm", reference: "10.6.0" });

    expect(read().devEngines?.packageManager).toEqual({ name: "pnpm", version: "10.6.0" });
  });

  it("keeps an integrity that still describes the version being written", () => {
    manifest(".", {
      devEngines: {
        packageManager: { name: "pnpm", version: "10.5.0", integrity: "sha512-q83v" },
      },
    });

    writePin(root, { name: "pnpm", reference: "10.5.0" });

    // Nothing moved, so nothing is stale: §15.11 keeps the verification tier.
    expect(read().devEngines?.packageManager).toEqual({
      name: "pnpm",
      version: "10.5.0",
      integrity: "sha512-q83v",
    });
  });

  it("writes a fresh digest when a range is narrowed back to an exact version", () => {
    manifest(".", { devEngines: { packageManager: { name: "pnpm", version: "^11.0.0" } } });

    writePin(
      root,
      { name: "pnpm", reference: "11.1.2+sha512.abcdef", hash: "sha512.abcdef" },
      { pinStyle: "sidecar" },
    );

    expect(read().devEngines?.packageManager).toMatchObject({
      name: "pnpm",
      version: "11.1.2",
      integrity: "sha512-q83v",
    });
  });

  it("preserves indentation, line endings and key order when removing integrity", () => {
    const original = [
      "{",
      `\t"devEngines": {`,
      `\t\t"packageManager": {`,
      `\t\t\t"name": "pnpm",`,
      `\t\t\t"integrity": "sha512-q83v",`,
      `\t\t\t"version": "10.5.0",`,
      `\t\t\t"onFail": "error"`,
      "\t\t}",
      "\t}",
      "}",
      "",
    ].join("\r\n");
    write("package.json", original);

    writePin(root, { name: "pnpm", reference: "^11.0.0", resolved: "11.1.2" });

    const updated = readFileSync(join(root, "package.json"), "utf8");
    expect(updated).toBe(
      original.replace(`\t\t\t"integrity": "sha512-q83v",\r\n`, "").replace("10.5.0", "^11.0.0"),
    );
  });

  it("reports the path it wrote, which is what the caller prints (§15.35l)", () => {
    manifest(".", { name: "demo" });
    dir("nested");

    expect(writePin(join(root, "nested"), { name: "yarn", reference: "1.22.4" }).target).toBe(
      join(root, "package.json"),
    );
    expect(
      writePin(join(root, "nested"), { name: "yarn", reference: "1.22.4" }, { here: true }).target,
    ).toBe(join(root, "nested", "package.json"));
  });
});
