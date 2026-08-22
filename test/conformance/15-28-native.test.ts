/**
 * §15.28 — package managers that are not portable JavaScript (rows 193–194).
 *
 * #295 is the single most-upvoted issue in corepack's tracker (146👍, open since
 * 2023) and it is closed by architecture, not by code: *"Corepack was written
 * with assumption that package managers would be implemented in JS"*. Three
 * places carry that assumption — one URL template per version (§02.4), a `bin`
 * map of `.js` paths (§07.7), and in-process module loading (§08.2) — and §15.28
 * requires all three to admit a native artifact.
 *
 * **This suite adds no package manager.** §15.21 and §15.28 both require a
 * maintainer's agreement before an entry reaches the built-in table, and Bun's
 * maintainers reportedly asked not to be added; what is being proven here is
 * that the *architecture* no longer forecloses it. The fixture manager therefore
 * lives in a throwaway **copy** of the tool whose `table.ts` gains one entry —
 * which is also the strongest available evidence for §15.21's other requirement,
 * that adding a package manager is a **data-only** change: this file adds data
 * and nothing else, and everything below then works.
 *
 * POSIX only. The fixture artifact is a `#!/bin/sh` script, which is a perfectly
 * good native executable on a POSIX host and is nothing at all on Windows; row
 * 194 additionally asserts on `st_mode` bits Windows does not have. Rather than
 * let either fail there, the whole suite skips — the Windows equivalent needs a
 * committed `.exe` fixture, which is not worth carrying for a capability test.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  copyTool,
  createFixture,
  hashOf,
  makeTarball,
  MockRegistry,
  run,
} from "./_harness/index.ts";

const POSIX = process.platform !== "win32";

const registry = new MockRegistry();

/** The fixture package manager, and the one version of it that exists. */
const NAME = "bunny";
const VERSION = "1.0.0";

/**
 * The store-relative path of each artifact entry, and the mode the tar header
 * declares for it.
 *
 * Three entries, because one is not a test. `bin/bunny` is the executable the
 * run has to reach; `bin/bunny.data` is the negative control that keeps "the
 * extractor chmods everything" from passing as "the extractor preserved the
 * executable bit"; `bin/bunny.setuid` is §07.4 rule 6's other half, which must
 * come out executable **and** unprivileged.
 */
const ENTRIES = {
  executable: { path: "bin/bunny", mode: 0o755 },
  data: { path: "bin/bunny.data", mode: 0o644 },
  setuid: { path: "bin/bunny.setuid", mode: 0o4755 },
};

/**
 * The native artifact: a real executable with a shebang, not a JavaScript file.
 *
 * It is deliberately **not valid JavaScript** — `case "$1" in` is a syntax error
 * in any JS parser — so a run that reached §08.2's `import()` instead of §15.28's
 * direct execution could not possibly pass. That is half of row 193's "no JS
 * runtime consulted"; the other half is `--probe`, which reports `$0`.
 */
const SCRIPT = [
  `#!/bin/sh`,
  `case "$1" in`,
  `  --version) printf '%s\\n' "${VERSION}" ;;`,
  // `$0` is the executable itself under direct execution; under §08.2 the
  // process would be `node`, with the entry point demoted to `argv[1]`.
  `  --probe) printf 'argv0=%s\\nroot=%s\\nargs=%s\\n' "$0" "$COREPACK_ROOT" "$*" ;;`,
  `  --exit) exit "$2" ;;`,
  `  --raise) kill -"$2" $$ ; sleep 30 ;;`,
  // Signals the test by creating "$2", then waits to be signalled. The trap is
  // what makes the forwarding assertion meaningful: exit 33 can only happen if
  // the child actually received SIGTERM.
  `  --wait) trap 'exit 33' TERM ; : > "$2" ; n=0 ;`,
  `    while [ "$n" -lt 200 ] ; do sleep 0.1 ; n=$((n+1)) ; done ; exit 44 ;;`,
  // The same, for a SIGINT the *terminal* delivers to the whole foreground
  // process group. Nothing forwards this one: the child has to be in the group.
  `  --group) trap 'exit 55' INT ; : > "$2" ; n=0 ;`,
  `    while [ "$n" -lt 200 ] ; do sleep 0.1 ; n=$((n+1)) ; done ; exit 44 ;;`,
  `  *) printf '%s\\n' "${NAME} $*" ;;`,
  `esac`,
  ``,
].join("\n");

/** The npm layout: one leading component, stripped by §07.4. */
const TARBALL = makeTarball([
  {
    path: `package/package.json`,
    content: `${JSON.stringify({ name: NAME, version: VERSION })}\n`,
    mode: 0o644,
  },
  { path: `package/${ENTRIES.executable.path}`, content: SCRIPT, mode: ENTRIES.executable.mode },
  { path: `package/${ENTRIES.data.path}`, content: `not executable\n`, mode: ENTRIES.data.mode },
  { path: `package/${ENTRIES.setuid.path}`, content: SCRIPT, mode: ENTRIES.setuid.mode },
]);

/** §06.1 row 1 — an explicit pin is the whole verification story for this band. */
const REFERENCE = `${VERSION}+sha512.${hashOf(TARBALL)}`;

/**
 * The path the artifact is published at, with `{platform}` and `{arch}` already
 * resolved *by the test* — so a tool that resolved them differently, or not at
 * all, asks for a path that is not there.
 */
const ARTIFACT_PATH = `/native/${NAME}-${VERSION}-${process.platform}-${process.arch}.tgz`;

/**
 * The host is `registry.npmjs.org` because the harness's `--import` shim rewrites
 * exactly that host onto the mock (and only that host), which keeps the fixture
 * on `https:` and clear of §14.9's and §05.2's rewriting rules.
 *
 * A `url`-typed registry, like Yarn Berry's: it publishes no signatures, so §06.1
 * row 1's explicit hash pin is the whole verification story — which is also the
 * shape a package manager distributing its own per-platform builds would have.
 */
const REGISTRY_SPEC = {
  type: "url",
  url: "https://registry.npmjs.org/native/tags",
  fields: { tags: "aliases", versions: "tags" },
};

/** One band, parameterised only by which entry of the artifact its `bin` names. */
function band(bin: Record<string, string>): unknown {
  return [
    "*",
    {
      url: `https://registry.npmjs.org/native/${NAME}-{}-{platform}-{arch}.tgz`,
      bin,
      registry: REGISTRY_SPEC,
      exec: "native",
    },
  ];
}

/**
 * One table entry, and nothing else: `{platform}`/`{arch}` in the `url`,
 * `exec: "native"` on the band, and a `bin` map naming a file with no extension
 * at all. No code accompanies it, which is §15.21's data-only requirement.
 */
const DEFINITION = {
  default: REFERENCE,
  fetchLatestFrom: REGISTRY_SPEC,
  transparent: { commands: [] },
  ranges: [band({ [NAME]: `./${ENTRIES.executable.path}` })],
};

/**
 * A second entry, identical but for its `bin`, which names the **non-executable**
 * file in the same artifact.
 *
 * This is how the "the artifact could not be executed at all" path gets a test.
 * Without it, `execNative`'s `error` handler is unreachable from any row, and a
 * version of it that silently resolved 0 would look exactly like success.
 */
const BROKEN_DEFINITION = {
  ...DEFINITION,
  ranges: [band({ hare: `./${ENTRIES.data.path}` })],
};

let toolBin: string;

/**
 * Add one entry to a *copied* tool's embedded table.
 *
 * Deliberately a text edit against an anchor the copy must actually contain: a
 * patch that silently matched nothing would leave `bunny` unknown, and every row
 * below would then fail on "Unsupported package manager" rather than quietly
 * passing — but the explicit throw says so in one line instead of four.
 */
function patchTable(bin: string, name: string, definition: unknown): void {
  const file = join(dirname(bin), "config", "table.ts");
  const source = readFileSync(file, "utf8");
  const anchor = "export const DEFINITIONS: Record<string, PackageManagerDefinition> = {";
  if (!source.includes(anchor)) {
    throw new Error(`The table's declaration moved; this fixture patches ${file} by text`);
  }
  writeFileSync(
    file,
    source.replace(
      anchor,
      `${anchor}\n  ${name}: ${JSON.stringify(definition, undefined, 2)} as unknown as PackageManagerDefinition,\n`,
    ),
  );
}

/** `<home>/v1/<name>/<version>/<relative>` — §07.2's layout. */
function stored(home: string, relative: string): string {
  return join(home, "v1", NAME, VERSION, relative);
}

async function waitForFile(path: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

beforeAll(async () => {
  if (!POSIX) return;
  await registry.start();
  registry.publishFile(ARTIFACT_PATH, TARBALL);

  toolBin = copyTool();
  patchTable(toolBin, NAME, DEFINITION);
  patchTable(toolBin, "hare", BROKEN_DEFINITION);
});

afterAll(async () => {
  cleanupFixtures();
  if (POSIX) await registry.stop();
});

describe.skipIf(!POSIX)("§15.28 native package managers", () => {
  function project(): ReturnType<typeof createFixture> {
    return createFixture({ name: "app", packageManager: `${NAME}@${REFERENCE}` });
  }

  function options(
    fixture: ReturnType<typeof createFixture>,
    env?: Record<string, string | undefined>,
  ) {
    return {
      cwd: fixture.cwd,
      home: fixture.home,
      bin: toolBin,
      registry,
      env: {
        // Row 193's "no JS runtime consulted", stated as a trap rather than an
        // absence: §08.3.1 would consult this first, and it does not exist.
        COREPACK_NODE_EXECPATH: "/nonexistent/definitely-not-a-node",
        CI: undefined,
        ...env,
      },
    };
  }

  it("193: fetches the {platform}/{arch} artifact and executes it directly", async () => {
    const fixture = project();
    registry.reset();

    const result = await run([NAME, "--version"], options(fixture));

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${VERSION}\n`);

    // The URL the tool actually asked for. Both halves matter: the placeholders
    // resolved to *this* host's pair, and no placeholder survived into the URL.
    const paths = registry.requests.map((request) => request.path);
    expect(paths).toContain(ARTIFACT_PATH);
    for (const path of paths) expect(path).not.toContain("{");
  });

  it("193: `$0` is the artifact itself, so no interpreter was interposed", async () => {
    const fixture = project();

    const result = await run([NAME, "--probe", "a b", "--c"], options(fixture));

    expect(result.exitCode).toBe(0);
    const lines = Object.fromEntries(
      result.stdout
        .trimEnd()
        .split("\n")
        .map((line) => {
          const eq = line.indexOf("=");
          return [line.slice(0, eq), line.slice(eq + 1)];
        }),
    );

    // §08.2 would make this `process.execPath` and demote the entry point to
    // `argv[1]`; direct execution puts the artifact itself at `argv[0]`.
    expect(lines.argv0).toBe(stored(fixture.home, ENTRIES.executable.path));
    // §08.7 is unchanged by §15.28: the child still sees COREPACK_ROOT, and a
    // spawned child sees it because it inherits the ambient environment.
    expect(lines.root).toBe(dirname(dirname(toolBin)));
    // The arguments reach the package manager untouched, separators and all.
    expect(lines.args).toBe("--probe a b --c");
  });

  it("193: no JavaScript runtime is consulted even when one is configured badly", async () => {
    const fixture = project();

    // §08.3.1's first step is COREPACK_NODE_EXECPATH. A native band skips the
    // lookup entirely, so a value that could not possibly work is invisible.
    const result = await run([NAME, "--version"], options(fixture));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("Unable to locate a Node.js runtime");
  });

  it("193: the child's exit code is the tool's exit code (§08.4)", async () => {
    const fixture = project();

    // Two distinct codes, neither of which the tool itself can produce: it exits
    // 0 on success and 1 on every error, so a single value could be a
    // coincidence and a hardcoded one could not satisfy both.
    for (const code of ["42", "7"]) {
      const result = await run([NAME, "--exit", code], options(fixture));
      expect(result.signal).toBe(null);
      expect(result.exitCode).toBe(Number(code));
    }
  });

  it("193: a child killed by a signal kills the tool the same way (§08.4, §08.5)", async () => {
    const fixture = project();

    const result = await run([NAME, "--raise", "TERM"], options(fixture));

    // A *signal* death, not `128 + N`: the parent shell must see what it would
    // have seen from a direct invocation.
    expect(result.signal).toBe("SIGTERM");
    expect(result.exitCode).toBe(null);
  });

  it("193: a signal sent to the tool alone is forwarded to the child (§08.5)", async () => {
    const fixture = project();
    const ready = fixture.path("ready");

    // Seed first, so the wait below cannot be spent on a download.
    await run([NAME, "--version"], options(fixture));

    const result = await run([NAME, "--wait", ready], {
      ...options(fixture),
      onSpawn: (child) => {
        void waitForFile(ready).then(() => child.kill("SIGTERM"));
      },
    });

    // 33 is the child's own trap: it can only be reached if the child received
    // SIGTERM. 44 is the child timing out, `null`/`SIGTERM` is the tool dying
    // without forwarding, and 0 is the child never having been signalled — every
    // failure mode is distinguishable from success.
    expect(result.exitCode).toBe(33);
    expect(result.signal).toBe(null);
  });

  it("193: a group signal reaches the child, because the tool made no new group (§08.5)", async () => {
    const fixture = project();
    const ready = fixture.path("ready-group");

    await run([NAME, "--version"], options(fixture));

    const result = await run([NAME, "--group", ready], {
      ...options(fixture),
      // The tool leads its own group, standing in for a terminal's foreground
      // group; the negative pid then signals the tool *and* everything it did
      // not detach.
      detachedGroup: true,
      onSpawn: (child) => {
        void waitForFile(ready).then(() => {
          process.kill(-child.pid!, "SIGINT");
        });
      },
    });

    // 55 is the child's own SIGINT trap, and nothing forwards SIGINT — §08.5
    // says not to, precisely because the group already delivered it. Reaching 55
    // therefore proves two things at once: the child was still in the signalled
    // group, and the tool did not die of the same signal before it could report.
    expect(result.exitCode).toBe(55);
    expect(result.signal).toBe(null);
  });

  it("193: an unrunnable `bin` target is reported, not silently succeeded", async () => {
    const fixture = createFixture({ name: "app", packageManager: `hare@${REFERENCE}` });

    const result = await run(["hare", "--version"], options(fixture));

    // The other half of §07.4 rule 6: the entry that was *not* executable in the
    // archive is not executable in the store either, and `spawn` says so. An
    // implementation that swallowed the spawn error would exit 0 here with no
    // output at all, which is the failure this row exists to make impossible.
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      `Unable to execute ${join(fixture.home, "v1", "hare", VERSION, ENTRIES.data.path)}: EACCES`,
    );
  });

  it("194: the executable bit survives extraction, and nothing else does (§07.4 rule 6)", async () => {
    const fixture = project();

    const result = await run([NAME, "--version"], options(fixture));
    expect(result.exitCode).toBe(0);

    const modeOf = (relative: string): number => statSync(stored(fixture.home, relative)).mode;

    // The point of the row: a native `bin` target comes out runnable.
    expect(modeOf(ENTRIES.executable.path) & 0o111).not.toBe(0);

    // The control that makes the assertion above mean something. If the
    // extractor chmod'd everything, or the filesystem handed out `0777`, this
    // fails — so "it happened to be executable already" cannot pass this test.
    expect(modeOf(ENTRIES.data.path) & 0o111).toBe(0);

    // §07.4 rule 6's prohibition, which §15.28 explicitly must not widen: the
    // executable bit is taken, setuid and setgid never are.
    const setuid = modeOf(ENTRIES.setuid.path);
    expect(setuid & 0o111).not.toBe(0);
    expect(setuid & 0o4000).toBe(0);
    expect(setuid & 0o2000).toBe(0);
  });

  it("194: a second, cached run needs no network and still executes", async () => {
    const fixture = project();

    await run([NAME, "--version"], options(fixture));
    registry.reset();

    const result = await run([NAME, "hello"], options(fixture));

    // §01.3's warm path is not JavaScript-specific either: the marker is read,
    // and the native artifact is handed the process with no request made.
    expect(registry.requests).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${NAME} hello\n`);
  });

  it("194: `corepack install` seeds a native manager, and the store keeps it runnable", async () => {
    const fixture = createFixture({ name: "app" });

    const install = await run(["install", "-g", `${NAME}@${REFERENCE}`], {
      cwd: fixture.cwd,
      home: fixture.home,
      bin: toolBin,
      registry,
      env: { CI: undefined },
    });
    expect(install.exitCode).toBe(0);

    // Nothing in §07 is JavaScript-specific: the same store, the same marker,
    // the same layout — and the artifact is still an executable afterwards.
    expect(statSync(stored(fixture.home, ENTRIES.executable.path)).mode & 0o111).not.toBe(0);
    expect(JSON.parse(readFileSync(stored(fixture.home, ".corepack"), "utf8"))).toMatchObject({
      locator: { name: NAME, reference: REFERENCE },
      bin: { [NAME]: `./${ENTRIES.executable.path}` },
    });
  });
});

/**
 * A guard for the fixture itself.
 *
 * `makeTarball` is the harness's own writer, so a mode that never reached the
 * header would make row 194 vacuous: the "executable" entry would arrive as
 * `0644`, the assertion would be reading the extractor's default rather than the
 * header, and the test would pass while proving nothing. Read the bytes back.
 *
 * Parsed here by hand rather than through `src/tar.ts`, for the same reason the
 * harness has its own tar writer: a fixture validated by the implementation
 * under test can only ever prove the implementation agrees with itself.
 */
function headerModes(tarball: Uint8Array): Record<string, number> {
  const raw = gunzipSync(tarball);
  const text = (bytes: Uint8Array): string =>
    Buffer.from(bytes)
      .toString("latin1")
      .replace(/[\0 ].*$/s, "");

  const modes: Record<string, number> = {};
  for (let offset = 0; offset + 512 <= raw.length;) {
    const block = raw.subarray(offset, offset + 512);
    const name = text(block.subarray(0, 100));
    if (name === "") break;
    modes[name] = Number.parseInt(text(block.subarray(100, 108)), 8);
    const size = Number.parseInt(text(block.subarray(124, 136)), 8) || 0;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return modes;
}

describe.skipIf(!POSIX)("§15.28 fixture integrity", () => {
  it("the fixture tarball really declares the modes row 194 reads back", () => {
    const modes = headerModes(TARBALL);
    expect(modes[`package/${ENTRIES.executable.path}`]).toBe(0o755);
    expect(modes[`package/${ENTRIES.data.path}`]).toBe(0o644);
    expect(modes[`package/${ENTRIES.setuid.path}`]).toBe(0o4755);
  });
});
