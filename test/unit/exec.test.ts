import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { messages } from "../../src/errors.ts";
import { pathWith, resolveBinPath, SHIM_MARKER } from "../../src/run/exec.ts";
import type { BinSpec, LegacyBinList } from "../../src/types.ts";

/**
 * §08.4's contract is about how a *process* ends, so every one of these cases is
 * run in a real child process: `process.exitCode`, an uncaught error resetting it
 * to 1, and a `beforeExit` hook are all invisible from inside the test runner.
 * The child loads `src/exec.ts` through Node's own type stripping.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(
  new RegExp(`${sep === "\\" ? "\\\\" : sep}$`),
  "",
);
const EXEC_URL = pathToFileURL(join(REPO_ROOT, "src", "run", "exec.ts")).href;

/** A single-file download's URL, whose basename is what a `bin` list resolves to. */
const YARN_URL = "https://repo.yarnpkg.com/4.0.0/packages/yarnpkg-cli/bin/yarn.js";
/** A tarball URL, so the `bin` map branch is the one under test. */
const TGZ_URL = "https://registry.npmjs.org/yarn/-/yarn-1.0.0.tgz";

let root: string;
let driver: string;

/** Lay out `<root>/<name>/yarn/<version>/` and write `files` into it. */
function fixture(name: string, files: Record<string, string>, version = "1.0.0"): string {
  const location = join(root, name, "yarn", version);
  for (const [relative, content] of Object.entries(files)) {
    const target = join(location, relative);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  mkdirSync(location, { recursive: true });
  return location;
}

function run(
  location: string,
  binName: string,
  specUrl: string,
  bin: BinSpec | LegacyBinList,
  args: string[] = [],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [driver, location, binName, specUrl, JSON.stringify(bin), ...args],
    { encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  // realpath: macOS puts `$TMPDIR` behind a symlink (`/var` -> `/private/var`),
  // and the tool reports the paths it resolves — every assertion here that quotes
  // one back would compare the two spellings.
  root = realpathSync(mkdtempSync(join(tmpdir(), "jup-exec-")));
  driver = join(root, "driver.mjs");
  writeFileSync(
    driver,
    [
      `import { execPackageManager } from ${JSON.stringify(EXEC_URL)};`,
      `const [location, binName, specUrl, binJson, ...args] = process.argv.slice(2);`,
      `execPackageManager(binName, { location, bin: JSON.parse(binJson), hash: "" }, args, specUrl);`,
      ``,
    ].join("\n"),
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveBinPath — §08.1", () => {
  it("resolves a bin map entry against the install location", () => {
    const spec = {
      location: join(root, "map", "yarn", "1.0.0"),
      bin: { yarn: "./bin/yarn.js" },
      hash: "",
    };
    expect(resolveBinPath("yarn", spec, TGZ_URL)).toBe(join(spec.location, "bin", "yarn.js"));
  });

  it("resolves a bin list entry to the basename of the spec URL path", () => {
    const spec = {
      location: join(root, "list", "yarn", "4.0.0"),
      bin: ["yarn", "yarnpkg"],
      hash: "",
    };
    expect(resolveBinPath("yarn", spec, YARN_URL)).toBe(join(spec.location, "yarn.js"));
    expect(resolveBinPath("yarnpkg", spec, YARN_URL)).toBe(join(spec.location, "yarn.js"));
  });

  it("leaves the path unset for a bin list whose URL is not a .js file", () => {
    const spec = { location: join(root, "list", "yarn", "1.22.0"), bin: ["yarn"], hash: "" };
    expect(() => resolveBinPath("yarn", spec, TGZ_URL)).toThrow(
      messages.assertUnableToLocateBinPath("yarn"),
    );
  });

  it("leaves the path unset for a bin name that is not declared", () => {
    const spec = {
      location: join(root, "map", "yarn", "1.0.0"),
      bin: { yarn: "./bin/yarn.js" },
      hash: "",
    };
    expect(() => resolveBinPath("yarnpkg", spec, TGZ_URL)).toThrow(
      messages.assertUnableToLocateBinPath("yarnpkg"),
    );
    expect(() => resolveBinPath("yarn", { ...spec, bin: ["yarnpkg"] }, YARN_URL)).toThrow(
      messages.assertUnableToLocateBinPath("yarn"),
    );
  });

  it("does not treat inherited object properties as declared bins", () => {
    const spec = { location: join(root, "map", "yarn", "1.0.0"), bin: {} as BinSpec, hash: "" };
    expect(() => resolveBinPath("constructor", spec, TGZ_URL)).toThrow(
      messages.assertUnableToLocateBinPath("constructor"),
    );
  });

  /*
   * §08.1's first line is `bin := installSpec.bin ?? spec.bin`. Markers written
   * by older corepack releases carry no `bin`, and §07.1 requires the store to
   * stay compatible with them.
   */
  describe("a marker without a bin (§08.1's `?? spec.bin`)", () => {
    it("falls back to the table spec's bin map", () => {
      const spec = { location: join(root, "map", "yarn", "1.0.0"), hash: "" };
      expect(resolveBinPath("yarn", spec, TGZ_URL, { yarn: "./bin/yarn.js" })).toBe(
        join(spec.location, "bin", "yarn.js"),
      );
    });

    it("reads a LegacyBinList out of a marker an older build wrote (§07.1)", () => {
      // Not the *fallback* any more: since §15.41 no band declares a list, so the
      // table can never supply one. What still exists is the marker already
      // sitting in a store — a machine that installed Berry under an earlier
      // release has `["yarn", "yarnpkg"]` on disk — and that install has to keep
      // running. The file is recovered from the URL, as it always was.
      const spec = {
        location: join(root, "list", "yarn", "4.0.0"),
        bin: ["yarn", "yarnpkg"] as LegacyBinList,
        hash: "",
      };
      expect(resolveBinPath("yarn", spec, YARN_URL)).toBe(join(spec.location, "yarn.js"));
      expect(resolveBinPath("yarnpkg", spec, YARN_URL)).toBe(join(spec.location, "yarn.js"));
    });

    it("asserts rather than crashing when there is no fallback either", () => {
      const spec = { location: join(root, "map", "yarn", "1.0.0"), hash: "" };
      // Not a `TypeError` from reading a property of `undefined`: §12.8's
      // assertion, which says which bin could not be located.
      expect(() => resolveBinPath("yarn", spec, TGZ_URL)).toThrow(
        messages.assertUnableToLocateBinPath("yarn"),
      );
    });

    it("prefers the marker's own bin when it has one", () => {
      const spec = {
        location: join(root, "map", "yarn", "1.0.0"),
        bin: { yarn: "./bin/yarn.js" },
        hash: "",
      };
      expect(resolveBinPath("yarn", spec, TGZ_URL, { yarn: "./other.js" })).toBe(
        join(spec.location, "bin", "yarn.js"),
      );
    });
  });
});

describe("execPackageManager — §08.4 exit codes", () => {
  it("test 132 — a synchronously set exit code 42 is the tool's exit code", () => {
    const location = fixture("sync", { "bin/yarn.js": `process.exitCode = 42;\n` });
    const result = run(location, "yarn", TGZ_URL, { yarn: "./bin/yarn.js" });
    expect(result.status).toBe(42);
  });

  it("test 133 — exit code 42 then an uncaught error exits 1, with the message on stderr", () => {
    const location = fixture("throw", {
      "bin/yarn.js": `process.exitCode = 42;\nthrow new Error("kaboom-from-the-package-manager");\n`,
    });
    const result = run(location, "yarn", TGZ_URL, { yarn: "./bin/yarn.js" });
    // The runtime's own rule, which the tool must not override (corepack 0.18.1).
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("kaboom-from-the-package-manager");
  });

  it("test 133b — an asynchronously thrown error also exits 1 rather than 42", () => {
    const location = fixture("throw-async", {
      "bin/yarn.js": `process.exitCode = 42;\nsetTimeout(() => { throw new Error("late-kaboom"); }, 0);\n`,
    });
    const result = run(location, "yarn", TGZ_URL, { yarn: "./bin/yarn.js" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("late-kaboom");
  });

  it("test 134 — an exit code set only in a beforeExit hook survives", () => {
    const location = fixture("before-exit", {
      "bin/yarn.js": `process.on("beforeExit", () => { process.exitCode = 42; });\n`,
    });
    const result = run(location, "yarn", TGZ_URL, { yarn: "./bin/yarn.js" });
    expect(result.status).toBe(42);
  });

  it("a package manager that returns normally exits 0", () => {
    const location = fixture("clean", { "bin/yarn.js": `console.log("ran");\n` });
    const result = run(location, "yarn", TGZ_URL, { yarn: "./bin/yarn.js" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ran\n");
  });
});

describe("execPackageManager — §08.2 handover", () => {
  it("test 135 — an ESM entry point runs", () => {
    const location = fixture("esm", {
      "package.json": `{"type":"module"}\n`,
      "bin/yarn.js": [
        `import { pathToFileURL } from "node:url";`,
        `console.log("esm-ok", import.meta.url === pathToFileURL(process.argv[1]).href);`,
        ``,
      ].join("\n"),
    });
    const result = run(location, "yarn", TGZ_URL, { yarn: "./bin/yarn.js" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("esm-ok true\n");
  });

  it("a CJS entry point runs as require.main (npm 6 and pnpm 4 read its filename)", () => {
    const location = fixture("cjs", {
      "bin/yarn.js": `console.log("main:", require.main.filename, "execArgv:", JSON.stringify(process.execArgv));\n`,
    });
    const result = run(location, "yarn", TGZ_URL, { yarn: "./bin/yarn.js" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`main: ${join(location, "bin", "yarn.js")} execArgv: []\n`);
  });

  it("test 136 — a bin list resolves every declared name to the same file", () => {
    const location = fixture(
      "binlist",
      { "yarn.js": `console.log(process.argv[1], JSON.stringify(process.argv.slice(2)));\n` },
      "4.0.0",
    );
    const yarn = run(location, "yarn", YARN_URL, ["yarn", "yarnpkg"], ["--version"]);
    const yarnpkg = run(location, "yarnpkg", YARN_URL, ["yarn", "yarnpkg"], ["--version"]);
    expect(yarn.status).toBe(0);
    expect(yarnpkg.status).toBe(0);
    expect(yarn.stdout).toBe(`${join(location, "yarn.js")} ["--version"]\n`);
    // Both names run the same file, with the same argv.
    expect(yarnpkg.stdout).toBe(yarn.stdout);
  });

  it("passes the arguments through untouched after argv[0] and argv[1]", () => {
    const location = fixture("argv", {
      "bin/yarn.js": `console.log(JSON.stringify([process.argv[0] === process.execPath, process.argv.slice(1)]));\n`,
    });
    const result = run(location, "yarn", TGZ_URL, { yarn: "./bin/yarn.js" }, [
      "add",
      "-D",
      "--",
      "x y",
    ]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      true,
      [join(location, "bin", "yarn.js"), "add", "-D", "--", "x y"],
    ]);
  });
});

describe("execPackageManager — §08.7 environment", () => {
  it("test 51 — COREPACK_ROOT points at our own installation root and is visible to the child", () => {
    const location = fixture("env", {
      "bin/yarn.js": `console.log(process.env.COREPACK_ROOT);\n`,
    });
    const result = run(location, "yarn", TGZ_URL, { yarn: "./bin/yarn.js" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(REPO_ROOT);
  });
});

describe("resolveBinPath — §14.13 confinement", () => {
  it("test 141 — a bin value escaping the install directory is refused", () => {
    const spec = {
      location: join(root, "evil", "yarn", "1.0.0"),
      bin: { yarn: "../../../evil" },
      hash: "",
    };
    expect(() => resolveBinPath("yarn", spec, TGZ_URL)).toThrow(
      messages.binEscapes("../../../evil", "yarn", "1.0.0"),
    );
  });

  it("test 141 — the escaping bin is refused before anything is executed", () => {
    const location = fixture("evil", { "bin/yarn.js": `console.log("should not run");\n` });
    // Plant the file the malicious bin points at, so a missing target cannot be
    // what makes this test pass.
    writeFileSync(join(root, "evil.js"), `console.log("pwned");\n`);
    const result = run(location, "yarn", TGZ_URL, { yarn: "../../../evil.js" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(messages.binEscapes("../../../evil.js", "yarn", "1.0.0"));
  });

  it("refuses an absolute bin path", () => {
    const spec = {
      location: join(root, "abs", "yarn", "1.0.0"),
      bin: { yarn: "/etc/passwd" },
      hash: "",
    };
    expect(() => resolveBinPath("yarn", spec, TGZ_URL)).toThrow(
      messages.binEscapes("/etc/passwd", "yarn", "1.0.0"),
    );
  });

  it("accepts a bin path that only looks like it escapes", () => {
    const spec = {
      location: join(root, "ok", "yarn", "1.0.0"),
      bin: { yarn: "./bin/../bin/yarn.js" },
      hash: "",
    };
    expect(resolveBinPath("yarn", spec, TGZ_URL)).toBe(
      join(spec.location, "bin", "..", "bin", "yarn.js"),
    );
  });
});

/* ------------------------------------------------------------------ *
 * §15.32 — the resolved package manager on `PATH`
 *
 * #412: a script that shells out to `pnpm` under `corepack pnpm exec`
 * gets a *different* pnpm, or none. Every case below therefore plants a
 * decoy directory on `PATH` first: an assertion that only checked that
 * `pnpm` was findable would pass on the decoy, and prove nothing about
 * the entry the tool added.
 * ------------------------------------------------------------------ */

describe("§15.32 — PATH", () => {
  describe("pathWith", () => {
    it("prepends, with the platform's separator", () => {
      expect(pathWith("/a", "/b")).toBe(`/a${delimiter}/b`);
      expect(pathWith("/a", "/b/a")).toBe(`/a${delimiter}/b/a`);
    });

    it("is the only modification: the rest of PATH is carried through verbatim", () => {
      const current = `/x${delimiter}/y${delimiter}/z`;
      expect(pathWith("/a", current)).toBe(`/a${delimiter}${current}`);
    });

    it("is idempotent, so nesting cannot grow PATH without bound", () => {
      expect(pathWith("/a", `/a${delimiter}/b`)).toBeUndefined();
      expect(pathWith("/a", "/a")).toBeUndefined();
      // A *prefix* of an entry is not that entry.
      expect(pathWith("/a", `/ab${delimiter}/b`)).toBe(`/a${delimiter}/ab${delimiter}/b`);
      // Present but not first: §15.32 says prepend, so it moves to the front.
      expect(pathWith("/a", `/b${delimiter}/a`)).toBe(`/a${delimiter}/b${delimiter}/a`);
    });

    it("handles an absent or empty PATH", () => {
      expect(pathWith("/a", undefined)).toBe("/a");
      expect(pathWith("/a", "")).toBe("/a");
    });
  });

  /**
   * A shim directory holding a stub named `binName`, plus a decoy directory.
   *
   * The stubs carry {@link SHIM_MARKER}, because that banner — not the name — is
   * what §15.32's promotion recognises: the decoy's `yarn` is a file of exactly
   * the right name written by somebody else, and must not move its directory.
   */
  function pathFixture(name: string, binNames: string[]): { shims: string; decoy: string } {
    const shims = join(root, name, "shims");
    const decoy = join(root, name, "decoy");
    mkdirSync(shims, { recursive: true });
    mkdirSync(decoy, { recursive: true });
    for (const binName of binNames) {
      writeFileSync(join(shims, binName), `#!/usr/bin/env node\n// ${SHIM_MARKER} — generated\n`, {
        mode: 0o755,
      });
    }
    writeFileSync(join(decoy, "yarn"), "");
    return { shims, decoy };
  }

  /**
   * The environment is built from nothing rather than from `process.env`: the
   * developer's own `~/.local/bin` is §15.13's default shim directory, so a run
   * that inherited `HOME` could pass on *their* shims.
   */
  function runWithEnv(
    location: string,
    binName: string,
    bin: BinSpec,
    env: Record<string, string>,
  ): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(
      process.execPath,
      [driver, location, binName, TGZ_URL, JSON.stringify(bin)],
      {
        encoding: "utf8",
        env: { HOME: join(root, "nowhere"), USERPROFILE: join(root, "nowhere"), ...env },
      },
    );
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  const REPORT = `console.log(process.env.PATH);\n`;

  it("puts the shim directory in front of everything, including a decoy", () => {
    const location = fixture("path-shim", { "bin/yarn.js": REPORT });
    const { shims, decoy } = pathFixture("path-shim", ["yarn"]);

    const result = runWithEnv(
      location,
      "yarn",
      { yarn: "./bin/yarn.js" },
      {
        COREPACK_SHIM_DIRECTORY: shims,
        PATH: `${decoy}${delimiter}/usr/bin`,
      },
    );

    expect(result.status).toBe(0);
    // Ours, and first — not the decoy that also answers to `yarn`.
    expect(result.stdout.trim()).toBe(`${shims}${delimiter}${decoy}${delimiter}/usr/bin`);
  });

  it("prepends nothing when the shim directory holds no shim for this binary", () => {
    const location = fixture("path-noshim", { "bin/yarn.js": REPORT });
    // A shim for a *different* binary: the directory exists and is ours, and
    // still must not be prepended, because it does not contain this program.
    const { shims, decoy } = pathFixture("path-noshim", ["pnpm"]);

    const result = runWithEnv(
      location,
      "yarn",
      { yarn: "./bin/yarn.js" },
      {
        COREPACK_SHIM_DIRECTORY: shims,
        PATH: `${decoy}${delimiter}/usr/bin`,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`${decoy}${delimiter}/usr/bin`);
  });

  it("does not stack a second copy when it is already first (nested runs)", () => {
    const location = fixture("path-nested", { "bin/yarn.js": REPORT });
    const { shims, decoy } = pathFixture("path-nested", ["yarn"]);

    const result = runWithEnv(
      location,
      "yarn",
      { yarn: "./bin/yarn.js" },
      {
        COREPACK_SHIM_DIRECTORY: shims,
        PATH: `${shims}${delimiter}${decoy}`,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`${shims}${delimiter}${decoy}`);
  });

  // §15.13's per-user default is platform-specific; XDG is the Linux/BSD half.
  it.skipIf(process.platform === "darwin" || process.platform === "win32")(
    "falls back to §15.13's per-user default when nothing is configured",
    () => {
      const location = fixture("path-peruser", { "bin/yarn.js": REPORT });
      const { shims, decoy } = pathFixture("path-peruser", ["yarn"]);

      const result = runWithEnv(
        location,
        "yarn",
        { yarn: "./bin/yarn.js" },
        {
          XDG_BIN_HOME: shims,
          PATH: decoy,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(`${shims}${delimiter}${decoy}`);
    },
  );

  /* The native branch (§15.28) spawns, so it is the one place where "must not
   * leak into the tool's own process" has a literal meaning to check. */
  describe.skipIf(process.platform === "win32")("the native branch", () => {
    /** Reports the child's PATH, then the tool's own once the child is gone. */
    function runNative(location: string, bin: BinSpec, env: Record<string, string>) {
      const script = join(root, "native-driver.mjs");
      writeFileSync(
        script,
        [
          `import { execPackageManager } from ${JSON.stringify(EXEC_URL)};`,
          `const [location, binJson] = process.argv.slice(2);`,
          `await execPackageManager("bunny", { location, bin: JSON.parse(binJson), hash: "" }, [], ${JSON.stringify(TGZ_URL)}, undefined, "native");`,
          `console.log("parent:" + process.env.PATH);`,
          ``,
        ].join("\n"),
      );
      const result = spawnSync(process.execPath, [script, location, JSON.stringify(bin)], {
        encoding: "utf8",
        env: { HOME: join(root, "nowhere"), ...env },
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    }

    it("prepends the directory holding the extracted binary, and only to the child", () => {
      const location = fixture("path-native", {
        "bin/bunny": `#!/bin/sh\nprintf 'child:%s\\n' "$PATH"\n`,
      });
      chmodSync(join(location, "bin", "bunny"), 0o755);
      const { shims, decoy } = pathFixture("path-native", ["bunny"]);

      const result = runNative(
        location,
        { bunny: "./bin/bunny" },
        {
          // Set, and deliberately irrelevant: a native artifact is not reachable
          // through a shim, so the store directory is what must win.
          COREPACK_SHIM_DIRECTORY: shims,
          PATH: decoy,
        },
      );

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const lines = result.stdout.trimEnd().split("\n");
      expect(lines[0]).toBe(`child:${join(location, "bin")}${delimiter}${decoy}`);
      // No leak: the tool's own PATH is exactly what it started with.
      expect(lines[1]).toBe(`parent:${decoy}`);
    });

    /**
     * §15.28 — the invoked **name** reaches the child as `argv[0]`.
     *
     * This is what lets one artifact answer to two names, which is how bun
     * ships: `bun` and `bunx` are the same file, and the second behaves like
     * the first's `x` subcommand purely because of what `argv[0]` says. Bun's
     * own installer arranges that with a link beside the binary; §02.4 already
     * spells "two names, one file" as two `bin` entries with the same path, so
     * passing the name through is what makes that spelling mean the same thing
     * for a native artifact as it does for a JavaScript one.
     *
     * The fixture is a **symlink to the Node binary**, because a real
     * executable is the only thing that can report its own `argv[0]`: a
     * `#!/bin/sh` artifact never sees it — the kernel execs the interpreter,
     * and `$0` is then the script's path.
     */
    it("hands the child the invoked name as argv[0] (§15.28)", () => {
      const location = fixture("argv0-native", {});
      mkdirSync(join(location, "bin"), { recursive: true });
      symlinkSync(process.execPath, join(location, "bin", "bunny"));

      const script = join(root, "argv0-driver.mjs");
      writeFileSync(
        script,
        [
          `import { execPackageManager } from ${JSON.stringify(EXEC_URL)};`,
          `const [location, binName] = process.argv.slice(2);`,
          `const bin = { bunny: "./bin/bunny", bunnyx: "./bin/bunny" };`,
          `await execPackageManager(binName, { location, bin, hash: "" }, ["-e", "console.log(process.argv0)"], ${JSON.stringify(TGZ_URL)}, undefined, "native");`,
          ``,
        ].join("\n"),
      );

      for (const binName of ["bunny", "bunnyx"]) {
        const result = spawnSync(process.execPath, [script, location, binName], {
          encoding: "utf8",
        });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        // Not the path: both names resolve to `<location>/bin/bunny`, and a
        // child told only the path could not tell the two invocations apart.
        expect(result.stdout.trim()).toBe(binName);
      }
    });
  });
});
