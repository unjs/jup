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
 *
 * Every row runs the real entry point through a throwaway copy of the tool
 * (`copyTool`) with `HOME` redirected into the fixture, because §15.13's default
 * is a directory under the *user's* home and a row that forgets would install
 * into the developer's own `PATH`.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { chmod } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, copyTool, createFixture, run } from "./_harness/index.ts";

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
  const shimDir = join(fixture.root, "user-bin");
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
        XDG_BIN_HOME: shimDir,
        LOCALAPPDATA: undefined,
        PATH: [...entries, process.env.PATH ?? ""].join(delimiter),
      } as Record<string, string | undefined>,
    },
  };
}

afterAll(cleanupFixtures);

describe("§15.13 — never require elevation", () => {
  it.skipIf(IS_ROOT)(
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
    // #751 exactly: Node 25 stopped bundling corepack, so `dist/yarn.js` is no
    // longer there while the symlink in the bin directory survives.
    const gone = join(fixture.root, "removed-dist", "yarn.js");
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
    const gone = join(fixture.root, "removed-dist", "yarn.js");
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
