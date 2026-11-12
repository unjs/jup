/**
 * Experimental — smoke-test a native build (`scripts/build-native.mjs`).
 *
 * Drives the binary the way a user does: `enable` puts symlinks to it on a
 * scratch shim directory, and every check below runs *through* those shims
 * with a minimal environment — no inherited `PATH`, no `node` of the host's,
 * an isolated `JUP_HOME` and `HOME`. It downloads real tools at pinned
 * versions, so it needs the network; a warm rerun is fast.
 *
 * Usage (`pnpm test:native` runs the same thing):
 *   node scripts/test-native.mjs [<binary>] [--keep]
 *
 * `<binary>` defaults to `.native/jup-<platform>-<arch>`. The scratch tree is
 * removed on success and kept on failure (or with `--keep`) for inspection.
 * Exits non-zero when any check fails.
 */

import { fork, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = join(import.meta.dirname, "..");

// Pinned so a run measures the binary, not whatever `latest` is today.
const NODE_VERSION = "22.21.1";
const PNPM_VERSION = "9.15.9";
const YARN_VERSION = "4.10.3";

const PROXY_REFUSAL = "HTTP proxies and JUP_STRICT_SSL=0 are not supported by the native build";

// --- Harness -----------------------------------------------------------------

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const positional = args.filter((arg) => arg !== "--keep");
const binary = resolve(
  positional[0] ?? join(ROOT, ".native", `jup-${process.platform}-${process.arch}`),
);
if (!existsSync(binary)) {
  console.error(`No native build at ${binary}. Run \`pnpm build:native\` first.`);
  process.exit(1);
}
const self = realpathSync(binary);

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "jup-native-")));
const home = join(scratch, "jup-home");
const userHome = join(scratch, "user");
const shims = join(scratch, "shims");
for (const directory of [home, userHome, shims]) mkdirSync(directory, { recursive: true });

/** The only environment any check sees: nothing inherited but `TMPDIR`. */
const baseEnv = {
  HOME: userHome,
  JUP_HOME: home,
  JUP_SHIM_DIRECTORY: shims,
  PATH: [shims, "/usr/bin", "/bin"].join(":"),
  // Pinned projects make this moot; it keeps an unpinned lookup off `latest`.
  COREPACK_DEFAULT_TO_LATEST: "0",
  ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
};

let failures = 0;
let count = 0;

async function check(name, fn) {
  count += 1;
  const started = Date.now();
  try {
    await fn();
    console.log(`ok ${count} - ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    failures += 1;
    console.log(`not ok ${count} - ${name}`);
    console.log(indent(error instanceof Error ? error.message : String(error)));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Run `command` (a path) with the base environment plus `env`. */
function run(command, argv, { cwd = scratch, env = {}, argv0 } = {}) {
  const result = spawnSync(command, argv, {
    argv0,
    cwd,
    env: { ...baseEnv, ...env },
    encoding: "utf8",
    timeout: 300_000,
  });
  if (result.error) throw result.error;
  return result;
}

function expectStatus(result, status, label) {
  assert(
    result.status === status,
    `${label}: expected exit ${status}, got ${result.status ?? result.signal}\n` +
      `stdout: ${result.stdout.trim()}\nstderr: ${result.stderr.trim()}`,
  );
}

function project(name, manifest) {
  const directory = join(scratch, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    `${JSON.stringify({ name, private: true, ...manifest }, null, 2)}\n`,
  );
  return directory;
}

/** Every entry in the shim directory that is a symlink resolving to the binary. */
function ourLinks() {
  return readdirSync(shims)
    .filter((name) => {
      const file = join(shims, name);
      return lstatSync(file).isSymbolicLink() && existsSync(file) && realpathSync(file) === self;
    })
    .sort();
}

function indent(text) {
  return text.replace(/^/gm, "    ");
}

// --- Fixtures ----------------------------------------------------------------

const runtime = { devEngines: { runtime: { name: "node", version: NODE_VERSION } } };
const nodeProject = project("node-project", runtime);
const pnpmProject = project("pnpm-project", {
  ...runtime,
  packageManager: `pnpm@${PNPM_VERSION}`,
});
const yarnProject = project("yarn-project", {
  ...runtime,
  packageManager: `yarn@${YARN_VERSION}`,
});

// A foreign binary `enable` must not take without `--force` (§10.6).
const foreign = join(shims, "deno");
writeFileSync(foreign, "#!/bin/sh\necho foreign\n", { mode: 0o755 });

console.log(`# binary   ${binary}`);
console.log(`# scratch  ${scratch}`);
const hostNode = ["/usr/bin/node", "/bin/node"].filter((file) => existsSync(file));
console.log(`# PATH     ${baseEnv.PATH}${hostNode.length > 0 ? ` (host node: ${hostNode})` : ""}`);

// --- Checks ------------------------------------------------------------------

await check("--version", () => {
  const result = run(binary, ["--version"]);
  expectStatus(result, 0, "jup --version");
  assert(/^\d+\.\d+\.\d+/.test(result.stdout.trim()), `unexpected version ${result.stdout}`);
});

await check("enable --exclude yarn links the default set to the binary", () => {
  const result = run(binary, ["enable", "--exclude", "yarn"]);
  expectStatus(result, 0, "enable");
  const links = ourLinks();
  for (const name of ["npm", "npx", "pnpm", "pnpx"]) {
    assert(links.includes(name), `${name} is not a link to the binary: ${links}`);
  }
  for (const name of ["yarn", "yarnpkg", "node"]) {
    assert(!links.includes(name), `${name} should not be linked yet: ${links}`);
  }
});

await check("enable --all claims the rest, leaves a foreign entry, and is idempotent", () => {
  const first = run(binary, ["enable", "--all"]);
  expectStatus(first, 0, "enable --all");
  assert(
    first.stderr.includes("deno already exists at") && first.stderr.includes("--force"),
    `no foreign-entry report for deno:\n${first.stderr}`,
  );
  assert(!lstatSync(foreign).isSymbolicLink(), "the foreign deno was replaced");
  const links = ourLinks();
  for (const name of ["node", "yarn", "yarnpkg", "bun", "bunx"]) {
    assert(links.includes(name), `${name} is not a link to the binary: ${links}`);
  }
  const before = links.map((name) => lstatSync(join(shims, name)).mtimeMs);
  expectStatus(run(binary, ["enable", "--all"]), 0, "second enable --all");
  const after = ourLinks().map((name) => lstatSync(join(shims, name)).mtimeMs);
  assert(JSON.stringify(before) === JSON.stringify(after), "a second enable rewrote links");
});

await check("info --json reports the links as ours", () => {
  const result = run(binary, ["info", "--json"], { cwd: nodeProject });
  expectStatus(result, 0, "info --json");
  const { shims: report } = JSON.parse(result.stdout);
  const entry = (name) => report.entries.find((candidate) => candidate.binary === name);
  assert(report.directory === shims, `directory ${report.directory}, expected ${shims}`);
  for (const name of ["node", "pnpm", "yarn"]) {
    assert(entry(name)?.ours === true, `${name}: ${JSON.stringify(entry(name))}`);
  }
  assert(entry("deno")?.ours === false, `deno: ${JSON.stringify(entry("deno"))}`);
});

await check(`node shim runs devEngines.runtime ${NODE_VERSION} in place (exec, cold)`, () => {
  const result = run(
    join(shims, "node"),
    ["-e", "console.log(JSON.stringify({ version: process.version, ppid: process.ppid }))"],
    { cwd: nodeProject },
  );
  expectStatus(result, 0, "node -e");
  const { version, ppid } = JSON.parse(result.stdout);
  assert(version === `v${NODE_VERSION}`, `ran ${version}`);
  // The shim's own pid became node's: no wrapper process in between.
  assert(ppid === process.pid, `node's parent is ${ppid}, not this script (${process.pid})`);
});

await check("exit status passes through", () => {
  const result = run(join(shims, "node"), ["-e", "process.exit(42)"], { cwd: nodeProject });
  expectStatus(result, 42, "node -e process.exit(42)");
});

await check("death by signal passes through", () => {
  const result = run(join(shims, "node"), ["-e", "process.kill(process.pid, 'SIGTERM')"], {
    cwd: nodeProject,
  });
  assert(result.signal === "SIGTERM", `expected SIGTERM, got ${result.status ?? result.signal}`);
});

await check("fork() through the node shim keeps the IPC channel and the pid", async () => {
  const script = join(nodeProject, "child.cjs");
  writeFileSync(
    script,
    "process.on('message', (m) => process.send({ pid: process.pid, version: process.version, echo: m }));\n",
  );
  const child = fork(script, [], {
    cwd: nodeProject,
    env: baseEnv,
    execPath: join(shims, "node"),
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolveExit) =>
    child.on("exit", (code, signal) => resolveExit(signal ?? code)),
  );
  const reply = await new Promise((resolveReply, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply in 120 s\n${stderr}`)), 120_000);
    child.once("message", (message) => {
      clearTimeout(timer);
      resolveReply(message);
    });
    exited.then((how) => reject(new Error(`child exited (${how}) before replying\n${stderr}`)));
    child.send("ping");
  }).finally(() => child.kill("SIGKILL"));
  assert(reply.echo === "ping", `reply ${JSON.stringify(reply)}`);
  assert(reply.pid === child.pid, `replied from pid ${reply.pid}, forked ${child.pid}`);
  assert(reply.version === `v${NODE_VERSION}`, `child ran ${reply.version}`);
  assert((await exited) === "SIGKILL", "child did not die by SIGKILL");
});

await check(`pnpm shim runs pnpm@${PNPM_VERSION}`, () => {
  const result = run(join(shims, "pnpm"), ["--version"], { cwd: pnpmProject });
  expectStatus(result, 0, "pnpm --version");
  assert(result.stdout.trim() === PNPM_VERSION, `printed ${result.stdout.trim()}`);
});

await check("a JS tool's children get the shim directory on PATH (§08.7)", () => {
  // Shims off `PATH`, so only jup's promotion can put them back for the child;
  // and a bare `argv[0]`, as a shell's `PATH` lookup passes it, so the
  // directory is found by asking whether `<dir>/pnpm` is ours.
  const result = run(join(shims, "pnpm"), ["exec", "node", "-e", "console.log(process.env.PATH)"], {
    argv0: "pnpm",
    cwd: pnpmProject,
    env: { PATH: "/usr/bin:/bin", JUP_NODE_EXECPATH: join(shims, "node") },
  });
  expectStatus(result, 0, "pnpm exec node");
  assert(
    result.stdout.trim().split(":").includes(shims),
    `child PATH lacks ${shims}: ${result.stdout.trim()}`,
  );
});

await check(`yarn shim runs yarn@${YARN_VERSION} with no host node`, () => {
  const result = run(join(shims, "yarn"), ["--version"], { cwd: yarnProject });
  expectStatus(result, 0, "yarn --version");
  assert(result.stdout.trim() === YARN_VERSION, `printed ${result.stdout.trim()}`);
});

await check("an HTTP proxy is refused with the native-build message", () => {
  const result = run(binary, [`pnpm@${PNPM_VERSION}`, "--version"], {
    env: { JUP_HOME: join(scratch, "jup-home-proxy"), HTTPS_PROXY: "http://127.0.0.1:9" },
  });
  assert(result.status !== 0, `exited 0:\n${result.stdout}`);
  assert(result.stderr.includes(PROXY_REFUSAL), `stderr:\n${result.stderr}`);
});

await check("enable --force displaces a foreign entry and records it (§10.6)", () => {
  expectStatus(run(binary, ["enable", "--force", "deno"]), 0, "enable --force deno");
  assert(ourLinks().includes("deno"), "deno is not a link to the binary");
  assert(readFileSync(join(home, "shims.json"), "utf8").includes(foreign), "no shims.json record");
});

await check("disable removes our links only, restores what --force displaced, and repeats", () => {
  // A link to some *other* file is not ours, whatever its name.
  const elsewhere = join(scratch, "elsewhere");
  writeFileSync(elsewhere, "#!/bin/sh\n", { mode: 0o755 });
  rmSync(join(shims, "nubx"));
  symlinkSync(elsewhere, join(shims, "nubx"));

  expectStatus(run(binary, ["disable"]), 0, "disable");
  assert(ourLinks().length === 0, `links left behind: ${ourLinks()}`);
  assert(
    !lstatSync(foreign).isSymbolicLink() && readFileSync(foreign, "utf8").includes("foreign"),
    "the displaced deno was not restored",
  );
  assert(lstatSync(join(shims, "nubx")).isSymbolicLink(), "a foreign link was removed");
  expectStatus(run(binary, ["disable"]), 0, "second disable");
});

// --- Report ------------------------------------------------------------------

console.log(`\n${count - failures}/${count} passed`);
if (failures === 0 && !keep) rmSync(scratch, { recursive: true, force: true });
else console.log(`# scratch kept at ${scratch}`);
process.exitCode = failures === 0 ? 0 : 1;
