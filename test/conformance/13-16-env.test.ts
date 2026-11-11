/**
 * §09.18 — `jup env`, the shell integration for the runtimes (issue #11).
 *
 * These rows pin the bytes for each dialect, the strip that makes the line
 * idempotent, the strip-only degradation for a pin that is not installed or
 * cannot be resolved, and the agreement with the shim that justifies the whole
 * feature: the `node` the line puts on `PATH` is the `node` `jup node` runs.
 */

import { delimiter, join } from "node:path";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import {
  BIN,
  cleanupFixtures,
  createFixture,
  run,
  seedPackageManager,
  type Fixture,
} from "./_harness/index.ts";

afterAll(cleanupFixtures);

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

function env(fixture: Fixture, args: string[], vars: Record<string, string | undefined> = {}) {
  return run(["env", ...args], {
    cwd: fixture.cwd,
    home: fixture.home,
    env: { PATH: "/usr/bin", ...vars },
  });
}

describe("jup env", () => {
  it("prepends the resolved runtime's bin directory", async () => {
    const { fixture, binDir } = pinned();

    const result = await env(fixture, ["--shell", "zsh"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`export PATH='${binDir}:/usr/bin'\n`);
  });

  it("renders each dialect in its own shape", async () => {
    const { fixture, binDir } = pinned();
    const PATH = ["/usr/bin", "/bin"].join(delimiter);

    const fish = await env(fixture, ["--shell", "fish"], { PATH });
    const powershell = await env(fixture, ["--shell", "powershell"], { PATH });

    expect(fish.stdout).toBe(`set -gx PATH '${binDir}' '/usr/bin' '/bin'\n`);
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

    const result = await env(fixture, ["--shell", "bash"], {
      PATH: [older, binDir, "/usr/bin"].join(delimiter),
    });

    expect(result.stdout).toBe(`export PATH='${binDir}:/usr/bin'\n`);
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
    expect(result.stdout).toBe(`export PATH='${binDir}:/usr/bin'\n`);
  });

  it("prints the strip alone for a pin that is not installed", async () => {
    const fixture = createFixture();
    fixture.write(".nvmrc", "22.11.0\n");

    const result = await env(fixture, ["--shell", "zsh"]);

    // Exit 0 and stderr empty: an uninstalled pin is the shims' business, and
    // this command must be safe to evaluate from a shell hook.
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`export PATH='/usr/bin'\n`);
  });

  it("prints the strip alone when resolution fails, without the network", async () => {
    // Network left on: the line must not ask the registry, so a range the
    // store cannot answer fails at once rather than after a timeout.
    const result = await env(unresolvable(), ["--shell", "zsh"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`export PATH='/usr/bin'\n`);
  });

  it("prints nothing at all when there is nothing to say", async () => {
    const result = await env(unresolvable(), ["--shell", "zsh"], { PATH: "" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("puts the same node on PATH that the shim runs", async () => {
    const { fixture, binDir } = pinned();

    const shim = await run(["node", "--version"], {
      cwd: fixture.cwd,
      home: fixture.home,
      env: { PATH: "/usr/bin" },
    });
    const line = await env(fixture, ["--shell", "zsh"]);

    expect(shim.stdout).toBe("24.21.0\n");
    expect(line.stdout).toBe(`export PATH='${binDir}:/usr/bin'\n`);
  });

  it.each([
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
    const result = await env(createFixture(), [], { SHELL: undefined });

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
  if ($global:__JUP_PWD -ne $PWD.Path) {
    $global:__JUP_PWD = $PWD.Path
    & ${sh} env --shell powershell 2>$null | Out-String | Invoke-Expression
  }
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
    const result = await env(unresolvable(), ["--shell", "zsh", "--use-on-cd"], { PATH: "" });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("export PATH=");
    expect(result.stdout).toContain("add-zsh-hook chpwd _jup_env");
  });
});
