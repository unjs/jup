import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { messages } from "../../src/errors.ts";
import { pathWith, resolveBinPath, SHIM_MARKER } from "../../src/run/exec.ts";
import { execNative } from "../../src/run/native.ts";
import type { BinSpec } from "../../src/types.ts";

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
  bin: BinSpec,
  args: string[] = [],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [driver, location, binName, JSON.stringify(bin), ...args],
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
      `const [location, binName, binJson, ...args] = process.argv.slice(2);`,
      // `handover: true` — this driver stands in for §10's shims and for
      // `bin/jup.mjs`, the two callers for whom §08.2's in-process handover is
      // correct. `runMain`'s default is the isolated path (`RunOptions`), which
      // the driver below exercises.
      `execPackageManager(binName, { location, bin: JSON.parse(binJson), hash: "" }, args, undefined, undefined, undefined, { handover: true });`,
      ``,
    ].join("\n"),
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// Every env stub is undone between cases, whether or not the case that set it
// reached its own last line. A failing assertion used to leave `COREPACK_HOME`
// pointing at the runtime's own prefix for the rest of the file, which turns one
// failure into a page of them; `shims.test.ts` and `cli.test.ts` both hook it
// here for the same reason.
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveBinPath — §08.1", () => {
  it("resolves a bin map entry against the install location", () => {
    const spec = {
      location: join(root, "map", "yarn", "1.0.0"),
      bin: { yarn: "./bin/yarn.js" },
      hash: "",
    };
    expect(resolveBinPath("yarn", spec)).toBe(join(spec.location, "bin", "yarn.js"));
  });

  // §02.4 — "one file, two names" is a map with two keys, which is also the
  // shape a single-file URL install records (§07.7).
  it("resolves two declared names to the same file", () => {
    const spec = {
      location: join(root, "single", "yarn", "4.0.0"),
      bin: { yarn: "./yarn.js", yarnpkg: "./yarn.js" },
      hash: "",
    };
    expect(resolveBinPath("yarn", spec)).toBe(join(spec.location, "yarn.js"));
    expect(resolveBinPath("yarnpkg", spec)).toBe(join(spec.location, "yarn.js"));
  });

  it("leaves the path unset for a bin name that is not declared", () => {
    const spec = {
      location: join(root, "map", "yarn", "1.0.0"),
      bin: { yarn: "./bin/yarn.js" },
      hash: "",
    };
    expect(() => resolveBinPath("yarnpkg", spec)).toThrow(
      messages.assertUnableToLocateBinPath("yarnpkg"),
    );
  });

  it("does not treat inherited object properties as declared bins", () => {
    const spec = { location: join(root, "map", "yarn", "1.0.0"), bin: {} as BinSpec, hash: "" };
    expect(() => resolveBinPath("constructor", spec)).toThrow(
      messages.assertUnableToLocateBinPath("constructor"),
    );
  });

  /*
   * §08.1's first line is `bin := installSpec.bin ?? spec.bin`. §07.7 always
   * records a `bin`, so the fallback stands in for a marker jup did not write —
   * §07.10 promotes those out of somebody else's archive.
   */
  describe("a marker without a bin (§08.1's `?? spec.bin`)", () => {
    it("falls back to the table spec's bin map", () => {
      const spec = { location: join(root, "map", "yarn", "1.0.0"), hash: "" };
      expect(resolveBinPath("yarn", spec, { yarn: "./bin/yarn.js" })).toBe(
        join(spec.location, "bin", "yarn.js"),
      );
    });

    it("asserts rather than crashing when there is no fallback either", () => {
      const spec = { location: join(root, "map", "yarn", "1.0.0"), hash: "" };
      // Not a `TypeError` from reading a property of `undefined`: §12.8's
      // assertion, which says which bin could not be located.
      expect(() => resolveBinPath("yarn", spec)).toThrow(
        messages.assertUnableToLocateBinPath("yarn"),
      );
    });

    it("prefers the marker's own bin when it has one", () => {
      const spec = {
        location: join(root, "map", "yarn", "1.0.0"),
        bin: { yarn: "./bin/yarn.js" },
        hash: "",
      };
      expect(resolveBinPath("yarn", spec, { yarn: "./other.js" })).toBe(
        join(spec.location, "bin", "yarn.js"),
      );
    });
  });
});

describe("execPackageManager — §08.4 exit codes", () => {
  it("test 132 — a synchronously set exit code 42 is the tool's exit code", () => {
    const location = fixture("sync", { "bin/yarn.js": `process.exitCode = 42;\n` });
    const result = run(location, "yarn", { yarn: "./bin/yarn.js" });
    expect(result.status).toBe(42);
  });

  it("test 133 — exit code 42 then an uncaught error exits 1, with the message on stderr", () => {
    const location = fixture("throw", {
      "bin/yarn.js": `process.exitCode = 42;\nthrow new Error("kaboom-from-the-package-manager");\n`,
    });
    const result = run(location, "yarn", { yarn: "./bin/yarn.js" });
    // The runtime's own rule, which the tool must not override (corepack 0.18.1).
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("kaboom-from-the-package-manager");
  });

  it("test 133b — an asynchronously thrown error also exits 1 rather than 42", () => {
    const location = fixture("throw-async", {
      "bin/yarn.js": `process.exitCode = 42;\nsetTimeout(() => { throw new Error("late-kaboom"); }, 0);\n`,
    });
    const result = run(location, "yarn", { yarn: "./bin/yarn.js" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("late-kaboom");
  });

  it("test 134 — an exit code set only in a beforeExit hook survives", () => {
    const location = fixture("before-exit", {
      "bin/yarn.js": `process.on("beforeExit", () => { process.exitCode = 42; });\n`,
    });
    const result = run(location, "yarn", { yarn: "./bin/yarn.js" });
    expect(result.status).toBe(42);
  });

  it("a package manager that returns normally exits 0", () => {
    const location = fixture("clean", { "bin/yarn.js": `console.log("ran");\n` });
    const result = run(location, "yarn", { yarn: "./bin/yarn.js" });
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
    const result = run(location, "yarn", { yarn: "./bin/yarn.js" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("esm-ok true\n");
  });

  it("a CJS entry point runs as require.main (npm 6 and pnpm 4 read its filename)", () => {
    const location = fixture("cjs", {
      "bin/yarn.js": `console.log("main:", require.main.filename, "execArgv:", JSON.stringify(process.execArgv));\n`,
    });
    const result = run(location, "yarn", { yarn: "./bin/yarn.js" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`main: ${join(location, "bin", "yarn.js")} execArgv: []\n`);
  });

  it("test 136 — every name a bin map declares runs the same file", () => {
    const location = fixture(
      "twonames",
      { "yarn.js": `console.log(process.argv[1], JSON.stringify(process.argv.slice(2)));\n` },
      "4.0.0",
    );
    const bin = { yarn: "./yarn.js", yarnpkg: "./yarn.js" };
    const yarn = run(location, "yarn", bin, ["--version"]);
    const yarnpkg = run(location, "yarnpkg", bin, ["--version"]);
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
    const result = run(location, "yarn", { yarn: "./bin/yarn.js" }, ["add", "-D", "--", "x y"]);
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
    const result = run(location, "yarn", { yarn: "./bin/yarn.js" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(REPO_ROOT);
  });
});

describe("resolveBinPath — §08.1 confinement", () => {
  it("test 141 — a bin value escaping the install directory is refused", () => {
    const spec = {
      location: join(root, "evil", "yarn", "1.0.0"),
      bin: { yarn: "../../../evil" },
      hash: "",
    };
    expect(() => resolveBinPath("yarn", spec)).toThrow(
      messages.binEscapes("../../../evil", "yarn", "1.0.0"),
    );
  });

  it("test 141 — the escaping bin is refused before anything is executed", () => {
    const location = fixture("evil", { "bin/yarn.js": `console.log("should not run");\n` });
    // Plant the file the malicious bin points at, so a missing target cannot be
    // what makes this test pass.
    writeFileSync(join(root, "evil.js"), `console.log("pwned");\n`);
    const result = run(location, "yarn", { yarn: "../../../evil.js" });
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
    expect(() => resolveBinPath("yarn", spec)).toThrow(
      messages.binEscapes("/etc/passwd", "yarn", "1.0.0"),
    );
  });

  it("accepts a bin path that only looks like it escapes", () => {
    const spec = {
      location: join(root, "ok", "yarn", "1.0.0"),
      bin: { yarn: "./bin/../bin/yarn.js" },
      hash: "",
    };
    expect(resolveBinPath("yarn", spec)).toBe(join(spec.location, "bin", "..", "bin", "yarn.js"));
  });
});

/* ------------------------------------------------------------------ *
 * §10.2 — the forwarded host runtime
 *
 * `node` is a table entry (§02.3), so a native handover can be *the
 * runtime itself*: our `node` shim resolves the project's version and
 * spawns it, and everything below that point — a nested `jup enable`
 * most of all — has a `process.execPath` inside the store. `enable`
 * must not bake that into a shebang, so the last process outside the
 * store leaves its realpath in the child's environment for it.
 *
 * `execNative` inherits stdio, so the probe writes what it saw to a
 * file rather than to a pipe.
 * ------------------------------------------------------------------ */

describe.skipIf(process.platform === "win32")("§10.2 — JUP_HOST_RUNTIME", () => {
  /** Both spellings (§11.6), one per line, into the file named as `$1`. */
  function probe(): string {
    const file = join(root, "probe.sh");
    writeFileSync(
      file,
      `#!/bin/sh\nprintf '%s\\n%s\\n' "$JUP_HOST_RUNTIME" "$JUP_HOST_RUNTIME" > "$1"\n`,
    );
    chmodSync(file, 0o755);
    return file;
  }

  async function observed(env: NodeJS.ProcessEnv): Promise<[string, string]> {
    const out = join(root, `host-runtime-${Math.random().toString(16).slice(2)}`);
    expect(await execNative(probe(), [out], env)).toBe(0);
    const [corepack, jup] = readFileSync(out, "utf8").split("\n");
    return [corepack!, jup!];
  }

  it("writes the realpath of the runtime spawning the child, under both spellings", async () => {
    expect(await observed({ ...process.env })).toEqual([
      realpathSync(process.execPath),
      realpathSync(process.execPath),
    ]);
  });

  it("writes into the child's environment and never into our own", async () => {
    // `env` defaults to `process.env`, so a forward that wrote *into* the object
    // it was handed would set `JUP_HOST_RUNTIME` on this process for the
    // rest of its life — §03.2 refuses that same value from an env file, and a
    // mutating default is the only other way into it. Called the way the
    // signature permits, with no environment of the caller's own.
    const out = join(root, "host-runtime-default-env");
    expect(await execNative(probe(), [out])).toBe(0);

    expect(readFileSync(out, "utf8").split("\n").slice(0, 2)).toEqual([
      realpathSync(process.execPath),
      realpathSync(process.execPath),
    ]);
    expect(process.env.JUP_HOST_RUNTIME).toBeUndefined();
    expect(process.env.JUP_HOST_RUNTIME).toBeUndefined();
  });

  it("passes an inherited value through when our own runtime is in the store", async () => {
    // The position a store runtime is in, without a 126 MB copy of one: a
    // `<home>` whose `v1` *is* the installation holding the runtime this test
    // runs under. §10.2's boundary test resolves the install folder through
    // `realpath`, so the link makes `process.execPath` answer exactly as
    // `<home>/v1/node/22.14.0/bin/node` would.
    //
    // `<home>` on its own is no longer enough, and that is the point of the
    // link: §07.11's `self/` — and a runtime an install script parks beside
    // it — are siblings of `v1` that `cache clean` deliberately cannot reach,
    // so a path under `<home>` but outside `v1` is *not* a store runtime.
    const home = join(root, "store-home");
    mkdirSync(home, { recursive: true });
    symlinkSync(dirname(dirname(realpathSync(process.execPath))), join(home, "v1"));
    vi.stubEnv("COREPACK_HOME", home);

    const inherited = "/opt/hostnode/bin/node";
    expect(
      await observed({
        ...process.env,
        JUP_HOST_RUNTIME: inherited,
      }),
    ).toEqual([inherited, inherited]);

    // And it is not invented either: a chain that started inside the store has
    // nothing to forward, and `enable` falls through to its `PATH` walk.
    expect(await observed({ ...process.env })).toEqual(["", ""]);
  });
});

/* ------------------------------------------------------------------ *
 * §08.3 — the resolved package manager on `PATH`
 *
 * #412: a script that shells out to `pnpm` under `corepack pnpm exec`
 * gets a *different* pnpm, or none. Every case below therefore plants a
 * decoy directory on `PATH` first: an assertion that only checked that
 * `pnpm` was findable would pass on the decoy, and prove nothing about
 * the entry the tool added.
 * ------------------------------------------------------------------ */

describe("§08.3 — PATH", () => {
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
      // Present but not first: §08.3 says prepend, so it moves to the front.
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
   * what §08.3's promotion recognises: the decoy's `yarn` is a file of exactly
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
   * developer's own `~/.local/bin` is §10.5's default shim directory, so a run
   * that inherited `HOME` could pass on *their* shims.
   */
  function runWithEnv(
    location: string,
    binName: string,
    bin: BinSpec,
    env: Record<string, string>,
  ): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [driver, location, binName, JSON.stringify(bin)], {
      encoding: "utf8",
      env: { HOME: join(root, "nowhere"), USERPROFILE: join(root, "nowhere"), ...env },
    });
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
        JUP_SHIM_DIRECTORY: shims,
        PATH: `${decoy}${delimiter}/usr/bin`,
      },
    );

    expect(result.status).toBe(0);
    // Ours, and first — not the decoy that also answers to `yarn`.
    expect(result.stdout.trim()).toBe(`${shims}${delimiter}${decoy}${delimiter}/usr/bin`);
  });

  /**
   * §16 — the zero-syscall branch, and the guard that keeps it honest.
   *
   * A copy of the driver *at* `<dir>/yarn` is §10.1's shape as Node sees it:
   * `argv[1]` is the shim's own path, not the stub's, because Node does not
   * `realpath` it. The pair below asserts both halves of the test that reads —
   * the name has to match, **and** the directory has to be one we would have
   * chosen, or the promotion is being decided on a name alone.
   */
  function driverNamed(directory: string, binName: string): string {
    // Extensionless, so it needs the same `"type": "module"` marker the real
    // `dist/` carries for the real stub.
    writeFileSync(join(directory, "package.json"), `{"type":"module"}\n`);
    const entry = join(directory, binName);
    writeFileSync(entry, readFileSync(driver));
    return entry;
  }

  it("needs no read when the run came through the shim itself (§16)", () => {
    const location = fixture("path-self", { "bin/yarn.js": REPORT });
    const { shims, decoy } = pathFixture("path-self", []);
    // No marker stub is written into `shims` at all: the file that runs *is* the
    // shim, so there is nothing left for the banner read to find, and the
    // promotion must still happen.
    const entry = driverNamed(shims, "yarn");

    const result = spawnSync(
      process.execPath,
      [entry, location, "yarn", JSON.stringify({ yarn: "./bin/yarn.js" })],
      {
        encoding: "utf8",
        env: {
          HOME: join(root, "nowhere"),
          USERPROFILE: join(root, "nowhere"),
          JUP_SHIM_DIRECTORY: shims,
          PATH: `${decoy}${delimiter}/usr/bin`,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`${shims}${delimiter}${decoy}${delimiter}/usr/bin`);
  });

  it("will not promote a directory off the candidate list, whatever it is named", () => {
    const location = fixture("path-notcand", { "bin/yarn.js": REPORT });
    const { shims, decoy } = pathFixture("path-notcand", ["yarn"]);
    // `argv[1]` is `<decoy>/yarn`: the right name in the wrong directory. The
    // answer must come from the candidate list, so `<shims>` wins on its banner
    // and `<decoy>` is left exactly where it was.
    const entry = driverNamed(decoy, "yarn");

    const result = spawnSync(
      process.execPath,
      [entry, location, "yarn", JSON.stringify({ yarn: "./bin/yarn.js" })],
      {
        encoding: "utf8",
        env: {
          HOME: join(root, "nowhere"),
          USERPROFILE: join(root, "nowhere"),
          JUP_SHIM_DIRECTORY: shims,
          PATH: `${decoy}${delimiter}/usr/bin`,
        },
      },
    );

    expect(result.status).toBe(0);
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
        JUP_SHIM_DIRECTORY: shims,
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
        JUP_SHIM_DIRECTORY: shims,
        PATH: `${shims}${delimiter}${decoy}`,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`${shims}${delimiter}${decoy}`);
  });

  // §10.5's per-user default is platform-specific; XDG is the Linux/BSD half.
  it.skipIf(process.platform === "darwin" || process.platform === "win32")(
    "falls back to §10.5's per-user default when nothing is configured",
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

  /* The native branch (§08.3) spawns, so it is the one place where "must not
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
          `await execPackageManager("bunny", { location, bin: JSON.parse(binJson), hash: "" }, [], undefined, "native", undefined, { handover: true });`,
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
          JUP_SHIM_DIRECTORY: shims,
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
     * §08.3 — the invoked **name** reaches the child as `argv[0]`.
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
    it("hands the child the invoked name as argv[0] (§08.3)", () => {
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
          `await execPackageManager(binName, { location, bin, hash: "" }, ["-e", "console.log(process.argv0)"], undefined, "native", undefined, { handover: true });`,
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

/* ------------------------------------------------------------------ *
 * §08.2 / §08.3.1 — `RunOptions.handover`
 *
 * Everything above this point asks for handover explicitly, because
 * everything above stands in for a shim. This block is the other
 * caller: a host application that called `runMain` with work left to
 * do, for whom giving the process away and dying the child's death are
 * both fatal. The default is therefore off, and what stands in for
 * §08.2 is §08.3.1's spawn.
 *
 * Each case is a real child process for the reason the whole file is:
 * the claims are about what a *process* still holds after the call.
 * ------------------------------------------------------------------ */

describe("execPackageManager — the isolated path (§08.2, §08.3.1)", () => {
  /**
   * Run a JavaScript entry point with handover off, then report what the
   * calling process still holds. `probe` is appended to the driver, so a
   * case can print whatever it wants to assert about the caller.
   */
  function runIsolated(
    location: string,
    bin: BinSpec,
    probe: string[] = [],
    args: string[] = [],
    env: Record<string, string> = {},
  ): { status: number | null; stdout: string; stderr: string } {
    const script = join(root, "isolated-driver.mjs");
    writeFileSync(
      script,
      [
        `import { execPackageManager } from ${JSON.stringify(EXEC_URL)};`,
        `const [location, binJson, ...args] = process.argv.slice(2);`,
        `const before = {`,
        `  argv: JSON.stringify(process.argv),`,
        `  execArgv: JSON.stringify(process.execArgv),`,
        `  path: process.env.PATH,`,
        `  main: process.mainModule,`,
        `  root: process.env.COREPACK_ROOT,`,
        `  jupRoot: process.env.JUP_ROOT,`,
        `};`,
        // No options argument at all: the default is what is under test.
        `const code = await execPackageManager("yarn", { location, bin: JSON.parse(binJson), hash: "" }, args);`,
        `console.log("code:" + code);`,
        ...probe,
        ``,
      ].join("\n"),
    );

    const result = spawnSync(process.execPath, [script, location, JSON.stringify(bin), ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("returns the tool's real exit code instead of §08.4's placeholder 0", () => {
    const location = fixture("isolated-code", {
      "bin/yarn.js": `console.log("ran");\nprocess.exitCode = 42;\n`,
    });

    const result = runIsolated(location, { yarn: "./bin/yarn.js" });

    expect(result.stdout).toContain("ran\n");
    // The number §08.2 cannot produce: there the module body runs after the
    // call returns, so the only honest answer is 0 and the process's own
    // status carries the truth.
    expect(result.stdout).toContain("code:42");
    // And the caller decides its own fate: it set nothing, so it exits 0
    // despite having just run a tool that asked for 42.
    expect(result.status).toBe(0);
  });

  it("leaves the caller's process state exactly as it found it (§08.2)", () => {
    const location = fixture("isolated-state", {
      // The child is the one place §08.7's addition must be visible.
      "bin/yarn.js": `console.log("child-root:" + (process.env.COREPACK_ROOT !== undefined));\n`,
    });

    const result = runIsolated(location, { yarn: "./bin/yarn.js" }, [
      `console.log("argv:" + (before.argv === JSON.stringify(process.argv)));`,
      `console.log("execArgv:" + (before.execArgv === JSON.stringify(process.execArgv)));`,
      `console.log("path:" + (before.path === process.env.PATH));`,
      `console.log("mainModule:" + (before.main === process.mainModule));`,
      // Unchanged, not absent: a run nested inside another version manager
      // inherits a `COREPACK_ROOT` that was never ours to clear (§08.7).
      `console.log("root:" + (before.root === process.env.COREPACK_ROOT));`,
      `console.log("jup-root:" + (before.jupRoot === process.env.JUP_ROOT));`,
      // The point of all of it: there is still a script here to run.
      `console.log("alive:true");`,
    ]);

    expect(result.status).toBe(0);
    // §08.7 — the child gets `COREPACK_ROOT`; the caller's environment does not.
    expect(result.stdout).toContain("child-root:true");
    for (const claim of [
      "argv:true",
      "execArgv:true",
      "path:true",
      "mainModule:true",
      "root:true",
      "jup-root:true",
      "alive:true",
    ]) {
      expect(result.stdout).toContain(claim);
    }
  });

  it("passes the arguments through and finds itself at argv[1] (§08.3.1)", () => {
    const location = fixture("isolated-argv", {
      "bin/yarn.js": [
        `console.log("args:" + JSON.stringify(process.argv.slice(2)));`,
        // Yarn's own read: `process.argv[1]` must be the entry point, which is
        // what a spawned `<interpreter> <binPath>` produces without a rewrite.
        `console.log("self:" + process.argv[1].endsWith("yarn.js"));`,
        ``,
      ].join("\n"),
    });

    const result = runIsolated(location, { yarn: "./bin/yarn.js" }, [], ["install", "--frozen"]);

    expect(result.stdout).toContain(`args:["install","--frozen"]`);
    expect(result.stdout).toContain("self:true");
  });

  it("honours JUP_NODE_EXECPATH as the interpreter (§08.3.1)", () => {
    const location = fixture("isolated-interpreter", { "bin/yarn.js": `\n` });

    // A shell script standing in for a runtime: it can report that it was the
    // thing spawned, and what it was handed, which no real interpreter can say
    // about itself without ambiguity.
    const fake = join(root, "fake-node");
    writeFileSync(fake, `#!/bin/sh\nprintf 'interpreter:%s\\n' "$1"\nexit 7\n`);
    chmodSync(fake, 0o755);

    const result = runIsolated(location, { yarn: "./bin/yarn.js" }, [], [], {
      JUP_NODE_EXECPATH: fake,
    });

    expect(result.stdout).toContain(join(location, "bin", "yarn.js"));
    // The interpreter's own status is the run's, exactly as a tool's would be.
    expect(result.stdout).toContain("code:7");
  });

  /* §08.5 — the native path's other fatality. */
  describe.skipIf(process.platform === "win32")("a signal death", () => {
    it("comes back as 128 + N rather than killing the caller (§08.4)", () => {
      const location = fixture("isolated-signal", {
        "bin/bunny": `#!/bin/sh\nkill -TERM $$\n`,
      });
      chmodSync(join(location, "bin", "bunny"), 0o755);

      const script = join(root, "isolated-signal-driver.mjs");
      writeFileSync(
        script,
        [
          `import { execPackageManager } from ${JSON.stringify(EXEC_URL)};`,
          `const [location] = process.argv.slice(2);`,
          `const bin = { bunny: "./bin/bunny" };`,
          `const code = await execPackageManager("bunny", { location, bin, hash: "" }, [], undefined, "native");`,
          `console.log("code:" + code);`,
          `console.log("alive:true");`,
          ``,
        ].join("\n"),
      );

      const result = spawnSync(process.execPath, [script, location], { encoding: "utf8" });

      // §08.4's stated fallback, taken deliberately: `SIGTERM` is 15.
      expect(result.stdout).toContain("code:143");
      expect(result.stdout).toContain("alive:true");
      // The caller is not the tool, so it did not die the tool's death: with
      // handover it would have exited *by signal*, with no status at all.
      expect(result.signal).toBe(null);
      expect(result.status).toBe(0);
    });
  });
});
