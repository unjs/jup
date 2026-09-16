/**
 * §09.18 — `jup env`, the shell integration for the runtimes (issue #11).
 *
 * The command's contract is one line for `eval`: a complete `PATH` assignment
 * computed from the `PATH` the invocation inherited, with every store entry
 * dropped and the resolved runtime `bin` directories in front. These rows pin
 * the bytes for each dialect, the strip that makes the line idempotent, the
 * strip-only degradation for a pin that is not installed or cannot be
 * resolved, and the agreement with the shim that justifies the whole feature:
 * the `node` the line puts on `PATH` is the `node` `jup node` runs.
 */

import { delimiter, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, createFixture, run, seedPackageManager } from "./_harness/index.ts";

afterAll(cleanupFixtures);

/** A fixture whose `.nvmrc` names a seeded node, plus the seeded bin dir. */
function pinned(seeded = "24.21.0", pin = seeded) {
  const fixture = createFixture();
  fixture.write(".nvmrc", `${pin}\n`);
  const location = seedPackageManager(fixture.home, "node", seeded);
  return { fixture, binDir: join(location, "bin") };
}

describe("jup env", () => {
  it("prepends the resolved runtime's bin directory", async () => {
    const { fixture, binDir } = pinned();

    const result = await run(["env", "--shell", "zsh"], {
      cwd: fixture.cwd,
      home: fixture.home,
      env: { PATH: "/usr/bin" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`export PATH='${binDir}:/usr/bin'\n`);
  });

  it("renders each dialect in its own shape", async () => {
    const { fixture, binDir } = pinned();

    const fish = await run(["env", "--shell", "fish"], {
      cwd: fixture.cwd,
      home: fixture.home,
      env: { PATH: "/usr/bin" },
    });
    const powershell = await run(["env", "--shell", "powershell"], {
      cwd: fixture.cwd,
      home: fixture.home,
      env: { PATH: ["/usr/bin", "/bin"].join(delimiter) },
    });

    expect(fish.stdout).toBe(`set -gx PATH '${binDir}' '/usr/bin'\n`);
    expect(powershell.stdout).toBe(
      `$env:PATH = '${[binDir, "/usr/bin", "/bin"].join(delimiter)}'\n`,
    );
  });

  it("drops a store entry a previous line added, so it is idempotent", async () => {
    const { fixture, binDir } = pinned();
    const older = join(seedPackageManager(fixture.home, "node", "24.20.0"), "bin");

    const result = await run(["env", "--shell", "bash"], {
      cwd: fixture.cwd,
      home: fixture.home,
      env: { PATH: [older, binDir, "/usr/bin"].join(delimiter) },
    });

    expect(result.stdout).toBe(`export PATH='${binDir}:/usr/bin'\n`);
  });

  it("prints the strip alone for a pin that is not installed", async () => {
    const fixture = createFixture();
    fixture.write(".nvmrc", "22.11.0\n");

    const result = await run(["env", "--shell", "zsh"], {
      cwd: fixture.cwd,
      home: fixture.home,
      env: { PATH: "/usr/bin" },
    });

    // Exit 0 and stderr empty: an uninstalled pin is the shims' business, and
    // this command must be safe to evaluate from a shell hook.
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`export PATH='/usr/bin'\n`);
  });

  it("prints the strip alone when resolution fails", async () => {
    const fixture = createFixture({
      devEngines: { runtime: { name: "node", version: "^99.0.0" } },
    });

    const result = await run(["env", "--shell", "zsh"], {
      cwd: fixture.cwd,
      home: fixture.home,
      env: { PATH: "/usr/bin", COREPACK_ENABLE_NETWORK: "0" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`export PATH='/usr/bin'\n`);
  });

  it("prints nothing at all when there is nothing to say", async () => {
    const fixture = createFixture({
      devEngines: { runtime: { name: "node", version: "^99.0.0" } },
    });

    const result = await run(["env", "--shell", "zsh"], {
      cwd: fixture.cwd,
      home: fixture.home,
      // An empty `PATH` with nothing to prepend would export an empty `PATH`,
      // which is not the strip — so the command stays silent instead.
      env: { PATH: "", COREPACK_ENABLE_NETWORK: "0" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("puts the same node on PATH that the shim runs", async () => {
    const { fixture, binDir } = pinned("24.21.0", "24.21.0");

    const shim = await run(["node", "--version"], {
      cwd: fixture.cwd,
      home: fixture.home,
      env: { PATH: "/usr/bin" },
    });
    const line = await run(["env", "--shell", "zsh"], {
      cwd: fixture.cwd,
      home: fixture.home,
      env: { PATH: "/usr/bin" },
    });

    expect(shim.stdout).toBe("24.21.0\n");
    expect(line.stdout).toBe(`export PATH='${binDir}:/usr/bin'\n`);
    expect(line.stdout).toContain(shim.stdout.trim());
  });

  it("infers the dialect from SHELL when --shell is absent", async () => {
    const { fixture, binDir } = pinned();

    const result = await run(["env"], {
      cwd: fixture.cwd,
      home: fixture.home,
      env: { PATH: "/usr/bin", SHELL: "/usr/local/bin/fish" },
    });

    expect(result.stdout).toBe(`set -gx PATH '${binDir}' '/usr/bin'\n`);
  });

  it("refuses a shell it does not speak", async () => {
    const fixture = createFixture();

    const result = await run(["env", "--shell", "csh"], {
      cwd: fixture.cwd,
      home: fixture.home,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `Usage Error: Unsupported shell "csh"; jup env supports bash, zsh, fish and powershell\n\n` +
        `$ jup env [--shell <bash|zsh|fish|powershell>]\n`,
    );
  });

  it("asks for --shell when SHELL names nothing", async () => {
    const fixture = createFixture();

    const result = await run(["env"], {
      cwd: fixture.cwd,
      home: fixture.home,
      env: { SHELL: undefined },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("jup env cannot tell which shell to target");
    expect(result.stdout).toContain("$ jup env [--shell <bash|zsh|fish|powershell>]");
  });

  it("takes no positional arguments", async () => {
    const fixture = createFixture();

    const result = await run(["env", "zsh"], {
      cwd: fixture.cwd,
      home: fixture.home,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("The 'jup env' command takes no arguments");
  });
});
