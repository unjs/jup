import { spawn, spawnSync } from "node:child_process";
import {
  mkdirSync,
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  join,
  relative as relativePath,
  resolve as resolvePath,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WARM_MODULES } from "../../build.config.ts";
import { DEFINITIONS, getSpecFor, resolveSpecBin } from "../../src/config/table.ts";
import { messages, UsageError } from "../../src/errors.ts";
import { messages as cold } from "../../src/errors-cold.ts";
import { LOCKFILE_NAME } from "../../src/project/lockfile.ts";
import {
  parseArgs,
  isGlobalInvocation,
  isTransparentCommand,
  presentError,
} from "../../src/main.ts";
import { parse } from "../../src/version/semver.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BIN = join(REPO_ROOT, "src", "bin.ts");

/* ------------------------------------------------------------------ *
 * Fixtures: fake package managers written straight into the store.
 *
 * A `.jup` marker is the only thing that makes an install "real"
 * (§07.2), so a hand-written marker plus a trivial entry script gives
 * the whole proxy pipeline something to hand over to without a single
 * byte of network traffic.
 * ------------------------------------------------------------------ */

/** The compiled-in defaults the fallback path resolves to with `DEFAULT_TO_LATEST=0`. */
const YARN_DEFAULT = DEFINITIONS.yarn!.default;
const YARN_TRANSPARENT = DEFINITIONS.yarn!.transparent.default!;
const PNPM_DEFAULT = DEFINITIONS.pnpm!.default;
const NPM_DEFAULT = DEFINITIONS.npm!.default;

/** `1.22.22+sha1.abc` → `1.22.22`; the store never keeps the build suffix (§07.2). */
function versionOf(reference: string): string {
  return parse(reference)!.version;
}

/**
 * Install a fake `<name>@<reference>` into `<home>/v1`.
 *
 * The `bin` shape is taken from the real embedded table, so the entry point this
 * writes is exactly the one `resolveBinPath` will look for — including the
 * single-file case, where the path comes from the basename of the spec URL.
 */
function installFake(home: string, name: string, reference: string, body?: string): string {
  const version = versionOf(reference);
  const spec = getSpecFor(name, version);
  const location = join(home, "v1", name, version);
  mkdirSync(location, { recursive: true });

  const script =
    body ??
    [
      `const args = process.argv.slice(2);`,
      `console.log(${JSON.stringify(`${name}@${version}`)} + (args.length ? " " + args.join(" ") : ""));`,
      ``,
    ].join("\n");

  // §02.4 — a native band's `bin` carries `{exe}`, and §08.3 *spawns* what it
  // names instead of loading it in-process. So the fake has to be a real
  // executable: a shebang, and the execute bit `install.ts` would have set.
  // pnpm reaches this path now that its default is on the native `>=12.0.0`
  // band; before that every default here was JS.
  //
  // POSIX only: on Windows `{exe}` makes this `pnpm.exe`, where a shebang script
  // is `spawn UNKNOWN`. Seeding one is still fine — only *executing* it is not.
  const native = spec.exec === "native";
  const bin = resolveSpecBin(spec);
  const targets = Array.isArray(spec.bin)
    ? [basename(new URL(spec.url.replace("{}", version)).pathname)]
    : Object.values(bin);

  for (const relative of new Set(targets)) {
    const file = join(location, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, native ? `#!${process.execPath}\n${script}` : script);
    if (native && process.platform !== "win32") chmodSync(file, 0o755);
  }

  writeFileSync(
    join(location, ".jup"),
    // §06.1 — a cache hit is now checked against the pin, so a seeded install
    // has to record the digest the reference it stands for actually names.
    JSON.stringify({
      locator: { name, reference },
      bin,
      hash: parse(reference)!.build.join(".") || "sha512.fake",
    }),
  );

  return location;
}

/* ------------------------------------------------------------------ *
 * A mock registry on a real socket. Nothing in these tests should ever
 * reach it: every route it serves is a 500, and `requested` is the
 * assertion surface for test 96's budget.
 * ------------------------------------------------------------------ */

let server: Server;
let registry: string;
let requested: string[];

beforeAll(async () => {
  requested = [];
  server = createServer((request, response) => {
    requested.push(request.url ?? "");
    response.writeHead(500, { "content-type": "application/json" });
    response.end(`{"error":"the tests must not reach the network"}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

/* ------------------------------------------------------------------ *
 * Spawning the real entry point.
 * ------------------------------------------------------------------ */

const scratch: string[] = [];

/** A throwaway `COREPACK_HOME` plus project directory, cleaned up afterwards. */
function makeProject(manifest: unknown): { cwd: string; home: string } {
  // realpath: macOS puts `$TMPDIR` behind a symlink (`/var` -> `/private/var`),
  // and the tool reports the paths it resolves — every assertion here that quotes
  // one back would compare the two spellings.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jup-main-")));
  scratch.push(root);
  const cwd = join(root, "project");
  const home = join(root, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  if (manifest !== undefined) {
    writeFileSync(join(cwd, "package.json"), `${JSON.stringify(manifest, undefined, 2)}\n`);
  }
  return { cwd, home };
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(
  cwd: string,
  home: string,
  args: string[],
  env: Record<string, string> = {},
  entry: string = BIN,
): RunResult {
  const result = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      // Deterministic: no ambient `COREPACK_*` leaks in, the compiled-in default
      // is used instead of "whatever the registry says today", and the download
      // prompt never blocks on stdin.
      COREPACK_HOME: home,
      COREPACK_DEFAULT_TO_LATEST: "0",
      COREPACK_NPM_REGISTRY: registry,
      CI: "1",
      ...env,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

afterEach(() => {
  requested.length = 0;
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * §01.2 — classification
 * ------------------------------------------------------------------ */

describe("parseArgs — §01.2", () => {
  it.for([["npm"], ["npx"], ["pnpm"], ["pnpx"], ["yarn"], ["yarnpkg"]])(
    "sends the known binary %s to proxy mode",
    ([binaryName]) => {
      expect(parseArgs([binaryName!, "add", "x"])).toEqual({
        mode: "proxy",
        binaryName,
        args: ["add", "x"],
      });
    },
  );

  it("carries a CLI version override", () => {
    expect(parseArgs(["yarn@1.22.4", "--version"])).toEqual({
      mode: "proxy",
      binaryName: "yarn",
      binaryVersion: "1.22.4",
      args: ["--version"],
    });
  });

  it("treats a trailing @ as no version at all", () => {
    // Corepack's `binaryVersion || null`: `yarn@` behaves exactly like `yarn`.
    expect(parseArgs(["yarn@"])).toEqual({ mode: "proxy", binaryName: "yarn", args: [] });
  });

  it("sends an unknown name bearing an @ to proxy mode, not to the CLI", () => {
    // This is the whole point of the second branch: `foo@1.2.3` must reach the
    // unsupported-specification error rather than "unknown command".
    expect(parseArgs(["foo@1.2.3"])).toEqual({
      mode: "proxy",
      binaryName: "foo",
      binaryVersion: "1.2.3",
      args: [],
    });
  });

  it("never matches a scoped package as a name", () => {
    // `[^@]*` cannot cross the leading `@`, so the name is empty and the whole
    // remainder becomes the version.
    expect(parseArgs(["@scope/pkg@1.0.0"])).toEqual({
      mode: "proxy",
      binaryName: "",
      binaryVersion: "scope/pkg@1.0.0",
      args: [],
    });
  });

  it.for([["enable"], ["use"], ["--version"], ["--help"], ["cache"]])(
    "sends the bare command %s to management mode with the full argv",
    ([command]) => {
      expect(parseArgs([command!, "extra"])).toEqual({
        mode: "management",
        args: [command, "extra"],
      });
    },
  );

  it("sends an empty argv to management mode", () => {
    expect(parseArgs([])).toEqual({ mode: "management", args: [] });
  });
});

/* ------------------------------------------------------------------ *
 * §01.4 — transparent commands
 * ------------------------------------------------------------------ */

describe("isTransparentCommand — §01.4", () => {
  it("matches the declared prefixes", () => {
    expect(isTransparentCommand("yarn", ["dlx", "foo"])).toBe(true);
    expect(isTransparentCommand("yarn", ["init"])).toBe(true);
    expect(isTransparentCommand("pnpm", ["dlx", "foo"])).toBe(true);
    expect(isTransparentCommand("pnpm", ["init", "-y"])).toBe(true);
    expect(isTransparentCommand("npm", ["init"])).toBe(true);
  });

  it("matches a single-segment prefix whatever the arguments are", () => {
    expect(isTransparentCommand("npx", [])).toBe(true);
    expect(isTransparentCommand("npx", ["cowsay"])).toBe(true);
    expect(isTransparentCommand("pnpx", ["cowsay"])).toBe(true);
  });

  it("does not match a different command", () => {
    expect(isTransparentCommand("yarn", ["add", "x"])).toBe(false);
    expect(isTransparentCommand("pnpm", ["install"])).toBe(false);
    expect(isTransparentCommand("npm", ["install"])).toBe(false);
    expect(isTransparentCommand("yarn", [])).toBe(false);
  });

  it("does not match a prefix belonging to another package manager", () => {
    // `prefix[0] === binaryName` — `yarnpkg dlx` is not `yarn dlx`.
    expect(isTransparentCommand("yarnpkg", ["dlx"])).toBe(false);
    expect(isTransparentCommand("foo", ["dlx"])).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * §01.4 — global flags, recognised positionally
 * ------------------------------------------------------------------ */

describe("isGlobalInvocation — §01.4", () => {
  it("recognises a global flag before the subcommand", () => {
    expect(isGlobalInvocation(["-g", "install", "corepack@latest"])).toBe(true);
    expect(isGlobalInvocation(["--global", "add", "x"])).toBe(true);
    expect(isGlobalInvocation(["--location=global", "install", "x"])).toBe(true);
    expect(isGlobalInvocation(["--location", "global", "install", "x"])).toBe(true);
  });

  it("recognises one after the subcommand — the #690 invocation itself", () => {
    expect(isGlobalInvocation(["install", "-g", "corepack@latest"])).toBe(true);
    expect(isGlobalInvocation(["i", "--global", "x"])).toBe(true);
    expect(isGlobalInvocation(["add", "--location=global", "x"])).toBe(true);
    expect(isGlobalInvocation(["install", "--location", "global", "x"])).toBe(true);
    // Other options in front of it are still leading arguments.
    expect(isGlobalInvocation(["--silent", "install", "--no-audit", "-g", "x"])).toBe(true);
  });

  /* The boundary, from the other side. Each of these contains a `-g` that
   * belongs to something the package manager is about to run, and a scan that
   * simply grepped `args` would accept every one of them. */

  it("stops at `--`", () => {
    expect(isGlobalInvocation(["run", "build", "--", "-g"])).toBe(false);
    expect(isGlobalInvocation(["exec", "--", "something", "-g"])).toBe(false);
    expect(isGlobalInvocation(["--", "-g"])).toBe(false);
    // Even directly after the subcommand, `--` ends the tool's reading of argv.
    expect(isGlobalInvocation(["install", "--", "-g"])).toBe(false);
  });

  it("stops at the subcommand's first operand", () => {
    expect(isGlobalInvocation(["exec", "something", "-g"])).toBe(false);
    expect(isGlobalInvocation(["run", "build", "-g"])).toBe(false);
    expect(isGlobalInvocation(["dlx", "tool", "--global"])).toBe(false);
    // The deliberate false negative (see the doc comment): npm would honour
    // this, and the tool does not guess.
    expect(isGlobalInvocation(["install", "foo", "-g"])).toBe(false);
  });

  it("does not match a flag that merely contains or resembles one", () => {
    expect(isGlobalInvocation([])).toBe(false);
    expect(isGlobalInvocation(["install"])).toBe(false);
    expect(isGlobalInvocation(["install", "-G"])).toBe(false);
    expect(isGlobalInvocation(["install", "--globalthing"])).toBe(false);
    expect(isGlobalInvocation(["install", "--global=false"])).toBe(false);
    expect(isGlobalInvocation(["install", "--location=user"])).toBe(false);
    expect(isGlobalInvocation(["install", "--location", "user", "-g"])).toBe(true);
    // A bare `-` is an operand, not an option, so it consumes the one slot.
    expect(isGlobalInvocation(["publish", "-", "-g"])).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * §08.4 / §12.1 — the two error presentations
 * ------------------------------------------------------------------ */

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  return {
    out,
    err,
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

describe("presentError — §08.4, §12.1", () => {
  it("prints a proxy-mode UsageError bare on stderr", async () => {
    const sink = capture();
    let code: number;
    try {
      code = await presentError(new UsageError("This project is configured to use npm"), {
        mode: "proxy",
        binaryName: "yarn",
        args: [],
      });
    } finally {
      sink.restore();
    }

    expect(code).toBe(1);
    expect(sink.out.join("")).toBe("");
    expect(sink.err.join("")).toBe("This project is configured to use npm\n");
  });

  it("prints a management-mode UsageError on stdout with a usage line", async () => {
    const sink = capture();
    let code: number;
    try {
      code = await presentError(new UsageError("boom"), {
        mode: "management",
        args: ["use", "yarn@1"],
      });
    } finally {
      sink.restore();
    }

    expect(code).toBe(1);
    expect(sink.err.join("")).toBe("");
    expect(sink.out.join("")).toBe(
      "Usage Error: boom\n\n$ jup use [--here] [--no-integrity] [--no-lockfile] <pattern>\n",
    );
  });

  it("keeps the stack for anything that is not a UsageError", async () => {
    const sink = capture();
    const error = new TypeError("internal");
    try {
      await expect(
        presentError(error, { mode: "proxy", binaryName: "yarn", args: [] }),
      ).resolves.toBe(1);
      await expect(presentError(error, { mode: "management", args: ["use"] })).resolves.toBe(1);
    } finally {
      sink.restore();
    }

    // Both modes: stderr, with a stack. A stack trace is the correct output for
    // a bug, and corepack shipped a release where this was swallowed.
    expect(sink.out.join("")).toBe("");
    expect(sink.err.join("")).toContain("TypeError: internal");
    expect(sink.err.join("")).toContain("main.test.ts");
  });
});

/* ------------------------------------------------------------------ *
 * The proxy pipeline, end to end
 * ------------------------------------------------------------------ */

describe("runProxy — project enforcement (tests 38, 39)", () => {
  it("errors when the project pins a different package manager", () => {
    const { cwd, home } = makeProject({ packageManager: `yarn@1.0.0` });
    installFake(home, "yarn", "1.0.0");
    installFake(home, "pnpm", PNPM_DEFAULT);

    const result = run(cwd, home, ["pnpm", "--version"]);

    expect(result.status).toBe(1);
    // Test 39 asserts this byte for byte, including the absolute manifest path.
    expect(result.stderr).toBe(
      `This project is configured to use yarn because ${join(cwd, "package.json")} has a "packageManager" field\n`,
    );
    expect(result.stdout).toBe("");
  });

  it("errors for a yarn invocation in an npm project (test 38)", () => {
    const { cwd, home } = makeProject({ packageManager: NPM_DEFAULT.replace(/^/, "npm@") });
    installFake(home, "npm", NPM_DEFAULT);
    installFake(home, "yarn", YARN_DEFAULT);

    const result = run(cwd, home, ["yarn", "--version"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("This project is configured to use npm");
    expect(result.stderr).not.toContain("Usage Error");
    // Proxy mode never prints a stack for a UsageError.
    expect(result.stderr).not.toContain("    at ");
  });

  it("lets a transparent command through in a foreign project (test 42)", () => {
    const { cwd, home } = makeProject({ packageManager: `npm@${versionOf(NPM_DEFAULT)}` });
    installFake(home, "npm", NPM_DEFAULT);
    // `yarn dlx` falls back to `transparent.default`, not to the 1.x default.
    installFake(home, "yarn", YARN_TRANSPARENT);

    const result = run(cwd, home, ["yarn", "dlx", "--help"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(`yarn@${versionOf(YARN_TRANSPARENT)} dlx --help\n`);
  });
});

describe("runProxy — the escape hatches (tests 40, 41)", () => {
  it("COREPACK_ENABLE_STRICT=0 downgrades a mismatch to the fallback (test 40)", () => {
    const { cwd, home } = makeProject({ packageManager: `yarn@1.0.0` });
    installFake(home, "yarn", "1.0.0");
    // npm, not pnpm, as the foreign manager: the row is about the *fallback*,
    // which resolves the compiled-in default, and pnpm's now sits on the native
    // `>=12.0.0` band. A native artifact cannot be faked on Windows — its `bin`
    // is a real `.exe` — so seeding pnpm here would make this row POSIX-only for
    // a reason that has nothing to do with what it tests. `npm --version` is not
    // a transparent command either, so the path exercised is identical.
    installFake(home, "npm", NPM_DEFAULT);

    const foreign = run(cwd, home, ["npm", "--version"], { COREPACK_ENABLE_STRICT: "0" });
    expect(foreign.status).toBe(0);
    expect(foreign.stdout).toBe(`npm@${versionOf(NPM_DEFAULT)} --version\n`);

    // The project's *own* package manager still honours the pin.
    const own = run(cwd, home, ["yarn", "--version"], { COREPACK_ENABLE_STRICT: "0" });
    expect(own.status).toBe(0);
    expect(own.stdout).toBe(`yarn@1.0.0 --version\n`);
  });

  it("COREPACK_ENABLE_PROJECT_SPEC=0 ignores the pin entirely (test 41)", () => {
    const { cwd, home } = makeProject({ packageManager: `yarn@1.0.0` });
    installFake(home, "yarn", "1.0.0");
    installFake(home, "yarn", YARN_DEFAULT);

    const result = run(cwd, home, ["yarn", "--version"], { COREPACK_ENABLE_PROJECT_SPEC: "0" });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`yarn@${versionOf(YARN_DEFAULT)} --version\n`);
  });
});

describe("runProxy — auto-pin (tests 43, 44)", () => {
  it("writes the pin and both notices with COREPACK_ENABLE_AUTO_PIN=1 (test 43)", () => {
    const { cwd, home } = makeProject({});
    installFake(home, "yarn", YARN_DEFAULT);

    const result = run(cwd, home, ["yarn", "--version"], { COREPACK_ENABLE_AUTO_PIN: "1" });

    expect(result.status).toBe(0);

    const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
      packageManager?: string;
      devEngines?: { packageManager?: Record<string, unknown> };
    };
    // §03.7 — the project declared neither field, so the auto-pin lands in
    // `devEngines` alone: a clean version with the digest beside it.
    expect(manifest.packageManager).toBeUndefined();
    // The pin is hash-bearing, and the hash is the *installed* artifact's — the
    // fixture's marker. Since §06.1 the marker must record the digest its own
    // reference names, so for a seeded compiled-in default the two coincide.
    const pinned = versionOf(YARN_DEFAULT);
    expect(manifest.devEngines?.packageManager).toEqual({
      name: "yarn",
      version: pinned,
      integrity: expect.stringMatching(/^sha512-/) as unknown as string,
    });

    // Verbatim, on stderr, followed by a blank line — then §12.11's line naming
    // the manifest that was modified. Everything stays on stderr because this is
    // proxy mode and stdout belongs to the package manager (§09.14).
    // The notice names the full hash-bearing reference it is about to record;
    // §12.11's `Updated` line names `written`, which is the clean version the
    // member actually holds with its digest beside it in `integrity`.
    expect(result.stderr).toBe(
      `${messages.autoPinNotice("yarn", YARN_DEFAULT)}\n${messages.autoPinDocs()}\n\n` +
        `${messages.updatedManifest(join(cwd, "package.json"), "yarn", pinned)}\n`,
    );
    // stdout is the fake package manager's own output, unpolluted.
    expect(result.stdout).toBe(`yarn@${versionOf(YARN_DEFAULT)} --version\n`);
    expect(result.stderr).toContain(
      "! The local project doesn't define a package manager. jup will now add a 'devEngines.packageManager' entry",
    );
    expect(result.stderr).toContain("https://nodejs.org/api/packages.html#packagemanager");
  });

  it("writes nothing without the variable (test 44)", () => {
    const { cwd, home } = makeProject({});
    installFake(home, "yarn", YARN_DEFAULT);

    const result = run(cwd, home, ["yarn", "--version"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
      packageManager?: string;
    };
    expect(manifest.packageManager).toBeUndefined();
  });
});

describe("runProxy — dispatch and errors", () => {
  it("shadows the built-in commands: `yarn --version` is yarn's (tests 146, 147)", () => {
    const { cwd, home } = makeProject({ packageManager: `yarn@1.0.0` });
    installFake(home, "yarn", "1.0.0");

    const result = run(cwd, home, ["yarn", "--version"]);

    expect(result.status).toBe(0);
    // Not the tool's own version, and not the CLI's `--version` output.
    expect(result.stdout).toBe(`yarn@1.0.0 --version\n`);
    expect(result.stderr).toBe("");
  });

  it("honours a CLI version override inside a pinned project", () => {
    const { cwd, home } = makeProject({ packageManager: `yarn@1.0.0` });
    installFake(home, "yarn", "1.0.0");
    installFake(home, "yarn", "1.22.4");

    const result = run(cwd, home, ["yarn@1.22.4", "--version"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`yarn@1.22.4 --version\n`);
  });

  it("reports an unknown package manager as an unsupported specification", () => {
    const { cwd, home } = makeProject({});

    const result = run(cwd, home, ["foo@1.2.3", "--version"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`${messages.unsupportedSpec("foo@1.2.3")}\n`);
  });

  it("reports a scoped specification the same way", () => {
    const { cwd, home } = makeProject({});

    const result = run(cwd, home, ["@scope/pkg@1.0.0"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`${messages.unsupportedSpec("@scope/pkg@1.0.0")}\n`);
  });

  it("keeps the stack for a non-usage error", () => {
    const { cwd, home } = makeProject({ packageManager: `yarn@1.0.0` });
    const location = installFake(home, "yarn", "1.0.0");
    // A truncated marker is a broken install, not a cache miss (§07.2): it must
    // surface as a bug, with a stack, not as a friendly usage error.
    writeFileSync(join(location, ".jup"), "{ not json");

    const result = run(cwd, home, ["yarn", "--version"]);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("SyntaxError");
    expect(result.stderr).toContain("    at ");
    expect(result.stderr).not.toContain("Usage Error");
  });
});

describe("runProxy — the package manager owns the exit code (§08.4)", () => {
  const cases: Array<[string, string, number]> = [
    ["a synchronous exit code", `process.exitCode = 42;`, 42],
    [
      "an exit code set in beforeExit",
      `process.on("beforeExit", () => { process.exitCode = 42; });`,
      42,
    ],
    // The runtime's own rule: an uncaught exception resets the pending code to
    // 1. Handing back `0` from `runProxy` must not disturb any of the three.
    ["a thrown error over a set exit code", `process.exitCode = 42; throw new Error("boom");`, 1],
  ];

  it.for(cases)("propagates %s", ([, body, expected]) => {
    const { cwd, home } = makeProject({ packageManager: `yarn@1.0.0` });
    installFake(home, "yarn", "1.0.0", body);

    expect(run(cwd, home, ["yarn"]).status).toBe(expected);
  });
});

describe("runProxy — .jup.env applies before the flags are read (test 52)", () => {
  it("auto-pins when only the env file asks for it", () => {
    const { cwd, home } = makeProject({});
    installFake(home, "yarn", YARN_DEFAULT);
    writeFileSync(join(cwd, ".jup.env"), "COREPACK_ENABLE_AUTO_PIN=1\n");

    const result = run(cwd, home, ["yarn", "--version"]);

    expect(result.status).toBe(0);
    const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
      packageManager?: string;
      devEngines?: { packageManager?: { version?: string } };
    };
    expect(manifest.devEngines?.packageManager?.version).toBe(versionOf(YARN_DEFAULT));
  });
});

/* ------------------------------------------------------------------ *
 * §04.4 — the expired memo, and what it is allowed to answer for
 * ------------------------------------------------------------------ */

describe("runProxy — the expired-memo fallback (§04.4)", () => {
  /** The version the memo names, installed so a fallback run can hand over. */
  const STALE = "11.1.2";

  /** A port nothing is listening on, for the one failure that is not a status. */
  let deadRegistry: string;

  beforeAll(async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    deadRegistry = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`;
    await new Promise<void>((resolve, reject) => {
      closed.close((error) => (error ? reject(error) : resolve()));
    });
  });

  /**
   * A registry answering one fixed status, in a process of its own.
   *
   * The file-wide mock above cannot serve these: `run` is `spawnSync`, which
   * blocks *this* process's event loop for the whole child run, so an
   * in-process server never gets to answer and every request would look like a
   * timeout — which is a transport failure, the very case these tests have to
   * tell apart from a status.
   */
  async function statusRegistry(code: number): Promise<{ url: string; stop: () => void }> {
    const script =
      `require("node:http").createServer((q, s) => {` +
      `s.writeHead(${code}, {"content-type": "application/json"}); s.end("{}");` +
      `}).listen(0, "127.0.0.1", function () { process.stdout.write(String(this.address().port)); })`;
    const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
    const port = await new Promise<string>((resolve, reject) => {
      child.stdout.once("data", (chunk: Buffer) => resolve(chunk.toString()));
      child.once("error", reject);
    });
    return { url: `http://127.0.0.1:${port}`, stop: () => void child.kill() };
  }

  /**
   * A project whose spec is a **tag**, with an expired memo for it and the
   * memoed version already in the store.
   *
   * The tag matters: §04.1 resolves it *before* step 4's store probe, so the
   * resolution genuinely has to reach the registry even though the version it
   * would return is installed. That is what makes the difference between
   * "propagated" and "fell back" observable — one run fails, the other prints
   * `pnpm@11.1.2` from the store.
   */
  function memoProject(): { cwd: string; home: string; memo: string } {
    const { cwd, home } = makeProject({ packageManager: `pnpm@latest` });
    const memo = join(cwd, "node_modules", ".jup", LOCKFILE_NAME);
    mkdirSync(dirname(memo), { recursive: true });
    writeFileSync(
      memo,
      `${JSON.stringify({
        version: 1,
        resolutions: { "pnpm@latest": { resolved: STALE, expires: Date.now() - 1000 } },
      })}\n`,
    );
    installFake(home, "pnpm", STALE);
    return { cwd, home, memo };
  }

  const notice = cold.staleResolutionUnreachable("pnpm", "latest", STALE);

  it("answers with the expired memo, and says so, when the registry is unreachable", () => {
    const { cwd, home, memo } = memoProject();
    const before = readFileSync(memo, "utf8");

    const result = run(cwd, home, ["pnpm", "--version"], {
      COREPACK_NPM_REGISTRY: deadRegistry,
      JUP_NETWORK_RETRIES: "0",
    });

    // A connection that is refused is the case the fallback exists for.
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`pnpm@${STALE} --version\n`);
    // And it is *announced*: a silent fallback is indistinguishable from a
    // normal run, and recurs on every invocation until the outage ends.
    expect(result.stderr).toBe(`${notice}\n`);
    // The stamp is not extended, which is why the notice has to recur too.
    expect(readFileSync(memo, "utf8")).toBe(before);
  });

  it("mutes the notice, not the fallback, under JUP_QUIET_ADVISORIES=1", () => {
    const { cwd, home } = memoProject();

    const result = run(cwd, home, ["pnpm", "--version"], {
      COREPACK_NPM_REGISTRY: deadRegistry,
      JUP_NETWORK_RETRIES: "0",
      JUP_QUIET_ADVISORIES: "1",
    });

    // §11.3 — the line is one jup adds, so the mute covers it.
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`pnpm@${STALE} --version\n`);
    expect(result.stderr).toBe("");
  });

  it("propagates a network-disabled refusal rather than running the stale version", () => {
    const { cwd, home } = memoProject();

    const result = run(cwd, home, ["pnpm", "--version"], { COREPACK_ENABLE_NETWORK: "0" });

    // §12.6's diagnostic, not a silent downgrade: a security control that
    // reports success without having been applied is worse than one that stops.
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`${cold.notInCacheOffline("pnpm", "latest")}\n`);
    expect(result.stderr).not.toContain(notice);
  });

  it("propagates a 401 rather than running the stale version", async () => {
    const { cwd, home } = memoProject();
    const unauthorised = await statusRegistry(401);

    const result = run(cwd, home, ["pnpm", "--version"], {
      COREPACK_NPM_REGISTRY: unauthorised.url,
      JUP_NETWORK_RETRIES: "0",
    });
    unauthorised.stop();

    // A rotated or revoked token is permanent, so falling back would pin the
    // project on the memoed version indefinitely — and never say so, since the
    // stamp is not extended and the swallow repeats on every run.
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Server answered with HTTP 401");
    expect(result.stderr).not.toContain(notice);
  });

  it("falls back for a 503, which is a registry that is degraded rather than sure", async () => {
    const { cwd, home } = memoProject();
    const unavailable = await statusRegistry(503);

    const result = run(cwd, home, ["pnpm", "--version"], {
      COREPACK_NPM_REGISTRY: unavailable.url,
      JUP_NETWORK_RETRIES: "0",
    });
    unavailable.stop();

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`pnpm@${STALE} --version\n`);
    expect(result.stderr).toBe(`${notice}\n`);
  });
});

/* ------------------------------------------------------------------ *
 * §01.3 — the fast-path budget (test 96)
 * ------------------------------------------------------------------ */

describe("the warm fast path — §01.3 (test 96)", () => {
  it("makes zero requests and never reads lastKnownGood.json", () => {
    const { cwd, home } = makeProject({ packageManager: `yarn@1.0.0` });
    installFake(home, "yarn", "1.0.0");
    // A recorded default exists and is deliberately wrong: reading it would both
    // be a budget violation and change the answer.
    writeFileSync(join(home, "lastKnownGood.json"), JSON.stringify({ yarn: "9.9.9" }));

    const report = join(home, "report.json");
    const driver = join(home, "driver.mjs");
    writeFileSync(
      driver,
      [
        `import fs from "node:fs";`,
        `import { writeFileSync } from "node:fs";`,
        `import { syncBuiltinESMExports } from "node:module";`,
        ``,
        `// Every filesystem read and every request the run performs, recorded`,
        `// before the modules under test bind their imports.`,
        `const reads = [];`,
        `const fetched = [];`,
        `const readFileSync = fs.readFileSync;`,
        `fs.readFileSync = (path, ...rest) => {`,
        `  reads.push(String(path));`,
        `  return readFileSync(path, ...rest);`,
        `};`,
        `globalThis.fetch = (input) => {`,
        `  fetched.push(String(input));`,
        `  return Promise.reject(new Error("the warm path must not reach the network"));`,
        `};`,
        `syncBuiltinESMExports();`,
        ``,
        `process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT ??= "0";`,
        `const { runMain } = await import(${JSON.stringify(pathToFileURL(join(REPO_ROOT, "src", "main.ts")).href)});`,
        `const code = await runMain(process.argv.slice(2));`,
        `writeFileSync(${JSON.stringify(report)}, JSON.stringify({`,
        `  code,`,
        `  // Module loading itself reads files; only the store's bookkeeping matters.`,
        `  lkg: reads.filter((path) => path.includes("lastKnownGood.json")),`,
        `  fetched,`,
        `}));`,
        ``,
      ].join("\n"),
    );

    const result = run(cwd, home, ["yarn", "--version"], {}, driver);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`yarn@1.0.0 --version\n`);

    const budget = JSON.parse(readFileSync(report, "utf8")) as {
      code: number;
      lkg: string[];
      fetched: string[];
    };
    expect(budget.code).toBe(0);
    expect(budget.fetched).toEqual([]);
    expect(budget.lkg).toEqual([]);
    // And nothing reached the mock registry either.
    expect(requested).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * §01.3 / §16 — what a warm run is allowed to *load*
 *
 * The syscall budget above says nothing about the module graph, and a
 * single static `import` anywhere in the `main → resolve → install`
 * chain silently drags the download-and-verify stack — and with it
 * `node:crypto` (two dozen native modules) and `node:zlib` — into every
 * `yarn`, `npm` and `pnpm` invocation on the machine.
 * ------------------------------------------------------------------ */

/**
 * Modules a warm, exactly-pinned run must never load. Everything here is
 * cold-path only: the downloader and its transport, hashing, signature
 * verification and tar reader (§07, §06), plus the management command surface
 * (§09) and the shim writer (§10), which the proxy path already loads lazily.
 *
 * `proxy.ts` (§05.1) is on this list for the same reason as `http.ts`: it is
 * reached only when a request is about to go out, and its socket stack is loaded
 * later still — only once a proxy has actually matched.
 */
const COLD_PATH_MODULES = [
  "cache/install.ts",
  "net/http.ts",
  "net/proxy.ts",
  "verify/integrity.ts",
  "net/registry.ts",
  "cache/tar.ts",
  "commands/cli.ts",
  "commands/shims.ts",
  // §09.9's report is management-mode only, and it reaches for the shim
  // resolver and a full store listing — none of which a `yarn --version` may pay
  // for.
  "commands/info.ts",
  // §05.1's CA handling and failure classification. `http.ts` reaches it only
  // when a request is about to go out, and `tls.ts` itself defers `node:tls`
  // until something is actually configured.
  "net/tls.ts",
  // §05.3's `.npmrc` reader. A cache hit must not read a single `.npmrc`, and
  // `strace` on the built binary confirms zero such syscalls — this list is what
  // keeps it that way.
  "net/npmrc.ts",
  // §08.3's native handover, and with it `node:child_process`. A JavaScript
  // package manager is handed over to in-process (§08.2) and must not pay for
  // the machinery that exists for the ones that are not JavaScript.
  "run/native.ts",
  // §04.1's tag lookup, range fan-out and `lastKnownGood.json` fallback. An
  // exactly-pinned descriptor resolves to itself and the store marker is the
  // probe (§04.3), so the whole of `resolve.ts` — and the registry entry points
  // it reaches — belongs behind a dynamic import.
  "version/resolve.ts",
  // §09's synopsis and §12.1's usage lines. Both are error/`--help` output; a
  // proxy run that succeeds has no business parsing either.
  "commands/usage.ts",
  // §12's download, verification, network and management vocabulary, plus the
  // three helpers that only ever run with a URL in hand. A warm run can print
  // none of it, and at ~7 kB of the emitted chunk it was the largest thing the
  // warm path parsed and discarded. `main.ts` reaches it from two `catch`
  // blocks, both already behind the dynamic import whose failure they explain.
  "errors-cold.ts",
  // §03.7's pin writer and, under it, §16's format-preserving JSON editor —
  // which reaches `node:os` for the platform line ending. Only `use`, `up` and
  // §03.6's auto-pin write a manifest; every other invocation on the machine
  // only reads one.
  "project/pin.ts",
  "utils/json-write.ts",
];

/**
 * Native modules a warm run may load *beyond* what the measuring harness itself
 * costs, measured against a driver that registers the same hooks and runs
 * nothing.
 *
 * The budget is a delta rather than an absolute so that a Node upgrade, which
 * moves both numbers together, does not fail the suite. Before the cold path was
 * made lazy the warm path cost 41 of these, and `node:crypto` alone accounts for
 * 21 — so a reintroduced static import cannot slip under this.
 *
 * At the time of writing all three entries cost **2**, against a ceiling that
 * was 25 and had 24 of them spent: `node:util`, imported by `env.ts` for
 * `parseEnv`, was dragging in `internal/util/parse_args`, `internal/util/colors`
 * and `internal/util/diff` on every invocation to parse a `.jup.env` that
 * usually does not exist. The hand-rolled parser that replaced it (§16) is
 * what freed the headroom, and this is now a real ceiling again rather than one
 * a single import would breach.
 */
const NATIVE_MODULE_BUDGET = 6;

interface ModuleGraph {
  code: number;
  natives: number;
  /** `node:crypto` / `node:zlib` internals, which only the cold path needs. */
  heavy: string[];
  /** Our own source files, relative to `src/`. */
  ours: string[];
}

/**
 * Run the proxy pipeline through `entry` and report what the process loaded.
 *
 * `registerHooks` sees every module the run resolves, and the report is written
 * *before* the package manager is loaded on `nextTick` (§08.2), so the numbers
 * describe our pipeline and nothing else.
 */
function moduleGraph(entry: string): ModuleGraph {
  const { cwd, home } = makeProject({ packageManager: `yarn@1.0.0` });
  installFake(home, "yarn", "1.0.0");

  const report = join(home, "graph.json");
  const driver = join(home, "graph-driver.mjs");
  writeFileSync(
    driver,
    [
      `import { writeFileSync } from "node:fs";`,
      `import { registerHooks } from "node:module";`,
      ``,
      `const loaded = [];`,
      `registerHooks({ load(url, context, next) { loaded.push(url); return next(url, context); } });`,
      ``,
      `process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT ??= "0";`,
      `const { runMain } = await import(${JSON.stringify(pathToFileURL(join(REPO_ROOT, "src", entry)).href)});`,
      `const code = await runMain(process.argv.slice(2));`,
      `writeFileSync(${JSON.stringify(report)}, JSON.stringify({`,
      `  code,`,
      `  natives: process.moduleLoadList.length,`,
      `  heavy: process.moduleLoadList.filter((name) => /crypto|zlib/.test(name)),`,
      `  ours: loaded`,
      `    .filter((url) => url.includes("/src/"))`,
      `    .map((url) => url.slice(url.indexOf("/src/") + 5)),`,
      `}));`,
      ``,
    ].join("\n"),
  );

  const result = run(cwd, home, ["yarn", "--version"], {}, driver);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);

  return JSON.parse(readFileSync(report, "utf8")) as ModuleGraph;
}

/** The same harness with nothing under test: the floor both entries are measured against. */
function harnessFloor(): number {
  const { cwd, home } = makeProject({});
  const report = join(home, "floor.json");
  const driver = join(home, "floor-driver.mjs");
  writeFileSync(
    driver,
    [
      `import { writeFileSync } from "node:fs";`,
      `import { registerHooks } from "node:module";`,
      `registerHooks({ load(url, context, next) { return next(url, context); } });`,
      `writeFileSync(${JSON.stringify(report)}, JSON.stringify({ natives: process.moduleLoadList.length }));`,
      ``,
    ].join("\n"),
  );

  expect(run(cwd, home, [], {}, driver).status).toBe(0);
  return (JSON.parse(readFileSync(report, "utf8")) as { natives: number }).natives;
}

describe("the warm fast path — the module graph (§16)", () => {
  // Both entries a warm proxy run can arrive through: our own binary, and the
  // module the generated shims import (§10.1). They are the same file now —
  // `index.ts` is what the stubs and `bin/jup.mjs` both `import()`, and the
  // separate `shim.ts` it replaced reached an identical module set — but the
  // shims are the hot one, since they are what occupies `yarn`, `npm` and `pnpm`
  // on `PATH` once `enable` has run. A lazy `main.ts` is worth nothing unless
  // the entry above it is lazy too.
  it.for([
    ["bin", "main.ts"],
    ["shim and library", "index.ts"],
  ])("loads no cold-path module through the %s entry", ([, entry]) => {
    const graph = moduleGraph(entry!);

    expect(graph.code).toBe(0);
    for (const cold of COLD_PATH_MODULES) {
      expect(graph.ours).not.toContain(cold);
    }
    // Nothing else reached for them either: `node:crypto` is 21 native modules
    // on its own, and only hashing and signature verification need it.
    expect(graph.heavy).toEqual([]);
  });

  it("stays inside the native-module budget", () => {
    const floor = harnessFloor();

    for (const entry of ["main.ts", "index.ts"]) {
      const graph = moduleGraph(entry);
      expect(graph.natives - floor).toBeLessThanOrEqual(NATIVE_MODULE_BUDGET);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The *emitted* warm chunk, which the graph above cannot see.
 *
 * `moduleGraph` reports what a run loads from `src/`, and it is blind
 * to how the bundler groups those files. That blindness cost a
 * measurable ~2.8 ms: obuild merged `exec.ts` (warm) with `resolve.ts`
 * and `usage.ts` (cold) into one chunk, so every exactly-pinned
 * invocation parsed §04.1's range fan-out and §09's `--help` synopsis
 * before handing over. `COLD_PATH_MODULES` could not catch it —
 * `resolve.ts` really is warm-reachable in the *source* graph, since an
 * unpinned project needs it — because the chunking was what was wrong.
 *
 * The build no longer emits chunks — `codeSplitting: false` inlines
 * every entry's whole graph into one file, with each module behind a
 * lazy init thunk — so the set below is what a warm run *evaluates*
 * rather than what it parses. Static-import reachability from the entry
 * is still what decides it, so that is what these tests pin: the warm
 * set is exactly `WARM_MODULES`. Either half drifting fails the suite,
 * and no build is needed to find out.
 * ------------------------------------------------------------------ */

const SRC = join(REPO_ROOT, "src");

/**
 * `import`/`export … from "./relative"` statements, skipping `import type`.
 *
 * Type-only specifiers are erased before the bundler ever sees them, so they do
 * not put a module in a chunk — which is why `types.ts` is absent from the warm
 * set despite being named by nearly every file in it.
 */
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^;]*?from\s*"(\.[^"]+)"/g;

/** Every module statically reachable from `src/<entry>`, relative to `src/`, sorted. */
function staticGraph(entry: string): string[] {
  const seen = new Set<string>();
  const pending = [join(SRC, entry)];

  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(STATIC_IMPORT)) {
      pending.push(resolvePath(dirname(file), specifier!));
    }
  }

  return [...seen].map((file) => relativePath(SRC, file).replaceAll("\\", "/")).sort();
}

describe("the warm fast path — the emitted chunk (§16)", () => {
  it("reaches exactly the modules the build ships as one warm chunk", () => {
    // `index.ts` is the entry itself, so it is a file of its own either way.
    expect(staticGraph("index.ts")).toEqual(["index.ts", ...WARM_MODULES].sort());
  });

  it("keeps every cold-path module out of that chunk", () => {
    // Belt and braces on top of the runtime graph: a cold module reached
    // statically is evaluated on every run even if nothing ever calls into it.
    for (const cold of COLD_PATH_MODULES) {
      expect(WARM_MODULES).not.toContain(cold);
    }
  });

  /**
   * The invariant the single-file build rests on (§16).
   *
   * `build.config.ts` inlines each entry's whole graph into one file, so a
   * static `import` of a `node:` builtin anywhere in `src/` — cold module or not
   * — is hoisted to the top of that file and loaded on every invocation. The
   * cold set alone (`node:crypto`, `node:zlib`, `node:child_process`,
   * `node:stream/promises`, `node:fs/promises`) measured ~10 ms of startup that
   * way. Reached through `process.getBuiltinModule` at the point of use, they
   * cost nothing until something calls them.
   *
   * Type-only imports are erased before the bundler sees them and are fine.
   */
  it("reaches every `node:` builtin through `process.getBuiltinModule`", () => {
    const offenders = readdirSync(SRC, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .flatMap((entry) => {
        const file = join(entry.parentPath, entry.name);
        const source = readFileSync(file, "utf8");
        return [...source.matchAll(/^import\s+(?!type\b)[^;]*?from\s*"(node:[^"]+)"/gm)].map(
          (match) => `${relativePath(SRC, file)} imports ${match[1]}`,
        );
      });

    expect(offenders).toEqual([]);
  });

  it("names only modules that exist", () => {
    for (const module of WARM_MODULES) {
      expect(statSync(join(SRC, module)).isFile()).toBe(true);
    }
  });

  /**
   * A ceiling on the source the warm chunk is built from.
   *
   * The module *set* above is exact, but a set can stay exact while one of its
   * members doubles in size, and every byte of it is parsed on every `yarn`,
   * `npm` and `pnpm` invocation on the machine. This is the second half of that
   * guard: it is measured on the source rather than on `dist/`, so it runs
   * without a build and reports which file grew.
   *
   * The numbers, when this was written: 176.9 kB of source emitted a 72.7 kB
   * `warm.mjs`, and the headroom below is about one average module. A change
   * that needs more than that is a change worth arguing for in review — raise
   * the ceiling deliberately, or move the code behind a dynamic import the way
   * `pin.ts` and `resolve.ts` are.
   *
   * The ceiling was raised from 190,000 to 191,000 when the sources moved into
   * subdirectories: the deeper relative specifiers (`"../errors.ts"` for
   * `"./errors.ts"`, and a few lines rewrapped by the formatter) cost 190 bytes
   * of source and **nothing** at runtime — the emitted `warm.mjs` was
   * byte-identical at 76,005 before and after. Specifier text is the one kind
   * of growth this measure over-counts, so it was corrected for once, here.
   *
   * It was raised again, from 191,000 to 202,000, when every environment
   * variable name moved into `config/env-vars.ts` (§11) and each grew a `JUP_`
   * spelling. That file is 9.8 kB of source — a table of names, four accessors,
   * and the prose explaining why the set of names is contract — but only the
   * names and the accessors survive into the chunk: measured, `warm.mjs` went
   * 76,005 -> 79,050, +3.0 kB, or +4.0%.
   *
   * Two things are being bought. A variable name misspelt at a read site is
   * `undefined`, which is also its unset value, so the bug is silent; the table
   * makes it a compile error, and makes the inventory auditable against §11 in
   * one place. And a variable now has two spellings, so a bare
   * `process.env[name]` is *wrong* — it sees one of them — which is what the
   * accessors exist to make unavailable. Neither can move off the warm path: it
   * is the warm path that reads the environment.
   *
   * And once more, from 202,000 to 204,000, for `JUP_QUIET_ADVISORIES`
   * (§11.3): `errors.ts` gained `advisory()` and its import of
   * `config/env-vars.ts` (+958 source bytes, most of it the comment explaining
   * *why* the mute is scoped by origin), `project/env.ts` its two deny-list
   * entries (+440) and `config/env-vars.ts` the name itself (+49). Source
   * +1,447; measured, `warm.mjs` went 79,056 -> 79,263, +207 bytes or +0.26%,
   * because the rest is prose. Neither half can move off the warm path: the
   * gate reads the environment, and `env.ts`'s own §03.2 warning goes through
   * it. Held at 204,000 rather than the 203,432 this leaves, so the next
   * addition is still a change worth arguing for.
   *
   * And once more, 204,000 -> 206,000, for §03.2's layout rename. Only one of
   * the five names cost anything: the store root, the marker, the temp prefix
   * and `jup.tgz` are all string edits, but `.corepack.env` is a file that
   * exists in repositories today, so §03.2 keeps reading it — `.jup.env` first,
   * the old name only on `ENOENT`, per directory so that closest still wins.
   * `project/env.ts` +911 (the second candidate, `readIfPresent`, the constant,
   * and the comment for why a *configured* path gets no fallback), plus +236 in
   * `cache/store.ts` and +184 in `run/exec.ts`, both pure comment for why
   * abandoning the old paths strands nothing. Source +1,310; measured,
   * `warm.mjs` went 79,359 -> 79,597, +238 bytes or +0.30%. The fallback cannot
   * move off the warm path — it *is* the §03.1 walk. Held at 206,000 rather
   * than the 205,209 this leaves, on the same terms as the raise above.
   *
   * And once more, 206,000 -> 208,000, for three fixes that each land in a warm
   * module. `errors.ts` +1,227: §06.5's expired-key acceptance warning (npm's
   * 2025-01-29 rotation makes leniency the only workable policy, and the
   * warning is what makes it safe) plus §05.1's two "the CA bundle did not take"
   * messages. `utils/self.ts` +1,043: `getOwnVersion` reads a build-time
   * constant instead of locating and parsing our own manifest, so it cannot be
   * wrong about a version it could not find. Source +2,270; measured, `warm.mjs`
   * went 79,597 -> 79,926, +329 bytes or +0.41% — the rest is prose. None of it
   * can move off the warm path: `errors.ts` is where every message lives, and
   * `self.ts` already answers §08.7's `COREPACK_ROOT` on the same run. Note the
   * version constant makes the *built* warm path strictly smaller in work done —
   * a `readFileSync` and a `JSON.parse` fold away entirely. Held at 208,000
   * rather than the 207,479 this leaves, on the same terms as the raises above.
   *
   * And once more, 208,000 -> 226,000 — by far the largest raise so far, and the
   * only one where the measured cost is code rather than prose. §02.4's two
   * native entries, bun and deno, land in `config/table.ts` (+12,123) and
   * `project/lockfile.ts` (+3,767), with +731 in `errors.ts` and a few hundred
   * across `main.ts` and `run/exec.ts`. Source +16,904; measured, `warm.mjs`
   * went 79,926 -> 85,931, **+6,005 bytes or +7.5%**.
   *
   * That is a real cost and it is worth stating what it buys and why none of it
   * moved off:
   *
   * * ~2 kB is the table data itself — two entries, four bands, six host
   *   targets each. Data in the compiled-in table is the one thing §03.1 says
   *   adding a package manager is allowed to cost.
   * * The rest is §02.4's per-host machinery, and the warm path reads it. The
   *   handover resolves the band's `url` (`getSpecUrl`, for the artifact
   *   extension) and its `bin` (the §08.1 fallback), and for a native entry both
   *   now carry `{target}`/`{exe}`; a lockfile *read* needs `hostTarget` to pick
   *   its own key out of §04.4's integrity map. None of those can be deferred
   *   to the download path, because they run when there is no download.
   * * `resolveArtifactRegistry` is the one piece that is genuinely cold — only
   *   `cache/install.ts` calls it. It stays here anyway: it holds the identity
   *   cache that `packageManagerForRegistry` does `Map` lookups against, and
   *   splitting a registry spec's construction from the maps it registers into
   *   would trade ~900 bytes for a seam that is easy to get subtly wrong.
   *
   * Held at 226,000 rather than the 224,383 this leaves, on the same terms as
   * every raise above: the next addition is still a change worth arguing for.
   *
   * And once more, 226,000 -> 234,000, for §03.1's third native entry, `aube`,
   * and for the libc half of §02.4's host name that it forced. All of it lands
   * in `config/table.ts` (+6,757; nothing else on the warm path changed at all),
   * and the previous raise predicted most of that: the machinery was paid for,
   * so the entry itself is ~700 bytes of table data. Measured, `_warm.mjs` went
   * 86,214 -> 88,178, **+1,964 bytes or +2.3%** — a third of the last raise for
   * a comparable addition, which is what "nearly free" turned out to mean.
   *
   * The libc probe is the part that was not predicted, and it is worth naming
   * what it costs: two `existsSync` calls, memoised per architecture, reached
   * only from `hostTarget()` — which npm, pnpm and yarn never call, because
   * neither a `targets` lookup nor §04.4's per-host integrity map exists for
   * them. So the warm path grows in bytes and not in work. It cannot move off:
   * `hostTarget()` is read by a lockfile *read*, which happens when there is no
   * download to defer it to.
   *
   * Held at 234,000 rather than the 232,092 this leaves, on the same terms as
   * every raise above.
   *
   * And once more, 234,000 -> 238,000, for §03.1's fourth native entry, `nub`.
   * Table data and nothing else: `config/table.ts` +3,647, no other warm module
   * touched, and no new machinery at all — `nub` uses §02.4's per-host model
   * exactly as the three before it do, and the identity `targets` map is eight
   * lines of it. Measured, `_warm.mjs` went 88,178 -> 89,097, **+919 bytes or
   * +1.04%**, which is the smallest per-entry cost so far and is what the
   * 226,000 -> 234,000 raise predicted would happen once the machinery was paid
   * for. Roughly half the source delta is the prose above the band explaining
   * why one file serves both `nub` and `nubx`; the emitted chunk carries none of
   * it.
   *
   * Held at 238,000 rather than the 235,739 this leaves, on the same terms as
   * every raise above.
   *
   * And once more, 238,000 -> 246,000, for §02.3's `node` — and this one breaks
   * the trend the last two established, because the entry is *not* where the
   * cost went. `config/table.ts` +4,275 is the fifth per-host entry at about the
   * price of the fourth; the other +4,739 is the `kind` branches, spread over
   * three modules that had no reason to grow before: `project/manifest.ts`
   * +2,762 (the walk, the read and the parse each taking a `devEngines` member
   * rather than assuming one), `errors.ts` +1,563 (four messages parameterised
   * by that member, plus §12.2's runtime refusal) and `main.ts` +414 (passing
   * the requested tool into discovery).
   *
   * Measured, `_warm.mjs` went 89,097 -> 90,862, **+1,765 bytes or +1.98%** —
   * still under the `aube` raise despite nearly three times the source delta,
   * because most of what was added is prose and type annotations that the
   * emitted chunk does not carry. What it *does* carry is one extra branch on
   * two warm functions (`stopsWalk`, `readSpecFromManifest`), both comparing a
   * string that is a compile-time constant for every caller but the proxy's.
   *
   * The number to watch next is not the second runtime — that is table data
   * again, on the aube-to-nub trend — but any requirement that makes `kind`
   * readable from a fifth place. §02.3 caps it at four deliberately, and this
   * raise is what that cap costs when it is honoured.
   *
   * Held at 246,000 rather than the 244,753 this leaves, on the same terms as
   * every raise above.
   *
   * And from 246,000 to 258,000 for §03.1's version file. Source +11,978:
   * `project/version-file.ts` +6,859 (a new warm module — the reader, nvm's
   * content grammar, and the prose stating why the LTS aliases are refused on
   * the data rather than on principle), `project/manifest.ts` +3,153 (the read
   * inside the walk, and the `Found` a version file produces), `errors.ts`
   * +1,248 (two messages) and `config/table.ts` +718 (one entry field and its
   * accessor).
   *
   * Measured, `_warm.mjs` went 90,862 -> 93,343, **+2,481 bytes or +2.73%** —
   * a larger emitted delta than §02.3's for a source delta four times the size,
   * because this one adds actual executable code rather than a branch: a file
   * read, a line-by-line parse, and two long message strings. The ratio is the
   * thing to note. Source grew by 4.9% and the chunk by 2.7%, which is the usual
   * signature of a prose-heavy module; a future change where those two numbers
   * converge is one that added code, not comments.
   *
   * It cannot move off the warm path: §03.1 reads the file *during* the walk,
   * and the walk is synchronous, so there is no dynamic-import seam of the kind
   * `pin.ts` and `resolve.ts` use. What keeps the cost off a `pnpm` run is
   * cheaper than a seam and is not visible here — the whole path is skipped
   * unless the requested tool's table entry declares a `versionFile`, which
   * only `node` does, so the bytes are parsed and never executed.
   *
   * And then **down**, 258,000 -> 238,000: the first lowering, and the answer to
   * the sentence every raise above ends with. `errors.ts` was 36.8 kB of source
   * and the largest single resident of the emitted chunk, nearly all of it text
   * a warm run cannot print — §12.6's transport failures, §05.1's TLS
   * sentences, §12.7's integrity refusals, §12.10's and §12.11's command output.
   * The 62 builders no warm module can name moved to `errors-cold.ts`, along
   * with `redactUserinfo`, `networkError` and `explainFetchFailure`, which only
   * ever run with a URL in hand; that file re-exports `errors.ts` and merges the
   * two tables, so no cold call site changed at all — only the specifier it
   * imports.
   *
   * Source: `errors.ts` 36,791 -> 14,889, total 257,122 -> 235,651. Measured,
   * `_warm.mjs` went 92,966 -> 82,328, **-10,638 bytes or -11.4%** — the one
   * entry here where the emitted delta *exceeds* the raises it undoes, because
   * what left was string literals rather than prose. `aube`, `nub`, `node` and
   * the version file together cost 5,165 emitted bytes; this hands back twice
   * that.
   *
   * The seam holds because the compiler enforces it: a warm module importing
   * `errors.ts` cannot name a cold message, since the type does not have one,
   * and `errors-cold.ts` is in `COLD_PATH_MODULES` above, so a warm module that
   * reaches for it fails the two tests before this one. Note what the lowering
   * gives up: growth in the cold half is now unmeasured, which is correct —
   * nothing there is parsed by a `yarn --version` — but it means this number no
   * longer moves when §12 gains a message. It moves when the *warm path* gains
   * one, which is the thing worth arguing about.
   *
   * Held at 238,000 rather than the 235,651 this leaves, on the same terms as
   * every raise above.
   *
   * And then **up again, 238,000 -> 256,000**, for a run of ten commits rather
   * than one change. 235,651 -> 253,712, **+18,061 or +7.7%**, and no single
   * entry in it is arguable on its own:
   *
   * | Change | Module | Bytes |
   * |---|---|---|
   * | §04.2's version prefix and x-range grammar narrowed | `version/semver.ts` | +2,853 |
   * | §03.2's three location variables denied in a project env file | `project/env.ts` | +2,055 |
   * | §03.2's env-file search stopped at the project boundary | `project/manifest.ts` | +4,181 |
   * | §02.1's spec name refused when it cannot be a store directory | `project/manifest.ts` | +2,855 |
   * | §07.2's marker shape validated before it is trusted | `cache/store.ts` | +964 |
   * | §07.4's fixed mode ceiling on the extractor and the store | `cache/store.ts` | +964 |
   * | §08.3's shim directory promoted only on our own banner | `run/exec.ts` | +2,637 |
   * | §06.1's pin reasoning moved out to the spec | `cache/store.ts` | −1,705 |
   * | §02.5's whole table moved onto the npm registry | `config/table.ts`, `run/exec.ts` | +2,341 |
   * | §02.3's `node@lts` table constant | `config/table.ts` | +916 |
   *
   * Eight of the ten are hardening: each replaces a check that trusted a shape,
   * a name or a boundary with one that verifies it, and every one of them sits
   * on the warm path because that is where the untrusted input arrives — a
   * manifest, an env file, a store marker, a `PATH` entry. There is no seam to
   * move them behind, for the reason the version-file entry above gives: a warm
   * run is exactly the run that reads these.
   *
   * The ratio is the thing to read, on the terms this comment has used
   * throughout. Source grew 7.7% and the largest single contributor,
   * `project/manifest.ts`, grew 21.8% — the signature of added code, not added
   * prose, which is what a run of validators is. That is the argument for
   * accepting it and the reason not to accept another like it silently: the next
   * lowering is owed, and `config/table.ts` at 43,434 bytes is now the largest
   * resident, most of it data that a warm run parses and a `yarn --version`
   * never reads past one entry of.
   *
   * Held at 256,000 rather than the 253,712 this leaves, on the same terms as
   * every raise above.
   *
   * And then **up, 256,000 -> 260,000**, for one change: §10.2's rule that a
   * shim never names an interpreter living inside the store. 255,986 -> 258,173,
   * **+2,187 or +0.9%** — the ceiling had 14 bytes of headroom left, so a change
   * this size could not have been absorbed at any wording.
   *
   * | Change | Module | Bytes |
   * |---|---|---|
   * | §10.2's store-boundary test, `isInsideHome` | `cache/store.ts` | +1,158 |
   * | §08.3's `JUP_HOST_RUNTIME`, and `writeEnvInto` to set it on a child | `config/env-vars.ts` | +570 |
   * | §03.2's deny-list entry for that variable | `project/env.ts` | +337 |
   * | a pointer to where the child's environment is finished | `run/exec.ts` | +122 |
   *
   * The forwarding *itself* — the code that computes and writes the variable —
   * is deliberately absent from that table, and it is why the entry is 2 kB
   * rather than 4: it lives in `run/native.ts`, reached only through `exec.ts`'s
   * `import()`, so a `yarn --version` never parses a byte of it. Two halves
   * could not follow it there. The boundary test is `store.ts`'s to answer,
   * because `<home>` is, and every other module that needs it is cold; and a
   * variable's name and env-file eligibility belong with the other forty, where
   * §11.6's two spellings are resolved once (`env-vars.ts`) and §03.2's
   * deny-list is one list (`env.ts`) rather than a predicate scattered per
   * variable. Both are the shape this codebase already argues for elsewhere, so
   * neither is worth undoing to buy back a kilobyte.
   *
   * Held at 260,000 rather than the 258,173 this leaves, on the same terms as
   * every raise above — and the lowering the previous entry says is owed is
   * still owed.
   *
   * And then **up, 260,000 -> 266,000**, for §04.4's split of the resolution
   * file in two: a committed `jup.lock` that only `use` and `up` write, and a
   * `node_modules/jup.lock` memo that ordinary runs write instead. 259,586 ->
   * 265,546, **+5,960 or +2.3%**.
   *
   * | Change | Module | Bytes |
   * |---|---|---|
   * | `CACHE_DIRECTORY`, `CACHE_TTL_MS`, `readCachedResolution`, `writeCachedResolution` | `project/lockfile.ts` | +5,317 |
   * | the read order — recorded, memo, resolve — and the expired-memo fallback | `main.ts` | +791 |
   * | the CI frozen default, deleted: nothing implicit writes any more | `project/env.ts` | -148 |
   *
   * What the warm path *lost* is not in that table and is the reason the change
   * is worth its bytes: a range run no longer writes the project root, and no
   * longer consults `JUP_FROZEN_LOCKFILE` before it may resolve. What it
   * gained is one `readFileSync` of a second path, and only on a range run whose
   * recorded file had nothing to say. Two thirds of the entry is prose, on the
   * same terms as the `version-file.ts` entry above.
   *
   * Held at 266,000 rather than the 265,546 this leaves — the tightest margin
   * any entry here has taken, deliberately: the next range-resolution change
   * should have to argue for itself rather than land inside somebody else's
   * headroom. The lowering two entries above still stands owed.
   *
   * And then **up, 266,000 -> 278,000**, for a review pass over §04.4 and the
   * shim rules — six bug fixes and two seams, landing together across four warm
   * modules and measured together. Source 259,586 -> 277,687, **+18,101 or +7.0%**; measured,
   * `_warm.mjs` went 86,620 -> 90,478, **+3,858 bytes or +4.45%**.
   *
   * | Change | Module | Bytes |
   * |---|---|---|
   * | the memo moved to `node_modules/.jup/`, the `expires` upper bound, `readEntry`/`readCachedEntry`, `readKnownResolution`, `removeCachedResolution` | `project/lockfile.ts` | +10,201 |
   * | §04.4's fallback scoped to transport failures and announced; `fromRegistry` in place of the identity test | `main.ts` | +6,637 |
   * | §10.6's shim recogniser completed, and `WIN32_WRAPPER_HEADS` moved here to be its one definition | `run/exec.ts` | +898 |
   * | §03.7's sidecar folded only when the version beside it is exact | `project/manifest.ts` | +519 |
   * | §04.4's CI frozen default, already gone; small net trims elsewhere | `project/env.ts` and three others | -154 |
   *
   * The ratio is the thing to read, on the terms this comment has used
   * throughout: source grew 6.8% and the chunk 4.33%, so this is nearer an
   * added-code entry than a prose one, and it should be. Four of the six are
   * bug fixes with a failing case behind each — a memo npm deleted on every
   * install, an `expires` believed however far out it read, a fallback that
   * swallowed `COREPACK_ENABLE_NETWORK=0` and a rotated credential alike, and a
   * recogniser blind to the very wrappers this tool writes. The other two are
   * the seams that stopped the fixes from being pasted twice:
   * `readKnownResolution` is §04.4's precedence order in one place rather than
   * in `main.ts` and `install` separately, and `WIN32_WRAPPER_HEADS` now has one
   * home rather than three.
   *
   * None of it moves off the warm path. `lockfile.ts` *is* the range fast path;
   * `main.ts` is the branch taken when resolution fails; `exec.ts`'s recogniser
   * decides what `PATH` entry may be baked into a shim. What did move off is the
   * fallback's two advisory strings, which were written into `main.ts` and are
   * now in `errors-cold.ts` behind the dynamic import that branch had already
   * taken to classify the failure: measured on its own, `_warm.mjs` 90,870 ->
   * 90,374, **-496 bytes**, for text a warm run can never print. That is the
   * lowering mechanism this comment keeps pointing at, applied in the small.
   *
   * Held at 278,000 rather than the 277,687 this leaves, on the same terms as
   * every raise above. Two things are owed. `project/lockfile.ts` at +10,201 is
   * nearly double the +5,317 the entry above recorded for the same subsystem,
   * and roughly two thirds of it is prose that the emitted chunk does not carry
   * — which is an argument for the ceiling being measured on source, not against
   * it, but it does mean the next range-resolution change starts with almost no
   * headroom. And the lowering owed since the `errors.ts` split is now owed
   * three times over: `config/table.ts` at 42,665 is still the largest resident,
   * most of it data a `yarn --version` never reads past one entry of.
   *
   * And **up, 278,000 -> 283,000**, for pnpm 12 going native. 277,687 ->
   * 282,592, **+4,905 or +1.77%**:
   *
   * | Change | Module | Bytes |
   * |---|---|---|
   * | §02.4's `@pnpm/exe.<host>` band, its `targets` map, and why the wrapper is not the artifact | `config/table.ts` | +3,172 |
   * | §04.4's bare digest, recorded before the band was per-host, dropped on read | `project/lockfile.ts` | +1,063 |
   * | §02.4's `binArgs` prepended, for a `pnpx` its binary cannot read off `argv[0]` | `run/exec.ts` | +473 |
   * | the same, threaded from the band to the handover | `main.ts` | +197 |
   *
   * Measured, `_warm.mjs` went 51,064 -> 51,741, **+677 bytes or +1.33%** —
   * measured on the **minified** chunk this build now emits, so the absolute
   * figures are not comparable with the entries above, though the ratios still
   * are. Source grew 1.77% and the chunk 1.33%, the usual signature of an entry
   * that is mostly prose: the executable part of it is one table row, one
   * `typeof` on the read path, and a two-line array spread.
   *
   * None of it can move off the warm path — the table row *is* the fetch, and
   * the other two are on the range fast path and the handover. What is owed is
   * unchanged and now owed a fourth time: `config/table.ts` at 45,837 is the
   * largest resident by a wider margin than before, and a `yarn --version` still
   * reads past every pnpm band to reach it.
   *
   * And **up, 283,000 -> 284,500**, for §10.5 point 8's system directory —
   * `--system`, and the `/usr/local/bin` a `root` `enable` may reach when no
   * per-user candidate is on `PATH`. 282,592 -> 284,010, **+1,418 or +0.50%**:
   *
   * | Change | Module | Bytes |
   * |---|---|---|
   * | §10.5 point 8's `systemShimDirectory`, and the candidate appended for uid 0 | `run/exec.ts` | +1,297 |
   * | `ProgramData`, the one variable that directory reads, on Windows only | `config/env-vars.ts` | +121 |
   *
   * Measured, `_warm.mjs` 51,741 -> 51,975, **+234 bytes or +0.45%** — source
   * grew 0.50% and the chunk 0.45%, and the executable part of it really is that
   * small: one `getuid` test, one array push and two string literals. The rest is
   * the prose above them, which the chunk does not carry.
   *
   * It cannot move off the warm path for the reason the candidate list is here
   * at all: §08.3's promotion reads that list on every proxy invocation, and
   * `enable` must choose from the same one it later searches (§10.5 point 7).
   * What is owed is unchanged and now owed a fifth time, against the same
   * resident: `config/table.ts`, still 45,837, still read past one entry at a
   * time by every `yarn --version`.
   *
   * A note on the `_warm.mjs` figures above: that file no longer exists. The
   * build inlines its one entry into one file and leaves every module behind a
   * lazy init thunk, so the same set is now evaluated out of `dist/index.mjs`
   * and the bytes sharing the file with it cost nothing measurable — parsing
   * 164 kB and parsing 52 kB came out equal, and what the split was really
   * buying was an import list free of `node:crypto` and `node:zlib`, which
   * `process.getBuiltinModule` now buys instead. The entries are kept as
   * measured; the ceiling below now bounds the source that is *evaluated* on
   * every warm run, which is the thing that was ever worth bounding.
   *
   * The entry row became `index.ts` when `shim.ts` was deleted and its role
   * passed to the library entry (§16): +1,151 bytes on a sum that has since
   * fallen well under this ceiling anyway. Nothing was added to the warm path —
   * the two files reach an identical module set, which is why one of them could
   * go — so this is the same code measured under a different entry, and the
   * ceiling stays where it was.
   */
  it("stays inside the warm set's byte ceiling", () => {
    const sizes = ["index.ts", ...WARM_MODULES]
      .map((module) => [module, statSync(join(SRC, module)).size] as const)
      .sort(([, a], [, b]) => b - a);
    const total = sizes.reduce((sum, [, bytes]) => sum + bytes, 0);

    const breakdown = sizes.map(([module, bytes]) => `${module} ${bytes}`).join(", ");
    expect(
      total,
      `warm source is ${(total / 1024).toFixed(1)} kB: ${breakdown}`,
    ).toBeLessThanOrEqual(284_500);
  });
});
