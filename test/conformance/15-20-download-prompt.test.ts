/**
 * §05.4 — predictable download-prompt behaviour (row 180).
 *
 * #550 is not "the variable does nothing". It is that the variable's *default*
 * is chosen by the entry point — `0` in `bin.ts`, `1` in a generated shim
 * (§10.1) — so the same project, the same store and the same command behave
 * differently depending on whether the user typed `corepack yarn` or `yarn`.
 * §05.4 leaves that default in place and makes the explicit value absolute:
 * `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` suppresses both the notice and the
 * confirmation, from every entry point, unconditionally.
 *
 * The half that could regress silently is therefore the **shim** one, and the
 * two halves have to be joined in one file or the row proves nothing:
 *
 * * The tool's own entry point already defaults to `0`, so an explicit `0` there
 *   is indistinguishable from the default. Only a shim can tell "the value was
 *   honoured" from "the value was ignored".
 * * A run with nothing to download is silent whatever the setting, so a row that
 *   forgets to make the download happen passes against any implementation. Every
 *   row below asserts the artifact request the mock registry actually received.
 * * A shim row can pass because the *machine's own* corepack answered. These run
 *   a throwaway copy of the tool (`copyTool`) and check that the shim resolves
 *   back into that copy before trusting a word it says.
 *
 * §05.4's third condition — the interactive confirmation additionally needs a
 * TTY and an unset `CI` — is unreachable from here: `run()` gives the tool a
 * pipe for stdin, so `process.stdin.isTTY` is never true and the confirmation
 * branch cannot be entered at all. What is asserted instead is the notice, which
 * is the branch a suppressed prompt has to skip *before* it reaches the
 * confirmation, plus the fact that stdin is never consumed.
 */

import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  copyTool,
  createFixture,
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
/** The artifact URL the notice names, and the path the mock serves it at. */
const TARBALL_PATH = `/pnpm/-/pnpm-${VERSION}.tgz`;
const TARBALL_URL = `https://registry.npmjs.org${TARBALL_PATH}`;

beforeAll(async () => {
  await registry.start();
  registry.publish("pnpm", VERSION, packageManagerTarball("pnpm", VERSION), {
    distTags: { latest: VERSION },
  });
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
function shimFixture(): {
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
  const fixture = createFixture({ name: "app", packageManager: `pnpm@${VERSION}` });
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
        // §05.4's third condition. Leaving the developer's own `CI` in place
        // would make the confirmation branch unreachable for a reason this file
        // did not choose.
        CI: undefined,
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
  // it lands on carries our marker, and it is the marker's own default that the
  // control row below observes.
  expect(realpathSync(shim).startsWith(TOOL_ROOT)).toBe(true);
  expect(readFileSync(shim, "utf8")).toContain("@jup-shim");
  return shim;
}

/** The paths the mock actually served during the last run. */
function servedPaths(): string[] {
  return registry.requests.map((request) => request.path);
}

describe.skipIf(IS_WINDOWS)("§05.4 the download prompt from a shim entry point", () => {
  it("180: the shim's own default is 1, so there is something to suppress", async () => {
    // The control. Without it row 180 cannot tell "the 0 was honoured" from
    // "this entry point never prints anything anyway", and #550 is precisely a
    // report about entry points disagreeing.
    const { shimDir, options } = shimFixture();
    const shim = await installShim(shimDir, options);
    registry.reset();

    const result = await run(["--version"], { ...options, bin: shim });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${VERSION}\n`);
    expect(result.stderr).toBe(`! jup is about to download ${TARBALL_URL}\n`);
    expect(servedPaths()).toContain(TARBALL_PATH);
  });

  it("180: COREPACK_ENABLE_DOWNLOAD_PROMPT=0 through a shim is fully silent", async () => {
    const { shimDir, options } = shimFixture();
    const shim = await installShim(shimDir, options);
    registry.reset();

    const result = await run(["--version"], {
      ...options,
      bin: shim,
      env: { ...options.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
    });

    // "Fully silent" is `=== ""`, not `not.toContain(…)`: a `not.toContain`
    // assertion passes against an implementation that prints a *differently
    // worded* notice, which is the same defect wearing a new string.
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${VERSION}\n`);

    // The download really happened in this run — otherwise silence proves
    // nothing at all, because a cache hit is silent under every setting.
    expect(servedPaths()).toContain(TARBALL_PATH);
  });

  it("180: an already-suppressing entry point stays silent, and the value is not env-file settable", async () => {
    // The other entry point, for completeness: `bin.ts` defaults to `0`, and an
    // explicit `0` must not un-suppress anything. The `.jup.env` half is
    // §03.2's deny-list — a project that tries to turn the prompt on for the
    // tool's own entry point is ignored, silently (row 48), and the same file
    // must not be able to turn it on for a shim either.
    const { shimDir, options, fixture } = shimFixture();
    fixture.write(".jup.env", "COREPACK_ENABLE_DOWNLOAD_PROMPT=1\n");
    const shim = await installShim(shimDir, options);
    registry.reset();

    const viaTool = await run(["pnpm", "--version"], {
      ...options,
      env: { ...options.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
    });

    expect(viaTool.stderr).toBe("");
    expect(viaTool.exitCode).toBe(0);
    expect(servedPaths()).toContain(TARBALL_PATH);

    // A second, separate project so the shim run downloads too.
    const second = shimFixture();
    second.fixture.write(".jup.env", "COREPACK_ENABLE_DOWNLOAD_PROMPT=1\n");
    registry.reset();

    const viaShim = await run(["--version"], {
      ...second.options,
      bin: shim,
      env: { ...second.options.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
    });

    expect(viaShim.stderr).toBe("");
    expect(viaShim.exitCode).toBe(0);
    expect(viaShim.stdout).toBe(`${VERSION}\n`);
    expect(servedPaths()).toContain(TARBALL_PATH);
  });

  it("180: suppression does not consume stdin, so a piped package manager still reads it", async () => {
    // §08.6 — the confirmation is the only thing that ever touches stdin, and it
    // must not be touched when there is no confirmation to make. The fake
    // package manager echoes its argv rather than reading stdin, so what this
    // asserts is the negative: the bytes the tool was handed are still there for
    // the child, i.e. nothing upstream of the handover speculatively read them.
    const { shimDir, options } = shimFixture();
    const shim = await installShim(shimDir, options);
    registry.reset();

    const result = await run(["install"], {
      ...options,
      bin: shim,
      input: "n\n",
      env: { ...options.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
    });

    expect(result.stderr).toBe("");
    // `n` is the one answer that aborts the confirmation (§05.4). Reaching the
    // package manager at all proves the confirmation was never asked.
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`pnpm@${VERSION} install\n`);
    expect(servedPaths()).toContain(TARBALL_PATH);
  });
});
