/**
 * §15.40 — the version file a tool's ecosystem already writes (rows 237–243).
 *
 * §15.39 gave a runtime a field of its own, and almost no repository has written
 * one. `.nvmrc` is in a large share of them today, says the same thing, and is
 * already obeyed by a program most of those repositories have installed. These
 * rows are the whole of what reading it may do: fill a silence (237, 238, 242),
 * never displace jup's own field (239), refuse honestly what it cannot answer
 * (240, 241), and stay out of every path that *writes* (243).
 *
 * What is deliberately not tested here is anything past §03: a range that came
 * from `.nvmrc` is a range, and §04–§08 never learn where it was written down.
 * Row 237 asserts that once — the install is an ordinary §15.28 per-host install
 * — and the rest of the file stays in the walk.
 *
 * POSIX only, for `15-39`'s reason: the artifact has to be a real executable.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hostTarget } from "../../src/config/table.ts";
import { messages } from "../../src/errors.ts";
import {
  cleanupFixtures,
  createFixture,
  type Fixture,
  makeTarball,
  MockRegistry,
  npmTarball,
  packageManagerTarball,
  run,
} from "./_harness/index.ts";

const POSIX = process.platform !== "win32";

const registry = new MockRegistry();

const PINNED = "22.23.2";
const NEWEST = "24.20.0";
const PNPM_VERSION = "11.1.2";

/** See `15-39`'s copy: three of the six published hosts are renames. */
const NODE_TARGETS: Record<string, string> = {
  "darwin-arm64": "bin-darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-arm64": "linux-arm64",
  "linux-x64": "linux-x64",
  "win32-arm64": "win-arm64",
  "win32-x64": "win-x64",
};

const NODE_PACKAGE = `node-${NODE_TARGETS[hostTarget()]}`;

/** Reports the name it was invoked under and its arguments. */
const PROBE = `#!/bin/sh\nprintf 'ran=%s args=%s\\n' "$(basename "$0")" "$*"\n`;

function artifact(version: string): Uint8Array {
  return makeTarball([
    {
      path: "package/package.json",
      content: `${JSON.stringify({ name: NODE_PACKAGE, version, bin: { node: "bin/node" } })}\n`,
      mode: 0o644,
    },
    { path: "package/bin/node", content: PROBE, mode: 0o755 },
  ]);
}

beforeAll(async () => {
  if (!POSIX) return;
  await registry.start();

  for (const version of [PINNED, NEWEST]) {
    registry.publish("node", version, npmTarball({ "package.json": "{}\n" }), {
      distTags: { latest: NEWEST },
    });
    registry.publish(NODE_PACKAGE, version, artifact(version));
  }

  registry.publish("pnpm", PNPM_VERSION, packageManagerTarball("pnpm", PNPM_VERSION));
});

afterAll(async () => {
  cleanupFixtures();
  if (POSIX) await registry.stop();
});

describe.skipIf(!POSIX)("§15.40 version files", () => {
  function options(fixture: Fixture, env?: Record<string, string | undefined>) {
    return {
      cwd: fixture.cwd,
      home: fixture.home,
      registry,
      env: { COREPACK_INTEGRITY_KEYS: registry.trustStore(), CI: undefined, ...env },
    };
  }

  const installed = (fixture: Fixture, version: string): boolean =>
    existsSync(join(fixture.home, "v1", "node", version));

  it("237: an `.nvmrc` speaks where the manifest says nothing about the runtime", async () => {
    const fixture = createFixture({ name: "app", packageManager: `pnpm@${PNPM_VERSION}` });
    fixture.write(".nvmrc", `v${PINNED}\n`);
    registry.reset();

    const node = await run(["node", "server.js"], options(fixture));
    expect(node.stderr).toBe("");
    expect(node.exitCode).toBe(0);
    expect(node.stdout.trim()).toBe("ran=node args=server.js");

    // The `v` prefix needs no translating: §04.2's partial-version grammar
    // accepts it, which is why the numeric half of nvm's vocabulary is already
    // jup range syntax and this file is as short as it is.
    expect(installed(fixture, PINNED)).toBe(true);
    expect(installed(fixture, NEWEST)).toBe(false);

    // Past §03 nothing knows where the range came from: this is an ordinary
    // §15.28 install, launcher for the version line and per-host package for the
    // bytes. Asserted once, here, and not again.
    const fetched = registry.requests.map((request) => request.path);
    expect(fetched.some((path) => path.includes(`${NODE_PACKAGE}/-/`))).toBe(true);
    expect(fetched.some((path) => path.includes("/node/-/"))).toBe(false);

    // The file is node's, and says nothing about anything else.
    const pnpm = await run(["pnpm", "--version"], options(fixture));
    expect(pnpm.exitCode).toBe(0);
    expect(pnpm.stdout).toContain(PNPM_VERSION);

    // Nothing was written back. §03.7 writes `devEngines.runtime` and only that.
    expect(fixture.read(".nvmrc")).toBe(`v${PINNED}\n`);
    expect(fixture.json("package.json")).toEqual({
      name: "app",
      packageManager: `pnpm@${PNPM_VERSION}`,
    });
  });

  it("238: nvm's grammar, and the nearest file wins", async () => {
    const fixture = createFixture({ name: "root" });
    // nvm's own reading of this file: `#` to end of line is a comment, blank
    // lines and surrounding space go, `key=value` lines are settings jup has no
    // counterpart for and skips, and exactly one bare line is the version.
    fixture.write(
      ".nvmrc",
      ["# the version this repository builds on", "", `  ${NEWEST}  # bumped`, "", ""].join("\n"),
    );
    fixture.write("packages/app/package.json", `${JSON.stringify({ name: "app" })}\n`);
    fixture.write("packages/app/.nvmrc", "22.x\nsome-nvm-setting=on\n");
    fixture.write("packages/app/node_modules/.keep", "");

    const nested = { ...options(fixture), cwd: join(fixture.cwd, "packages", "app") };
    const result = await run(["node", "-e", "0"], nested);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    // The nearer file, exactly as `nvm_find_up` picks it — and read through both
    // the comment and the setting line.
    expect(installed(fixture, PINNED)).toBe(true);
    expect(installed(fixture, NEWEST)).toBe(false);

    // §15.23 — a range resolves through `jup.lock`, and the version file is the
    // spec result's target, so the memo lands beside the file that declared the
    // range rather than at the repository root. Neither project file is written:
    // running `node` is not a decision about what the repository builds on.
    expect(fixture.exists("packages/app/jup.lock")).toBe(false);
    expect(fixture.exists("jup.lock")).toBe(false);
    expect(fixture.json("packages/app/node_modules/.jup/jup.lock")).toMatchObject({
      resolutions: { "node@22.x": expect.objectContaining({ resolved: PINNED }) },
    });
  });

  it("239: `devEngines.runtime` outranks the file, and is not compared against it", async () => {
    const fixture = createFixture({
      name: "app",
      devEngines: { runtime: { name: "node", version: PINNED } },
    });
    // Disagreeing on purpose. There is no reconciliation between the two and no
    // warning: jup's own field is the one a user edits to override a file they
    // may not be free to delete, so it simply wins.
    fixture.write(".nvmrc", `${NEWEST}\n`);

    const result = await run(["node", "-e", "0"], options(fixture));
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(installed(fixture, PINNED)).toBe(true);
    expect(installed(fixture, NEWEST)).toBe(false);
  });

  it("240: an nvm alias jup cannot resolve is refused, before any request", async () => {
    for (const alias of ["lts/*", "lts/jod", "system", "iojs", "default"]) {
      const fixture = createFixture({ name: "app" });
      fixture.write(".nvmrc", `${alias}\n`);
      registry.reset();

      const result = await run(["node", "-e", "0"], options(fixture));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(messages.versionFileUnsupported(alias, ".nvmrc"));
      // `lts/*` is the one people miss, and it is not an oversight: the `node`
      // launcher publishes `latest` and `v4-lts` … `v20-lts` and the LTS series
      // tags stop there, so there is nothing to resolve it against. The message
      // names `devEngines.runtime`, which can say what the alias meant.
      expect(result.stderr).toContain("devEngines.runtime");
      expect(registry.requests).toHaveLength(0);
    }
  });

  it("240b: the two `newest` aliases do resolve, to the `latest` dist-tag", async () => {
    for (const alias of ["node", "stable"]) {
      const fixture = createFixture({ name: "app" });
      fixture.write(".nvmrc", `${alias}\n`);

      const result = await run(["node", "-e", "0"], options(fixture));
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(installed(fixture, NEWEST)).toBe(true);
    }
  });

  it("241: a file that does not carry exactly one version is invalid, not ignored", async () => {
    const cases = [
      // Two bare lines: the ambiguity nvm refuses too.
      `${PINNED}\n${NEWEST}\n`,
      // Nothing but comments and settings — written to be obeyed, and silent.
      "# just a note\nsome-nvm-setting=on\n",
      "",
    ];

    for (const content of cases) {
      const fixture = createFixture({ name: "app" });
      fixture.write(".nvmrc", content);
      registry.reset();

      const result = await run(["node", "-e", "0"], options(fixture));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(messages.versionFileInvalid(".nvmrc"));
      // Falling back to the compiled-in default would run a version the project
      // did not ask for, which is the one outcome worse than an error.
      expect(registry.requests).toHaveLength(0);
    }
  });

  it("242: an `.nvmrc` with no `package.json` anywhere still speaks", async () => {
    const fixture = createFixture();
    fixture.write(".nvmrc", `${PINNED}\n`);

    const result = await run(["node", "-e", "0"], options(fixture));
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(installed(fixture, PINNED)).toBe(true);

    // §03.6's auto-pin fires on `NoSpec`, and this is a `Found`: a version file
    // is a declaration, so there is nothing to pin and no manifest is invented.
    expect(fixture.exists("package.json")).toBe(false);
  });

  it("243: not read where the project is disabled, nor on the walk that writes", async () => {
    const fixture = createFixture({ name: "app" });
    fixture.write(".nvmrc", "lts/*\n");

    // §11.1 — "never look at the project at all" covers the version file too, so
    // the escape hatch users reach for *because* a file is wrong still works.
    const disabled = await run(
      ["node", "-e", "0"],
      options(fixture, { COREPACK_ENABLE_PROJECT_SPEC: "0" }),
    );
    expect(disabled.exitCode).toBe(0);
    expect(disabled.stderr).toBe("");

    // §15.27's mutating walk never looks for one: the file a write targets is
    // always the manifest, so an unreadable `.nvmrc` cannot block the command
    // that would replace it.
    const used = await run(["use", `node@${PINNED}`], options(fixture));
    expect(used.exitCode).toBe(0);
    expect(fixture.json("package.json")).toMatchObject({
      devEngines: { runtime: { name: "node", version: PINNED } },
    });
    // And the file is left exactly as it was — jup reads it and never writes it.
    expect(fixture.read(".nvmrc")).toBe("lts/*\n");
  });

  it("the table is where the file name lives", () => {
    const source = readFileSync(new URL("../../src/project/manifest.ts", import.meta.url), "utf8");
    // §15.21 — adding a second version file must be a data-only change, which it
    // is only while §03's walk does not know what it is looking for.
    expect(source).not.toContain(".nvmrc");
  });
});
