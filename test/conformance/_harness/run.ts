/**
 * §13.1's `run()` — spawn the real entry point and assert on
 * `(exitCode, stdout, stderr)`.
 *
 * The environment is scrubbed of every `COREPACK_*`, `DEBUG` and `FORCE_COLOR`
 * variable, `COREPACK_HOME` is always a fresh directory the caller owns, and
 * `COREPACK_DEFAULT_TO_LATEST` is `0` unless the test is about default-version
 * lookup and says otherwise.
 *
 * §13.1 also fixes *which name* the tool is spawned under: `corepack` by
 * default, since rows 1–147 assert corepack's verbatim spellings (§17.4 R12).
 * Pass `as: "jup"` for a row about the jup surface.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type EntryName, entryPath } from "../../_fixtures/entry.ts";
import type { MockRegistry } from "./registry.ts";
import type { FixtureTable } from "./table-fixture.ts";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const BIN = join(REPO_ROOT, "src", "bin.ts");

const INTERCEPT = fileURLToPath(new URL("./intercept.ts", import.meta.url));
const TABLE_PRELOAD = fileURLToPath(new URL("./table-preload.ts", import.meta.url));

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd: string;
  /** §13.1 — a fresh `COREPACK_HOME` per test. */
  home: string;
  /**
   * Overrides applied last; an explicit `undefined` removes the variable.
   *
   * That deletion is also §13.1's exemption for §17.9 rows 216–217, which have
   * to set the store-home variables themselves rather than inherit the fresh
   * `COREPACK_HOME` above: `env: { COREPACK_HOME: undefined }` leaves the row
   * on §07.1's fallback chain, which `cleanEnv` keeps inside the fixture.
   */
  env?: Record<string, string | undefined>;
  /** Route the embedded table's hardcoded hosts at this mock. */
  registry?: MockRegistry | string;
  /**
   * §17.9 — table entries to merge into the spawned tool's embedded table,
   * before its entry point runs. See `table-fixture.ts`; a test that also builds
   * artifacts for them calls `useFixtureTable()` so this process's table agrees.
   */
  table?: FixtureTable;
  /** Written to the child's stdin, which is then closed. */
  input?: string;
  /** Run a *copy* of the tool (see `copyTool`) rather than `src/bin.ts`. */
  bin?: string;
  /**
   * §13.1, §17.6 C1′ — which of the tool's two entry-point names to spawn it
   * under.
   *
   * `corepack` by default, because rows 1–147 assert corepack's verbatim output
   * and §13.1 requires them to run through that entry point (§17.4 R12). §17.9's
   * rows are the ones that opt into `jup`, so no existing row changes meaning.
   */
  as?: EntryName;
  /** Inherit the parent's stdio instead of piping it (row 140's TTY case). */
  inheritStdio?: boolean;
  /**
   * Called with the spawned tool process, for rows that must signal **the tool
   * itself** rather than wait for it (§08.5's forwarding requirement).
   *
   * The child of `run()` is in the test runner's process group, not its own, so
   * a signal sent to this pid reaches the tool alone — which is exactly the
   * "received directly, not via the group" case §08.5 requires forwarding for.
   */
  onSpawn?: (child: ChildProcess) => void;
  /**
   * Put the tool in a process group of its own, so a test can signal the
   * **group** — `process.kill(-pid, …)` — the way a terminal signals its
   * foreground group on Ctrl-C.
   *
   * Without this the tool shares the test runner's group and there is no group
   * to signal but vitest's own. With it, §08.5's "do not create a new process
   * group for the child" becomes observable: a package manager the tool
   * detached would not be in the group that gets signalled.
   */
  detachedGroup?: boolean;
  timeout?: number;
}

/**
 * A clean environment: everything the tool reads is either absent or set
 * deliberately by the test.
 */
const PROXY_VARIABLES = new Set([
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
  "NODE_EXTRA_CA_CERTS",
]);

export function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("COREPACK_") || key === "DEBUG" || key === "FORCE_COLOR") continue;
    // `CI` gates the interactive half of the download prompt (§05.5), and
    // `NODE_OPTIONS` could smuggle a loader into the child.
    if (key === "CI" || key === "NODE_OPTIONS") continue;
    // The harness's own preload channels (§17.9). Stripped so that a value left
    // in a developer's environment cannot reach a row that did not ask for one.
    if (key === "JUP_MOCK_ORIGIN" || key === "JUP_TEST_TABLE") continue;
    // §07.1's and §10.4's fallback chains, which a row that unsets the store
    // home is at the mercy of: with the developer's own `XDG_CACHE_HOME` still
    // in the environment, §17.9 row 216's `<cache>/jup` would be *their* cache
    // rather than the fixture's. `HOME` is repointed below, so dropping these
    // leaves the whole chain inside the fixture. The rows that want either set
    // it themselves.
    if (key === "XDG_CACHE_HOME" || key === "XDG_BIN_HOME") continue;
    // §14.8 makes the proxy variables live with no second opt-in, so a developer
    // who has one configured would otherwise route every fixture request through
    // it. The rows that want a proxy set these themselves.
    if (PROXY_VARIABLES.has(key)) continue;
    env[key] = value;
  }
  return env;
}

export function run(args: string[], options: RunOptions): Promise<RunResult> {
  const env = cleanEnv();
  env.COREPACK_HOME = options.home;
  env.COREPACK_DEFAULT_TO_LATEST = "0";
  // §15.1 makes `$HOME/.npmrc` a real input, so the developer's own — with the
  // registry and token their day job needs — would otherwise leak into every
  // row. Point `HOME` at the fresh, empty store directory instead. Rows that
  // care about the home directory (the shim ones) set it themselves in
  // `options.env`, which is applied below and wins.
  env.HOME = options.home;
  env.USERPROFILE = options.home;
  // Same reasoning for §15.1's global tier, `<prefix>/etc/npmrc`: `PREFIX` is
  // npm's own override for it, and pointing it at the fixture keeps a machine
  // with a system-wide npm configuration from changing what the rows observe.
  env.PREFIX = options.home;
  env.npm_config_prefix = options.home;

  const bin = options.bin ?? BIN;
  // The name the tool sees in `argv[1]`; the module it loads is `bin` either way.
  const entry = entryPath(bin, options.as ?? "corepack");

  const nodeArgs: string[] = [];
  if (options.registry !== undefined) {
    env.JUP_MOCK_ORIGIN =
      typeof options.registry === "string" ? options.registry : options.registry.origin;
    nodeArgs.push("--import", INTERCEPT);
  }
  if (options.table !== undefined) {
    // The table module *this* run will load, which is the copy's own when
    // `options.bin` names one (`copyTool`).
    env.JUP_TEST_TABLE = JSON.stringify({
      module: pathToFileURL(join(dirname(bin), "config", "table.ts")).href,
      tools: options.table,
    });
    nodeArgs.push("--import", TABLE_PRELOAD);
  }

  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }

  const child = spawn(process.execPath, [...nodeArgs, entry, ...args], {
    cwd: options.cwd,
    env,
    stdio: options.inheritStdio ? ["pipe", "inherit", "inherit"] : "pipe",
    detached: options.detachedGroup === true,
    timeout: options.timeout ?? 30_000,
  });

  options.onSpawn?.(child);

  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));

  if (options.input !== undefined) child.stdin?.end(options.input);
  else child.stdin?.end();

  return new Promise<RunResult>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      resolve({ exitCode, signal, stdout, stderr });
    });
  });
}
