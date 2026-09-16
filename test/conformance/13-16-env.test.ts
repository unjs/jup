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
import { symlinkSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupFixtures, createFixture, run, seedPackageManager } from "./_harness/index.ts";

afterAll(cleanupFixtures);

const POSIX = process.platform !== "win32";

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

  // POSIX only: the row's home is reached through a symlink, which Windows
  // cannot create without a privilege the suite must not assume.
  describe.skipIf(!POSIX)("behind a symlinked home", () => {
    it("strips entries spelled through the link", async () => {
      const fixture = createFixture();
      // A home behind a link is spelled differently from its realpath, which
      // is how `$TMPDIR` on macOS and an `XDG_CACHE_HOME` behind a link both
      // spell it. The strip owns both spellings (§09.18) — or the entry a
      // previous line added would survive every later one.
      const linked = join(fixture.root, "linked");
      symlinkSync(fixture.home, linked);
      fixture.write(".nvmrc", "24.21.0\n");
      seedPackageManager(fixture.home, "node", "24.21.0");
      seedPackageManager(fixture.home, "node", "24.20.0");
      const binDir = join(linked, "v1", "node", "24.21.0", "bin");
      const stale = join(linked, "v1", "node", "24.20.0", "bin");

      const result = await run(["env", "--shell", "zsh"], {
        cwd: fixture.cwd,
        home: linked,
        env: { PATH: [stale, "/usr/bin"].join(delimiter) },
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(`export PATH='${binDir}:/usr/bin'\n`);
    });
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
        `$ jup env [--shell <bash|zsh|fish|powershell>] [--json] [--use-on-cd]\n`,
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
    expect(result.stdout).toContain(
      "$ jup env [--shell <bash|zsh|fish|powershell>] [--json] [--use-on-cd]",
    );
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

describe("jup env --json", () => {
  it("prints the resolution as one JSON document", async () => {
    const { fixture, binDir } = pinned();

    const result = await run(["env", "--json"], {
      cwd: fixture.cwd,
      home: fixture.home,
      env: { PATH: "/usr/bin", SHELL: undefined },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `${JSON.stringify({
        version: 1,
        runtimes: [{ name: "node", reference: "24.21.0", binDir, installed: true }],
      })}\n`,
    );
  });

  it("reports a failed resolution instead of failing the run", async () => {
    const fixture = createFixture({
      devEngines: { runtime: { name: "node", version: "^99.0.0" } },
    });

    const result = await run(["env", "--json"], {
      cwd: fixture.cwd,
      home: fixture.home,
      env: { COREPACK_ENABLE_NETWORK: "0" },
    });

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as {
      runtimes: Array<{ reference: string | null; error?: string }>;
    };
    expect(report.runtimes).toHaveLength(1);
    expect(report.runtimes[0]!.reference).toBeNull();
    expect(typeof report.runtimes[0]!.error).toBe("string");
  });

  it("refuses --json together with --shell", async () => {
    const fixture = createFixture();

    const result = await run(["env", "--json", "--shell", "zsh"], {
      cwd: fixture.cwd,
      home: fixture.home,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `Usage Error: The 'jup env' command cannot take --json and --shell together\n\n` +
        `$ jup env [--shell <bash|zsh|fish|powershell>] [--json] [--use-on-cd]\n`,
    );
  });
});

describe("jup env --use-on-cd", () => {
  it("appends the zsh registration after the line", async () => {
    const { fixture, binDir } = pinned();

    const result = await run(["env", "--shell", "zsh", "--use-on-cd"], {
      cwd: fixture.cwd,
      home: fixture.home,
      env: { PATH: "/usr/bin" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      [
        `export PATH='${binDir}:/usr/bin'`,
        "_jup_env() {",
        `  eval "$(jup env --shell zsh 2>/dev/null)"`,
        "}",
        "autoload -Uz add-zsh-hook",
        "add-zsh-hook -D chpwd _jup_env",
        "add-zsh-hook chpwd _jup_env",
        "",
      ].join("\n"),
    );
  });

  it("registers through PROMPT_COMMAND on bash, absent-only", async () => {
    const { fixture } = pinned();

    const result = await run(["env", "--shell", "bash", "--use-on-cd"], {
      cwd: fixture.cwd,
      home: fixture.home,
      env: { PATH: "/usr/bin" },
    });

    expect(result.stdout).toContain(
      [
        "_jup_env() {",
        `  eval "$(jup env --shell bash 2>/dev/null)"`,
        "}",
        'case ";${PROMPT_COMMAND:-};" in',
        '*";_jup_env;"*) ;;',
        '*) PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND;}_jup_env" ;;',
        "esac",
      ].join("\n"),
    );
  });

  it("hooks fish's PWD variable and powershell's prompt", async () => {
    const { fixture } = pinned();

    const fish = await run(["env", "--shell", "fish", "--use-on-cd"], {
      cwd: fixture.cwd,
      home: fixture.home,
      env: { PATH: "/usr/bin" },
    });
    const powershell = await run(["env", "--shell", "powershell", "--use-on-cd"], {
      cwd: fixture.cwd,
      home: fixture.home,
      env: { PATH: "/usr/bin" },
    });

    expect(fish.stdout).toContain(
      [
        "function _jup_env --on-variable PWD",
        "  jup env --shell fish 2>/dev/null | source",
        "end",
      ].join("\n"),
    );
    expect(powershell.stdout).toContain(
      [
        "if ($null -eq $global:__JUP_ORIG_PROMPT) {",
        "  $global:__JUP_ORIG_PROMPT = $function:prompt",
        "}",
        "function global:prompt {",
        "  if ($global:__JUP_PWD -ne $PWD.Path) {",
        "    $global:__JUP_PWD = $PWD.Path",
        "    jup env --shell powershell 2>$null | Out-String | Invoke-Expression",
        "  }",
        "  & $global:__JUP_ORIG_PROMPT",
        "}",
      ].join("\n"),
    );
  });

  it("registers the hook even when there is no line to print", async () => {
    const fixture = createFixture({
      devEngines: { runtime: { name: "node", version: "^99.0.0" } },
    });

    const result = await run(["env", "--shell", "zsh", "--use-on-cd"], {
      cwd: fixture.cwd,
      home: fixture.home,
      env: { PATH: "", COREPACK_ENABLE_NETWORK: "0" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("export PATH=");
    expect(result.stdout).toContain("add-zsh-hook chpwd _jup_env");
  });

  it("evaluates the base command, never itself", async () => {
    const { fixture } = pinned();

    const result = await run(["env", "--shell", "zsh", "--use-on-cd"], {
      cwd: fixture.cwd,
      home: fixture.home,
      env: { PATH: "/usr/bin" },
    });

    // The hook body must call the flag-free command: a hook that re-evaluated
    // its own registration would recurse, and one that re-resolved twice would
    // double the startup cost. The flag never appears in any output byte.
    expect(result.stdout).toContain(`eval "$(jup env --shell zsh 2>/dev/null)"`);
    expect(result.stdout).not.toContain("--use-on-cd");
  });

  it("refuses --json together with --use-on-cd", async () => {
    const fixture = createFixture();

    const result = await run(["env", "--json", "--use-on-cd"], {
      cwd: fixture.cwd,
      home: fixture.home,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `Usage Error: The 'jup env' command cannot take --json and --use-on-cd together\n\n` +
        `$ jup env [--shell <bash|zsh|fish|powershell>] [--json] [--use-on-cd]\n`,
    );
  });
});
