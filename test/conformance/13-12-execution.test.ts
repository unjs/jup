/**
 * §13.12 — execution (rows 132–141).
 *
 * §08.4's exit-code contract is three-way and easy to collapse: a synchronous
 * `exitCode = 42` exits 42; setting 42 and then throwing exits **1**; setting 42
 * only in a `beforeExit` hook exits 42. All three are asserted through the real
 * entry point, because none of them is observable in-process.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  createFixture,
  MockRegistry,
  npmTarball,
  run,
  seedPackageManager,
} from "./_harness/index.ts";

const registry = new MockRegistry();

/** Row 140 needs a real terminal; there is no pty available to a zero-dep suite. */
const HAS_TTY = process.stdout.isTTY === true;

beforeAll(async () => {
  await registry.start();
  registry.publish(
    "evilpm",
    "1.0.0",
    npmTarball({
      "package.json": `{"name":"evilpm","version":"1.0.0","bin":{"evilpm":"../../../evil.js"}}`,
      "index.js": "",
    }),
  );
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§13.12 execution", () => {
  it("132: a synchronously set exit code 42 is the tool's exit code", async () => {
    const fixture = createFixture({ packageManager: "yarn@1.22.4" });
    seedPackageManager(fixture.home, "yarn", "1.22.4", {
      script: `process.exitCode = 42;\n`,
    });

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(42);
  });

  it("133: exit code 42 followed by an uncaught error exits 1", async () => {
    const fixture = createFixture({ packageManager: "yarn@1.22.4" });
    seedPackageManager(fixture.home, "yarn", "1.22.4", {
      script: `process.exitCode = 42;\nthrow new Error("the package manager blew up");\n`,
    });

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("the package manager blew up");
  });

  it("134: an exit code set only in a beforeExit hook survives", async () => {
    const fixture = createFixture({ packageManager: "yarn@1.22.4" });
    seedPackageManager(fixture.home, "yarn", "1.22.4", {
      script: `process.on("beforeExit", () => { process.exitCode = 42; });\n`,
    });

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(42);
  });

  /**
   * The same case as 134, in the form that actually catches the bug 134 misses.
   *
   * A hook that sets the code *unconditionally* survives an entry point which
   * has already written `0`, because the hook runs last. A hook that first asks
   * whether anyone has claimed an exit code does not: it sees the `0` and
   * declines. So this is the row that pins "a plain success leaves
   * `process.exitCode` undefined" — the in-process handover answers `0` to mean
   * "handed over", and no entry point may assign that.
   */
  it("134b: a beforeExit hook guarding on an unset exit code still sets one", async () => {
    const fixture = createFixture({ packageManager: "yarn@1.22.4" });
    seedPackageManager(fixture.home, "yarn", "1.22.4", {
      script: `process.once("beforeExit", () => { if (process.exitCode === undefined) process.exitCode = 42; });\n`,
    });

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(42);
  });

  it("135: an ESM entry point runs", async () => {
    const fixture = createFixture({ packageManager: "yarn@1.22.4" });
    seedPackageManager(fixture.home, "yarn", "1.22.4", {
      esm: true,
      script: `import { basename } from "node:path";\nprocess.stdout.write("esm " + basename(import.meta.filename) + "\\n");\n`,
    });

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("esm yarn.js\n");
    expect(result.stderr).toBe("");
  });

  it("136: a bin declared as a list runs the same file under every name", async () => {
    const fixture = createFixture({ packageManager: "yarn@2.2.2" });
    seedPackageManager(fixture.home, "yarn", "2.2.2", {
      script: `process.stdout.write(process.argv[1] + "\\n");\n`,
    });

    const asYarn = await run(["yarn", "--version"], fixture);
    const asYarnpkg = await run(["yarnpkg", "--version"], fixture);

    expect(asYarn.exitCode).toBe(0);
    expect(asYarnpkg.exitCode).toBe(0);
    expect(asYarn.stdout).toContain("yarn.js");
    expect(asYarnpkg.stdout).toBe(asYarn.stdout);
  });

  // The row names "a real classic yarn"; what it actually pins down is that the
  // wrapper contributes nothing, so the stand-in's only job is to print a version.
  it("137: yarn --version prints exactly 1.22.4 and nothing else", async () => {
    const fixture = createFixture({ packageManager: "yarn@1.22.4" });
    seedPackageManager(fixture.home, "yarn", "1.22.4", {
      script: `process.stdout.write("1.22.4\\n");\n`,
    });

    const result = await run(["yarn", "--version"], fixture);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("1.22.4\n");
    expect(result.stderr).toBe("");
  });

  it("138: a package manager killed by SIGINT takes the process with it (§08.5)", async () => {
    const fixture = createFixture({ packageManager: "yarn@1.22.4" });
    seedPackageManager(fixture.home, "yarn", "1.22.4", {
      script: `process.kill(process.pid, "SIGINT");\nsetTimeout(() => {}, 1000);\n`,
    });

    const result = await run(["yarn", "install"], fixture);

    // Death by signal, not a plain exit code: the handover is in-process, so the
    // package manager's death *is* the tool's death.
    expect(result.signal).toBe("SIGINT");
    expect(result.exitCode).toBeNull();
  });

  it("139: stdin passes through to the package manager intact", async () => {
    const fixture = createFixture({ packageManager: "npm@6.14.2" });
    seedPackageManager(fixture.home, "npm", "6.14.2", {
      script: [
        `let data = "";`,
        `process.stdin.setEncoding("utf8");`,
        `process.stdin.on("data", (chunk) => { data += chunk; });`,
        `process.stdin.on("end", () => { process.stdout.write("STDIN:" + data); });`,
        ``,
      ].join("\n"),
    });

    const result = await run(["npm", "read"], { ...fixture, input: "hello stdin\n" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("STDIN:hello stdin\n");
  });

  it.skipIf(!HAS_TTY)("140: TTY detection still succeeds inside the package manager", async () => {
    // Needs a real terminal on the other end of stdio; there is no pty binding in
    // a zero-dependency suite, so this row only runs in an interactive session.
    const fixture = createFixture({ packageManager: "yarn@1.22.4" });
    const report = fixture.path("tty.txt");
    seedPackageManager(fixture.home, "yarn", "1.22.4", {
      script: `require("node:fs").writeFileSync(${JSON.stringify(report)}, String(process.stdout.isTTY));\n`,
    });

    const result = await run(["yarn", "install"], { ...fixture, inheritStdio: true });

    expect(result.exitCode).toBe(0);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(report, "utf8")).toBe("true");
  });

  it("141: a downloaded bin path escaping the install directory is refused (§14.13)", async () => {
    const fixture = createFixture({});
    const url = `${registry.origin}/evilpm/-/evilpm-1.0.0.tgz`;

    const result = await run([`evilpm@${url}`, "--version"], {
      ...fixture,
      registry,
      // §15.11 redirected this row: a bare custom URL now clears no
      // verification tier, and the refusal would come *before* the download —
      // leaving §14.13's containment check untested while the row still went
      // red for the right exit code and the wrong reason. The opt-out is what
      // keeps this row about the bin path.
      env: { COREPACK_ENABLE_UNSAFE_CUSTOM_URLS: "1", COREPACK_ALLOW_UNVERIFIED: "1" },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("escapes its installation directory");
    expect(result.stderr).toContain("../../../evil.js");
  });
});
