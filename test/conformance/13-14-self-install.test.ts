/**
 * §09.12 — `self-install`.
 *
 * The rows here need something no other suite does: a tool laid out the way a
 * *published* install is. `copyTool` copies `src/`, which is what every other
 * shim row wants and is exactly what this command refuses — a checkout has no
 * build to install (§09.12). So {@link builtTool} assembles the published
 * shape instead: a `dist/` with an entry in it, the two shipped files in `bin/`,
 * and a manifest naming a version, which together are all the command looks for.
 *
 * The bundle inside that `dist/` re-exports the sources by **absolute** URL. A
 * relative one would be correct in the fixture and broken in the store, since
 * `self-install` copies `dist/` and `bin/` and deliberately not `src/` — and the
 * rows below run the copy in the store, which is the whole point.
 */

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  cliEntrySource,
  stubNameFor,
  selfWin32Wrappers,
  SHIM_MARKER,
  shimSource,
} from "../../src/commands/shims.ts";
import { BUILT_ENTRY_SPECIFIER, CLI_ENTRY_NAME } from "../../src/utils/self.ts";
import {
  cleanupFixtures,
  createFixture,
  perUserShims,
  REPO_ROOT,
  run,
  tempRoot,
} from "./_harness/index.ts";

const IS_WINDOWS = process.platform === "win32";

/** The version the fixture's manifest names; the store directory takes it verbatim. */
const VERSION = "9.9.9";

/**
 * A published-shape installation of this tool, returning its CLI entry.
 *
 * Everything `self-install` reads is here and nothing else is: the two folders
 * it copies, and the manifest §08.7 needs to travel with them.
 */
function builtTool(version: string = VERSION): { root: string; entry: string } {
  const root = tempRoot("jup-built-");
  cpSync(join(REPO_ROOT, "src"), join(root, "src"), { recursive: true });

  mkdirSync(join(root, "dist"), { recursive: true });
  const sources = pathToFileURL(join(root, "src", "index.ts")).href;
  writeFileSync(join(root, "dist", "index.mjs"), `export * from ${JSON.stringify(sources)};\n`);

  mkdirSync(join(root, "bin"), { recursive: true });
  const entry = join(root, "bin", CLI_ENTRY_NAME);
  writeFileSync(entry, cliEntrySource());
  // One §10.2 stub beside it, so the copied payload has the shape a published
  // install has: `enable` links these, `self-install` links the entry above.
  writeFileSync(join(root, "bin", stubNameFor("pnpm")), shimSource(BUILT_ENTRY_SPECIFIER, "pnpm"));
  chmodSync(entry, 0o755);
  chmodSync(join(root, "bin", stubNameFor("pnpm")), 0o755);

  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "jup", version, type: "module" })}\n`,
  );

  return { root, entry };
}

/**
 * A fixture whose per-user shim directory is inside it and on `PATH` — §15.13's
 * default, redirected, so a row never writes into the developer's own `PATH`.
 */
function selfFixture() {
  const fixture = createFixture();
  const { dir: shimDir, env: shimEnv } = perUserShims(fixture.root);
  mkdirSync(shimDir, { recursive: true });
  const tool = builtTool();

  return {
    fixture,
    shimDir,
    tool,
    /** `<home>/self/<version>` — where the copy is expected to land. */
    selfDir: join(fixture.home, "self", VERSION),
    options: {
      cwd: fixture.cwd,
      home: fixture.home,
      bin: tool.entry,
      env: {
        HOME: fixture.root,
        USERPROFILE: fixture.root,
        ...shimEnv,
        PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
      },
    },
  };
}

/** `self-install` claimed the name, in whatever shape this platform uses. */
function expectInstalled(directory: string, binName: string): void {
  if (IS_WINDOWS) {
    for (const extension of ["", ".cmd", ".ps1"]) {
      expect(lstatSync(join(directory, `${binName}${extension}`)).isFile()).toBe(true);
    }
    return;
  }
  expect(lstatSync(join(directory, binName)).isSymbolicLink()).toBe(true);
}

afterAll(cleanupFixtures);

describe("§09.12 self-install", () => {
  it("copies the installation into <home>/self/<version> and shims both of our names", async () => {
    const { shimDir, selfDir, options } = selfFixture();

    const result = await run(["self-install"], options);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      [
        `Installing jup@${VERSION}...`,
        `jup ${VERSION} -> ${selfDir}`,
        `jup, corepack -> ${shimDir}`,
        "",
      ].join("\n"),
    );

    // The copy is a complete installation: the bundle, the shipped files, and
    // the manifest §08.7 reads back as `COREPACK_ROOT`.
    expect(statSync(join(selfDir, "dist", "index.mjs")).isFile()).toBe(true);
    expect(statSync(join(selfDir, "bin", CLI_ENTRY_NAME)).isFile()).toBe(true);
    expect(statSync(join(selfDir, "bin", stubNameFor("pnpm"))).isFile()).toBe(true);
    expect(JSON.parse(readFileSync(join(selfDir, "package.json"), "utf8")).version).toBe(VERSION);

    // §07.2's marker, which is what makes the directory readable as an install.
    const marker = JSON.parse(readFileSync(join(selfDir, ".jup"), "utf8"));
    expect(marker.locator).toEqual({ name: "jup", reference: VERSION });
    expect(marker.hash).toMatch(/^sha256\.[0-9a-f]{64}$/);

    expectInstalled(shimDir, "jup");
    expectInstalled(shimDir, "corepack");
  });

  it("leaves the copy outside v1, where cache clean cannot reach it", async () => {
    const { fixture, selfDir, options } = selfFixture();

    expect((await run(["self-install"], options)).exitCode).toBe(0);
    expect((await run(["cache", "clean"], options)).exitCode).toBe(0);

    expect(statSync(join(selfDir, "bin", CLI_ENTRY_NAME)).isFile()).toBe(true);
    expect(statSync(join(fixture.home, "self", VERSION)).isDirectory()).toBe(true);
  });

  // §10.8 — both names link the CLI entry, which passes the argv through
  // instead of prepending a binary name. Without that, this is
  // `Unknown command "jup"`.
  it.skipIf(IS_WINDOWS)("installs a jup that runs, under both of its names", async () => {
    const { shimDir, options } = selfFixture();

    expect((await run(["self-install"], options)).exitCode).toBe(0);

    for (const binName of ["jup", "corepack"]) {
      const shim = spawnSync(join(shimDir, binName), ["--version"], {
        encoding: "utf8",
        env: { ...process.env, COREPACK_HOME: options.home, PATH: options.env.PATH },
      });
      expect(shim.status).toBe(0);
      expect(shim.stdout).toBe(`${VERSION}\n`);
    }
  });

  it("is idempotent: an unchanged payload rewrites neither the store nor the shims", async () => {
    const { shimDir, selfDir, options } = selfFixture();

    expect((await run(["self-install"], options)).exitCode).toBe(0);
    const marker = statSync(join(selfDir, ".jup"));
    const shim = lstatSync(join(shimDir, "jup"));
    const body = readFileSync(join(shimDir, "jup"), "utf8");

    const second = await run(["self-install"], options);

    expect(second.exitCode).toBe(0);
    expect(second.stderr).toBe("");
    expect(statSync(join(selfDir, ".jup")).ino).toBe(marker.ino);
    expect(statSync(join(selfDir, ".jup")).mtimeMs).toBe(marker.mtimeMs);
    // The shim is unchanged on both platforms, but only §10.2's link is left
    // *untouched*: §10.3 has no idempotency short-circuit, so Windows rewrites
    // its trio byte for byte and the mtime moves (as it does for `enable`).
    expect(readFileSync(join(shimDir, "jup"), "utf8")).toBe(body);
    if (!IS_WINDOWS) expect(lstatSync(join(shimDir, "jup")).mtimeMs).toBe(shim.mtimeMs);
  });

  it("replaces a copy of the same version whose bytes have changed", async () => {
    const { selfDir, tool, options } = selfFixture();

    expect((await run(["self-install"], options)).exitCode).toBe(0);
    const before = readFileSync(join(selfDir, "dist", "index.mjs"), "utf8");

    // A rebuilt installation at the same version — the case `promote` alone
    // treats as a lost race and would silently decline to install.
    writeFileSync(join(tool.root, "dist", "index.mjs"), `${before}// rebuilt\n`);
    const second = await run(["self-install"], options);

    expect(second.exitCode).toBe(0);
    expect(readFileSync(join(selfDir, "dist", "index.mjs"), "utf8")).toBe(`${before}// rebuilt\n`);
    // Nothing left behind by the rename-aside (§09.12).
    expect(readFileSync(join(selfDir, ".jup"), "utf8")).toContain("sha256.");
  });

  it.skipIf(IS_WINDOWS)("refuses a name it does not own, and takes it with --force", async () => {
    const { shimDir, options } = selfFixture();
    const foreign = "#!/bin/sh\necho a real corepack\n";
    writeFileSync(join(shimDir, "corepack"), foreign);

    const refused = await run(["self-install"], options);

    expect(refused.exitCode).toBe(0);
    expect(refused.stderr).toContain("was not installed by this tool");
    expect(readFileSync(join(shimDir, "corepack"), "utf8")).toBe(foreign);
    // Its sibling still went in, and the summary names only what was installed.
    expect(refused.stdout).toContain(`jup -> ${shimDir}`);
    expect(lstatSync(join(shimDir, "jup")).isSymbolicLink()).toBe(true);

    const forced = await run(["self-install", "--force"], options);

    expect(forced.exitCode).toBe(0);
    expect(lstatSync(join(shimDir, "corepack")).isSymbolicLink()).toBe(true);
    // §15.15 — what it displaced is recorded, so `disable` can put it back.
    expect(readFileSync(join(options.home, "shims.json"), "utf8")).toContain("corepack");
  });

  // §09.12's own ownership rule: a link into `<home>/self` is ours whatever it
  // points at. Without it the second run files the first run's shim under
  // §15.15 as somebody else's.
  it.skipIf(IS_WINDOWS)("recognises its own shims rather than displacing them", async () => {
    const { options } = selfFixture();

    expect((await run(["self-install"], options)).exitCode).toBe(0);
    const second = await run(["self-install"], options);

    expect(second.exitCode).toBe(0);
    expect(second.stderr).toBe("");
    expect(() => readFileSync(join(options.home, "shims.json"), "utf8")).toThrow();
  });

  it("puts the shims where --install-directory says", async () => {
    const { fixture, shimDir, options } = selfFixture();
    const target = join(fixture.root, "elsewhere");
    mkdirSync(target);

    const result = await run(["self-install", "--install-directory", target], options);

    expect(result.exitCode).toBe(0);
    expectInstalled(target, "jup");
    expectInstalled(target, "corepack");
    expect(() => lstatSync(join(shimDir, "jup"))).toThrow();
  });

  it("refuses a source checkout, naming what it looked for", async () => {
    const { fixture } = selfFixture();
    // `copyTool`'s shape: sources and a manifest, no build.
    const checkout = tempRoot("jup-checkout-");
    cpSync(join(REPO_ROOT, "src"), join(checkout, "src"), { recursive: true });
    writeFileSync(
      join(checkout, "package.json"),
      `{"name":"jup","version":"0.0.0","type":"module"}\n`,
    );

    const result = await run(["self-install"], {
      cwd: fixture.cwd,
      home: fixture.home,
      bin: join(checkout, "src", "bin.ts"),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("that is a source checkout");
    expect(result.stdout).toContain("`dist/` and `bin/`");
    expect(result.stdout).toContain("$ jup self-install");
  });

  it("writes over a marker nobody can parse, rather than failing on it", async () => {
    const { selfDir, options } = selfFixture();

    expect((await run(["self-install"], options)).exitCode).toBe(0);
    // §07.2 propagates a corrupt marker; this command is the repair for one.
    writeFileSync(join(selfDir, ".jup"), "not json");

    const result = await run(["self-install"], options);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(readFileSync(join(selfDir, ".jup"), "utf8")).hash).toMatch(/^sha256\./);
  });

  it("refuses a version it cannot name a directory after", async () => {
    const { fixture } = selfFixture();
    const broken = builtTool("../../escape");

    const result = await run(["self-install"], {
      cwd: fixture.cwd,
      home: fixture.home,
      bin: broken.entry,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("not a version a store directory can be named after");
  });

  it("rejects an argument that is not one of its three flags", async () => {
    const { options } = selfFixture();

    const result = await run(["self-install", "jup"], options);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("takes no arguments other than");
  });
});

/**
 * §10.3's trio for our own names, which `installSelfShims` writes on Windows and
 * which no POSIX row above can reach. The bodies are platform-independent, so
 * they are asserted here rather than skipped everywhere but one runner.
 */
describe("§09.12 Windows wrappers", () => {
  it("names our CLI entry under the baked-in interpreter for a package payload", () => {
    const wrappers = selfWin32Wrappers(
      `..\\self\\9.9.9\\bin\\${CLI_ENTRY_NAME}`,
      "C:\\node\\node.exe",
    );

    for (const source of Object.values(wrappers)) {
      // §14.16 reads ownership off the marker, these wrappers naming no stub.
      expect(source).toContain(SHIM_MARKER);
      expect(source).toContain(CLI_ENTRY_NAME);
    }
    expect(wrappers.cmd).toContain(
      `"C:\\node\\node.exe"  "%~dp0\\..\\self\\9.9.9\\bin\\${CLI_ENTRY_NAME}" %*`,
    );
    expect(wrappers.sh).toContain(
      `exec "C:/node/node.exe"  "$basedir/../self/9.9.9/bin/${CLI_ENTRY_NAME}" "$@"`,
    );
    expect(wrappers.ps1).toContain(
      `& "C:\\node\\node.exe"  "$basedir/../self/9.9.9/bin/${CLI_ENTRY_NAME}" $args`,
    );
  });
});
