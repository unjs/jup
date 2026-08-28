/**
 * §15.38 row 198 — §15.32, the resolved package manager on `PATH`.
 *
 * #412: `corepack pnpm exec …` does not put the resolved pnpm on `PATH`, so a
 * script that shells out to `pnpm` gets a *different* one, or nothing. Yarn only
 * appears to work because it adds itself to `PATH` independently, and the
 * maintainer's answer — *"that's something you should bring up to pnpm"* — makes
 * correctness depend on each package manager volunteering to fix it.
 *
 * The whole difficulty of testing this is that a nested `pnpm` resolving to
 * *something* proves nothing: the machine running the test has its own. So every
 * row here plants a **decoy** `pnpm` on `PATH` that prints `DECOY`, and the
 * control row shows the decoy really is what a nested call finds when the tool
 * has added nothing. The passing row is then the difference between the two.
 *
 * POSIX only: the decoy is a `#!/bin/sh` script and the shim is a symlink.
 */

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFINITIONS } from "../../src/config/table.ts";
import {
  childPath,
  cleanupFixtures,
  copyTool,
  createFixture,
  perUserShims,
  run,
  seedPackageManager,
  versionOf,
} from "./_harness/index.ts";

const POSIX = process.platform !== "win32";

const TOOL = POSIX ? copyTool() : "";

const PNPM = DEFINITIONS.pnpm!.default;
const VERSION = versionOf(PNPM);

/**
 * The stand-in pnpm. `exec` is #412's own command: it shells out to `pnpm` by
 * bare name, exactly as a `package.json` script would, and reports what it got.
 *
 * ESM, because the `>=11.0.0` band's entry point is `bin/pnpm.mjs`.
 */
const SCRIPT = [
  `import { spawnSync } from "node:child_process";`,
  `const args = process.argv.slice(2);`,
  `if (args[0] === "--version") {`,
  `  process.stdout.write(${JSON.stringify(VERSION)} + "\\n");`,
  `} else if (args[0] === "exec") {`,
  `  const nested = spawnSync("pnpm", ["--version"], { encoding: "utf8" });`,
  `  process.stdout.write("nested:" + JSON.stringify(nested.stdout ?? null) + "\\n");`,
  `  process.stdout.write("error:" + (nested.error ? nested.error.code : "none") + "\\n");`,
  `  process.stdout.write("path:" + (process.env.PATH ?? "") + "\\n");`,
  `} else {`,
  `  process.stdout.write("pnpm@" + ${JSON.stringify(VERSION)} + "\\n");`,
  `}`,
  ``,
].join("\n");

interface Scene {
  shimDir: string;
  decoy: string;
  options: Parameters<typeof run>[1];
}

/**
 * A pnpm-pinned project, a shim directory that is **not on `PATH`**, and a decoy
 * `pnpm` that is.
 *
 * Leaving the shim directory off `PATH` is what makes the row about §15.32 and
 * not about the user's shell profile: if the tool prepends nothing, the only
 * `pnpm` a nested process can reach is the decoy.
 */
function scene(): Scene {
  const fixture = createFixture({ name: "app", packageManager: `pnpm@${PNPM}` });
  seedPackageManager(fixture.home, "pnpm", PNPM, { script: SCRIPT, esm: true });

  // §15.13's per-user default, spelled for this platform — see `perUserShims`.
  const { dir: shimDir, env: shimEnv } = perUserShims(fixture.root);
  const decoy = join(fixture.root, "decoy");
  mkdirSync(shimDir, { recursive: true });
  mkdirSync(decoy, { recursive: true });

  const impostor = join(decoy, "pnpm");
  writeFileSync(impostor, `#!/bin/sh\nprintf 'DECOY\\n'\n`);
  chmodSync(impostor, 0o755);

  return {
    shimDir,
    decoy,
    options: {
      cwd: fixture.cwd,
      home: fixture.home,
      bin: TOOL,
      env: {
        HOME: fixture.root,
        USERPROFILE: fixture.root,
        ...shimEnv,
        // The decoy first, then the real PATH — `node` has to stay reachable,
        // because the shim is `#!/usr/bin/env node`.
        PATH: `${decoy}${delimiter}${process.env.PATH ?? ""}`,
      } as Record<string, string | undefined>,
    },
  };
}

/** `nested:"11.1.2\n"` → `11.1.2\n`. */
function field(stdout: string, key: string): string {
  const line = stdout.split("\n").find((entry) => entry.startsWith(`${key}:`));
  if (line === undefined) throw new Error(`No ${key} line in: ${JSON.stringify(stdout)}`);
  return line.slice(key.length + 1);
}

afterAll(cleanupFixtures);

describe.skipIf(!POSIX)("§15.32 — the resolved package manager on PATH (row 198)", () => {
  it("198: a nested script invoking `pnpm` resolves to the same pnpm", async () => {
    const { shimDir, options } = scene();

    // §14.15's shims are what makes the shim directory a directory of package
    // manager binaries, so `enable` is a precondition of the fix, not a
    // separate feature.
    const enabled = await run(["enable", "pnpm"], options);
    expect(enabled.exitCode).toBe(0);

    const result = await run(["pnpm", "exec", "whatever"], options);

    expect(result.exitCode).toBe(0);
    expect(field(result.stdout, "error")).toBe("none");
    // The same version the outer run resolved — reached by re-entering the tool
    // through the shim, which walked the same project.
    expect(JSON.parse(field(result.stdout, "nested")) as string).toBe(`${VERSION}\n`);
    // And it is *our* entry that did it: first on `PATH`, ahead of the decoy.
    expect(field(result.stdout, "path").split(delimiter)[0]).toBe(shimDir);
  });

  it("198: the control — with no shims, the nested call finds the decoy", async () => {
    const { decoy, options } = scene();

    // Identical, minus `enable`. This is the row that keeps the one above from
    // passing on the machine's own pnpm: the decoy is reachable, and nothing
    // the tool did displaced it.
    const result = await run(["pnpm", "exec", "whatever"], options);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(field(result.stdout, "nested")) as string).toBe("DECOY\n");
    // Untouched, entry for entry — against what `run` actually sent, which is
    // the caller's `PATH` minus §15.13 point 8's directory (see `childPath`).
    expect(field(result.stdout, "path")).toBe(childPath(options.env!.PATH));
    expect(field(result.stdout, "path").split(delimiter)[0]).toBe(decoy);
  });

  it("198: the prepended entry is the only modification to PATH", async () => {
    const { shimDir, options } = scene();

    expect((await run(["enable", "pnpm"], options)).exitCode).toBe(0);
    const result = await run(["pnpm", "exec", "whatever"], options);

    // Byte for byte: one entry added at the front, and everything the caller
    // had carried through in its original order.
    expect(field(result.stdout, "path")).toBe(
      `${shimDir}${delimiter}${childPath(options.env!.PATH)}`,
    );
  });
});
