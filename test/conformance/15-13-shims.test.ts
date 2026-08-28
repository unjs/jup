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
 * | 254 | §15.45 | the stubs `npm pack` ships are not executable, so every shim is inert |
 * | 255 | §15.46 | the tool's own entry point runs through the tool's own `node` shim |
 *
 * Every row runs the real entry point through a throwaway copy of the tool
 * (`copyTool`) with `HOME` redirected into the fixture, because §15.13's default
 * is a directory under the *user's* home and a row that forgets would install
 * into the developer's own `PATH`.
 */

import { execFile } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
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

/**
 * §15.13 point 8's directory, spelled here rather than imported: a conformance
 * row asserts what the spec says, not what the implementation computed.
 */
const SYSTEM_DIR = "/usr/local/bin";

/**
 * Rows 266 and 270 install into the **real** `/usr/local/bin`, so they run only
 * where that is a throwaway filesystem: as `root`, inside a container. On a
 * developer's root shell they would displace whatever `yarn` the machine has and
 * restore it a few lines later, which is not a bargain a test suite gets to
 * offer. CI running rootless skips them; a container job runs them.
 */
const IN_CONTAINER = existsSync("/.dockerenv") || existsSync("/run/.containerenv");
const CAN_INSTALL_SYSTEM = !IS_WINDOWS && IS_ROOT === true && IN_CONTAINER;

/**
 * `/usr/local/bin` is writable by this user — the Homebrew-on-Intel shape, where
 * row 268's refusal cannot happen because there is nothing to refuse.
 */
function systemDirWritable(): boolean {
  try {
    accessSync(SYSTEM_DIR, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

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

  /**
   * Rows 266–270 — §15.13 point 8, the system directory.
   *
   * Point 8 is the answer to the shape this file's other rows cannot reach: a
   * container whose only user is `root`, where every per-user candidate is inert
   * and point 3's advisory — a `PATH` line to type into a shell — is a remedy no
   * `Dockerfile` can perform.
   */
  it.skipIf(!CAN_INSTALL_SYSTEM)(
    "266: root reaches /usr/local/bin when nothing user-owned is on PATH",
    async () => {
      const { shimDir, options } = shimFixture({ offPath: true });
      const onPath = {
        ...options,
        // The one row that asks the harness to leave point 8's directory on the
        // child's `PATH`; every other row runs with it stripped.
        allowSystemShimDirectory: true,
        env: { ...options.env, PATH: `${SYSTEM_DIR}${delimiter}${options.env.PATH ?? ""}` },
      };

      try {
        const result = await run(["enable", "yarn"], onPath);

        expect(result.exitCode).toBe(0);
        // Point 6's line, unchanged: point 8 adds a candidate, not a message.
        expect(result.stderr).toBe(
          `! ${shimDir} is not on your PATH; installing shims to ${SYSTEM_DIR} instead\n`,
        );
        expect(existsSync(join(SYSTEM_DIR, "yarn"))).toBe(true);
        expect(existsSync(join(shimDir, "yarn"))).toBe(false);

        // Point 7: the directory is a *candidate*, so a bare `disable` from a
        // shell that never had it on `PATH` still finds what `enable` wrote.
        const removed = await run(["disable", "yarn"], options);
        expect(removed.exitCode).toBe(0);
        expect(existsSync(join(SYSTEM_DIR, "yarn"))).toBe(false);
      } finally {
        rmSync(join(SYSTEM_DIR, "yarn"), { force: true });
        rmSync(join(SYSTEM_DIR, "yarnpkg"), { force: true });
      }
    },
  );

  it.skipIf(IS_WINDOWS || IS_ROOT)(
    "267: every other user never sees it, whatever PATH says",
    async () => {
      const { shimDir, options } = shimFixture({ offPath: true });

      const result = await run(["enable", "yarn"], {
        ...options,
        allowSystemShimDirectory: true,
        env: {
          ...options.env,
          SHELL: "/bin/bash",
          PATH: `${SYSTEM_DIR}${delimiter}${options.env.PATH ?? ""}`,
        },
      });

      expect(result.exitCode).toBe(0);
      expect(existsSync(join(SYSTEM_DIR, "yarn"))).toBe(false);
      expect(existsSync(join(shimDir, "yarn"))).toBe(true);
      // Row 172's outcome unchanged: no candidate was on `PATH`, so the advisory
      // fires and nothing was preferred over anything.
      expect(result.stderr).toContain(`! ${shimDir} is not on your PATH`);
      expect(result.stderr).not.toContain("installing shims to");
    },
  );

  it.skipIf(IS_WINDOWS || IS_ROOT || systemDirWritable())(
    "268: --system fails rather than falling back to the per-user directory",
    async () => {
      const { shimDir, options } = shimFixture();

      const result = await run(["enable", "--system", "yarn"], options);

      // Point 2's fallback is what a `RUN jup enable --system` layer must not
      // get: it would exit 0 and ship an image whose shims are in a directory
      // nothing on `PATH` names.
      expect(result.exitCode).toBe(1);
      // §12 puts a usage error on stdout, corepack's own choice (§14.24).
      expect(result.stdout).toContain(`Unable to write shims to ${SYSTEM_DIR}`);
      expect(result.stderr).not.toContain("installing shims to");
      expect(existsSync(join(shimDir, "yarn"))).toBe(false);
    },
  );

  it("269: --system and --install-directory are refused as a pair", async () => {
    const { fixture, shimDir, options } = shimFixture();
    const named = join(fixture.root, "named-bin");
    mkdirSync(named, { recursive: true });

    const result = await run(["enable", "--system", "--install-directory", named, "yarn"], options);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("--system and --install-directory");
    // Neither directory was written to, and neither was probed.
    expect(existsSync(join(named, "yarn"))).toBe(false);
    expect(existsSync(join(shimDir, "yarn"))).toBe(false);
  });

  it.skipIf(!CAN_INSTALL_SYSTEM)(
    "270: disable --system removes them and restores what they displaced",
    async () => {
      const { options } = shimFixture();
      const foreign = join(SYSTEM_DIR, "yarn");

      try {
        writeFileSync(foreign, "#!/bin/sh\necho foreign\n");
        chmodSync(foreign, 0o755);

        const enabled = await run(["enable", "--system", "--force", "yarn"], options);
        expect(enabled.exitCode).toBe(0);
        expect(lstatSync(foreign).isSymbolicLink()).toBe(true);

        // §15.15 — `disable` is non-destructive, and `--system` is how a run
        // that is not `root` names the directory point 7's scan cannot see.
        const removed = await run(["disable", "--system", "yarn"], options);
        expect(removed.exitCode).toBe(0);
        expect(lstatSync(foreign).isSymbolicLink()).toBe(false);
        expect(readFileSync(foreign, "utf8")).toContain("echo foreign");
      } finally {
        rmSync(foreign, { force: true });
        rmSync(join(SYSTEM_DIR, "yarnpkg"), { force: true });
      }
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

/* ------------------------------------------------------------------ *
 * §15.45 — row 254
 *
 * §10.2's shim is a symlink, so the execute bit the kernel checks
 * before running the name is the **stub's**. The build chmods the
 * stubs `0o755` and `npm pack` undoes it: it
 * re-applies the bit to the package's `bin` targets and to nothing
 * else, so a published install has `dist/bin.mjs` executable and every
 * stub at `0o644`. `enable` compared the stub's *content*, found it
 * already correct, and left the mode alone — which is right for §10.7
 * and wrong for the shim, since a `PATH` lookup passes over a file it
 * cannot execute without a word.
 *
 * The row runs the shim through a real `execve` rather than
 * `node <shim>`, because `node <shim>` is precisely the spelling that
 * never looks at the bit.
 * ------------------------------------------------------------------ */

const execFileAsync = promisify(execFile);

describe.skipIf(IS_WINDOWS)("§15.45 — the stub a shim points at is executable", () => {
  /** Its own copy: this row rewrites the mode of the shared stub inside it. */
  const PUBLISHED = copyTool();

  /** The stub `<shimDir>/<binName>` points at — §10.2's relative symlink. */
  function stubOf(shimDir: string, binName: string): string {
    return resolve(shimDir, readlinkSync(join(shimDir, binName)));
  }

  it("254: enable repairs a stub that arrived without the execute bit", async () => {
    const { fixture, shimDir, options } = shimFixture();
    fixture.write("package.json", `${JSON.stringify({ packageManager: "yarn@1.22.4" })}\n`);
    seedPackageManager(fixture.home, "yarn", "1.22.4");
    const env = { ...options.env, COREPACK_HOME: fixture.home, COREPACK_ENABLE_NETWORK: "0" };

    // Put the copy into the shape npm publishes: the stub is written once, then
    // its mode is put back to the `0o644` a packed tarball carries.
    expect((await run(["enable", "yarn"], { ...options, bin: PUBLISHED })).exitCode).toBe(0);
    const stub = stubOf(shimDir, "yarn");
    await chmod(stub, 0o644);

    const enabled = await run(["enable", "yarn"], { ...options, bin: PUBLISHED });

    expect(enabled.exitCode).toBe(0);
    expect(enabled.stderr).toBe("");
    expect(statSync(stub).mode & 0o111).toBe(0o111);

    // The property the mode is a proxy for: the name on `PATH` is executable,
    // through the symlink, by the kernel rather than by an explicit `node`.
    const { stdout } = await execFileAsync(join(shimDir, "yarn"), ["--version"], {
      cwd: fixture.cwd,
      env: env as NodeJS.ProcessEnv,
    });
    expect(stdout).toBe("1.22.4\n");
  });

  it("254: and changes nothing at all when it is already executable", async () => {
    const { fixture, shimDir, options } = shimFixture();
    fixture.write("package.json", `${JSON.stringify({ packageManager: "yarn@1.22.4" })}\n`);

    expect((await run(["enable", "yarn"], { ...options, bin: PUBLISHED })).exitCode).toBe(0);
    const stub = stubOf(shimDir, "yarn");
    // Stated rather than inherited from the row above, which shares this copy.
    await chmod(stub, 0o755);
    // `ctime` moves for a chmod even when the mode it writes is the mode already
    // there, so this is what an unconditional one would show. §10.2 property 4
    // and §10.7 both want this run to write nothing.
    const before = statSync(stub).ctimeMs;

    const again = await run(["enable", "yarn"], { ...options, bin: PUBLISHED });

    expect(again.exitCode).toBe(0);
    expect(again.stdout).toBe("");
    expect(again.stderr).toBe("");
    expect(statSync(stub).ctimeMs).toBe(before);
  });
});

/* ------------------------------------------------------------------ *
 * §15.46 — row 255
 *
 * `bin/jup.mjs` — what `package.json`'s `bin` points `jup` and
 * `corepack` at — opens `#!/usr/bin/env node`, and §14.26 consequence 2
 * is about that spelling rather than about who wrote it. Once
 * `enable node` has put our shim on the `PATH` §15.32 asks the user to
 * prepend, `env node` finds the shim, the shim resolves the project's
 * `.nvmrc` (§15.40), and `jup --version` downloads a runtime to print
 * its own version string.
 *
 * The row plants a `jup.mjs` beside the copy's entry — an installation
 * without one makes §15.46 a no-op rather than a failure — and then
 * runs it through a real `execve`, because `node <entry>` is
 * precisely the spelling that never reads a shebang. `JUP_ENABLE_NETWORK=0`
 * turns the recursion into a loud failure instead of a 171 MB download,
 * so the row proves the same property either way round without a
 * network.
 * ------------------------------------------------------------------ */

describe.skipIf(IS_WINDOWS)(
  "§15.46 — jup's own entry point does not run through jup's shim",
  () => {
    /** Its own copy: this row rewrites a file inside the installation. */
    const BUILT = copyTool();

    /** `<copy>/src/jup.mjs` — the CLI entry §15.46 pins, beside the copy's stubs. */
    const ENTRY = join(dirname(BUILT), "jup.mjs");

    /** What §15.43 tier 0 chooses for a suite running outside any `<home>`. */
    const HOST = realpathSync(process.execPath);

    const UNPINNED = "#!/usr/bin/env node";

    /**
     * The entry, in the shape a published install has it: a `bin` target npm left
     * `0o755`, opening on the relocatable shebang. Re-written between the phases
     * below, which is how the "already pinned" and "unpinned again" states are
     * reached without a second copy of the tool.
     */
    function writeEntry(shebang: string): void {
      writeFileSync(ENTRY, `${shebang}\nimport "./bin.ts";\n`);
      chmodSync(ENTRY, 0o755);
    }

    function firstLine(file: string): string {
      return readFileSync(file, "utf8").split("\n")[0]!;
    }

    it("255: enable pins its first line, only when a node shim is claimed, and only once", async () => {
      const { shimDir, options } = shimFixture();
      const run255 = (args: string[]) => run(args, { ...options, bin: BUILT });
      writeEntry(UNPINNED);
      const before = readFileSync(ENTRY);

      // An `enable` that claims no `node` leaves it byte-identical: §10.7's
      // read-only installation and §10.2's idempotency both rest on that.
      expect((await run255(["enable", "pnpm"])).exitCode).toBe(0);
      expect(readFileSync(ENTRY).equals(before)).toBe(true);

      // Claiming the name is what requires the pin — the same condition §10.1
      // puts on the stub, and the same interpreter §15.43 chooses for it.
      expect((await run255(["enable", "node"])).exitCode).toBe(0);
      expect(firstLine(ENTRY)).toBe(`#!${HOST}`);
      expect(existsSync(join(shimDir, "node"))).toBe(true);
      // The body and the mode are the artifact's, not ours: only line one moved.
      expect(readFileSync(ENTRY, "utf8").slice(firstLine(ENTRY).length)).toBe(
        before.toString("utf8").slice(UNPINNED.length),
      );
      expect(statSync(ENTRY).mode & 0o777).toBe(0o755);

      // Warm: already the line we want, so nothing is written. `ctime` moves for
      // the rename even when the bytes are identical, which is what an
      // unconditional rewrite would show here.
      const ctime = statSync(ENTRY).ctimeMs;
      const again = await run255(["enable", "node"]);
      expect(again.exitCode).toBe(0);
      expect(again.stdout).toBe("");
      expect(statSync(ENTRY).ctimeMs).toBe(ctime);
    });

    it("255: so `jup --version` in a project pinning an uncached runtime installs nothing", async () => {
      const { fixture, shimDir, options } = shimFixture();
      // §15.40 — a runtime the store does not hold, and no network to get it.
      fixture.write(".nvmrc", "22.14.0\n");
      const env = {
        ...options.env,
        COREPACK_HOME: fixture.home,
        COREPACK_ENABLE_NETWORK: "0",
        // The shim directory is first on `PATH` already (`shimFixture`), which is
        // §15.32's own advice and the precondition for the whole failure.
        PATH: [shimDir, process.env.PATH ?? ""].join(delimiter),
      } as NodeJS.ProcessEnv;

      writeEntry(UNPINNED);
      expect((await run(["enable", "node"], { ...options, bin: BUILT })).exitCode).toBe(0);
      expect(firstLine(ENTRY)).toBe(`#!${HOST}`);

      // Pinned: the kernel runs the host runtime named on line one, so nothing
      // resolves `.nvmrc` and nothing is installed.
      const { stdout } = await execFileAsync(ENTRY, ["--version"], { cwd: fixture.cwd, env });
      expect(stdout).toBe("0.0.0\n");
      expect(existsSync(join(fixture.home, "v1", "node"))).toBe(false);

      // And the contrast, from the same tree: put the relocatable shebang back —
      // what every `enable` before §15.46 left — and the entry resolves through
      // our own `node` shim, which goes looking for a runtime it cannot have.
      writeEntry(UNPINNED);
      const recursed = await execFileAsync(ENTRY, ["--version"], {
        cwd: fixture.cwd,
        env,
      }).catch((error: Error & { code?: number; stderr?: string }) => error);

      expect(recursed).toBeInstanceOf(Error);
      expect((recursed as { stderr?: string }).stderr ?? "").toContain("22.14.0");
    });

    it.skipIf(IS_ROOT)("255: and fails naming that file when it cannot be rewritten", async () => {
      const { shimDir, options } = shimFixture();
      writeEntry(UNPINNED);
      // Seed the stub, so the refusal below is about the entry rather than about a
      // stub that was never written.
      expect((await run(["enable", "pnpm"], { ...options, bin: BUILT })).exitCode).toBe(0);
      // The file *and* its directory: the write is temp-then-rename, and a system
      // package install puts both beyond the user's reach.
      await chmod(ENTRY, 0o555);
      await chmod(dirname(ENTRY), 0o555);

      try {
        const refused = await run(["enable", "node"], { ...options, bin: BUILT });

        // §12 — a `UsageError` is reported on stdout, with the usage line after it.
        expect(refused.exitCode).toBe(1);
        expect(refused.stdout).toContain(ENTRY);
        // Not §15.43's stub message, which names the wrong file, and not §15.45's,
        // whose remedy is for a different property.
        expect(refused.stdout).not.toContain("shim stub");
        expect(refused.stdout).not.toContain("chmod +x");
        expect(refused.stdout).not.toContain("set JUP_SHIM_DIRECTORY");
        // Nothing half-written: the check precedes every shim it protects.
        expect(existsSync(join(shimDir, "node"))).toBe(false);
        expect(firstLine(ENTRY)).toBe(UNPINNED);
      } finally {
        await chmod(dirname(ENTRY), 0o755);
        await chmod(ENTRY, 0o755);
      }
    });
  },
);
