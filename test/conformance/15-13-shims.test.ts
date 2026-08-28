/**
 * §15.38 rows 170–175 and 195 — the shims-and-enablement cluster.
 *
 * `enable` is the one command a corepack migrant runs first, and every item here
 * comes from a long-open issue about it:
 *
 * | Row | § | Issue |
 * |---|---|---|
 * | 170 | §15.13 | #71 (34👍), #265, #416 — the install directory needs root |
 * | 171 | §15.13 | #673 — `LOCALAPPDATA` honoured on Linux/WSL |
 * | 172 | §15.13 | #71 — shims installed somewhere inert, silently |
 * | 173 | §15.14 | #751 — a stale shim pointing at a `dist/` that is gone |
 * | 174 | §15.15 | #112 (10👍) — `disable` deletes the real yarn `enable` ate |
 * | 175 | §15.16 | #138 — npm is not shimmed, so `npm install` bypasses the pin |
 * | 195 | §15.29 | #507 (12👍) — `enable` exits 0 and nothing changed |
 * | 246–249 | §15.13 | the per-user default is not on macOS's `PATH` at all, and is on Debian's only after the next login |
 *
 * Every row runs the real entry point through a throwaway copy of the tool
 * (`copyTool`) with `HOME` redirected into the fixture, because §15.13's default
 * is a directory under the *user's* home and a row that forgets would install
 * into the developer's own `PATH`.
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  alternateShims,
  cleanupFixtures,
  copyTool,
  createFixture,
  perUserShims,
  run,
  seedPackageManager,
} from "./_harness/index.ts";

const TOOL = copyTool();

const IS_WINDOWS = process.platform === "win32";
const IS_ROOT = process.getuid?.() === 0;

interface ShimFixtureOptions {
  /** Extra directories, in order, before the per-user default on `PATH`. */
  pathPrefix?: string[];
  /** Leave the per-user default off `PATH` entirely (row 172). */
  offPath?: boolean;
}

function shimFixture(options: ShimFixtureOptions = {}) {
  const fixture = createFixture();
  // §15.13's per-user default is spelled differently on each platform, and so
  // is the variable that redirects it — see `perUserShims`.
  const { dir: shimDir, env: shimEnv } = perUserShims(fixture.root);
  mkdirSync(shimDir, { recursive: true });

  const entries = [...(options.pathPrefix ?? [])];
  if (options.offPath !== true) entries.push(shimDir);

  return {
    fixture,
    shimDir,
    options: {
      cwd: fixture.cwd,
      home: fixture.home,
      bin: TOOL,
      env: {
        HOME: fixture.root,
        USERPROFILE: fixture.root,
        ...shimEnv,
        PATH: [...entries, process.env.PATH ?? ""].join(delimiter),
      } as Record<string, string | undefined>,
    },
  };
}

afterAll(cleanupFixtures);

describe("§15.13 — never require elevation", () => {
  // Skipped on Windows for the same reason it is skipped for root: nothing
  // here can make the directory unwritable. `chmod` on that platform toggles
  // the read-only *file* attribute and has no effect on a directory, so
  // `enable` correctly writes into it and never falls back. Reaching §15.13
  // point 2 there would mean denying a WRITE_DATA ACE through `icacls`, which
  // is a different test than this one. §14.18 is unaffected: the refusal it
  // describes is the same code path, reached from the same probe.
  it.skipIf(IS_ROOT || IS_WINDOWS)(
    "170: a read-only install directory falls back to the per-user one, and says so",
    async () => {
      const { fixture, shimDir, options } = shimFixture();
      const readOnly = join(fixture.root, "usr-bin");
      mkdirSync(readOnly);
      await chmod(readOnly, 0o555);

      const result = await run(["enable", "--install-directory", readOnly, "yarn"], options);

      expect(result.exitCode).toBe(0);
      // Byte-exact (§15.13 point 2).
      expect(result.stderr).toBe(
        `! ${readOnly} is not writable; installing shims to ${shimDir} instead\n`,
      );
      expect(existsSync(join(shimDir, "yarn"))).toBe(true);
      expect(existsSync(join(readOnly, "yarn"))).toBe(false);

      await chmod(readOnly, 0o755);
    },
  );

  it.skipIf(IS_WINDOWS)("171: LOCALAPPDATA is ignored off Windows, for the store too", async () => {
    const { fixture, options } = shimFixture();
    // #673's shape: a Linux process that inherited LOCALAPPDATA through WSL
    // interop. Neither the store nor the shim directory may follow it.
    const alien = join(fixture.root, "mnt", "c", "Users", "someone", "AppData", "Local");
    mkdirSync(alien, { recursive: true });

    const result = await run(["info", "--json"], {
      ...options,
      env: {
        ...options.env,
        COREPACK_HOME: undefined,
        XDG_CACHE_HOME: undefined,
        XDG_BIN_HOME: undefined,
        LOCALAPPDATA: alien,
      },
    });

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as {
      store: { home: string };
      shims: { directory: string };
    };
    expect(report.store.home).toBe(join(fixture.root, ".cache", "jup"));
    expect(report.store.home.startsWith(alien)).toBe(false);
    expect(report.shims.directory).toBe(join(fixture.root, ".local", "bin"));
  });

  it("171: COREPACK_SHIM_DIRECTORY names the default install directory", async () => {
    const { fixture, options } = shimFixture();
    const configured = join(fixture.root, "configured");

    const result = await run(["enable", "yarn"], {
      ...options,
      env: {
        ...options.env,
        COREPACK_SHIM_DIRECTORY: configured,
        PATH: `${configured}${delimiter}${options.env.PATH ?? ""}`,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(existsSync(join(configured, "yarn"))).toBe(true);

    // …and `disable` looks in the same place, which is what makes the variable
    // usable at all.
    const removed = await run(["disable", "yarn"], {
      ...options,
      env: { ...options.env, COREPACK_SHIM_DIRECTORY: configured },
    });
    expect(removed.exitCode).toBe(0);
    expect(existsSync(join(configured, "yarn"))).toBe(false);
  });

  it("172: a shim directory absent from PATH prints the exact line to add", async () => {
    const { shimDir, options } = shimFixture({ offPath: true });

    const result = await run(["enable", "yarn"], {
      ...options,
      env: { ...options.env, SHELL: "/bin/bash" },
    });

    // Exit 0 — a warning, not a failure — but never silence.
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(`! ${shimDir} is not on your PATH`);
    expect(result.stderr).toContain(`export PATH="${shimDir}:$PATH"`);
    expect(result.stderr).toContain("hash -r");
    expect(existsSync(join(shimDir, "yarn"))).toBe(true);
  });

  /**
   * Rows 246–249 — §15.13 point 6, the `PATH` preference.
   *
   * Windows is skipped throughout, and not for the usual reason: its candidate
   * list has exactly one entry (§15.13 point 6), so there is no preference to
   * exercise and a row that invented an alternate would be testing something the
   * spec does not require.
   */
  it.skipIf(IS_WINDOWS)(
    "246: an off-PATH default yields to <home>/bin when that is on PATH",
    async () => {
      const { fixture, shimDir, options } = shimFixture({ offPath: true });
      const alternate = alternateShims(fixture.root);
      mkdirSync(alternate, { recursive: true });

      const withAlternate = {
        ...options,
        env: { ...options.env, PATH: `${alternate}${delimiter}${options.env.PATH ?? ""}` },
      };
      const result = await run(["enable", "yarn"], withAlternate);

      expect(result.exitCode).toBe(0);
      // Byte-exact (§15.13 point 6), and the *only* line: the chosen directory is
      // on `PATH` by construction, so point 3's advisory has nothing to say.
      expect(result.stderr).toBe(
        `! ${shimDir} is not on your PATH; installing shims to ${alternate} instead\n`,
      );
      expect(existsSync(join(alternate, "yarn"))).toBe(true);
      expect(existsSync(join(shimDir, "yarn"))).toBe(false);

      // §15.13 point 7 — removal does not read `PATH`, so a `disable` from a
      // shell that never had the alternate on it still finds the shims.
      const removed = await run(["disable", "yarn"], options);
      expect(removed.exitCode).toBe(0);
      expect(existsSync(join(alternate, "yarn"))).toBe(false);
    },
  );

  it.skipIf(IS_WINDOWS)(
    "247: a writable non-candidate on PATH is ignored, however early it sits",
    async () => {
      const { fixture, shimDir, options } = shimFixture({ offPath: true });
      // #71's shape: a writable directory on `PATH` holding the tool's own
      // binary. Corepack would install beside it; a "first writable entry on
      // PATH" rule would land back there too.
      const beside = join(fixture.root, "usr-local-bin");
      mkdirSync(beside, { recursive: true });
      writeFileSync(join(beside, "jup"), "#!/bin/sh\n");
      await chmod(join(beside, "jup"), 0o755);

      const result = await run(["enable", "yarn"], {
        ...options,
        env: {
          ...options.env,
          SHELL: "/bin/bash",
          PATH: `${beside}${delimiter}${options.env.PATH ?? ""}`,
        },
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(join(beside, "yarn"))).toBe(false);
      expect(existsSync(join(shimDir, "yarn"))).toBe(true);
      // No preference was available, so this is row 172's outcome unchanged.
      expect(result.stderr).toContain(`! ${shimDir} is not on your PATH`);
      expect(result.stderr).not.toContain("installing shims to");
    },
  );

  it.skipIf(IS_WINDOWS)(
    "248: <home>/bin is skipped when group-writable, and never created",
    async () => {
      const { fixture, shimDir, options } = shimFixture({ offPath: true });
      const alternate = alternateShims(fixture.root);
      mkdirSync(alternate, { recursive: true });
      await chmod(alternate, 0o775);

      const onPath = {
        ...options,
        env: { ...options.env, PATH: `${alternate}${delimiter}${options.env.PATH ?? ""}` },
      };
      const groupWritable = await run(["enable", "yarn"], onPath);

      expect(groupWritable.exitCode).toBe(0);
      expect(existsSync(join(alternate, "yarn"))).toBe(false);
      expect(existsSync(join(shimDir, "yarn"))).toBe(true);
      expect(groupWritable.stderr).toContain(`! ${shimDir} is not on your PATH`);

      // And absent altogether: a `PATH` entry naming a directory that is not
      // there is inert, and `enable` does not manufacture one.
      const second = shimFixture({ offPath: true });
      const missing = alternateShims(second.fixture.root);
      const absent = await run(["enable", "yarn"], {
        ...second.options,
        env: {
          ...second.options.env,
          PATH: `${missing}${delimiter}${second.options.env.PATH ?? ""}`,
        },
      });

      expect(absent.exitCode).toBe(0);
      expect(existsSync(missing)).toBe(false);
      expect(existsSync(join(second.shimDir, "yarn"))).toBe(true);
    },
  );

  it.skipIf(IS_WINDOWS)(
    "249: continuity outranks the preference, and info agrees without reading PATH",
    async () => {
      const { fixture, shimDir, options } = shimFixture({ offPath: true });
      // A first `enable`, before the alternate existed: the shims are in the
      // default, which is off `PATH`.
      expect((await run(["enable", "yarn"], options)).exitCode).toBe(0);
      expect(existsSync(join(shimDir, "yarn"))).toBe(true);

      const alternate = alternateShims(fixture.root);
      mkdirSync(alternate, { recursive: true });
      const withAlternate = {
        ...options,
        env: { ...options.env, PATH: `${alternate}${delimiter}${options.env.PATH ?? ""}` },
      };

      const again = await run(["enable", "yarn"], withAlternate);

      // No second set. Moving them is `disable` then `enable`.
      expect(again.exitCode).toBe(0);
      expect(existsSync(join(alternate, "yarn"))).toBe(false);
      expect(again.stderr).not.toContain("installing shims to");

      const report = await run(["info", "--json"], withAlternate);
      expect(report.exitCode).toBe(0);
      expect((JSON.parse(report.stdout) as { shims: { directory: string } }).shims.directory).toBe(
        shimDir,
      );
    },
  );

  it("172: the line is spelled for the detected shell", async () => {
    const { shimDir, options } = shimFixture({ offPath: true });

    const fish = await run(["enable", "yarn"], {
      ...options,
      env: { ...options.env, SHELL: "/usr/bin/fish" },
    });

    expect(fish.exitCode).toBe(0);
    expect(fish.stderr).toContain(`fish_add_path ${shimDir}`);
    expect(fish.stderr).not.toContain("export PATH");
  });
});

describe("§15.14 — stale shims", () => {
  it.skipIf(IS_WINDOWS)("173: enable replaces a shim whose target is gone", async () => {
    const { fixture, shimDir, options } = shimFixture();
    // #751 exactly: Node 25 stopped bundling corepack, so `dist/yarn.mjs` is no
    // longer there while the symlink in the bin directory survives.
    const gone = join(fixture.root, "removed-dist", "yarn.mjs");
    symlinkSync(gone, join(shimDir, "yarn"));
    expect(existsSync(join(shimDir, "yarn"))).toBe(false); // dangling
    expect(lstatSync(join(shimDir, "yarn")).isSymbolicLink()).toBe(true);

    const result = await run(["enable", "yarn"], options);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    // Now it points at something that exists, and that something is ours.
    expect(existsSync(join(shimDir, "yarn"))).toBe(true);
    expect(readFileSync(join(shimDir, "yarn"), "utf8")).toContain("@jup-shim");
  });

  it.skipIf(IS_WINDOWS)("173: disable removes such a shim rather than skipping it", async () => {
    const { fixture, shimDir, options } = shimFixture();
    const gone = join(fixture.root, "removed-dist", "yarn.mjs");
    symlinkSync(gone, join(shimDir, "yarn"));

    const result = await run(["disable", "yarn"], options);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(lstatSync(join(shimDir, "yarn"), { throwIfNoEntry: false })).toBeUndefined();
  });
});

describe("§15.15 — disable is non-destructive", () => {
  it.skipIf(IS_WINDOWS)(
    "174: enable --force over a real binary, then disable, restores it",
    async () => {
      const { shimDir, options } = shimFixture();
      const real = join(shimDir, "yarn");
      const body = "#!/bin/sh\necho the real yarn\n";
      writeFileSync(real, body);
      await chmod(real, 0o755);

      // Without --force it is refused outright (§14.16) — the first half of the
      // guarantee. #112 is about what happens when the user insists.
      const refused = await run(["enable", "yarn"], options);
      expect(refused.exitCode).toBe(0);
      expect(refused.stderr).toContain("was not installed by this tool");
      expect(readFileSync(real, "utf8")).toBe(body);

      const forced = await run(["enable", "yarn", "--force"], options);
      expect(forced.exitCode).toBe(0);
      expect(lstatSync(real).isSymbolicLink()).toBe(true);
      // The displacement is on record, in the home directory the run owns.
      expect(existsSync(join(options.home, "shims.json"))).toBe(true);

      const removed = await run(["disable", "yarn"], options);

      expect(removed.exitCode).toBe(0);
      expect(removed.stderr).toBe("");
      expect(lstatSync(real).isSymbolicLink()).toBe(false);
      expect(readFileSync(real, "utf8")).toBe(body);
      expect(lstatSync(real).mode & 0o777).toBe(0o755);
      // The record is cleared, so a second disable does nothing at all.
      expect(existsSync(join(options.home, "shims.json"))).toBe(false);
      expect((await run(["disable", "yarn"], options)).exitCode).toBe(0);
      expect(readFileSync(real, "utf8")).toBe(body);
    },
  );

  it.skipIf(IS_WINDOWS)(
    "174: disable leaves a foreign binary it never displaced alone",
    async () => {
      const { shimDir, options } = shimFixture();
      const real = join(shimDir, "pnpm");
      const body = "#!/bin/sh\necho the real pnpm\n";
      writeFileSync(real, body);
      await chmod(real, 0o755);

      const result = await run(["disable"], options);

      expect(result.exitCode).toBe(0);
      expect(readFileSync(real, "utf8")).toBe(body);
    },
  );
});

describe("§15.16 — npm is shimmed by default", () => {
  it("175: enable with no arguments creates npm shims; --exclude npm omits them", async () => {
    const withNpm = shimFixture();
    expect((await run(["enable"], withNpm.options)).exitCode).toBe(0);
    for (const name of ["npm", "npx", "pnpm", "pnpx", "yarn", "yarnpkg"]) {
      expect(existsSync(join(withNpm.shimDir, name))).toBe(true);
    }

    const without = shimFixture();
    expect((await run(["enable", "--exclude", "npm"], without.options)).exitCode).toBe(0);
    expect(existsSync(join(without.shimDir, "yarn"))).toBe(true);
    expect(existsSync(join(without.shimDir, "npm"))).toBe(false);
    expect(existsSync(join(without.shimDir, "npx"))).toBe(false);
  });

  it("175: --exclude rejects a name that is not a package manager", async () => {
    const { options } = shimFixture();

    const result = await run(["enable", "--exclude", "cargo"], options);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain(`Usage Error: Invalid package manager name 'cargo'`);
  });
});

describe("§15.29 — enable verifies its own post-condition", () => {
  it.skipIf(IS_WINDOWS)(
    "195: warns, naming the winner, when another manager shadows the shim",
    async () => {
      // A rival version manager sitting earlier on `PATH` than our directory.
      const volta = join(createFixture().root, "volta", "bin");
      mkdirSync(volta, { recursive: true });
      writeFileSync(join(volta, "yarn"), "#!/bin/sh\necho volta's yarn\n");
      await chmod(join(volta, "yarn"), 0o755);

      const { shimDir, options } = shimFixture({ pathPrefix: [volta] });

      const result = await run(["enable", "yarn"], options);

      // Exit 0 — the shim is installed correctly, it simply does not win.
      expect(result.exitCode).toBe(0);
      // Byte-exact (§15.29 point 2).
      expect(result.stderr).toContain(
        `! yarn on PATH resolves to ${join(volta, "yarn")}, not the shim just installed at ${join(shimDir, "yarn")}. Another version manager may be shadowing it.`,
      );
      // §15.29 point 4.
      expect(result.stderr).toContain("hash -r");
      expect(existsSync(join(shimDir, "yarn"))).toBe(true);
    },
  );

  it("195: says nothing when the shim is what PATH resolves to", async () => {
    const { options } = shimFixture();

    const result = await run(["enable", "yarn"], options);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});

/**
 * §14.25 — the stub must not depend on the runtime resolving its main module
 * through the realpath.
 *
 * The shim on `PATH` is a symlink to the stub (§10.2), so a relative specifier
 * inside the stub is resolved against whichever path the runtime considers the
 * main module's. Stock Node makes that the realpath, which is why the relative
 * form appeared to work — but `--preserve-symlinks-main` is a supported flag
 * that turns it off, and the stub then dies with `ERR_MODULE_NOT_FOUND` before
 * any of this tool's code runs. Non-Node ESM runtimes resolve from the link too.
 */
describe("§14.25 — the stub resolves its own entry", () => {
  it.skipIf(IS_WINDOWS)("211: the shim runs under --preserve-symlinks-main", async () => {
    const { fixture, shimDir, options } = shimFixture();
    fixture.write("package.json", `${JSON.stringify({ packageManager: "yarn@1.22.4" })}\n`);
    seedPackageManager(fixture.home, "yarn", "1.22.4");

    expect((await run(["enable", "yarn"], options)).exitCode).toBe(0);

    const result = await run(["--version"], {
      ...options,
      // `run` spawns `node <bin> <args>`, so the flag has to arrive this way.
      bin: join(shimDir, "yarn"),
      env: { ...options.env, NODE_OPTIONS: "--preserve-symlinks-main" },
    });

    expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.22.4\n");
  });

  it.skipIf(IS_WINDOWS)("211: and under ordinary resolution, unchanged", async () => {
    const { fixture, shimDir, options } = shimFixture();
    fixture.write("package.json", `${JSON.stringify({ packageManager: "yarn@1.22.4" })}\n`);
    seedPackageManager(fixture.home, "yarn", "1.22.4");

    expect((await run(["enable", "yarn"], options)).exitCode).toBe(0);

    const result = await run(["--version"], { ...options, bin: join(shimDir, "yarn") });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.22.4\n");
  });
});

describe("§14.15 — one stub, dispatching on the name it was invoked under", () => {
  it.skipIf(IS_WINDOWS)("244: two shims share a target and still reach their own", async () => {
    const { fixture, shimDir, options } = shimFixture();
    fixture.write("package.json", `${JSON.stringify({ packageManager: "yarn@1.22.4" })}\n`);
    seedPackageManager(fixture.home, "yarn", "1.22.4");

    expect((await run(["enable", "yarn", "pnpm"], options)).exitCode).toBe(0);

    // One target for both names. This is the property: nothing in the dist
    // folder is named after a binary, so there is no per-name file to go stale
    // when the tool is upgraded or removed (§15.14, #751).
    const yarnLink = readlinkSync(join(shimDir, "yarn"));
    expect(readlinkSync(join(shimDir, "pnpm"))).toBe(yarnLink);
    expect(basename(yarnLink)).not.toBe("yarn.mjs");
    expect(basename(yarnLink)).not.toBe("pnpm.mjs");

    // And the shared stub still tells them apart, because the name comes from
    // `argv[1]` rather than from the file. The yarn shim runs the pinned yarn…
    const asYarn = await run(["--version"], { ...options, bin: join(shimDir, "yarn") });
    expect(asYarn.exitCode).toBe(0);
    expect(asYarn.stdout).toBe("1.22.4\n");

    // …and the pnpm shim is refused by this project, which is what proves the
    // dispatch: a stub that had baked in `yarn` would have answered 1.22.4 here.
    const asPnpm = await run(["--version"], { ...options, bin: join(shimDir, "pnpm") });
    expect(asPnpm.exitCode).toBe(1);
    expect(asPnpm.stderr).toContain("This project is configured to use yarn");
  });
});

/* ------------------------------------------------------------------ *
 * §15.43 — rows 250 and 251
 *
 * §14.26 has `enable` bake `realpath(process.execPath)` into the shim
 * stub's shebang whenever the shim directory claims the name `node`,
 * and §15.39 makes `node` a name it can claim. Once it has, §15.32's
 * advice puts the shim ahead of the real runtime on `PATH`, the tool's
 * own `#!/usr/bin/env node` resolves through it, and `enable` ends up
 * running under a runtime out of `<home>` — baking in a path the next
 * `jup cache clean` deletes.
 *
 * Both rows put the tool in that position by moving `<home>` **over**
 * the runtime the suite is running under, rather than by copying a
 * 126 MB binary into the fixture. `JUP_HOME` is the user's to set, the
 * boundary test is the same one either way, and `enable` writes nothing
 * under `<home>` — so nothing here depends on that directory being ours.
 * ------------------------------------------------------------------ */

/** The runtime running this suite, and a `<home>` that would contain it. */
const HOST_RUNTIME = realpathSync(process.execPath);
const HOME_OVER_HOST = dirname(HOST_RUNTIME);

describe.skipIf(IS_WINDOWS || HOME_OVER_HOST === dirname(HOME_OVER_HOST))(
  "§15.43 — the interpreter a shim names",
  () => {
    /**
     * Two tool copies of their own. These rows rewrite the shared stub's
     * shebang and make one of them read-only, and `TOOL` above is a directory
     * every other row in this file reads.
     */
    const PINNED = copyTool();
    const READ_ONLY = copyTool();

    /** The stub `<shimDir>/<binName>` points at — §10.2's relative symlink. */
    function stubFor(shimDir: string, binName: string): string {
      return resolve(shimDir, readlinkSync(join(shimDir, binName)));
    }

    function shebangOf(file: string): string {
      return readFileSync(file, "utf8").split("\n")[0]!;
    }

    /** An ordinary `node` outside `<home>`: a wrapper around the real one. */
    function decoyNode(root: string, name: string): string {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, "node");
      writeFileSync(file, `#!/bin/sh\nexec ${HOST_RUNTIME} "$@"\n`);
      chmodSync(file, 0o755);
      return file;
    }

    it("250: the forwarded host runtime first, then one from PATH, never one from <home>", async () => {
      const { fixture, shimDir, options } = shimFixture();
      const forwarded = decoyNode(fixture.root, "forwarded");
      const onPath = decoyNode(fixture.root, "on-path");
      const inStore = { ...options.env, COREPACK_HOME: HOME_OVER_HOST };

      // Tier 1. Nothing usable on `PATH` at all, so a run that ignored the
      // forwarded value would refuse rather than quietly pick something else.
      const first = await run(["enable", "node"], {
        ...options,
        bin: PINNED,
        env: { ...inStore, JUP_HOST_RUNTIME: forwarded, PATH: shimDir },
      });

      expect(first.exitCode).toBe(0);
      expect(first.stderr).toBe("");
      expect(shebangOf(stubFor(shimDir, "node"))).toBe(`#!${forwarded}`);

      // Tier 2. Nothing forwarded now, and the first `node` on `PATH` is the
      // shim the run above installed — which is skipped, or this would be a
      // shebang naming a file that execs itself (§14.26).
      const second = await run(["enable", "node"], {
        ...options,
        bin: PINNED,
        env: { ...inStore, PATH: [shimDir, dirname(onPath)].join(delimiter) },
      });

      expect(second.exitCode).toBe(0);
      expect(shebangOf(stubFor(shimDir, "node"))).toBe(`#!${onPath}`);

      // The property both cases are for: what the shebang names is outside the
      // directory `cache clean` empties, so a clean cannot invalidate it.
      const baked = shebangOf(stubFor(shimDir, "node")).slice(2);
      expect(baked.startsWith(HOME_OVER_HOST)).toBe(false);
      expect(existsSync(baked)).toBe(true);
    });

    it.skipIf(IS_ROOT)(
      "251: refuses rather than baking one in, and names the stub it could not rewrite",
      async () => {
        const { shimDir, options } = shimFixture();

        // No runtime outside `<home>` by either route: nothing forwarded, and the
        // only entry on `PATH` is the shim directory, which holds no `node` yet.
        const refused = await run(["enable", "node"], {
          ...options,
          bin: PINNED,
          env: { ...options.env, COREPACK_HOME: HOME_OVER_HOST, PATH: shimDir },
        });

        // §12 — a `UsageError` is reported on stdout, with the usage line after it.
        expect(refused.exitCode).toBe(1);
        expect(refused.stdout).toContain(HOME_OVER_HOST);
        expect(refused.stdout).toContain("cache clean");
        // Neither fallback was taken, and the name is still free.
        expect(refused.stdout).not.toContain("/usr/bin/env");
        expect(existsSync(join(shimDir, "node"))).toBe(false);

        // The adjacent message: the package directory is read-only, so the stub
        // cannot be rewritten to carry the pin. Seed it first, or the failure
        // would be "no stub yet" rather than "the stub needs rewriting".
        expect((await run(["enable", "pnpm"], { ...options, bin: READ_ONLY })).exitCode).toBe(0);
        const stub = stubFor(shimDir, "pnpm");
        // The file *and* the directory: a read-only directory alone still permits
        // a write to a file already inside it, and a system package install
        // leaves behind files the user cannot open for writing.
        await chmod(stub, 0o555);
        await chmod(dirname(stub), 0o555);

        try {
          const unwritable = await run(["enable", "node"], { ...options, bin: READ_ONLY });

          expect(unwritable.exitCode).toBe(1);
          expect(unwritable.stdout).toContain(stub);
          // The two remedies that move the *shims* are not offered, because
          // neither of them moves this file.
          expect(unwritable.stdout).not.toContain("--install-directory <a writable");
          expect(unwritable.stdout).not.toContain("set JUP_SHIM_DIRECTORY");

          // §10.7 — and the case that must keep working: `enable` of anything but
          // the interpreter compares the stub before writing it, so it never
          // touches the package directory at all.
          const again = await run(["enable", "pnpm"], { ...options, bin: READ_ONLY });
          expect(again.exitCode).toBe(0);
          expect(again.stdout).toBe("");
          expect(again.stderr).toBe("");
        } finally {
          await chmod(dirname(stub), 0o755);
          await chmod(stub, 0o755);
        }
      },
    );
  },
);
