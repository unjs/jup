/**
 * §09.13 — `self-upgrade`.
 *
 * The mock registry publishes *us*: a tarball laid out the way the real package
 * is, whose `dist/index.mjs` re-exports a copy of this checkout's sources by
 * absolute `file://` URL. That is what lets a row run the copy the command just
 * put in the store — the whole point of the command — while the bytes travelling
 * over the wire, being signed and being digested are the mock's own. The copy is
 * what makes `--version` meaningful; see {@link publishedSources}.
 *
 * Its `bin/` entries are published **without** the execute bit on purpose. npm
 * has been observed to deliver them that way (§15.45), a symlink to a stub the
 * kernel will not execute is passed over in silence by a `PATH` lookup, and the
 * rows that run the installed shim below would be the ones to catch it.
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cliEntrySource, shimSource, stubNameFor } from "../../src/commands/shims.ts";
import { BUILT_ENTRY_SPECIFIER, CLI_ENTRY_NAME } from "../../src/utils/self.ts";
import {
  cleanupFixtures,
  createFixture,
  makeTarball,
  MockRegistry,
  perUserShims,
  REPO_ROOT,
  run,
  tempRoot,
} from "./_harness/index.ts";

const IS_WINDOWS = process.platform === "win32";

/** What the mock publishes as `latest`, and the store directory it must produce. */
const VERSION = "9.9.9";

/** An older copy of ourselves, seeded to prove §07.11's prune. */
const PREVIOUS = "9.9.8";

const registry = new MockRegistry();
/** A second registry, for the one row about a mirror publishing something else. */
const impostor = new MockRegistry();

/**
 * The sources the published bundle re-exports, as a checkout of their own.
 *
 * A copy rather than this repository's `src/`, and the reason is what makes the
 * rows below able to tell one jup from another: `--version` walks up from the
 * module that answers it to the nearest manifest, so a bundle pointing at
 * `REPO_ROOT/src` reports *this* checkout's version whichever store copy loaded
 * it. Pointed at a copy with a manifest of its own, the number that comes back
 * is the published one, and nothing but the store copy's `dist/` names it.
 */
function publishedSources(): string {
  const root = tempRoot("jup-published-");
  cpSync(join(REPO_ROOT, "src"), join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "jup", version: VERSION, type: "module" })}\n`,
  );
  return join(root, "src", "index.ts");
}

/**
 * The published package, as a tarball.
 *
 * `dist/index.mjs` is a re-export by **absolute** URL rather than a bundle: the
 * copy is unpacked into the store and run from there, so a relative specifier
 * would resolve against a directory holding no `src/`.
 */
function publishedTool(version: string, entry: string): Uint8Array {
  const sources = pathToFileURL(entry).href;
  return makeTarball([
    {
      path: "package/package.json",
      content: `${JSON.stringify({ name: "jup", version, type: "module" })}\n`,
      mode: 0o644,
    },
    {
      path: "package/dist/index.mjs",
      content: `export * from ${JSON.stringify(sources)};\n`,
      mode: 0o644,
    },
    // §15.45 — published unreadable to the kernel as programs; the command has
    // to grant the bit itself.
    { path: `package/bin/${CLI_ENTRY_NAME}`, content: cliEntrySource(), mode: 0o644 },
    {
      path: `package/bin/${stubNameFor("pnpm")}`,
      content: shimSource(BUILT_ENTRY_SPECIFIER, "pnpm"),
      mode: 0o644,
    },
  ]);
}

/** A fixture whose shim directory is inside it and on `PATH` (§15.13, redirected). */
function upgradeFixture(mock: MockRegistry = registry) {
  const fixture = createFixture();
  const { dir: shimDir, env: shimEnv } = perUserShims(fixture.root);
  mkdirSync(shimDir, { recursive: true });

  return {
    fixture,
    shimDir,
    selfDir: join(fixture.home, "self", VERSION),
    options: {
      cwd: fixture.cwd,
      home: fixture.home,
      env: {
        HOME: fixture.root,
        USERPROFILE: fixture.root,
        COREPACK_NPM_REGISTRY: mock.origin,
        COREPACK_INTEGRITY_KEYS: mock.trustStore(),
        ...shimEnv,
        PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
      },
    },
  };
}

/** `<algo>.<hex>` of the bytes the mock served, which is what the marker records. */
function tarballHash(mock: MockRegistry, version: string): string {
  return `sha512.${createHash("sha512").update(mock.tarballOf("jup", version)).digest("hex")}`;
}

/** The tarball requests the mock answered — the count that says "downloaded". */
function downloads(mock: MockRegistry): number {
  return mock.requests.filter((request) => request.path.endsWith(".tgz")).length;
}

beforeAll(async () => {
  await registry.start();
  await impostor.start();

  const entry = publishedSources();
  registry.publish("jup", PREVIOUS, publishedTool(PREVIOUS, entry));
  registry.publish("jup", VERSION, publishedTool(VERSION, entry), {
    distTags: { latest: VERSION },
  });

  // A mirror publishing *something else* under our name: correctly signed, and
  // not an installation of anything.
  impostor.publish(
    "jup",
    VERSION,
    makeTarball([
      { path: "package/package.json", content: `{"name":"jup","version":"${VERSION}"}` },
      { path: "package/index.js", content: "throw new Error('not jup')" },
    ]),
    { distTags: { latest: VERSION } },
  );
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
  await impostor.stop();
});

beforeEach(() => {
  registry.reset();
  impostor.reset();
});

describe("§09.13 self-upgrade", () => {
  it("downloads the published version into <home>/self/<version> and shims both names", async () => {
    const { shimDir, selfDir, options } = upgradeFixture();

    const result = await run(["self-upgrade"], options);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      [
        `Installing jup@${VERSION}...`,
        `jup ${VERSION} -> ${selfDir}`,
        `jup, corepack -> ${shimDir}`,
        "",
      ].join("\n"),
    );

    // The whole package, as published: the two folders and the manifest §08.7
    // needs to travel with them.
    expect(existsSync(join(selfDir, "dist", "index.mjs"))).toBe(true);
    expect(existsSync(join(selfDir, "bin", CLI_ENTRY_NAME))).toBe(true);
    expect(existsSync(join(selfDir, "bin", stubNameFor("pnpm")))).toBe(true);
    expect(JSON.parse(readFileSync(join(selfDir, "package.json"), "utf8")).version).toBe(VERSION);

    // §07.2's marker, with §07.11's meaning: `hash` is the artifact's digest.
    const marker = JSON.parse(readFileSync(join(selfDir, ".jup"), "utf8"));
    expect(marker.locator).toEqual({ name: "jup", reference: VERSION });
    expect(marker.hash).toBe(tarballHash(registry, VERSION));
    expect(marker.bin).toEqual({
      jup: `./bin/${CLI_ENTRY_NAME}`,
      corepack: `./bin/${CLI_ENTRY_NAME}`,
    });

    for (const binName of ["jup", "corepack"]) {
      const shim = join(shimDir, IS_WINDOWS ? `${binName}.cmd` : binName);
      expect(existsSync(shim)).toBe(true);
    }
  });

  it.skipIf(IS_WINDOWS)(
    "§15.45 — grants the execute bit the archive did not carry, so the shims run",
    async () => {
      const { shimDir, selfDir, options } = upgradeFixture();

      await run(["self-upgrade"], options);

      // §10.8 points both of our names at the CLI entry, so it is the one file
      // the command has to make executable; the per-name stubs beside it are a
      // later `enable`'s business (§15.45).
      expect(statSync(join(selfDir, "bin", CLI_ENTRY_NAME)).mode & 0o111).not.toBe(0);

      // Both names, through the shims the command just wrote, answering out of
      // the copy in the store.
      for (const binName of ["jup", "corepack"]) {
        const spawned = spawnSync(join(shimDir, binName), ["--version"], {
          encoding: "utf8",
          env: { ...process.env, COREPACK_HOME: options.home },
        });
        expect(spawned.stdout).toBe(`${VERSION}\n`);
      }
    },
  );

  it("§10.8 — links the downloaded CLI entry rather than rewriting it", async () => {
    const { selfDir, options } = upgradeFixture();

    await run(["self-upgrade"], options);

    // Byte for byte what the tarball carried. This is the file §10.8 points both
    // of our names at, and an upgrade that regenerated it from the *running*
    // version's source would put an old entry in front of a new bundle.
    expect(readFileSync(join(selfDir, "bin", CLI_ENTRY_NAME), "utf8")).toBe(cliEntrySource());

    // The per-name stubs travel untouched too: nothing links them until a later
    // `enable`, which is where §10.2 writes or repairs one.
    expect(readFileSync(join(selfDir, "bin", stubNameFor("pnpm")), "utf8")).toBe(
      shimSource(BUILT_ENTRY_SPECIFIER, "pnpm"),
    );
  });

  it("is idempotent: a second run downloads nothing and rewrites nothing", async () => {
    const { selfDir, options } = upgradeFixture();

    await run(["self-upgrade"], options);
    expect(downloads(registry)).toBe(1);
    const before = statSync(join(selfDir, "dist", "index.mjs"));

    const second = await run(["self-upgrade"], options);

    expect(second.exitCode).toBe(0);
    expect(downloads(registry)).toBe(1);
    const after = statSync(join(selfDir, "dist", "index.mjs"));
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("§07.11 — removes the copy it replaced, and only that", async () => {
    const { fixture, selfDir, options } = upgradeFixture();

    // A previous release, complete with the marker that makes it an install.
    const previous = join(fixture.home, "self", PREVIOUS);
    mkdirSync(previous, { recursive: true });
    writeFileSync(
      join(previous, ".jup"),
      JSON.stringify({ locator: { name: "jup", reference: PREVIOUS }, hash: "sha512.aa" }),
    );
    // Not a version directory, and so not ours to interpret.
    mkdirSync(join(fixture.home, "self", "notes"), { recursive: true });

    const result = await run(["self-upgrade"], options);

    expect(result.exitCode).toBe(0);
    expect(existsSync(selfDir)).toBe(true);
    expect(existsSync(previous)).toBe(false);
    expect(existsSync(join(fixture.home, "self", "notes"))).toBe(true);
  });

  it("`upgrade` is the same command", async () => {
    const { shimDir, selfDir, options } = upgradeFixture();

    const result = await run(["upgrade"], options);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      [
        `Installing jup@${VERSION}...`,
        `jup ${VERSION} -> ${selfDir}`,
        `jup, corepack -> ${shimDir}`,
        "",
      ].join("\n"),
    );
  });

  it("§06.2 — a tarball that does not match the signed digest installs nothing", async () => {
    const { fixture, selfDir, options } = upgradeFixture();
    registry.mode = "invalid_integrity";

    const result = await run(["self-upgrade"], options);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/[Hh]ash/);
    expect(existsSync(selfDir)).toBe(false);
    expect(existsSync(join(fixture.home, "self", VERSION))).toBe(false);
  });

  it("refuses a package that is not a layout it can shim", async () => {
    const { selfDir, options } = upgradeFixture(impostor);

    const result = await run(["self-upgrade"], options);

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("so there is nothing to point");
    expect(existsSync(selfDir)).toBe(false);
  });

  it("§12.1 — an unknown argument names the word that was typed", async () => {
    const { options } = upgradeFixture();

    const result = await run(["upgrade", "pnpm"], options);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("The 'jup upgrade' command takes no arguments other than");
    expect(result.stdout).toContain(
      "$ jup upgrade [--install-directory <path>|--system] [--force]",
    );
  });

  it("--install-directory puts the names where it says", async () => {
    const { fixture, selfDir, options } = upgradeFixture();
    const elsewhere = join(fixture.root, "chosen-bin");

    const result = await run(["self-upgrade", "--install-directory", elsewhere], options);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`jup, corepack -> ${elsewhere}`);
    expect(existsSync(join(elsewhere, IS_WINDOWS ? "jup.cmd" : "jup"))).toBe(true);
    expect(existsSync(selfDir)).toBe(true);
  });
});
