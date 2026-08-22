import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
import { DEFINITIONS, getSpecFor } from "../../src/config/table.ts";
import { messages, UsageError } from "../../src/errors.ts";
import { classifyInvocation, isTransparentCommand, presentError } from "../../src/main.ts";
import { parse } from "../../src/semver.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BIN = join(REPO_ROOT, "src", "bin.ts");

/* ------------------------------------------------------------------ *
 * Fixtures: fake package managers written straight into the store.
 *
 * A `.corepack` marker is the only thing that makes an install "real"
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

  const targets = Array.isArray(spec.bin)
    ? [basename(new URL(spec.url.replace("{}", version)).pathname)]
    : Object.values(spec.bin);

  for (const relative of targets) {
    const file = join(location, relative);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, script);
  }

  writeFileSync(
    join(location, ".corepack"),
    // §15.11 — a cache hit is now checked against the pin, so a seeded install
    // has to record the digest the reference it stands for actually names.
    JSON.stringify({
      locator: { name, reference },
      bin: spec.bin,
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
  const root = mkdtempSync(join(tmpdir(), "pipack-main-"));
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

describe("classifyInvocation — §01.2", () => {
  it.for([["npm"], ["npx"], ["pnpm"], ["pnpx"], ["yarn"], ["yarnpkg"]])(
    "sends the known binary %s to proxy mode",
    ([binaryName]) => {
      expect(classifyInvocation([binaryName!, "add", "x"])).toEqual({
        mode: "proxy",
        binaryName,
        args: ["add", "x"],
      });
    },
  );

  it("carries a CLI version override", () => {
    expect(classifyInvocation(["yarn@1.22.4", "--version"])).toEqual({
      mode: "proxy",
      binaryName: "yarn",
      binaryVersion: "1.22.4",
      args: ["--version"],
    });
  });

  it("treats a trailing @ as no version at all", () => {
    // Corepack's `binaryVersion || null`: `yarn@` behaves exactly like `yarn`.
    expect(classifyInvocation(["yarn@"])).toEqual({ mode: "proxy", binaryName: "yarn", args: [] });
  });

  it("sends an unknown name bearing an @ to proxy mode, not to the CLI", () => {
    // This is the whole point of the second branch: `foo@1.2.3` must reach the
    // unsupported-specification error rather than "unknown command".
    expect(classifyInvocation(["foo@1.2.3"])).toEqual({
      mode: "proxy",
      binaryName: "foo",
      binaryVersion: "1.2.3",
      args: [],
    });
  });

  it("never matches a scoped package as a name", () => {
    // `[^@]*` cannot cross the leading `@`, so the name is empty and the whole
    // remainder becomes the version.
    expect(classifyInvocation(["@scope/pkg@1.0.0"])).toEqual({
      mode: "proxy",
      binaryName: "",
      binaryVersion: "scope/pkg@1.0.0",
      args: [],
    });
  });

  it.for([["enable"], ["use"], ["--version"], ["--help"], ["cache"]])(
    "sends the bare command %s to management mode with the full argv",
    ([command]) => {
      expect(classifyInvocation([command!, "extra"])).toEqual({
        mode: "management",
        args: [command, "extra"],
      });
    },
  );

  it("sends an empty argv to management mode", () => {
    expect(classifyInvocation([])).toEqual({ mode: "management", args: [] });
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
      "Usage Error: boom\n\n$ corepack use [--here] [--pin-style=suffix|sidecar] <pattern>\n",
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
    installFake(home, "pnpm", PNPM_DEFAULT);

    const foreign = run(cwd, home, ["pnpm", "--version"], { COREPACK_ENABLE_STRICT: "0" });
    expect(foreign.status).toBe(0);
    expect(foreign.stdout).toBe(`pnpm@${versionOf(PNPM_DEFAULT)} --version\n`);

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
    };
    expect(manifest.packageManager).toMatch(/^yarn@/);
    // The pin is hash-bearing, and the hash is the *installed* artifact's — the
    // fixture's marker. Since §15.11 the marker must record the digest its own
    // reference names, so for a seeded compiled-in default the two coincide.
    const pinned = YARN_DEFAULT;
    expect(manifest.packageManager).toBe(`yarn@${pinned}`);

    // Verbatim, on stderr, followed by a blank line — then §15.35l's line naming
    // the manifest that was modified. Everything stays on stderr because this is
    // proxy mode and stdout belongs to the package manager (§09.11).
    expect(result.stderr).toBe(
      `${messages.autoPinNotice("yarn", pinned)}\n${messages.autoPinDocs()}\n\n` +
        `${messages.updatedManifest(join(cwd, "package.json"), "yarn", pinned)}\n`,
    );
    // stdout is the fake package manager's own output, unpolluted.
    expect(result.stdout).toBe(`yarn@${versionOf(YARN_DEFAULT)} --version\n`);
    expect(result.stderr).toContain("! The local project doesn't define a 'packageManager' field");
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
    writeFileSync(join(location, ".corepack"), "{ not json");

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

describe("runProxy — .corepack.env applies before the flags are read (test 52)", () => {
  it("auto-pins when only the env file asks for it", () => {
    const { cwd, home } = makeProject({});
    installFake(home, "yarn", YARN_DEFAULT);
    writeFileSync(join(cwd, ".corepack.env"), "COREPACK_ENABLE_AUTO_PIN=1\n");

    const result = run(cwd, home, ["yarn", "--version"]);

    expect(result.status).toBe(0);
    const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
      packageManager?: string;
    };
    expect(manifest.packageManager).toMatch(/^yarn@/);
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
        `const { runMain } = await import(${JSON.stringify(new URL("src/main.ts", new URL(`file://${REPO_ROOT}`)).href)});`,
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
 * §01.3 / §16.3 — what a warm run is allowed to *load*
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
 * `proxy.ts` (§14.8) is on this list for the same reason as `http.ts`: it is
 * reached only when a request is about to go out, and its socket stack is loaded
 * later still — only once a proxy has actually matched.
 */
const COLD_PATH_MODULES = [
  "install.ts",
  "http.ts",
  "proxy.ts",
  "integrity.ts",
  "registry.ts",
  "tar.ts",
  "cli.ts",
  "shims.ts",
  // §15.30's report is management-mode only, and it reaches for the shim
  // resolver and a full store listing — none of which a `yarn --version` may pay
  // for.
  "info.ts",
  // §15.4's CA handling and failure classification. `http.ts` reaches it only
  // when a request is about to go out, and `tls.ts` itself defers `node:tls`
  // until something is actually configured.
  "tls.ts",
  // §15.1's `.npmrc` reader. A cache hit must not read a single `.npmrc`, and
  // `strace` on the built binary confirms zero such syscalls — this list is what
  // keeps it that way.
  "npmrc.ts",
  // §15.28's native handover, and with it `node:child_process`. A JavaScript
  // package manager is handed over to in-process (§08.2) and must not pay for
  // the machinery that exists for the ones that are not JavaScript.
  "native.ts",
  // §04.1's tag lookup, range fan-out and `lastKnownGood.json` fallback. An
  // exactly-pinned descriptor resolves to itself and the store marker is the
  // probe (§14.1), so the whole of `resolve.ts` — and the registry entry points
  // it reaches — belongs behind a dynamic import.
  "resolve.ts",
  // §09's synopsis and §12.1's usage lines. Both are error/`--help` output; a
  // proxy run that succeeds has no business parsing either.
  "usage.ts",
  // §03.7's pin writer and, under it, §16.4's format-preserving JSON editor —
  // which reaches `node:os` for the platform line ending. Only `use`, `up` and
  // §03.6's auto-pin write a manifest; every other invocation on the machine
  // only reads one.
  "pin.ts",
  "json-write.ts",
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
 * and `internal/util/diff` on every invocation to parse a `.corepack.env` that
 * usually does not exist. The hand-rolled parser that replaced it (§16.2) is
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

describe("the warm fast path — the module graph (§16.3)", () => {
  // Both entries a warm proxy run can arrive through: our own binary, and the
  // module the generated shims import (§10.1). The shims are the hot one — they
  // are what occupies `yarn`, `npm` and `pnpm` on `PATH` once `enable` has run —
  // so a lazy `main.ts` is worth nothing unless the shim entry is lazy too.
  it.for([
    ["bin", "main.ts"],
    ["shim", "shim.ts"],
    ["library", "index.ts"],
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

    for (const entry of ["main.ts", "shim.ts", "index.ts"]) {
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
 * What decides the chunking is static-import reachability from the
 * entry, so that is what these tests pin: the warm set is exactly
 * `WARM_MODULES`, and `WARM_MODULES` is what `build.config.ts` ships as
 * a single `warm.mjs`. Either half drifting fails the suite, and no
 * build is needed to find out.
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

describe("the warm fast path — the emitted chunk (§16.3)", () => {
  it("reaches exactly the modules the build ships as one warm chunk", () => {
    // `shim.ts` is the entry itself, so it is a file of its own either way.
    expect(staticGraph("shim.ts")).toEqual(["shim.ts", ...WARM_MODULES].sort());
  });

  it("keeps every cold-path module out of that chunk", () => {
    // Belt and braces on top of the runtime graph: a cold module reached
    // statically would be merged into `warm.mjs` and parsed on every run even if
    // nothing ever called into it.
    for (const cold of COLD_PATH_MODULES) {
      expect(WARM_MODULES).not.toContain(cold);
    }
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
   */
  it("stays inside the warm chunk's byte ceiling", () => {
    const sizes = ["shim.ts", ...WARM_MODULES]
      .map((module) => [module, statSync(join(SRC, module)).size] as const)
      .sort(([, a], [, b]) => b - a);
    const total = sizes.reduce((sum, [, bytes]) => sum + bytes, 0);

    const breakdown = sizes.map(([module, bytes]) => `${module} ${bytes}`).join(", ");
    expect(
      total,
      `warm source is ${(total / 1024).toFixed(1)} kB: ${breakdown}`,
    ).toBeLessThanOrEqual(190_000);
  });
});
