/**
 * §15.38 row 207 — a store directory symlinked to a local checkout (#440).
 *
 * #440 asks for the one workflow the store's design otherwise forbids: point the
 * cache entry for `pnpm@11.1.2` at a working tree, edit the package manager, run
 * it again, see the change. Corepack has no `--link` flag and this spec adds
 * none — §15.34 holds the scope line — so the whole feature is "do not get in
 * the way of a symlink", and this row is what says the tool does not.
 *
 * There is nothing to implement, which is exactly why the row is worth having:
 * every plausible hardening of the store would break it silently. Resolving
 * `<home>/v1/<name>/<version>` through `realpath` before the §14.13 containment
 * check, listing the store with `withFileTypes` and an `isDirectory()` filter
 * (a symlink is not a directory to `Dirent`), or `lstat`-ing the marker's
 * directory — each is a reasonable-looking line of code, each passes every other
 * row in the suite, and each turns "debuggable in place" off.
 *
 * Every row below runs with `COREPACK_ENABLE_NETWORK=0`. A tool that failed to
 * see the symlinked entry would fall through to a download, and offline turns
 * that fallback from a silent re-install into a visible failure.
 */

import { lstatSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  binPathsFor,
  cleanupFixtures,
  createFixture,
  type Fixture,
  run,
  seedPackageManager,
} from "./_harness/index.ts";

const IS_WINDOWS = process.platform === "win32";

const NAME = "pnpm";
const VERSION = "11.1.2";

/** `<home>/v1/<name>/<version>` — §07.2's layout. */
function storePath(home: string, ...rest: string[]): string {
  return join(home, "v1", NAME, ...rest);
}

/**
 * Build a local checkout of the package manager and put the store entry for it
 * behind a symlink.
 *
 * The checkout is a *moved* store install rather than a hand-written directory,
 * deliberately: it is then byte-for-byte what a real install of this version
 * looks like, so the single variable under test is the symlink and not some
 * detail of how the fixture spelled the layout.
 *
 * `link` chooses which of the two store directories becomes the link — the
 * version (one checkout of one version) or the package manager's whole subtree
 * (a directory of checkouts, which is how someone bisecting keeps several).
 */
function checkoutFixture(options?: { link?: "version" | "name"; relative?: boolean }): {
  fixture: Fixture;
  /** The working tree the store now points at. */
  checkout: string;
  /** The store path that is a symlink. */
  linked: string;
} {
  const fixture = createFixture({ name: "app", packageManager: `${NAME}@${VERSION}` });
  seedPackageManager(fixture.home, NAME, VERSION);

  const linked =
    options?.link === "name" ? storePath(fixture.home) : storePath(fixture.home, VERSION);
  const checkout = join(fixture.root, "checkout");

  renameSync(linked, checkout);
  // A relative target is what a hand-made link usually is, and it resolves
  // against the link's own directory rather than the process's cwd — a
  // distinction an implementation that read the target as a plain path would get
  // wrong.
  symlinkSync(
    options?.relative === true
      ? join("..", options.link === "name" ? ".." : "../..", "checkout")
      : checkout,
    linked,
  );

  return { fixture, checkout, linked };
}

/** Offline, so a missed cache entry becomes a failure rather than a download. */
function offline(fixture: Fixture): {
  cwd: string;
  home: string;
  env: Record<string, string | undefined>;
} {
  return { cwd: fixture.cwd, home: fixture.home, env: { COREPACK_ENABLE_NETWORK: "0" } };
}

afterAll(cleanupFixtures);

describe.skipIf(IS_WINDOWS)("§15.38 row 207 — a store entry that is a symlink", () => {
  it("207: an exactly-pinned version resolves and runs from the symlinked checkout", async () => {
    const { fixture, linked } = checkoutFixture();

    const result = await run([NAME, "--version"], offline(fixture));

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${VERSION}\n`);
    // The entry is still a link afterwards: nothing re-materialised it as a real
    // directory behind the user's back, which would take the checkout back out
    // of the loop from the second run onwards.
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
  });

  it("207: edits to the checkout take effect on the next run, which is the point", async () => {
    const { fixture, checkout } = checkoutFixture();

    expect((await run([NAME, "--version"], offline(fixture))).exitCode).toBe(0);

    // Debugging in place: change the package manager where it lives, run it
    // again. If anything copied the tree into the store instead of following the
    // link, the second run replays the first one's bytes and this fails.
    for (const relative of binPathsFor(NAME, VERSION)) {
      writeFileSync(join(checkout, relative), `process.stdout.write("patched\\n");\n`);
    }

    const result = await run([NAME, "--version"], offline(fixture));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("patched\n");
    // And the edit is still where the developer made it.
    expect(readFileSync(join(checkout, binPathsFor(NAME, VERSION)[0]!), "utf8")).toContain(
      "patched",
    );
  });

  it("207: a relative link target resolves too", async () => {
    const { fixture } = checkoutFixture({ relative: true });

    const result = await run([NAME, "--version"], offline(fixture));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${VERSION}\n`);
  });

  it("207: the package manager's whole subtree can be the link", async () => {
    const { fixture, linked } = checkoutFixture({ link: "name" });

    const result = await run([NAME, "--version"], offline(fixture));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${VERSION}\n`);
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
  });

  it("207: the store *scan* finds it too, so a range pin resolves offline", async () => {
    // The exact-pin rows above reach the entry by `stat`-ing one path (§04.1
    // step 4's fast path). A range reaches it by listing the directory instead,
    // which is a different call and the one a `Dirent.isDirectory()` filter
    // would quietly lose.
    const { fixture } = checkoutFixture();
    fixture.write("package.json", `${JSON.stringify({ packageManager: `${NAME}@^11.0.0` })}\n`);

    const result = await run([NAME, "--version"], offline(fixture));

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${VERSION}\n`);
  });

  it("207: `cache list` reports the linked version, so `info` can explain the run", async () => {
    // §15.30 names #440 among its drivers: the reason to link a checkout in is to
    // debug it, and a run whose provenance the tool cannot report is not much
    // better than no run.
    const { fixture } = checkoutFixture();

    const result = await run(["cache", "list", "--json"], offline(fixture));

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      store: { versions: [{ name: NAME, version: VERSION }] },
    });
  });
});
