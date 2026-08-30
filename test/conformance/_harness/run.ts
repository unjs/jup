/**
 * §13.1's `run()` — spawn the real entry point and assert on
 * `(exitCode, stdout, stderr)`.
 *
 * The environment is scrubbed of every `COREPACK_*`, `DEBUG` and `FORCE_COLOR`
 * variable, `COREPACK_HOME` is always a fresh directory the caller owns, and
 * `COREPACK_DEFAULT_TO_LATEST` is `0` unless the test is about default-version
 * lookup and says otherwise.
 *
 * What it does **not** do is take the network away. The sandbox these tests run
 * in has one, so a row whose answer is supposed to come from a fixture — a
 * fallback version, a seeded store, an offline degradation — can pass over the
 * wire instead, and go green for the wrong reason. Any such row must seed the
 * store *and* set `COREPACK_ENABLE_NETWORK=0`, which is why so many of the rows
 * below already do.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { symlinkSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempRoot } from "./fixtures.ts";
import type { MockRegistry } from "./registry.ts";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const BIN = join(REPO_ROOT, "src", "bin.ts");

// A URL, not a path. Node consumes `--import` values in
// `runEntryPointWithESMLoader`, which hands each one straight to the ESM
// loader as a specifier resolved against the cwd URL — no `pathToFileURL` in
// between. A POSIX absolute path has no scheme and resolves correctly; a
// Windows one starts `D:\`, which the URL parser reads as the scheme `d:` and
// the loader then rejects with ERR_UNSUPPORTED_ESM_URL_SCHEME before the tool
// runs a single line. Passing the `file://` form is correct on every platform.
const INTERCEPT = new URL("./intercept.ts", import.meta.url).href;

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
  /** Overrides applied last; an explicit `undefined` removes the variable. */
  env?: Record<string, string | undefined>;
  /** Route the embedded table's hardcoded hosts at this mock. */
  registry?: MockRegistry | string;
  /** Written to the child's stdin, which is then closed. */
  input?: string;
  /** Run a *copy* of the tool (see `copyTool`) rather than `src/bin.ts`. */
  bin?: string;
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
  /**
   * Leave §10.5 point 8's `/usr/local/bin` on the child's `PATH`.
   *
   * Only the rows that mean to exercise point 8 set this — see `childPath` for
   * why every other row has it removed.
   */
  allowSystemShimDirectory?: boolean;
  timeout?: number;
}

/** §10.5 point 8's directory, spelled out rather than imported. */
const SYSTEM_SHIM_DIR = "/usr/local/bin";

let runtimeDirectory: string | undefined;

/**
 * The child's `PATH`, with §10.5 point 8's directory removed — exported so that
 * a row asserting on the `PATH` its child saw compares against what `run` sent.
 *
 * Point 8 makes `/usr/local/bin` a live candidate for `enable` **when the suite
 * runs as `root`**, which is a container CI job and the `node:*` image a
 * developer reaches for. Left alone, any row that takes the per-user default off
 * `PATH` would install shims into the machine's own system directory — where the
 * next row, in another worker, then finds them by point 7's continuity scan and
 * reports something else entirely. Removing the entry keeps every row that
 * predates point 8 running exactly as written, as any other user.
 *
 * `node` has to survive the removal: §10.1's stub is entered through
 * `#!/usr/bin/env node`, and in exactly the environment this matters for the
 * directory being removed is where `node` lives. When that is the case the
 * runtime is offered under a directory of the suite's own containing one
 * symlink, which is `PATH` keeping its promise without `/usr/local/bin` back on
 * it.
 */
export function childPath(value: string | undefined): string {
  if (process.platform === "win32") return value ?? "";
  const entries = (value ?? "").split(delimiter).filter((entry) => entry !== SYSTEM_SHIM_DIR);
  if (dirname(process.execPath) === SYSTEM_SHIM_DIR) {
    if (runtimeDirectory === undefined) {
      runtimeDirectory = tempRoot("jup-runtime-");
      symlinkSync(process.execPath, join(runtimeDirectory, "node"));
    }
    entries.push(runtimeDirectory);
  }
  return entries.join(delimiter);
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
    // `CI` is a habit the fixtures keep out of the child's environment, and
    // `NODE_OPTIONS` could smuggle a loader into it.
    if (key === "CI" || key === "NODE_OPTIONS" || key === "JUP_MOCK_ORIGIN") continue;
    // §05.1 makes the proxy variables live with no second opt-in, so a developer
    // who has one configured would otherwise route every fixture request through
    // it. The rows that want a proxy set these themselves.
    if (PROXY_VARIABLES.has(key)) continue;
    env[key] = value;
  }
  return env;
}

/**
 * Set — or, with `undefined`, unset — one variable in a child environment.
 *
 * Windows environment names are case-insensitive, and Node resolves a collision
 * when it builds the child's block by keeping the **first** key it sees. The
 * inherited spelling (`Path`, `TEMP`, `npm_config_prefix`) is copied by
 * `cleanEnv` before any override is applied, so a plain `env.PATH = …` adds a
 * second key that the spawn then discards, and the row silently runs with the
 * runner's value. Every override goes through here, which removes the other
 * spellings first.
 */
function setVar(env: Record<string, string>, key: string, value: string | undefined): void {
  if (process.platform === "win32") {
    const upper = key.toUpperCase();
    for (const existing of Object.keys(env)) {
      if (existing !== key && existing.toUpperCase() === upper) delete env[existing];
    }
  }
  if (value === undefined) delete env[key];
  else env[key] = value;
}

export function run(args: string[], options: RunOptions): Promise<RunResult> {
  const env = cleanEnv();
  setVar(env, "COREPACK_HOME", options.home);
  setVar(env, "COREPACK_DEFAULT_TO_LATEST", "0");
  // §05.3 makes `$HOME/.npmrc` a real input, so the developer's own — with the
  // registry and token their day job needs — would otherwise leak into every
  // row. Point `HOME` at the fresh, empty store directory instead. Rows that
  // care about the home directory (the shim ones) set it themselves in
  // `options.env`, which is applied below and wins.
  setVar(env, "HOME", options.home);
  setVar(env, "USERPROFILE", options.home);
  // Same reasoning for §05.3's global tier, `<prefix>/etc/npmrc`: `PREFIX` is
  // npm's own override for it, and pointing it at the fixture keeps a machine
  // with a system-wide npm configuration from changing what the rows observe.
  setVar(env, "PREFIX", options.home);
  setVar(env, "npm_config_prefix", options.home);

  const nodeArgs: string[] = [];
  if (options.registry !== undefined) {
    setVar(
      env,
      "JUP_MOCK_ORIGIN",
      typeof options.registry === "string" ? options.registry : options.registry.origin,
    );
    nodeArgs.push("--import", INTERCEPT);
  }

  for (const [key, value] of Object.entries(options.env ?? {})) {
    setVar(env, key, value);
  }

  // Last, so that it covers the rows that build a `PATH` of their own on top of
  // the runner's — which is every shim row.
  if (process.platform !== "win32" && options.allowSystemShimDirectory !== true) {
    setVar(env, "PATH", childPath(env.PATH));
  }

  const child = spawn(process.execPath, [...nodeArgs, options.bin ?? BIN, ...args], {
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

/**
 * §05.4 — every cold **artifact** download announces itself on stderr, from
 * every entry point and with no question attached.
 *
 * Rows about something else strip the notices and assert what is left, so a
 * fresh download does not turn every "stderr is exactly this" row into a
 * restatement of §05.4. The notice's own wording, placement and the fact that
 * nothing is read back are `15-20-download-notice.test.ts`'s rows.
 */
export function withoutDownloadNotices(stderr: string): string {
  return stderr.replaceAll(/^! jup is about to download \S+\n/gm, "");
}

/** §05.4's line for `url`, for the rows that assert it directly. */
export function downloadNotice(url: string): string {
  return `! jup is about to download ${url}\n`;
}
