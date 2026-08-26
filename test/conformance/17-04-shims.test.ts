/**
 * §17.9 rows 222–224 — the shim policy (C5) and the interpreter guard (C7).
 *
 * **What makes 223 and 224 load-bearing here.** §08.3 is written for a native
 * implementation, and this one hands the package manager over *in process*
 * (`src/run/exec.ts`), so §08.3.1's numbered interpreter lookup has no caller in
 * the tool itself: `process.execPath` is already a runtime by the time any of
 * our code runs. A row asserting a guard on a lookup that never happens would
 * pass for the wrong reason and prove nothing.
 *
 * The lookups that *are* live in this implementation are the ones C7 lists
 * outside §08.3.1, and one of them is ours to fix:
 *
 * * `#!/usr/bin/env node` at the top of every §10.1 stub resolves through `PATH`
 *   before the tool gets control at all, and the shim `env` would find is itself
 *   a `#!/usr/bin/env node` script — so the loop is in the kernel and `env`, and
 *   no guard we could write is ever reached. C7's own table defers this one to
 *   §15.14 ("§15.14 already requires replacing these; this is a second reason"),
 *   and §15.14 is a separate item. It is not tested here because it is not
 *   fixed here; `shimSource`'s comment says so at the source.
 * * §10.3's generated wrappers pick an interpreter themselves, and the generator
 *   is ours. That is where §08.3.1's search now lives — see `win32ShSource` —
 *   so these two rows run a **generated shim** and assert which interpreter it
 *   chose. Reverting the generator turns both red.
 *
 * The wrappers are Windows artifacts, and these rows run on POSIX: §10.3's
 * generator is platform-independent on purpose ("so Windows shims can be
 * produced from a POSIX build machine"), and `test/unit/shims.test.ts` already
 * asserts their bodies from POSIX for row 131. The sh wrapper is a `/bin/sh`
 * script, so running it here exercises exactly the bytes a Git Bash / MSYS user
 * executes.
 *
 * Row 222 goes through the spawned CLI like every other row, because C5 is about
 * what `enable` decides rather than about what it writes.
 */

import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { generateWin32Link } from "../../src/commands/shims.ts";
import { messages } from "../../src/errors.ts";
import {
  cleanupFixtures,
  copyTool,
  createFixture,
  DUAL_TOOL,
  FIXTURE_TOOLS,
  run,
  RUNTIME_TOOL,
} from "./_harness/index.ts";

const execFileAsync = promisify(execFile);

const TOOL = copyTool();
const IS_WINDOWS = process.platform === "win32";

afterAll(cleanupFixtures);

/* -------------------------------------------------------------------------- */
/* Row 222 — C5's default set                                                  */
/* -------------------------------------------------------------------------- */

/** 13-11's fixture, spawned under `jup` so §17.4's scope words are accepted. */
function shimFixture() {
  const fixture = createFixture();
  const shimDir = join(fixture.root, "user-bin");
  mkdirSync(shimDir, { recursive: true });

  return {
    fixture,
    shimDir,
    options: {
      cwd: fixture.cwd,
      home: fixture.home,
      bin: TOOL,
      as: "jup" as const,
      table: FIXTURE_TOOLS,
      env: {
        HOME: fixture.root,
        USERPROFILE: fixture.root,
        XDG_BIN_HOME: shimDir,
        LOCALAPPDATA: undefined,
        PATH: `${shimDir}${delimiter}${process.env.PATH ?? ""}`,
      },
    },
  };
}

const PACKAGE_MANAGER_BINARIES = ["npm", "npx", "pnpm", "pnpx", "yarn", "yarnpkg"];

describe("§17.6 C5 `enable`'s default set", () => {
  // Row 222. Reverted by dropping the `hasRole(name, scope)` filter from
  // `targetBinaries`'s default set (`src/commands/shims.ts`), which puts the
  // runtime-role fixture back in the no-names set and fails the first half.
  it("222: enable with no names shims the package-manager role only", async () => {
    const { shimDir, options } = shimFixture();

    const result = await run(["enable"], options);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    // §15.16's npm included, and the dual-role fixture too: it *has* the
    // package-manager role, and C5 scopes by role rather than by tool.
    for (const binary of [...PACKAGE_MANAGER_BINARIES, DUAL_TOOL]) {
      expect(lstatSync(join(shimDir, binary)).isSymbolicLink()).toBe(true);
    }
    // The whole of C5: occupying a runtime's name is a different order of
    // intervention, and a user who typed `jup enable` did not ask for it.
    expect(existsSync(join(shimDir, RUNTIME_TOOL))).toBe(false);
  });

  // Row 222's second half — the opt-in has to work, or C5 is just a removal.
  it("222: jup runtime enable creates the runtime shim", async () => {
    const { shimDir, options } = shimFixture();

    const result = await run(["runtime", "enable"], options);

    expect(result.exitCode).toBe(0);
    expect(lstatSync(join(shimDir, RUNTIME_TOOL)).isSymbolicLink()).toBe(true);
    // Scoped, so the package managers are *not* in this target set.
    expect(existsSync(join(shimDir, "yarn"))).toBe(false);
    // The dual-role tool is in both sets, because it has both roles.
    expect(existsSync(join(shimDir, DUAL_TOOL))).toBe(true);
  });

  // §10.5 — "shimmed only when it is named explicitly *or* the command is
  // scoped". The explicit name is the other half of that sentence.
  it("222: an explicit name shims a runtime without a scope word", async () => {
    const { shimDir, options } = shimFixture();

    expect((await run(["enable", RUNTIME_TOOL], options)).exitCode).toBe(0);

    expect(lstatSync(join(shimDir, RUNTIME_TOOL)).isSymbolicLink()).toBe(true);
    expect(existsSync(join(shimDir, "yarn"))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Rows 223–224 — C7's interpreter guard                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every `PATH` entry that does **not** hold a `node`, so a row can decide for
 * itself which runtimes exist.
 *
 * The wrapper's preamble needs `dirname`, `sed` and `uname` (§10.3's own body)
 * and its scan needs `head` and `grep`, so the system directories have to stay —
 * this drops only the ones that would smuggle a real runtime into row 224.
 */
function pathWithoutNode(): string {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry !== "" && !existsSync(join(entry, "node")))
    .join(delimiter);
}

/**
 * A shim directory holding a generated `pnpm` wrapper set and a generated `node`
 * wrapper set — which is exactly what `jup enable node` writes on Windows, and
 * exactly the sibling C7's second row is about.
 *
 * The stub's library entry is a stand-in that prints its `argv`, so what the
 * wrapper chose is directly observable: `["pnpm", …]` means a real runtime ran
 * the pnpm stub, and `["node", …]` means the `node` shim was selected as the
 * interpreter and re-entered the tool — the first turn of C7's recursion.
 */
async function plantShims() {
  const fixture = createFixture();
  const dist = join(fixture.root, "dist");
  const shimDir = join(fixture.root, "bin");
  const nodeDir = join(fixture.root, "node-bin");
  mkdirSync(dist);
  mkdirSync(shimDir);
  mkdirSync(nodeDir);
  writeFileSync(join(dist, "package.json"), `{"type":"module"}\n`);
  writeFileSync(
    join(dist, "index.mjs"),
    `export async function runMain(argv) {\n  process.stdout.write(JSON.stringify(argv));\n  return 0;\n}\n`,
  );
  symlinkSync(process.execPath, join(nodeDir, "node"));

  await generateWin32Link(shimDir, dist, "pnpm");
  await generateWin32Link(shimDir, dist, "node");

  return { shimDir, nodeDir };
}

interface ShimResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runShim(shim: string, path: string): Promise<ShimResult> {
  return await execFileAsync("sh", [shim, "install"], {
    env: { PATH: path },
    timeout: 30_000,
  })
    .then(({ stdout, stderr }) => ({ code: 0, stdout, stderr }))
    .catch((error: Error & { code?: number; stdout?: string; stderr?: string }) => ({
      code: error.code ?? 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
    }));
}

describe.skipIf(IS_WINDOWS)("§17.6 C7 no interpreter lookup resolves to a shim", () => {
  // Row 223. Reverted by restoring §10.3's `if [ -x "$basedir/node" ]` sibling
  // preference in `win32ShSource`: the assertion below then reads
  // `["node", "<dist>/pnpm.js", "install"]` — the shim, running as the
  // interpreter for the shim beside it.
  it("223: a shim first on PATH is skipped and the real runtime runs", async () => {
    const { shimDir, nodeDir } = await plantShims();
    // The shim directory first, exactly as §15.32 arranges it for every process
    // a package manager spawns; the real runtime is behind it.
    const path = [shimDir, nodeDir, pathWithoutNode()].join(delimiter);

    const result = await runShim(join(shimDir, "pnpm"), path);

    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual(["pnpm", "install"]);
  });

  // Row 224. Reverted the same way: with the sibling preference back, the
  // wrapper execs the shim instead of failing, and there is no message at all.
  it("224: when every candidate is a shim it fails with C7's message", async () => {
    const { shimDir } = await plantShims();
    // No real runtime anywhere on `PATH` — only the `node` shim just planted.
    const path = [shimDir, pathWithoutNode()].join(delimiter);

    const result = await runShim(join(shimDir, "pnpm"), path);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`${messages.everyInterpreterIsShim()}\n`);
  });

  // §08.3.1 step 4's *other* error, which the row above has to be distinct from:
  // "no runtime at all" and "every runtime was one of ours" are different
  // situations with different remedies, and a search that conflated them would
  // tell a user with no Node.js installed to go looking for a shim.
  it("no candidate at all is §08.3.1's other error, not C7's", async () => {
    const { shimDir } = await plantShims();
    const path = pathWithoutNode();

    const result = await runShim(join(shimDir, "pnpm"), path);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe(`${messages.noNodeRuntime("pnpm")}\n`);
  });

  // §08.3.1 step 1, which is what both messages advise. Without it the advice
  // would be untrue of this implementation.
  it("JUP_NODE_EXECPATH wins outright, under either spelling", async () => {
    const { shimDir } = await plantShims();
    const path = [shimDir, pathWithoutNode()].join(delimiter);

    for (const variable of ["JUP_NODE_EXECPATH", "COREPACK_NODE_EXECPATH"]) {
      const result = await execFileAsync("sh", [join(shimDir, "pnpm"), "install"], {
        env: { PATH: path, [variable]: process.execPath },
        timeout: 30_000,
      });
      expect(JSON.parse(result.stdout)).toEqual(["pnpm", "install"]);
    }
  });
});
