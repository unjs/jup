import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
    JSON.stringify({ locator: { name, reference }, bin: spec.bin, hash: "sha512.fake" }),
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
  it("prints a proxy-mode UsageError bare on stderr", () => {
    const sink = capture();
    let code: number;
    try {
      code = presentError(new UsageError("This project is configured to use npm"), {
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

  it("prints a management-mode UsageError on stdout with a usage line", () => {
    const sink = capture();
    let code: number;
    try {
      code = presentError(new UsageError("boom"), {
        mode: "management",
        args: ["use", "yarn@1"],
      });
    } finally {
      sink.restore();
    }

    expect(code).toBe(1);
    expect(sink.err.join("")).toBe("");
    expect(sink.out.join("")).toBe("Usage Error: boom\n\n$ corepack use <pattern>\n");
  });

  it("keeps the stack for anything that is not a UsageError", () => {
    const sink = capture();
    const error = new TypeError("internal");
    try {
      expect(presentError(error, { mode: "proxy", binaryName: "yarn", args: [] })).toBe(1);
      expect(presentError(error, { mode: "management", args: ["use"] })).toBe(1);
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
    // fixture's marker — not the one the compiled-in default happens to carry.
    const pinned = `${versionOf(YARN_DEFAULT)}+sha512.fake`;
    expect(manifest.packageManager).toBe(`yarn@${pinned}`);

    // Verbatim, on stderr, followed by a blank line.
    expect(result.stderr).toBe(
      `${messages.autoPinNotice("yarn", pinned)}\n${messages.autoPinDocs()}\n\n`,
    );
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
