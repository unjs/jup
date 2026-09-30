import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, sep } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "../../src/errors-cold.ts";
import { shimSource } from "../../src/commands/shims.ts";
import { addonPath, extractAddon } from "../../src/run/addon.ts";
import { pathWith, resolveBinPath, SHIM_MARKER } from "../../src/run/exec.ts";
import { execNative } from "../../src/run/native.ts";
import type { BinSpec } from "../../src/types.ts";

/**
 * §08.4's contract is about how a *process* ends, so every one of these cases is
 * run in a real child process: `process.exitCode`, an uncaught error resetting it
 * to 1, and a `beforeExit` hook are all invisible from inside the test runner.
 * The child loads `src/exec.ts` through Node's own type stripping.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(
  new RegExp(`${sep === "\\" ? "\\\\" : sep}$`),
  "",
);
const EXEC_URL = pathToFileURL(join(REPO_ROOT, "src", "run", "exec.ts")).href;

let root: string;
let driver: string;

/** Lay out `<root>/<name>/yarn/<version>/` and write `files` into it. */
function fixture(name: string, files: Record<string, string>, version = "1.0.0"): string {
  const location = join(root, name, "yarn", version);
  for (const [relative, content] of Object.entries(files)) {
    const target = join(location, relative);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, content);
  }
  mkdirSync(location, { recursive: true });
  return location;
}

function run(
  location: string,
  binName: string,
  bin: BinSpec,
  args: string[] = [],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(
    process.execPath,
    [driver, location, binName, JSON.stringify(bin), ...args],
    { encoding: "utf8" },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

beforeAll(() => {
  // realpath: macOS puts `$TMPDIR` behind a symlink (`/var` -> `/private/var`),
  // and the tool reports the paths it resolves — every assertion here that quotes
  // one back would compare the two spellings.
  root = realpathSync(mkdtempSync(join(tmpdir(), "jup-exec-")));
  driver = join(root, "driver.mjs");
  writeFileSync(
    driver,
    [
      `import { execPackageManager } from ${JSON.stringify(EXEC_URL)};`,
      `const [location, binName, binJson, ...args] = process.argv.slice(2);`,
      // `handover: true` — this driver stands in for §10's shims and for
      // `bin/jup.mjs`, the two callers for whom §08.2's in-process handover is
      // correct. `runMain`'s default is the isolated path (`RunOptions`), which
      // the driver below exercises.
      `execPackageManager(binName, { location, bin: JSON.parse(binJson), hash: "" }, args, undefined, undefined, undefined, { handover: true });`,
      ``,
    ].join("\n"),
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// Every env stub is undone between cases, whether or not the case that set it
// reached its own last line. A failing assertion used to leave `COREPACK_HOME`
// pointing at the runtime's own prefix for the rest of the file, which turns one
// failure into a page of them; `shims.test.ts` and `cli.test.ts` both hook it
// here for the same reason.
afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * A `COREPACK_HOME` below a regular file: nothing can be created in it, so a run
 * that would write §08.3.3's addon on demand finds none and keeps the relay.
 */
function unwritableHome(): string {
  const blocker = join(root, "not-a-directory");
  writeFileSync(blocker, "");
  return join(blocker, "home");
}

describe("resolveBinPath — §08.1", () => {
  it("resolves a bin map entry against the install location", () => {
    const spec = {
      location: join(root, "map", "yarn", "1.0.0"),
      bin: { yarn: "./bin/yarn.js" },
      hash: "",
    };
    expect(resolveBinPath("yarn", spec)).toBe(join(spec.location, "bin", "yarn.js"));
  });

  // §02.4 — "one file, two names" is a map with two keys, which is also the
  // shape a single-file URL install records (§07.7).
  it("resolves two declared names to the same file", () => {
    const spec = {
      location: join(root, "single", "yarn", "4.0.0"),
      bin: { yarn: "./yarn.js", yarnpkg: "./yarn.js" },
      hash: "",
    };
    expect(resolveBinPath("yarn", spec)).toBe(join(spec.location, "yarn.js"));
    expect(resolveBinPath("yarnpkg", spec)).toBe(join(spec.location, "yarn.js"));
  });

  it("leaves the path unset for a bin name that is not declared", () => {
    const spec = {
      location: join(root, "map", "yarn", "1.0.0"),
      bin: { yarn: "./bin/yarn.js" },
      hash: "",
    };
    expect(() => resolveBinPath("yarnpkg", spec)).toThrow(
      messages.assertUnableToLocateBinPath("yarnpkg"),
    );
  });

  it("does not treat inherited object properties as declared bins", () => {
    const spec = { location: join(root, "map", "yarn", "1.0.0"), bin: {} as BinSpec, hash: "" };
    expect(() => resolveBinPath("constructor", spec)).toThrow(
      messages.assertUnableToLocateBinPath("constructor"),
    );
  });

  /*
   * §08.1's first line is `bin := installSpec.bin ?? spec.bin`. §07.7 always
   * records a `bin`, so the fallback stands in for a marker jup did not write —
   * §07.10 promotes those out of somebody else's archive.
   */
  describe("a marker without a bin (§08.1's `?? spec.bin`)", () => {
    it("falls back to the table spec's bin map", () => {
      const spec = { location: join(root, "map", "yarn", "1.0.0"), hash: "" };
      expect(resolveBinPath("yarn", spec, { yarn: "./bin/yarn.js" })).toBe(
        join(spec.location, "bin", "yarn.js"),
      );
    });

    it("asserts rather than crashing when there is no fallback either", () => {
      const spec = { location: join(root, "map", "yarn", "1.0.0"), hash: "" };
      // Not a `TypeError` from reading a property of `undefined`: §12.8's
      // assertion, which says which bin could not be located.
      expect(() => resolveBinPath("yarn", spec)).toThrow(
        messages.assertUnableToLocateBinPath("yarn"),
      );
    });

    it("prefers the marker's own bin when it has one", () => {
      const spec = {
        location: join(root, "map", "yarn", "1.0.0"),
        bin: { yarn: "./bin/yarn.js" },
        hash: "",
      };
      expect(resolveBinPath("yarn", spec, { yarn: "./other.js" })).toBe(
        join(spec.location, "bin", "yarn.js"),
      );
    });
  });
});

describe("execPackageManager — §08.4 exit codes", () => {
  it("test 132 — a synchronously set exit code 42 is the tool's exit code", () => {
    const location = fixture("sync", { "bin/yarn.js": `process.exitCode = 42;\n` });
    const result = run(location, "yarn", { yarn: "./bin/yarn.js" });
    expect(result.status).toBe(42);
  });

  it("test 133 — exit code 42 then an uncaught error exits 1, with the message on stderr", () => {
    const location = fixture("throw", {
      "bin/yarn.js": `process.exitCode = 42;\nthrow new Error("kaboom-from-the-package-manager");\n`,
    });
    const result = run(location, "yarn", { yarn: "./bin/yarn.js" });
    // The runtime's own rule, which the tool must not override (corepack 0.18.1).
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("kaboom-from-the-package-manager");
  });

  it("test 133b — an asynchronously thrown error also exits 1 rather than 42", () => {
    const location = fixture("throw-async", {
      "bin/yarn.js": `process.exitCode = 42;\nsetTimeout(() => { throw new Error("late-kaboom"); }, 0);\n`,
    });
    const result = run(location, "yarn", { yarn: "./bin/yarn.js" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("late-kaboom");
  });

  it("test 134 — an exit code set only in a beforeExit hook survives", () => {
    const location = fixture("before-exit", {
      "bin/yarn.js": `process.on("beforeExit", () => { process.exitCode = 42; });\n`,
    });
    const result = run(location, "yarn", { yarn: "./bin/yarn.js" });
    expect(result.status).toBe(42);
  });

  it("a package manager that returns normally exits 0", () => {
    const location = fixture("clean", { "bin/yarn.js": `console.log("ran");\n` });
    const result = run(location, "yarn", { yarn: "./bin/yarn.js" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("ran\n");
  });
});

describe("execPackageManager — §08.2 handover", () => {
  it("test 135 — an ESM entry point runs", () => {
    const location = fixture("esm", {
      "package.json": `{"type":"module"}\n`,
      "bin/yarn.js": [
        `import { pathToFileURL } from "node:url";`,
        `console.log("esm-ok", import.meta.url === pathToFileURL(process.argv[1]).href);`,
        ``,
      ].join("\n"),
    });
    const result = run(location, "yarn", { yarn: "./bin/yarn.js" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("esm-ok true\n");
  });

  it("a CJS entry point runs as require.main (npm 6 and pnpm 4 read its filename)", () => {
    const location = fixture("cjs", {
      "bin/yarn.js": `console.log("main:", require.main.filename, "execArgv:", JSON.stringify(process.execArgv));\n`,
    });
    const result = run(location, "yarn", { yarn: "./bin/yarn.js" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`main: ${join(location, "bin", "yarn.js")} execArgv: []\n`);
  });

  it("test 136 — every name a bin map declares runs the same file", () => {
    const location = fixture(
      "twonames",
      { "yarn.js": `console.log(process.argv[1], JSON.stringify(process.argv.slice(2)));\n` },
      "4.0.0",
    );
    const bin = { yarn: "./yarn.js", yarnpkg: "./yarn.js" };
    const yarn = run(location, "yarn", bin, ["--version"]);
    const yarnpkg = run(location, "yarnpkg", bin, ["--version"]);
    expect(yarn.status).toBe(0);
    expect(yarnpkg.status).toBe(0);
    expect(yarn.stdout).toBe(`${join(location, "yarn.js")} ["--version"]\n`);
    // Both names run the same file, with the same argv.
    expect(yarnpkg.stdout).toBe(yarn.stdout);
  });

  it("passes the arguments through untouched after argv[0] and argv[1]", () => {
    const location = fixture("argv", {
      "bin/yarn.js": `console.log(JSON.stringify([process.argv[0] === process.execPath, process.argv.slice(1)]));\n`,
    });
    const result = run(location, "yarn", { yarn: "./bin/yarn.js" }, ["add", "-D", "--", "x y"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      true,
      [join(location, "bin", "yarn.js"), "add", "-D", "--", "x y"],
    ]);
  });
});

describe("execPackageManager — §08.7 environment", () => {
  it("test 51 — COREPACK_ROOT points at our own installation root and is visible to the child", () => {
    const location = fixture("env", {
      "bin/yarn.js": `console.log(process.env.COREPACK_ROOT);\n`,
    });
    const result = run(location, "yarn", { yarn: "./bin/yarn.js" });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(REPO_ROOT);
  });
});

describe("resolveBinPath — §08.1 confinement", () => {
  it("test 141 — a bin value escaping the install directory is refused", () => {
    const spec = {
      location: join(root, "evil", "yarn", "1.0.0"),
      bin: { yarn: "../../../evil" },
      hash: "",
    };
    expect(() => resolveBinPath("yarn", spec)).toThrow(
      messages.binEscapes("../../../evil", "yarn", "1.0.0"),
    );
  });

  it("test 141 — the escaping bin is refused before anything is executed", () => {
    const location = fixture("evil", { "bin/yarn.js": `console.log("should not run");\n` });
    // Plant the file the malicious bin points at, so a missing target cannot be
    // what makes this test pass.
    writeFileSync(join(root, "evil.js"), `console.log("pwned");\n`);
    const result = run(location, "yarn", { yarn: "../../../evil.js" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(messages.binEscapes("../../../evil.js", "yarn", "1.0.0"));
  });

  it("refuses an absolute bin path", () => {
    const spec = {
      location: join(root, "abs", "yarn", "1.0.0"),
      bin: { yarn: "/etc/passwd" },
      hash: "",
    };
    expect(() => resolveBinPath("yarn", spec)).toThrow(
      messages.binEscapes("/etc/passwd", "yarn", "1.0.0"),
    );
  });

  it("accepts a bin path that only looks like it escapes", () => {
    const spec = {
      location: join(root, "ok", "yarn", "1.0.0"),
      bin: { yarn: "./bin/../bin/yarn.js" },
      hash: "",
    };
    expect(resolveBinPath("yarn", spec)).toBe(join(spec.location, "bin", "..", "bin", "yarn.js"));
  });
});

/* ------------------------------------------------------------------ *
 * §10.2 — the forwarded host runtime
 *
 * `node` is a table entry (§02.3), so a native handover can be *the
 * runtime itself*: our `node` shim resolves the project's version and
 * spawns it, and everything below that point — a nested `jup enable`
 * most of all — has a `process.execPath` inside the store. `enable`
 * must not bake that into a shebang, so the last process outside the
 * store leaves its realpath in the child's environment for it.
 *
 * `execNative` inherits stdio, so the probe writes what it saw to a
 * file rather than to a pipe.
 * ------------------------------------------------------------------ */

describe.skipIf(process.platform === "win32")("§10.2 — JUP_HOST_RUNTIME", () => {
  /** Both spellings (§11.6), one per line, into the file named as `$1`. */
  function probe(): string {
    const file = join(root, "probe.sh");
    writeFileSync(
      file,
      `#!/bin/sh\nprintf '%s\\n%s\\n' "$JUP_HOST_RUNTIME" "$JUP_HOST_RUNTIME" > "$1"\n`,
    );
    chmodSync(file, 0o755);
    return file;
  }

  async function observed(env: NodeJS.ProcessEnv): Promise<[string, string]> {
    const out = join(root, `host-runtime-${Math.random().toString(16).slice(2)}`);
    expect(await execNative(probe(), [out], env)).toBe(0);
    const [corepack, jup] = readFileSync(out, "utf8").split("\n");
    return [corepack!, jup!];
  }

  it("writes the realpath of the runtime spawning the child, under both spellings", async () => {
    expect(await observed({ ...process.env })).toEqual([
      realpathSync(process.execPath),
      realpathSync(process.execPath),
    ]);
  });

  it("writes into the child's environment and never into our own", async () => {
    // `env` defaults to `process.env`, so a forward that wrote *into* the object
    // it was handed would set `JUP_HOST_RUNTIME` on this process for the
    // rest of its life — §03.2 refuses that same value from an env file, and a
    // mutating default is the only other way into it. Called the way the
    // signature permits, with no environment of the caller's own.
    const out = join(root, "host-runtime-default-env");
    expect(await execNative(probe(), [out])).toBe(0);

    expect(readFileSync(out, "utf8").split("\n").slice(0, 2)).toEqual([
      realpathSync(process.execPath),
      realpathSync(process.execPath),
    ]);
    expect(process.env.JUP_HOST_RUNTIME).toBeUndefined();
    expect(process.env.JUP_HOST_RUNTIME).toBeUndefined();
  });

  it("passes an inherited value through when our own runtime is in the store", async () => {
    // The position a store runtime is in, without a 126 MB copy of one: a
    // `<home>` whose `v1` *is* the installation holding the runtime this test
    // runs under. §10.2's boundary test resolves the install folder through
    // `realpath`, so the link makes `process.execPath` answer exactly as
    // `<home>/v1/node/22.14.0/bin/node` would.
    //
    // `<home>` on its own is no longer enough, and that is the point of the
    // link: §07.11's `self/` — and a runtime an install script parks beside
    // it — are siblings of `v1` that `cache clean` deliberately cannot reach,
    // so a path under `<home>` but outside `v1` is *not* a store runtime.
    const home = join(root, "store-home");
    mkdirSync(home, { recursive: true });
    symlinkSync(dirname(dirname(realpathSync(process.execPath))), join(home, "v1"));
    vi.stubEnv("COREPACK_HOME", home);

    const inherited = "/opt/hostnode/bin/node";
    expect(
      await observed({
        ...process.env,
        JUP_HOST_RUNTIME: inherited,
      }),
    ).toEqual([inherited, inherited]);

    // And it is not invented either: a chain that started inside the store has
    // nothing to forward, and `enable` falls through to its `PATH` walk.
    expect(await observed({ ...process.env })).toEqual(["", ""]);
  });
});

/* ------------------------------------------------------------------ *
 * §08.3.2 — the IPC channel, relayed rather than swallowed
 *
 * #7: `stdio: "inherit"` is fds 0, 1 and 2, so a caller that spawned a
 * shim with an `ipc` slot had its channel end at the shim — the runtime
 * it meant to talk to came up with `process.send === undefined` and
 * every handshake hung. Each case here is a real three-process chain,
 * because a channel that exists only inside one process proves nothing:
 * this test is the caller, the driver is the shim, and the probe stands
 * in for the runtime handed over to.
 * ------------------------------------------------------------------ */

describe("§08.3.2 — IPC", () => {
  // A home no addon can be written into, so the shim cannot replace itself
  // (§08.3.3) and what is under test is the relay.
  beforeEach(() => {
    vi.stubEnv("COREPACK_HOME", unwritableHome());
  });

  /** The runtime a shim hands over to: answers a message, then disconnects. */
  function probe(): string {
    const file = join(root, "ipc-probe.mjs");
    writeFileSync(
      file,
      [
        `process.send?.({ send: typeof process.send });`,
        `process.on("message", (m) => {`,
        `  process.send?.({ echo: m });`,
        `  process.disconnect();`,
        // Outlive the disconnect, so a caller that saw one saw it *relayed*
        // rather than inferred from this chain ending.
        `  setTimeout(() => {}, 500);`,
        `});`,
        ``,
      ].join("\n"),
    );
    return file;
  }

  /** A runtime that answers once and exits, so the *shim* disconnects first. */
  function briefProbe(): string {
    const file = join(root, "ipc-brief-probe.mjs");
    writeFileSync(file, `process.send?.({ send: typeof process.send });\n`);
    return file;
  }

  /**
   * The shim: `execNative` with §08.3.2's `ipc` on or off, standing in for the
   * `handover` the real stubs pass.
   */
  function shim(ipc: boolean): string {
    const file = join(root, `ipc-shim-${ipc}.mjs`);
    writeFileSync(
      file,
      [
        `const { execNative } = await import(${JSON.stringify(
          pathToFileURL(join(REPO_ROOT, "src", "run", "native.ts")).href,
        )});`,
        // `replace` rides with `ipc`, as it does from a real shim. The suite's
        // home holds no addon, so the channel keeps the relay (§08.3.3).
        `const code = await execNative(process.execPath, [process.argv[2]], { ...process.env },`,
        `  undefined, { reraise: false, ipc: ${ipc}, replace: ${ipc} });`,
        `process.exitCode = code;`,
        ``,
      ].join("\n"),
    );
    return file;
  }

  /**
   * Run the chain and collect what the caller saw.
   *
   * A message is always sent back, because the probe's `message` listener is
   * what keeps it alive: an answer is also how it is told to finish.
   */
  function chain(
    ipc: boolean,
    send: unknown = { hello: "world" },
  ): Promise<{ seen: unknown[]; heldOpenMs: number }> {
    const child = spawn(process.execPath, [shim(ipc), probe()], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const seen: unknown[] = [];
    let disconnectedAt = 0;
    let heldOpenMs = 0;
    child.on("message", (message: unknown) => {
      seen.push(message);
      if (seen.length === 1) child.send(send as never, () => {});
    });
    child.on("disconnect", () => {
      disconnectedAt = Date.now();
    });
    // How long the chain outlived the channel closing. Every chain ends with a
    // `disconnect`, relayed or not — the shim exiting closes the caller's
    // channel too — so the *fact* of one proves nothing and the gap is the whole
    // assertion: the probe holds itself open for 500 ms after disconnecting, and
    // only a relayed disconnect can reach the caller inside that window.
    child.on("exit", () => {
      heldOpenMs = disconnectedAt === 0 ? 0 : Date.now() - disconnectedAt;
    });
    return new Promise((resolve) => {
      child.on("close", () => resolve({ seen, heldOpenMs }));
    });
  }

  it("reaches the runtime, so `process.send` is a function there", async () => {
    const { seen } = await chain(true);
    expect(seen[0]).toEqual({ send: "function" });
  });

  it("carries messages the other way too", async () => {
    const { seen } = await chain(true, { hello: "world" });
    expect(seen).toEqual([{ send: "function" }, { echo: { hello: "world" } }]);
  });

  it("relays the runtime's `disconnect` up to the caller", async () => {
    const { heldOpenMs } = await chain(true);
    expect(heldOpenMs).toBeGreaterThan(150);
  });

  /**
   * Node's EOF handler calls `process.disconnect()` unconditionally, so a shim
   * that already disconnected is handed an `ERR_IPC_DISCONNECTED` *event* — not
   * a throw — on a `process` nothing else emits `error` on, and dies with a
   * stack where the tool's exit code belongs.
   *
   * The window is real rather than theoretical: `Bun.spawn`'s default
   * `serialization: "advanced"` cannot read the JSON any Node child writes, and
   * hangs up on the first byte it fails to parse. Reproduced here without bun by
   * owning the channel's bytes: fd 3 is an ordinary pipe the case writes into,
   * named to the shim through `NODE_CHANNEL_FD` the way Node's own `ipc` slot
   * names it. A message with no terminator leaves the shim mid-read, which is
   * what keeps its channel handle open past its own disconnect; the hang-up then
   * lands on it. The probe exits on its own so that the shim disconnects first,
   * which is the whole of the window.
   *
   * The hand-built channel is also why this case, alone in this block, is POSIX:
   * a real `ipc` slot frames its messages, so half of one can only be written by
   * owning the bytes, and an ordinary `pipe` slot is what gives that. Node builds
   * the two differently — `Pipe(IPC)` against `Pipe(SOCKET)`, and `readable:
   * false, writable: true` for anything past fd 2 — and only POSIX makes the
   * difference vanish, where both are socketpairs and duplex whatever the flags
   * say. On Windows they are named pipes created as asked, so the read half this
   * borrows is not there. The behaviour under test is not POSIX-only; this way of
   * provoking it is, and the four cases above run everywhere.
   */
  it.skipIf(process.platform === "win32")(
    "survives a caller that hangs up mid-message",
    async () => {
      const child = spawn(process.execPath, [shim(true), briefProbe()], {
        stdio: ["ignore", "ignore", "inherit", "pipe"],
        env: { ...process.env, NODE_CHANNEL_FD: "3" },
      });
      const channel = child.stdio[3] as unknown as Duplex;
      channel.write('{"never terminated":');
      channel.on("data", () => channel.destroy());

      const [code] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
        child.on("exit", (status, signal) => resolve([status, signal]));
      });
      // 0 is the probe's own status. 1 was `ERR_IPC_DISCONNECTED` on stderr.
      expect(code).toBe(0);
    },
  );

  // The gate is `handover` (§08.3.2): a host application that called `runMain`
  // mid-script owns its own channel, and a relay there would hand the tool
  // messages meant for the caller. Without it the old behaviour stands, which is
  // what the row below records rather than endorses.
  it("leaves the channel alone for a caller that is not a shim", async () => {
    const { seen } = await chain(false);
    expect(seen).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * §08.3.3 — the shim becomes the tool
 *
 * #8: a spawned runtime is a second pid, so the one a caller holds is
 * the wrapper's. `SIGKILL` killed only the wrapper, and the runtime —
 * reparented to init — kept its ports, its stdio and its children's IPC
 * channels open. Every case is a real two-process chain: this test is
 * the caller, the driver is the shim, and a `#!/bin/sh` probe is the
 * tool, because `$$` is the pid the kernel actually gave it.
 * ------------------------------------------------------------------ */

/**
 * Run twice: once through `process.execve`, with a home holding no addon, and
 * once through the addon `enable` extracts — which must pass every case the
 * first does, and then carry an IPC channel as well.
 */
const REPLACEMENT_MODES = [
  { mode: "process.execve", addon: false },
  { mode: "the addon", addon: true },
].filter(({ addon }) => (addon ? addonPath() !== undefined : typeof process.execve === "function"));

describe
  .skipIf(process.platform === "win32" || REPLACEMENT_MODES.length === 0)
  .each(REPLACEMENT_MODES)("§08.3.3 — process replacement through $mode", ({ addon }) => {
  let home: string;

  beforeAll(() => {
    // Without the addon, a home it cannot be extracted into on demand either.
    home = addon ? join(root, "replace-home") : unwritableHome();
    if (addon) {
      mkdirSync(home, { recursive: true });
      vi.stubEnv("COREPACK_HOME", home);
      const extracted = extractAddon();
      vi.unstubAllEnvs();
      expect(extracted).toBe(join(home, "addon", addonPath()!.split(sep).pop()!));
    }
  });

  beforeEach(() => {
    vi.stubEnv("COREPACK_HOME", home);
  });

  const NATIVE_URL = pathToFileURL(join(REPO_ROOT, "src", "run", "native.ts")).href;
  const LOG_URL = pathToFileURL(join(REPO_ROOT, "src", "utils", "log.ts")).href;
  /** A shim prelude that prints through jup's own writer, as a notice does. */
  const NOTICE = `(await import(${JSON.stringify(LOG_URL)})).err("notice\\n");`;

  /** An executable `#!/bin/sh` script. */
  function tool(name: string, body: string): string {
    const file = join(root, `replace-${name}.sh`);
    writeFileSync(file, `#!/bin/sh\n${body}\n`);
    chmodSync(file, 0o755);
    return file;
  }

  let shims = 0;

  /**
   * The shim: `execNative` as a handover calls it, or with every handover
   * option off. `prelude` runs first, for a case that needs the shim to have
   * done something before it hands over; `wrap` names the call, for a case
   * that has to make it from somewhere other than the main thread.
   */
  function shim(replace: boolean, prelude: string[] = []): string {
    const file = join(root, `replace-shim-${addon}-${(shims += 1)}.mjs`);
    writeFileSync(
      file,
      [
        ...prelude,
        `const { execNative } = await import(${JSON.stringify(NATIVE_URL)});`,
        `const [bin, ...args] = process.argv.slice(2);`,
        `const options = { reraise: ${replace}, ipc: ${replace}, replace: ${replace} };`,
        `await execNative(bin, args, { ...process.env }, undefined, options).then(`,
        `  (code) => { process.exitCode = code; },`,
        `  (error) => { console.error(error.message); process.exitCode = 1; },`,
        `);`,
        ``,
      ].join("\n"),
    );
    return file;
  }

  function runShim(replace: boolean, bin: string, args: string[] = [], prelude: string[] = []) {
    return spawnSync(process.execPath, [shim(replace, prelude), bin, ...args], {
      encoding: "utf8",
    });
  }

  /** Resolve with the first line the chain prints, and the chain itself. */
  function start(replace: boolean, bin: string): Promise<[number, ReturnType<typeof spawn>]> {
    const child = spawn(process.execPath, [shim(replace), bin], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    return new Promise((resolve) => {
      let text = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        if (text.includes("\n")) resolve([Number(text.split("\n")[0]), child]);
      });
    });
  }

  function alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it("hands the caller the tool's pid", async () => {
    const [pid, child] = await start(true, tool("pid", "echo $$"));
    expect(pid).toBe(child.pid);
  });

  it("keeps a caller that is not a shim on the spawn, and its second pid", async () => {
    const [pid, child] = await start(false, tool("pid", "echo $$"));
    expect(pid).not.toBe(child.pid);
  });

  it("lets `SIGKILL` on that pid reach the tool, leaving nothing orphaned", async () => {
    // `exec`, so `sleep` keeps the pid the script printed.
    const [pid, child] = await start(true, tool("sleep", "echo $$\nexec sleep 30"));
    const exited = new Promise((resolve) => child.on("exit", (...status) => resolve(status)));
    child.kill("SIGKILL");
    expect(await exited).toEqual([null, "SIGKILL"]);
    expect(alive(pid)).toBe(false);
  });

  it("hands the tool its arguments, and the caller its exit code and death", () => {
    const echo = runShim(true, tool("args", 'printf "%s|" "$@"\nexit 7'), ["a b", "--c"]);
    expect(echo.stdout).toBe("a b|--c|");
    expect(echo.status).toBe(7);

    const killed = runShim(true, tool("kill", "kill -TERM $$"));
    expect(killed.signal).toBe("SIGTERM");
  });

  it.skipIf(process.platform !== "linux")(
    "does not hand the tool the signals Node's startup ignores",
    () => {
      const result = runShim(true, tool("sigign", "grep SigIgn /proc/$$/status"));
      const ignored = BigInt(`0x${/SigIgn:\s*([0-9a-f]+)/.exec(result.stdout)?.[1] ?? "ff"}`);
      // Bit N-1 for signal N: SIGPIPE is 13, SIGXFSZ is 25. A spawned tool has
      // both at their default, because libuv resets every disposition.
      expect(ignored & (1n << 12n)).toBe(0n);
      expect(ignored & (1n << 24n)).toBe(0n);
    },
  );

  it.skipIf(process.platform !== "linux")(
    "flushes what the shim printed, and leaves a piped stderr blocking",
    () => {
      // A notice through the shim's own writer constructs the stream, and with
      // it libuv's non-blocking pipe — the state Node undoes only at exit.
      const result = runShim(true, tool("flags", "grep flags /proc/$$/fdinfo/2"), [], [NOTICE]);
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("notice\n");
      const flags = Number.parseInt(/flags:\s*([0-7]+)/.exec(result.stdout)?.[1] ?? "4000", 8);
      expect(flags & 0o4000).toBe(0);
    },
  );

  it("runs the tool when the caller has hung up a stream the shim never wrote", async () => {
    // The caller closes stdout; the shim writes its notice to stderr. Touching
    // stdout on the way out used to raise an unheard `EPIPE`, and jup died with
    // it before the tool — which here only exits — was ever run.
    // The pause lets the hang-up land before the shim touches any stream, so the
    // `EPIPE` is certain rather than a race against `execve`.
    const pause = `await new Promise((resolve) => setTimeout(resolve, 100));`;
    const child = spawn(process.execPath, [shim(true, [pause, NOTICE]), tool("exit", "exit 7")], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout!.destroy();
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const [code] = await new Promise<[number | null]>((resolve) =>
      child.on("close", (status) => resolve([status])),
    );
    expect(stderr).toBe("notice\n");
    expect(code).toBe(7);
  });

  it("spawns from a worker thread, where `execve` refuses, without its warning", () => {
    const driver = join(root, "replace-worker.mjs");
    writeFileSync(
      driver,
      [
        `import { Worker } from "node:worker_threads";`,
        `const [bin] = process.argv.slice(2);`,
        `const source = \`const { execNative } = await import(\${JSON.stringify(${JSON.stringify(NATIVE_URL)})});`,
        `const code = await execNative(\${JSON.stringify(bin)}, [], { ...process.env }, undefined, { replace: true, reraise: false });`,
        `(await import("node:worker_threads")).parentPort.postMessage(code);\`;`,
        `new Worker(new URL("data:text/javascript," + encodeURIComponent(source)))`,
        `  .on("message", (code) => { process.exitCode = code; });`,
        ``,
      ].join("\n"),
    );
    const result = spawnSync(process.execPath, [driver, tool("exit", "exit 7")], {
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(7);
  });

  /*
   * Every case below is a file `execve` would refuse. Node aborts on that —
   * `SIGABRT`, a native stack and its own errno line — where a spawn reports
   * §12.8's sentence, so each asserts the sentence *and* that nothing aborted.
   */

  it("leaves a file without the execute bit to the spawn, which names it", () => {
    const file = join(root, "replace-data");
    writeFileSync(file, "not a program\n");
    chmodSync(file, 0o644);
    const result = runShim(true, file);
    expect(result.signal).toBe(null);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(messages.cannotExecute(file, "EACCES"));
  });

  it("leaves a script whose interpreter is missing to the spawn", () => {
    const file = join(root, "replace-no-interpreter");
    writeFileSync(file, "#!/nonexistent/jup-test-sh\nexit 0\n");
    chmodSync(file, 0o755);
    const result = runShim(true, file);
    expect(result.signal).toBe(null);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(messages.cannotExecute(file, "ENOENT"));
  });

  it("leaves an executable with no program header to the spawn", () => {
    // No magic at all: what happens next is the spawn's, whichever way it
    // goes — `/bin/sh` runs it on glibc — and is not an abort.
    const file = join(root, "replace-no-header");
    writeFileSync(file, "exit 7\n");
    chmodSync(file, 0o755);
    const result = runShim(true, file);
    expect(result.signal).toBe(null);
    expect(result.stderr).not.toContain("process.execve failed");
  });

  it.skipIf(process.platform !== "linux")(
    "leaves an environment string past `MAX_ARG_STRLEN` to the spawn",
    () => {
      // Set inside the shim: a caller cannot hand one over, because its own
      // spawn of the shim would be refused first. A project env file can.
      const big = `process.env.JUP_TEST_BIG = "x".repeat(200 * 1024);`;
      const file = tool("big-env", "exit 0");
      const result = runShim(true, file, [], [big]);
      expect(result.signal).toBe(null);
      expect(result.status).toBe(1);
      // The spawn's own refusal, thrown from `spawn` itself rather than raised
      // as §12.8's `error` event — as it was before replacement existed.
      expect(result.stderr).toContain("E2BIG");
      expect(result.stderr).not.toContain("process.execve failed");
    },
  );

  it.skipIf(process.platform !== "linux")(
    "leaves an ELF whose loader is missing to the spawn",
    (context) => {
      // `/bin/true`, with the loader it names renamed to one that does not
      // exist: what a glibc build of a tool looks like on a host without glibc.
      const image = readFileSync("/bin/true");
      const loader = /\/[^\0]*ld-[^\0]*\.so[^\0]*/.exec(image.toString("latin1"));
      if (loader === null) return context.skip();
      const broken = Buffer.from(image);
      broken.write("/nonexistent".padEnd(loader[0].length, "x"), loader.index, "latin1");
      const file = join(root, "replace-no-loader");
      writeFileSync(file, broken);
      chmodSync(file, 0o755);

      const result = runShim(true, file);
      expect(result.signal).toBe(null);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(messages.cannotExecute(file, "ENOENT"));
    },
  );

  it.skipIf(process.platform !== "linux" || (process.arch !== "x64" && process.arch !== "arm64"))(
    "leaves an ELF whose program headers the kernel rejects to the spawn",
    () => {
      // `/bin/true` with an empty program-header table, then with entries of
      // the wrong size: both `ENOEXEC` in the kernel, both once accepted here.
      const image = readFileSync("/bin/true");
      for (const [field, value] of [
        [56, 0], // e_phnum
        [54, 64], // e_phentsize
      ] as const) {
        const broken = Buffer.from(image);
        broken.writeUInt16LE(value, field);
        const file = join(root, `replace-bad-phdr-${field}`);
        writeFileSync(file, broken);
        chmodSync(file, 0o755);

        const result = runShim(true, file);
        expect(result.signal).toBe(null);
        expect(result.stderr).not.toContain("process.execve failed");
      }
    },
  );

  /*
   * The IPC channel (#8's own repro): a caller that `fork`s the shim. Only the
   * addon can hand the channel through; `process.execve` keeps §08.3.2's relay,
   * and with it the second pid.
   */

  /** §10.1's stub lines: stop Node reading the channel before the loop turns. */
  const HOLD_CHANNEL = [
    `const channel = process.channel && process[Object.getOwnPropertySymbols(process).find((key) => key.description === "kChannelHandle")];`,
    `channel?.readStop?.();`,
  ];
  /** The work a cold run does before it hands over: the loop turns. */
  const PAUSE = `await new Promise((resolve) => setTimeout(resolve, 100));`;

  /** Every chain a case forked, killed after it so a hung one cannot hold the run open. */
  const forked = new Set<ReturnType<typeof spawn>>();
  afterEach(() => {
    for (const child of forked) child.kill("SIGKILL");
    forked.clear();
  });

  /** A Node tool that reports its pid, counts messages, and answers `done`. */
  function ipcTool(): string {
    const file = join(root, "replace-ipc-tool.mjs");
    writeFileSync(
      file,
      [
        `let count = 0;`,
        `let maps = 0;`,
        `process.send({ pid: process.pid });`,
        `process.on("message", (message) => {`,
        `  count += 1;`,
        `  if (message instanceof Map) maps += 1;`,
        `  if (message !== "done") return;`,
        `  process.send({ count, maps, back: new Map([[1, 2]]) });`,
        `  process.disconnect();`,
        `});`,
        ``,
      ].join("\n"),
    );
    return file;
  }

  /**
   * Fork the shim with the tool, send `burst` messages before it can have
   * handed over, and collect what comes back.
   */
  function forkChain(
    prelude: string[],
    options: { burst?: number; serialization?: "json" | "advanced"; kill?: boolean } = {},
  ): Promise<{ pid: number; seen: unknown[]; child: ReturnType<typeof spawn> }> {
    const child = spawn(process.execPath, [shim(true, prelude), process.execPath, ipcTool()], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      serialization: options.serialization ?? "json",
    });
    forked.add(child);
    const advanced = options.serialization === "advanced";
    for (let index = 0; index < (options.burst ?? 100); index += 1) {
      child.send(advanced ? new Map([[index, index]]) : index);
    }
    if (options.kill !== true) child.send("done");
    const seen: unknown[] = [];
    return new Promise((resolve) => {
      child.on("message", (message: { pid?: number }) => {
        seen.push(message);
        if (options.kill === true && message.pid !== undefined) {
          resolve({ pid: message.pid, seen, child });
        }
      });
      child.on("close", () =>
        resolve({ pid: (seen[0] as { pid: number } | undefined)?.pid ?? 0, seen, child }),
      );
    });
  }

  it(`${addon ? "hands" : "relays"} a held channel to the tool, every message included`, async () => {
    // Without the addon the stub's hold must still be released, or the relay
    // reads nothing and the tool waits for ever.
    const { pid, seen, child } = await forkChain([...HOLD_CHANNEL, PAUSE]);
    expect(pid === child.pid).toBe(addon);
    expect(seen[1]).toEqual({ count: 101, maps: 0, back: {} });
  });

  it.runIf(addon)('keeps `serialization: "advanced"` advanced for the tool', async () => {
    const { pid, seen, child } = await forkChain(HOLD_CHANNEL, { serialization: "advanced" });
    expect(pid).toBe(child.pid);
    expect(seen[1]).toEqual({ count: 101, maps: 100, back: new Map([[1, 2]]) });
  });

  it("relays an `advanced` channel to a tool that is not Node", async () => {
    // bun and deno cannot read Node's `advanced` framing, so only a `node` tool
    // may be handed it; anything else keeps the relay, which speaks JSON to it.
    const prelude = [
      ...HOLD_CHANNEL,
      `const { execNative: run } = await import(${JSON.stringify(NATIVE_URL)});`,
      `process.exitCode = await run(process.execPath, [${JSON.stringify(ipcTool())}], { ...process.env }, "bun", { reraise: true, ipc: true, replace: true });`,
      // Exit with the tool's status before the shim's own `execNative` runs.
      `process.exit(process.exitCode);`,
    ];
    const { pid, seen, child } = await forkChain(prelude, { serialization: "advanced" });
    expect(pid).not.toBe(child.pid);
    expect(seen[1]).toEqual({ count: 101, maps: 0, back: {} });
  });

  /**
   * The real §10.1 stub, from `shimSource`, around a stand-in entry: the hold
   * and its release are the stub's own lines, not a copy of them.
   */
  function realStub(kind: "js" | "native"): string {
    const folder = join(root, `replace-stub-${addon}-${kind}`);
    mkdirSync(folder, { recursive: true });
    const tool = ipcTool();
    writeFileSync(
      join(folder, "entry.mjs"),
      [
        `export async function runMain() {`,
        `  await new Promise((resolve) => setTimeout(resolve, 100));`,
        kind === "js"
          ? `  process.nextTick(() => import(${JSON.stringify(pathToFileURL(tool).href)})); return { code: 0 };`
          : `  const { execNative } = await import(${JSON.stringify(NATIVE_URL)});\n` +
            `  return { code: await execNative(process.execPath, [${JSON.stringify(tool)}], { ...process.env }, undefined, { reraise: true, ipc: true, replace: true }) };`,
        `}`,
        ``,
      ].join("\n"),
    );
    const stub = join(folder, "tool.mjs");
    writeFileSync(stub, shimSource("./entry.mjs", "tool"));
    return stub;
  }

  it.each(["js", "native"] as const)(
    "delivers every message through a real stub handing over to a %s tool",
    async (kind) => {
      const child = spawn(process.execPath, [realStub(kind)], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      forked.add(child);
      for (let index = 0; index < 100; index += 1) child.send(index);
      child.send("done");
      const seen: Array<{ pid?: number }> = [];
      child.on("message", (message: { pid?: number }) => seen.push(message));
      await new Promise((resolve) => child.on("close", resolve));
      // In process for JavaScript; replaced for a native tool only by the addon.
      expect(seen[0]?.pid === child.pid).toBe(kind === "js" || addon);
      expect(seen[1]).toEqual({ count: 101, maps: 0, back: {} });
    },
  );

  it.runIf(addon)("writes the addon on demand for a channel, as after an upgrade", async () => {
    // A home `enable` never ran against: the run extracts its own and replaces.
    const fresh = join(root, "replace-home-on-demand");
    vi.stubEnv("COREPACK_HOME", fresh);
    const { pid, seen, child } = await forkChain(HOLD_CHANNEL);
    expect(pid).toBe(child.pid);
    expect(seen[1]).toEqual({ count: 101, maps: 0, back: {} });
    expect(readFileSync(addonPath()!).length).toBeGreaterThan(0);
  });

  it.runIf(addon)("lets `SIGKILL` on a forked shim's pid reach the tool", async () => {
    const { pid, child } = await forkChain(HOLD_CHANNEL, { kill: true, burst: 0 });
    expect(pid).toBe(child.pid);
    const exited = new Promise((resolve) => child.on("exit", (...status) => resolve(status)));
    child.kill("SIGKILL");
    expect(await exited).toEqual([null, "SIGKILL"]);
    expect(alive(pid)).toBe(false);
  });

  it("relays a channel Node has already read from, losing nothing", async () => {
    // No hold: the pause lets Node take the burst off the pipe, which only a
    // relay can still deliver — so the tool keeps a pid of its own.
    const { pid, seen, child } = await forkChain([PAUSE]);
    expect(pid).not.toBe(child.pid);
    expect(seen[1]).toEqual({ count: 101, maps: 0, back: {} });
  });
});

/* ------------------------------------------------------------------ *
 * §08.3 — the resolved package manager on `PATH`
 *
 * #412: a script that shells out to `pnpm` under `corepack pnpm exec`
 * gets a *different* pnpm, or none. Every case below therefore plants a
 * decoy directory on `PATH` first: an assertion that only checked that
 * `pnpm` was findable would pass on the decoy, and prove nothing about
 * the entry the tool added.
 * ------------------------------------------------------------------ */

describe("§08.3 — PATH", () => {
  describe("pathWith", () => {
    it("prepends, with the platform's separator", () => {
      expect(pathWith("/a", "/b")).toBe(`/a${delimiter}/b`);
      expect(pathWith("/a", "/b/a")).toBe(`/a${delimiter}/b/a`);
    });

    it("is the only modification: the rest of PATH is carried through verbatim", () => {
      const current = `/x${delimiter}/y${delimiter}/z`;
      expect(pathWith("/a", current)).toBe(`/a${delimiter}${current}`);
    });

    it("is idempotent, so nesting cannot grow PATH without bound", () => {
      expect(pathWith("/a", `/a${delimiter}/b`)).toBeUndefined();
      expect(pathWith("/a", "/a")).toBeUndefined();
      // A *prefix* of an entry is not that entry.
      expect(pathWith("/a", `/ab${delimiter}/b`)).toBe(`/a${delimiter}/ab${delimiter}/b`);
      // Present but not first: §08.3 says prepend, so it moves to the front.
      expect(pathWith("/a", `/b${delimiter}/a`)).toBe(`/a${delimiter}/b${delimiter}/a`);
    });

    it("handles an absent or empty PATH", () => {
      expect(pathWith("/a", undefined)).toBe("/a");
      expect(pathWith("/a", "")).toBe("/a");
    });
  });

  /**
   * A shim directory holding a stub named `binName`, plus a decoy directory.
   *
   * The stubs carry {@link SHIM_MARKER}, because that banner — not the name — is
   * what §08.3's promotion recognises: the decoy's `yarn` is a file of exactly
   * the right name written by somebody else, and must not move its directory.
   */
  function pathFixture(name: string, binNames: string[]): { shims: string; decoy: string } {
    const shims = join(root, name, "shims");
    const decoy = join(root, name, "decoy");
    mkdirSync(shims, { recursive: true });
    mkdirSync(decoy, { recursive: true });
    for (const binName of binNames) {
      writeFileSync(join(shims, binName), `#!/usr/bin/env node\n// ${SHIM_MARKER} — generated\n`, {
        mode: 0o755,
      });
    }
    writeFileSync(join(decoy, "yarn"), "");
    return { shims, decoy };
  }

  /**
   * The environment is built from nothing rather than from `process.env`: the
   * developer's own `~/.local/bin` is §10.5's default shim directory, so a run
   * that inherited `HOME` could pass on *their* shims.
   */
  function runWithEnv(
    location: string,
    binName: string,
    bin: BinSpec,
    env: Record<string, string>,
  ): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(process.execPath, [driver, location, binName, JSON.stringify(bin)], {
      encoding: "utf8",
      env: { HOME: join(root, "nowhere"), USERPROFILE: join(root, "nowhere"), ...env },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  const REPORT = `console.log(process.env.PATH);\n`;

  it("puts the shim directory in front of everything, including a decoy", () => {
    const location = fixture("path-shim", { "bin/yarn.js": REPORT });
    const { shims, decoy } = pathFixture("path-shim", ["yarn"]);

    const result = runWithEnv(
      location,
      "yarn",
      { yarn: "./bin/yarn.js" },
      {
        JUP_SHIM_DIRECTORY: shims,
        PATH: `${decoy}${delimiter}/usr/bin`,
      },
    );

    expect(result.status).toBe(0);
    // Ours, and first — not the decoy that also answers to `yarn`.
    expect(result.stdout.trim()).toBe(`${shims}${delimiter}${decoy}${delimiter}/usr/bin`);
  });

  /**
   * §16 — the zero-syscall branch, and the guard that keeps it honest.
   *
   * A copy of the driver *at* `<dir>/yarn` is §10.1's shape as Node sees it:
   * `argv[1]` is the shim's own path, not the stub's, because Node does not
   * `realpath` it. The pair below asserts both halves of the test that reads —
   * the name has to match, **and** the directory has to be one we would have
   * chosen, or the promotion is being decided on a name alone.
   */
  function driverNamed(directory: string, binName: string): string {
    // Extensionless, so it needs the same `"type": "module"` marker the real
    // `dist/` carries for the real stub.
    writeFileSync(join(directory, "package.json"), `{"type":"module"}\n`);
    const entry = join(directory, binName);
    writeFileSync(entry, readFileSync(driver));
    return entry;
  }

  it("needs no read when the run came through the shim itself (§16)", () => {
    const location = fixture("path-self", { "bin/yarn.js": REPORT });
    const { shims, decoy } = pathFixture("path-self", []);
    // No marker stub is written into `shims` at all: the file that runs *is* the
    // shim, so there is nothing left for the banner read to find, and the
    // promotion must still happen.
    const entry = driverNamed(shims, "yarn");

    const result = spawnSync(
      process.execPath,
      [entry, location, "yarn", JSON.stringify({ yarn: "./bin/yarn.js" })],
      {
        encoding: "utf8",
        env: {
          HOME: join(root, "nowhere"),
          USERPROFILE: join(root, "nowhere"),
          JUP_SHIM_DIRECTORY: shims,
          PATH: `${decoy}${delimiter}/usr/bin`,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`${shims}${delimiter}${decoy}${delimiter}/usr/bin`);
  });

  it("will not promote a directory off the candidate list, whatever it is named", () => {
    const location = fixture("path-notcand", { "bin/yarn.js": REPORT });
    const { shims, decoy } = pathFixture("path-notcand", ["yarn"]);
    // `argv[1]` is `<decoy>/yarn`: the right name in the wrong directory. The
    // answer must come from the candidate list, so `<shims>` wins on its banner
    // and `<decoy>` is left exactly where it was.
    const entry = driverNamed(decoy, "yarn");

    const result = spawnSync(
      process.execPath,
      [entry, location, "yarn", JSON.stringify({ yarn: "./bin/yarn.js" })],
      {
        encoding: "utf8",
        env: {
          HOME: join(root, "nowhere"),
          USERPROFILE: join(root, "nowhere"),
          JUP_SHIM_DIRECTORY: shims,
          PATH: `${decoy}${delimiter}/usr/bin`,
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`${shims}${delimiter}${decoy}${delimiter}/usr/bin`);
  });

  it("prepends nothing when the shim directory holds no shim for this binary", () => {
    const location = fixture("path-noshim", { "bin/yarn.js": REPORT });
    // A shim for a *different* binary: the directory exists and is ours, and
    // still must not be prepended, because it does not contain this program.
    const { shims, decoy } = pathFixture("path-noshim", ["pnpm"]);

    const result = runWithEnv(
      location,
      "yarn",
      { yarn: "./bin/yarn.js" },
      {
        JUP_SHIM_DIRECTORY: shims,
        PATH: `${decoy}${delimiter}/usr/bin`,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`${decoy}${delimiter}/usr/bin`);
  });

  it("does not stack a second copy when it is already first (nested runs)", () => {
    const location = fixture("path-nested", { "bin/yarn.js": REPORT });
    const { shims, decoy } = pathFixture("path-nested", ["yarn"]);

    const result = runWithEnv(
      location,
      "yarn",
      { yarn: "./bin/yarn.js" },
      {
        JUP_SHIM_DIRECTORY: shims,
        PATH: `${shims}${delimiter}${decoy}`,
      },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(`${shims}${delimiter}${decoy}`);
  });

  // §10.5's per-user default is platform-specific; XDG is the Linux/BSD half.
  it.skipIf(process.platform === "darwin" || process.platform === "win32")(
    "falls back to §10.5's per-user default when nothing is configured",
    () => {
      const location = fixture("path-peruser", { "bin/yarn.js": REPORT });
      const { shims, decoy } = pathFixture("path-peruser", ["yarn"]);

      const result = runWithEnv(
        location,
        "yarn",
        { yarn: "./bin/yarn.js" },
        {
          XDG_BIN_HOME: shims,
          PATH: decoy,
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(`${shims}${delimiter}${decoy}`);
    },
  );

  /* The native branch (§08.3) builds the tool's environment block by hand —
   * spawned without handover, `execve`'d with it (§08.3.3) — so it is the one
   * place where "must not leak into the tool's own process" has a literal
   * meaning to check. */
  describe.skipIf(process.platform === "win32")("the native branch", () => {
    /**
     * Reports the child's PATH, then the tool's own once the child is gone.
     *
     * Without handover by default, because only then is there a "once the
     * child is gone": a handover replaces this process with the tool
     * (§08.3.3), so nothing of the driver's survives to report a leak into.
     */
    function runNative(
      location: string,
      bin: BinSpec,
      env: Record<string, string>,
      handover = false,
    ) {
      const script = join(root, "native-driver.mjs");
      writeFileSync(
        script,
        [
          `import { execPackageManager } from ${JSON.stringify(EXEC_URL)};`,
          `const [location, binJson] = process.argv.slice(2);`,
          `await execPackageManager("bunny", { location, bin: JSON.parse(binJson), hash: "" }, [], undefined, "native", undefined, { handover: ${handover} });`,
          `console.log("parent:" + process.env.PATH);`,
          ``,
        ].join("\n"),
      );
      const result = spawnSync(process.execPath, [script, location, JSON.stringify(bin)], {
        encoding: "utf8",
        env: { HOME: join(root, "nowhere"), ...env },
      });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    }

    it("prepends the directory holding the extracted binary, and only to the child", () => {
      const location = fixture("path-native", {
        "bin/bunny": `#!/bin/sh\nprintf 'child:%s\\n' "$PATH"\n`,
      });
      chmodSync(join(location, "bin", "bunny"), 0o755);
      const { shims, decoy } = pathFixture("path-native", ["bunny"]);

      const result = runNative(
        location,
        { bunny: "./bin/bunny" },
        {
          // Set, and deliberately irrelevant: a native artifact is not reachable
          // through a shim, so the store directory is what must win.
          JUP_SHIM_DIRECTORY: shims,
          PATH: decoy,
        },
      );

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const lines = result.stdout.trimEnd().split("\n");
      expect(lines[0]).toBe(`child:${join(location, "bin")}${delimiter}${decoy}`);
      // No leak: the tool's own PATH is exactly what it started with.
      expect(lines[1]).toBe(`parent:${decoy}`);
    });

    it("prepends the same directory for a tool that replaces the process (§08.3.3)", () => {
      const location = fixture("path-native-replaced", {
        "bin/bunny": `#!/bin/sh\nprintf 'child:%s\\n' "$PATH"\n`,
      });
      chmodSync(join(location, "bin", "bunny"), 0o755);
      const { shims, decoy } = pathFixture("path-native-replaced", ["bunny"]);

      const result = runNative(
        location,
        { bunny: "./bin/bunny" },
        { JUP_SHIM_DIRECTORY: shims, PATH: decoy },
        true,
      );

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      // Nothing of the driver's is left to print a `parent:` line.
      expect(result.stdout).toBe(`child:${join(location, "bin")}${delimiter}${decoy}\n`);
    });

    /**
     * §08.3 — the invoked **name** reaches the child as `argv[0]`.
     *
     * This is what lets one artifact answer to two names, which is how bun
     * ships: `bun` and `bunx` are the same file, and the second behaves like
     * the first's `x` subcommand purely because of what `argv[0]` says. Bun's
     * own installer arranges that with a link beside the binary; §02.4 already
     * spells "two names, one file" as two `bin` entries with the same path, so
     * passing the name through is what makes that spelling mean the same thing
     * for a native artifact as it does for a JavaScript one.
     *
     * The fixture is a **symlink to the Node binary**, because a real
     * executable is the only thing that can report its own `argv[0]`: a
     * `#!/bin/sh` artifact never sees it — the kernel execs the interpreter,
     * and `$0` is then the script's path.
     */
    it("hands the child the invoked name as argv[0] (§08.3)", () => {
      const location = fixture("argv0-native", {});
      mkdirSync(join(location, "bin"), { recursive: true });
      symlinkSync(process.execPath, join(location, "bin", "bunny"));

      const script = join(root, "argv0-driver.mjs");
      writeFileSync(
        script,
        [
          `import { execPackageManager } from ${JSON.stringify(EXEC_URL)};`,
          `const [location, binName] = process.argv.slice(2);`,
          `const bin = { bunny: "./bin/bunny", bunnyx: "./bin/bunny" };`,
          `await execPackageManager(binName, { location, bin, hash: "" }, ["-e", "console.log(process.argv0)"], undefined, "native", undefined, { handover: true });`,
          ``,
        ].join("\n"),
      );

      for (const binName of ["bunny", "bunnyx"]) {
        const result = spawnSync(process.execPath, [script, location, binName], {
          encoding: "utf8",
        });
        expect(result.stderr).toBe("");
        expect(result.status).toBe(0);
        // Not the path: both names resolve to `<location>/bin/bunny`, and a
        // child told only the path could not tell the two invocations apart.
        expect(result.stdout.trim()).toBe(binName);
      }
    });
  });
});

/* ------------------------------------------------------------------ *
 * §08.2 / §08.3.1 — `RunOptions.handover`
 *
 * Everything above this point asks for handover explicitly, because
 * everything above stands in for a shim. This block is the other
 * caller: a host application that called `runMain` with work left to
 * do, for whom giving the process away and dying the child's death are
 * both fatal. The default is therefore off, and what stands in for
 * §08.2 is §08.3.1's spawn.
 *
 * Each case is a real child process for the reason the whole file is:
 * the claims are about what a *process* still holds after the call.
 * ------------------------------------------------------------------ */

describe("execPackageManager — the isolated path (§08.2, §08.3.1)", () => {
  /**
   * Run a JavaScript entry point with handover off, then report what the
   * calling process still holds. `probe` is appended to the driver, so a
   * case can print whatever it wants to assert about the caller.
   */
  function runIsolated(
    location: string,
    bin: BinSpec,
    probe: string[] = [],
    args: string[] = [],
    env: Record<string, string> = {},
  ): { status: number | null; stdout: string; stderr: string } {
    const script = join(root, "isolated-driver.mjs");
    writeFileSync(
      script,
      [
        `import { execPackageManager } from ${JSON.stringify(EXEC_URL)};`,
        `const [location, binJson, ...args] = process.argv.slice(2);`,
        `const before = {`,
        `  argv: JSON.stringify(process.argv),`,
        `  execArgv: JSON.stringify(process.execArgv),`,
        `  path: process.env.PATH,`,
        `  main: process.mainModule,`,
        `  root: process.env.COREPACK_ROOT,`,
        `  jupRoot: process.env.JUP_ROOT,`,
        `};`,
        // No options argument at all: the default is what is under test.
        `const code = await execPackageManager("yarn", { location, bin: JSON.parse(binJson), hash: "" }, args);`,
        `console.log("code:" + code);`,
        ...probe,
        ``,
      ].join("\n"),
    );

    const result = spawnSync(process.execPath, [script, location, JSON.stringify(bin), ...args], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it("returns the tool's real exit code instead of §08.4's placeholder 0", () => {
    const location = fixture("isolated-code", {
      "bin/yarn.js": `console.log("ran");\nprocess.exitCode = 42;\n`,
    });

    const result = runIsolated(location, { yarn: "./bin/yarn.js" });

    expect(result.stdout).toContain("ran\n");
    // The number §08.2 cannot produce: there the module body runs after the
    // call returns, so the only honest answer is 0 and the process's own
    // status carries the truth.
    expect(result.stdout).toContain("code:42");
    // And the caller decides its own fate: it set nothing, so it exits 0
    // despite having just run a tool that asked for 42.
    expect(result.status).toBe(0);
  });

  it("leaves the caller's process state exactly as it found it (§08.2)", () => {
    const location = fixture("isolated-state", {
      // The child is the one place §08.7's addition must be visible.
      "bin/yarn.js": `console.log("child-root:" + (process.env.COREPACK_ROOT !== undefined));\n`,
    });

    const result = runIsolated(location, { yarn: "./bin/yarn.js" }, [
      `console.log("argv:" + (before.argv === JSON.stringify(process.argv)));`,
      `console.log("execArgv:" + (before.execArgv === JSON.stringify(process.execArgv)));`,
      `console.log("path:" + (before.path === process.env.PATH));`,
      `console.log("mainModule:" + (before.main === process.mainModule));`,
      // Unchanged, not absent: a run nested inside another version manager
      // inherits a `COREPACK_ROOT` that was never ours to clear (§08.7).
      `console.log("root:" + (before.root === process.env.COREPACK_ROOT));`,
      `console.log("jup-root:" + (before.jupRoot === process.env.JUP_ROOT));`,
      // The point of all of it: there is still a script here to run.
      `console.log("alive:true");`,
    ]);

    expect(result.status).toBe(0);
    // §08.7 — the child gets `COREPACK_ROOT`; the caller's environment does not.
    expect(result.stdout).toContain("child-root:true");
    for (const claim of [
      "argv:true",
      "execArgv:true",
      "path:true",
      "mainModule:true",
      "root:true",
      "jup-root:true",
      "alive:true",
    ]) {
      expect(result.stdout).toContain(claim);
    }
  });

  it("passes the arguments through and finds itself at argv[1] (§08.3.1)", () => {
    const location = fixture("isolated-argv", {
      "bin/yarn.js": [
        `console.log("args:" + JSON.stringify(process.argv.slice(2)));`,
        // Yarn's own read: `process.argv[1]` must be the entry point, which is
        // what a spawned `<interpreter> <binPath>` produces without a rewrite.
        `console.log("self:" + process.argv[1].endsWith("yarn.js"));`,
        ``,
      ].join("\n"),
    });

    const result = runIsolated(location, { yarn: "./bin/yarn.js" }, [], ["install", "--frozen"]);

    expect(result.stdout).toContain(`args:["install","--frozen"]`);
    expect(result.stdout).toContain("self:true");
  });

  // A shell script standing in for a runtime: it can report that it was the
  // thing spawned, and what it was handed, which no real interpreter can say
  // about itself without ambiguity. Windows has nothing that plays the part —
  // §08.3.1 spawns the named path with no `shell` (`run/native.ts`), so a
  // `#!/bin/sh` file is unrunnable there and a `.cmd` one is refused by Node
  // itself. The row below it makes the same claim without running anything.
  it.skipIf(process.platform === "win32")(
    "honours JUP_NODE_EXECPATH as the interpreter (§08.3.1)",
    () => {
      const location = fixture("isolated-interpreter", { "bin/yarn.js": `\n` });

      const fake = join(root, "fake-node");
      writeFileSync(fake, `#!/bin/sh\nprintf 'interpreter:%s\\n' "$1"\nexit 7\n`);
      chmodSync(fake, 0o755);

      const result = runIsolated(location, { yarn: "./bin/yarn.js" }, [], [], {
        JUP_NODE_EXECPATH: fake,
      });

      expect(result.stdout).toContain(join(location, "bin", "yarn.js"));
      // The interpreter's own status is the run's, exactly as a tool's would be.
      expect(result.stdout).toContain("code:7");
    },
  );

  it("takes JUP_NODE_EXECPATH at its word, and reports it by name (§08.3.1, §12.8)", () => {
    const location = fixture("isolated-missing-interpreter", { "bin/yarn.js": `\n` });

    // §08.3.1 does not `stat` the value it is given — a path that does not
    // execute is the spawn's failure, not a pre-judged one — so a name that was
    // never there proves the variable was used at all: nothing else could put
    // it in §12.8's sentence.
    const fake = join(root, "absent-node");

    const result = runIsolated(location, { yarn: "./bin/yarn.js" }, [], [], {
      JUP_NODE_EXECPATH: fake,
    });

    expect(result.stderr).toContain(messages.cannotExecute(fake, "ENOENT"));
    expect(result.stdout).not.toContain("code:");
  });

  /* §08.5 — the native path's other fatality. */
  describe.skipIf(process.platform === "win32")("a signal death", () => {
    it("comes back as 128 + N rather than killing the caller (§08.4)", () => {
      const location = fixture("isolated-signal", {
        "bin/bunny": `#!/bin/sh\nkill -TERM $$\n`,
      });
      chmodSync(join(location, "bin", "bunny"), 0o755);

      const script = join(root, "isolated-signal-driver.mjs");
      writeFileSync(
        script,
        [
          `import { execPackageManager } from ${JSON.stringify(EXEC_URL)};`,
          `const [location] = process.argv.slice(2);`,
          `const bin = { bunny: "./bin/bunny" };`,
          `const code = await execPackageManager("bunny", { location, bin, hash: "" }, [], undefined, "native");`,
          `console.log("code:" + code);`,
          `console.log("alive:true");`,
          ``,
        ].join("\n"),
      );

      const result = spawnSync(process.execPath, [script, location], { encoding: "utf8" });

      // §08.4's stated fallback, taken deliberately: `SIGTERM` is 15.
      expect(result.stdout).toContain("code:143");
      expect(result.stdout).toContain("alive:true");
      // The caller is not the tool, so it did not die the tool's death: with
      // handover it would have exited *by signal*, with no status at all.
      expect(result.signal).toBe(null);
      expect(result.status).toBe(0);
    });
  });
});
