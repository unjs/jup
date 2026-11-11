/**
 * §09.18 — `jup env`, the shell integration for the runtimes (issue #11).
 *
 * These rows pin the bytes for each dialect, the strip that makes the line
 * idempotent, the strip-only degradation for a pin that is not installed or
 * cannot be resolved, and the agreement with the shim that justifies the whole
 * feature: the `node` the line puts on `PATH` is the `node` `jup node` runs.
 */

import { delimiter, join } from "node:path";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  BIN,
  cleanupFixtures,
  createFixture,
  MockRegistry,
  run,
  seedPackageManager,
  type Fixture,
} from "./_harness/index.ts";

const registry = new MockRegistry();
beforeAll(() => registry.start());
beforeEach(() => registry.reset());
afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

const POSIX = process.platform !== "win32";
const USAGE = `$ jup env [--shell <bash|zsh|fish|powershell>] [--json] [--use-on-cd]\n`;

/** A fixture whose `.nvmrc` names a seeded node, plus the seeded bin dir. */
function pinned() {
  const fixture = createFixture();
  fixture.write(".nvmrc", "24.21.0\n");
  const location = seedPackageManager(fixture.home, "node", "24.21.0");
  return { fixture, binDir: join(location, "bin") };
}

/** A fixture whose runtime range nothing satisfies. */
function unresolvable() {
  return createFixture({ devEngines: { runtime: { name: "node", version: "^99.0.0" } } });
}

/**
 * Every row runs against the mock registry, so a request the line was not
 * supposed to make is recorded rather than sent to the internet.
 */
function env(fixture: Fixture, args: string[], vars: Record<string, string | undefined> = {}) {
  return run(["env", ...args], {
    cwd: fixture.cwd,
    home: fixture.home,
    registry,
    env: { PATH: "/usr/bin", ...vars },
  });
}

/** The dialect this host runs: Windows has only PowerShell (§09.18). */
const HOST = POSIX ? "zsh" : "powershell";

/** The line {@link HOST} prints for these entries. */
function line(entries: string[]): string {
  const value = entries.join(delimiter);
  return POSIX ? `export PATH='${value}'\n` : `$env:PATH = '${value}'\n`;
}

/**
 * No project, a seeded node, and that node recorded as the §04.6 default —
 * stamped `age` ms ago, or unstamped, which reads as due for its re-check.
 */
function defaulted(age?: number) {
  const fixture = createFixture();
  const location = seedPackageManager(fixture.home, "node", "24.21.0");
  const stamps = age === undefined ? {} : { "#stamps": { node: Date.now() - age } };
  writeFileSync(
    join(fixture.home, "lastKnownGood.json"),
    JSON.stringify({ node: "24.21.0", ...stamps }),
  );
  return { fixture, binDir: join(location, "bin") };
}

describe("jup env", () => {
  it("prepends the resolved runtime's bin directory", async () => {
    const { fixture, binDir } = pinned();

    const result = await env(fixture, ["--shell", HOST]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(line([binDir, "/usr/bin"]));
  });

  it.skipIf(!POSIX)("renders each dialect in its own shape", async () => {
    const { fixture, binDir } = pinned();
    const PATH = ["/usr/bin", "/bin"].join(delimiter);

    const fish = await env(fixture, ["--shell", "fish"], { PATH });
    const powershell = await env(fixture, ["--shell", "powershell"], { PATH });

    // fish doubles a backslash, which a temp directory may well contain.
    const fishBin = binDir.replaceAll("\\", "\\\\");
    expect(fish.stdout).toBe(`set -gx PATH '${fishBin}' '/usr/bin' '/bin'\n`);
    expect(powershell.stdout).toBe(
      `$env:PATH = '${[binDir, "/usr/bin", "/bin"].join(delimiter)}'\n`,
    );
  });

  it.skipIf(!POSIX)("quotes each dialect's own escapes", async () => {
    const fixture = createFixture();
    const PATH = ["/opt/a\\b", "/opt/O’Brien's", "/opt/x\\"].join(delimiter);

    const fish = await env(fixture, ["--shell", "fish"], { PATH });
    const powershell = await env(fixture, ["--shell", "powershell"], { PATH });

    expect(fish.stdout).toBe(`set -gx PATH '/opt/a\\\\b' '/opt/O’Brien\\'s' '/opt/x\\\\'\n`);
    expect(powershell.stdout).toBe(`$env:PATH = '/opt/a\\b:/opt/O’’Brien''s:/opt/x\\'\n`);
  });

  it("drops a store entry a previous line added, so it is idempotent", async () => {
    const { fixture, binDir } = pinned();
    const older = join(seedPackageManager(fixture.home, "node", "24.20.0"), "bin");

    const result = await env(fixture, ["--shell", HOST], {
      PATH: [older, binDir, "/usr/bin"].join(delimiter),
    });

    expect(result.stdout).toBe(line([binDir, "/usr/bin"]));
  });

  // Windows spells the variable `Path`; reading it as `PATH` from a plain copy
  // of the environment would find nothing and replace the whole value.
  it.runIf(!POSIX)("reads PATH whatever case Windows spells it in", async () => {
    const { fixture, binDir } = pinned();

    const result = await env(fixture, ["--shell", "powershell"], { Path: "C:\\Windows" });

    expect(result.stdout).toBe(`$env:PATH = '${binDir};C:\\Windows'\n`);
  });

  // Git Bash and Cygwin set `SHELL` on Windows but cannot read a `;`-joined
  // `C:\` value: refusing is what keeps a startup file from emptying `PATH`.
  it.runIf(!POSIX).each([
    [["--shell", "bash"], {}, "bash"],
    [[], { SHELL: "/usr/bin/bash" }, "bash"],
  ])("refuses POSIX dialects on Windows: %j %j", async (args, vars, name) => {
    const result = await env(createFixture(), args, vars);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe(
      `Usage Error: Unsupported shell "${name}" on Windows; jup env supports powershell there\n\n${USAGE}`,
    );
  });

  it.runIf(!POSIX)("infers PowerShell from PSModulePath on Windows", async () => {
    const { fixture, binDir } = pinned();

    const result = await env(fixture, [], { SHELL: undefined, PSModulePath: "C:\\Modules" });

    expect(result.stdout).toBe(line([binDir, "/usr/bin"]));
  });

  it.skipIf(!POSIX)("keeps relative and empty entries, even inside the store", async () => {
    const fixture = createFixture();
    const inside = join(fixture.home, "v1", "node");
    mkdirSync(inside, { recursive: true });

    // Standing inside the install folder, `.` resolves into it — but a
    // relative entry means something else in every directory and is not ours.
    const result = await run(["env", "--shell", "bash"], {
      cwd: inside,
      home: fixture.home,
      env: { PATH: ["node_modules/.bin", ".", "", "/usr/bin"].join(delimiter) },
    });

    expect(result.stdout).toBe(`export PATH='node_modules/.bin:.::/usr/bin'\n`);
  });

  // POSIX only: the row's home is reached through a symlink, which Windows
  // cannot create without a privilege the suite must not assume.
  it.skipIf(!POSIX)("strips entries spelled through a symlinked home", async () => {
    const fixture = createFixture();
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
    expect(result.stdout).toBe(`export PATH='${[binDir, "/usr/bin"].join(delimiter)}'\n`);
  });

  it("prints the strip alone for a pin that is not installed", async () => {
    const fixture = createFixture();
    fixture.write(".nvmrc", "22.11.0\n");

    const result = await env(fixture, ["--shell", HOST]);

    // Exit 0 and stderr empty: an uninstalled pin is the shims' business, and
    // this command must be safe to evaluate from a shell hook.
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(line(["/usr/bin"]));
  });

  it("prints nothing at all when there is nothing to say", async () => {
    const result = await env(unresolvable(), ["--shell", HOST], { PATH: "" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  // POSIX only: the seeded `node.exe` is a script, not a runnable executable.
  it.skipIf(!POSIX)("puts the same node on PATH that the shim runs", async () => {
    const { fixture, binDir } = pinned();

    const shim = await run(["node", "--version"], {
      cwd: fixture.cwd,
      home: fixture.home,
      env: { PATH: "/usr/bin" },
    });
    const printed = await env(fixture, ["--shell", HOST]);

    expect(shim.stdout).toBe("24.21.0\n");
    expect(printed.stdout).toBe(line([binDir, "/usr/bin"]));
  });

  it.skipIf(!POSIX).each([
    ["/usr/local/bin/fish", "fish"],
    ["-zsh", "zsh"],
    ["/bin/dash", "bash"],
  ])("infers the dialect from SHELL=%s", async (SHELL, dialect) => {
    const { fixture } = pinned();

    const inferred = await env(fixture, [], { SHELL });
    const named = await env(fixture, ["--shell", dialect]);

    expect(inferred.stdout).toBe(named.stdout);
  });

  it.each([
    [["--shell", "csh"], {}, "csh"],
    [[], { SHELL: "/bin/tcsh" }, "tcsh"],
  ])("refuses a shell it does not speak: %j %j", async (args, vars, name) => {
    const result = await env(createFixture(), args, vars);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `Usage Error: Unsupported shell "${name}"; jup env supports bash, zsh, fish and powershell\n\n${USAGE}`,
    );
  });

  it("asks for --shell when SHELL names nothing", async () => {
    // `PSModulePath` too: on Windows it is what names PowerShell.
    const result = await env(createFixture(), [], { SHELL: undefined, PSModulePath: undefined });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe(
      `Usage Error: jup env cannot tell which shell to target; pass --shell (bash, zsh, fish or powershell)\n\n${USAGE}`,
    );
  });

  it("takes no positional arguments", async () => {
    const result = await env(createFixture(), ["zsh"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe(`Usage Error: The 'jup env' command takes no arguments\n\n${USAGE}`);
  });
});

// §09.18 — the line runs from a hook on every directory change, so it never
// waits on a registry. `--json` is the control: same fixture, and it does ask.
describe("jup env and the network", () => {
  it("answers a range the store cannot without asking the registry", async () => {
    const fixture = unresolvable();

    const result = await env(fixture, ["--shell", HOST]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(line(["/usr/bin"]));
    expect(registry.requests).toEqual([]);

    await env(fixture, ["--json"]);
    expect(registry.requests.length).toBeGreaterThan(0);
  });

  it("leaves a default due for its re-check to the shims", async () => {
    const { fixture } = defaulted();

    // Online, the shim would refresh the default, so the line cannot vouch for it.
    const result = await env(fixture, ["--shell", HOST], { COREPACK_DEFAULT_TO_LATEST: "1" });
    expect(result.stdout).toBe(line(["/usr/bin"]));
    expect(registry.requests).toEqual([]);
  });

  it.each([
    ["fresh", { COREPACK_DEFAULT_TO_LATEST: "1" }, 60_000],
    ["offline", { COREPACK_DEFAULT_TO_LATEST: "1", COREPACK_ENABLE_NETWORK: "0" }, undefined],
  ] as const)("accelerates a recorded default the shim agrees with: %s", async (_, vars, age) => {
    const { fixture, binDir } = defaulted(age);

    const result = await env(fixture, ["--shell", HOST], vars);
    expect(result.stdout).toBe(line([binDir, "/usr/bin"]));
    expect(registry.requests).toEqual([]);
  });
});

describe("jup env --json", () => {
  it("prints the resolution as one JSON document", async () => {
    const { fixture, binDir } = pinned();

    const result = await env(fixture, ["--json"], { SHELL: undefined });

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
    const result = await env(unresolvable(), ["--json"], { COREPACK_ENABLE_NETWORK: "0" });

    expect(result.exitCode).toBe(0);
    const report = JSON.parse(result.stdout) as {
      runtimes: Array<{ reference: string | null; error?: string }>;
    };
    expect(report.runtimes).toHaveLength(1);
    expect(report.runtimes[0]!.reference).toBeNull();
    expect(typeof report.runtimes[0]!.error).toBe("string");
  });

  it.each(["--shell", "--use-on-cd"])("refuses --json together with %s", async (flag) => {
    const args = flag === "--shell" ? ["--json", flag, "zsh"] : ["--json", flag];

    const result = await env(createFixture(), args);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `Usage Error: The 'jup env' command cannot take --json and ${flag} together\n\n${USAGE}`,
    );
  });
});

describe("jup env --use-on-cd", () => {
  // The hook names this jup by absolute path — the host runtime and the entry —
  // so it never starts under a `node` the line itself put on `PATH`.
  const self = [realpathSync(process.execPath), realpathSync(BIN)];
  const sh = self.map((word) => `'${word}'`).join(" ");

  const hooks: Record<string, string> = {
    zsh: `_jup_env() {
  eval "$(${sh} env --shell zsh 2>/dev/null)"
}
autoload -Uz add-zsh-hook
add-zsh-hook -D chpwd _jup_env
add-zsh-hook chpwd _jup_env
`,
    bash: `_jup_env() {
  [[ $PWD == "\${_JUP_ENV_PWD-}" ]] && return
  _JUP_ENV_PWD=$PWD
  eval "$(${sh} env --shell bash 2>/dev/null)"
}
_JUP_ENV_PWD=$PWD
case \${PROMPT_COMMAND-} in
*_jup_env*) ;;
*) PROMPT_COMMAND="\${PROMPT_COMMAND:+$PROMPT_COMMAND
}_jup_env" ;;
esac
`,
    fish: `function _jup_env --on-variable PWD
  ${sh} env --shell fish 2>/dev/null | source
end
`,
    powershell: `if ($null -eq $global:__JUP_ORIG_PROMPT) {
  $global:__JUP_ORIG_PROMPT = $function:prompt
}
$global:__JUP_PWD = $PWD.Path
function global:prompt {
  $ok = $?
  $code = $global:LASTEXITCODE
  if ($global:__JUP_PWD -ne $PWD.Path) {
    $global:__JUP_PWD = $PWD.Path
    try { $line = & ${sh} env --shell powershell 2>$null | Out-String } catch { $line = $null }
    if ($line) { Invoke-Expression $line }
    $global:LASTEXITCODE = $code
  }
  if (-not $ok) { Write-Error '' -ErrorAction Ignore }
  & $global:__JUP_ORIG_PROMPT
}
`,
  };

  it.skipIf(!POSIX).each(Object.keys(hooks))("appends the %s registration", async (dialect) => {
    const { fixture } = pinned();

    const line = await env(fixture, ["--shell", dialect]);
    const result = await env(fixture, ["--shell", dialect, "--use-on-cd"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    // The hook calls the flag-free command, so it never re-registers itself.
    expect(result.stdout).toBe(line.stdout + hooks[dialect]);
  });

  it("registers the hook even when there is no line to print", async () => {
    const result = await env(unresolvable(), ["--shell", HOST, "--use-on-cd"], { PATH: "" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("PATH");
    expect(result.stdout).toContain(
      POSIX ? "add-zsh-hook chpwd _jup_env" : "function global:prompt",
    );
  });
});
