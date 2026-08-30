/**
 * §05.4 — predictable download-notice behaviour (row 180).
 *
 * #550 was not "the variable does nothing". It was that the variable's *default*
 * was chosen by the entry point — `0` in `bin.ts`, `1` in a generated shim
 * (§10.1) — so the same project, the same store and the same command behaved
 * differently depending on whether the user typed `corepack yarn` or `yarn`.
 * §05.4 answers it by removing the choice: an artifact download announces itself
 * on stderr, from every entry point, always, and asks nothing. There is no
 * variable left to disagree about and no answer for a non-interactive run to
 * fail to give.
 *
 * What that leaves to prove is the sameness, and the two halves have to be
 * joined in one file or the row proves nothing:
 *
 * * A run with nothing to download is silent whatever the entry point, so a row
 *   that forgets to make the download happen passes against any implementation.
 *   Every row below asserts the artifact request the mock registry received.
 * * A shim row can pass because the *machine's own* corepack answered. These run
 *   a throwaway copy of the tool (`copyTool`) and check that the shim resolves
 *   back into that copy before trusting a word it says.
 *
 * §08.6's half is here too, and it is what the removed confirmation used to put
 * at risk: the notice reads nothing back, so the bytes a caller piped in are
 * still there for the package manager, on a cold run that downloads.
 */

import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  copyTool,
  createFixture,
  downloadNotice,
  perUserShims,
  type Fixture,
  MockRegistry,
  packageManagerTarball,
  run,
} from "./_harness/index.ts";

const IS_WINDOWS = process.platform === "win32";

const TOOL = copyTool();
/** The copy's root — what `COREPACK_ROOT` reports and what the shim must link into. */
const TOOL_ROOT = dirname(dirname(TOOL));

const registry = new MockRegistry();

const VERSION = "11.1.2";
/** A second band whose fake pnpm echoes its stdin back, for the §08.6 row. */
const ECHO_VERSION = "11.1.3";
/** The artifact URL the notice names, and the path the mock serves it at. */
const TARBALL_PATH = `/pnpm/-/pnpm-${VERSION}.tgz`;
const TARBALL_URL = `https://registry.npmjs.org${TARBALL_PATH}`;
const ECHO_TARBALL_PATH = `/pnpm/-/pnpm-${ECHO_VERSION}.tgz`;
const ECHO_TARBALL_URL = `https://registry.npmjs.org${ECHO_TARBALL_PATH}`;

beforeAll(async () => {
  await registry.start();
  registry.publish("pnpm", VERSION, packageManagerTarball("pnpm", VERSION), {
    distTags: { latest: VERSION },
  });
  registry.publish(
    "pnpm",
    ECHO_VERSION,
    packageManagerTarball("pnpm", ECHO_VERSION, {
      script: [
        `let data = "";`,
        `process.stdin.setEncoding("utf8");`,
        `process.stdin.on("data", (chunk) => { data += chunk; });`,
        `process.stdin.on("end", () => { process.stdout.write("STDIN:" + data); });`,
        ``,
      ].join("\n"),
    }),
  );
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

/**
 * A project pinned to an **uncached** package manager, with its own per-user
 * shim directory (§10.5) inside the fixture and on `PATH`.
 *
 * `perUserShims` is what redirects the default install directory, and which
 * variable does it is platform-specific; without the redirection `enable`
 * writes into the developer's own `~/.local/bin`.
 */
function shimFixture(version = VERSION): {
  fixture: Fixture;
  shimDir: string;
  options: {
    cwd: string;
    home: string;
    bin: string;
    registry: MockRegistry;
    env: Record<string, string | undefined>;
  };
} {
  const fixture = createFixture({ name: "app", packageManager: `pnpm@${version}` });
  // §10.5's per-user default, spelled for this platform — see `perUserShims`.
  const { dir: shimDir, env: shimEnv } = perUserShims(fixture.root);
  mkdirSync(shimDir, { recursive: true });

  return {
    fixture,
    shimDir,
    options: {
      cwd: fixture.cwd,
      home: fixture.home,
      bin: TOOL,
      registry,
      env: {
        HOME: fixture.root,
        USERPROFILE: fixture.root,
        ...shimEnv,
        PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
        COREPACK_INTEGRITY_KEYS: registry.trustStore(),
      },
    },
  };
}

/** `enable` the pnpm shim, and prove the thing it wrote is ours. */
async function installShim(shimDir: string, options: Parameters<typeof run>[1]): Promise<string> {
  const result = await run(["enable", "pnpm"], options);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");

  const shim = join(shimDir, "pnpm");
  // Three independent proofs that a shim row cannot be answered by the
  // machine's own corepack: the link lands inside the throwaway copy, the file
  // it lands on carries our marker, and it is that copy's own output the rows
  // below read.
  expect(realpathSync(shim).startsWith(TOOL_ROOT)).toBe(true);
  expect(readFileSync(shim, "utf8")).toContain("@jup-shim");
  return shim;
}

/** The paths the mock actually served during the last run. */
function servedPaths(): string[] {
  return registry.requests.map((request) => request.path);
}

describe.skipIf(IS_WINDOWS)("§05.4 the download notice from every entry point", () => {
  it("180: a shim announces the download, and the tool's own entry point says the same", async () => {
    const first = shimFixture();
    const shim = await installShim(first.shimDir, first.options);
    registry.reset();

    const viaShim = await run(["--version"], { ...first.options, bin: shim });

    expect(viaShim.exitCode).toBe(0);
    expect(viaShim.stdout).toBe(`${VERSION}\n`);
    // "Exactly this" rather than `toContain`: a row that only looks for a
    // substring passes against an implementation that also asks a question.
    expect(viaShim.stderr).toBe(downloadNotice(TARBALL_URL, { name: "pnpm", version: VERSION }));
    expect(servedPaths()).toContain(TARBALL_PATH);

    // The other entry point, on a second, separate project so that it downloads
    // too. #550 is exactly the difference between these two lines, and there
    // is no setting either of them could disagree about any more.
    const second = shimFixture();
    registry.reset();

    const viaTool = await run(["pnpm", "--version"], second.options);

    expect(viaTool.exitCode).toBe(0);
    expect(viaTool.stdout).toBe(`${VERSION}\n`);
    expect(viaTool.stderr).toBe(viaShim.stderr);
    expect(servedPaths()).toContain(TARBALL_PATH);
  });

  it("180: the notice reads nothing, so a piped package manager still gets its stdin", async () => {
    // §08.6 — the confirmation was the only thing that ever touched stdin, and
    // removing it is what this row keeps honest: the `n` that used to abort the
    // download is now just input, and it has to arrive at the package manager
    // whole on the very run that downloads it.
    const { shimDir, options } = shimFixture(ECHO_VERSION);
    const shim = await installShim(shimDir, options);
    registry.reset();

    const result = await run(["cache", "install"], { ...options, bin: shim, input: "n\n" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("STDIN:n\n");
    expect(result.stderr).toBe(
      downloadNotice(ECHO_TARBALL_URL, { name: "pnpm", version: ECHO_VERSION }),
    );
    expect(servedPaths()).toContain(ECHO_TARBALL_PATH);
  });
});
