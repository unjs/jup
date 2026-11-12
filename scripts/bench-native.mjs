/**
 * Experimental — benchmark the native build's shims against other Node version
 * managers: per-call wall time and CPU time (user + sys) over raw Node, each
 * tool's own peak memory, the memory it keeps resident beside Node, and size on
 * disk. It regenerates the tables in the native-build PR.
 *
 * Usage (`pnpm bench:native` runs the same thing):
 *   node scripts/bench-native.mjs [<binary>] [--jup-node=<dir>] [--quick]
 *                                 [--dir=<work dir>] [--out=<results dir>]
 *
 * - `<binary>` defaults to `.native/jup-<platform>-<arch>`; it is copied first.
 * - `--jup-node=<dir>` adds a Node-hosted jup baseline: a directory of its shims
 *   (`node`, `npm`, `pnpm`), e.g. one written by `jup enable`.
 * - `--quick` cuts run counts about fivefold, for a smoke run.
 * - `--dir` is the work tree (default `node_modules/.cache/jup-bench-native/`):
 *   downloads, tools, one isolated HOME per tool, projects. A rerun reuses it.
 *   Raw hyperfine JSON, `summary.json` and `summary.md` go to `--out`
 *   (default `<dir>/results`).
 *
 * Requirements: Linux x64 only — the pinned artifacts are linux-x64 builds and
 * the wrapper-memory probe reads `/proc`. macOS is unverified and refused.
 * Needs `tar` (with xz), `unzip`, `git`, `bash`, `curl` (nvm and asdf call it)
 * and `strace` (5.3+, for the own-peak measurement).
 * Setup needs the network: every tool installs Node 22.21.1 into its own home,
 * and every download is checked against a pinned sha256. Timed runs are warm
 * and local, each tool in an `env -i`-style environment whose PATH has no node.
 * Every row is first checked to print the right version and, where a Node
 * preload can see it, to have run Node 22.21.1; a row that ran another Node is
 * flagged ⚠ in its table.
 *
 * Runtime: about 8 minutes for a full run on a warm work tree (first setup adds
 * one to two, mostly downloads); about 3 with `--quick`. Results depend on the
 * machine and its load: use a quiet one, and read differences under about
 * 1.5 ms on the pnpm and npm rows as noise.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

/* ---------------------------------- pins ---------------------------------- */

const NODE = "22.21.1";
const PNPM = "10.20.0";
const NPM = "10.9.4"; // bundled with Node 22.21.1; jup's npm project pins the same
const GH = "https://github.com";
// name, tar --strip-components (unused for .zip), sha256, URL
const ARTIFACTS = Object.fromEntries(
  `
hyperfine 1 ae2beda2ac99c098427e4f755244552daf20e514422889cca6d44421e2d93c87 ${GH}/sharkdp/hyperfine/releases/download/v2.0.0/hyperfine-v2.0.0-x86_64-unknown-linux-gnu.tar.gz
node      1 680d3f30b24a7ff24b98db5e96f294c0070f8f9078df658da1bce1b9c9873c88 https://nodejs.org/dist/v${NODE}/node-v${NODE}-linux-x64.tar.xz
pnpm      1 47a3352808501b8d1ef20112273b6a5dcfa53d28a55bcce36d268e878bd6bfe9 https://registry.npmjs.org/pnpm/-/pnpm-${PNPM}.tgz
fnm       0 7807664f39d39fc518da1c35ba0181e4b3267603c4b1dedeb4b5fc6ae440a224 ${GH}/Schniz/fnm/releases/download/v1.39.0/fnm-linux.zip
volta     0 6cec054c911fb925b629a09455775af6e95dc0f5694a4c28b63979ab9ef18037 ${GH}/volta-cli/volta/releases/download/v2.0.2/volta-2.0.2-linux.tar.gz
mise      1 9a6c9c55f5c6372d0af70a9979fe6d742aea3793267a929e1738022143c466cc ${GH}/jdx/mise/releases/download/v2026.10.24/mise-v2026.10.24-linux-x64.tar.gz
proto     1 24df51fc98848abfcc27507a53c2ce005b4da783d4bf662717ae9a9d17432c9a ${GH}/moonrepo/proto/releases/download/v0.63.2/proto_cli-x86_64-unknown-linux-gnu.tar.xz
asdf      0 6d45e6fab12f50a259b5643adf06a2e77af30a87300b4402440eda09af467a6d ${GH}/asdf-vm/asdf/releases/download/v0.20.2/asdf-v0.20.2-linux-amd64.tar.gz
nvm       1 7c5b2c4c78e6447b518860ead1f365056e9a03b3562903439bb401607b05a2ef ${GH}/nvm-sh/nvm/archive/refs/tags/v0.40.8.tar.gz
`
    .trim()
    .split("\n")
    .map((line) => {
      const [name, strip, sha256, url] = line.split(/\s+/);
      return [name, { strip, sha256, url }];
    }),
);
// asdf's Node plugin is a git repository, pinned by commit. It fetches node-build
// at install time, unpinned; Node itself still comes from nodejs.org.
const ASDF_NODEJS = [`${GH}/asdf-vm/asdf-nodejs.git`, "779c8dc84b3bdab38c2c80622d315c2c3267f74b"];

/* ---------------------------------- args ---------------------------------- */

const ROOT = join(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const quick = args.includes("--quick");
const native = `jup-${process.platform}-${process.arch}`;
const binary = resolve(args.find((a) => !a.startsWith("--")) ?? join(ROOT, ".native", native));
const jupNode = flag("jup-node") && resolve(flag("jup-node"));
const DIR = resolve(flag("dir") ?? join(ROOT, "node_modules/.cache/jup-bench-native"));
const OUT = resolve(flag("out") ?? join(DIR, "results"));

function fail(message) {
  console.error(`bench-native: ${message}`);
  process.exit(1);
}
if (native !== "jup-linux-x64") fail("linux-x64 only (see the header).");
if (!existsSync(binary)) fail(`No native build at ${binary} — run \`pnpm build:native\` first.`);
const which = (tool) => spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" });
for (const tool of ["tar", "unzip", "git", "bash", "curl", "strace"]) {
  if (which(tool).status !== 0) fail(`\`${tool}\` is required.`);
}
const STRACE = which("strace").stdout.trim();

/* --------------------------------- helpers -------------------------------- */

const BASE_PATH = "/usr/local/bin:/usr/bin:/bin"; // no node here: a silent fallback fails
const T = (...p) => join(DIR, "tools", ...p);
const HOME = (tool, ...p) => join(DIR, "homes", tool, ...p);
const PROJ = (name) => join(DIR, "proj", name);
const MiB = (bytes) => bytes / 1048576;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];

function run(argv, env, cwd = DIR) {
  const r = spawnSync(argv[0], argv.slice(1), { env, cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`${argv.join(" ")} failed: ${r.error ?? r.status}\n${r.stdout}${r.stderr}`);
  }
  return r;
}

function write(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function size(path) {
  const st = statSync(path);
  if (!st.isDirectory()) return st.size;
  return readdirSync(path).reduce((sum, name) => sum + size(join(path, name)), 0);
}

/** Download, check the pinned sha256, unpack into a fresh `tools/<name>`. */
async function fetchTool(name) {
  const { strip, sha256, url } = ARTIFACTS[name];
  if (existsSync(T(name))) return;
  const archive = join(DIR, "dl", url.split("/").pop());
  if (!existsSync(archive)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    const got = createHash("sha256").update(body).digest("hex");
    if (got !== sha256) throw new Error(`${url}: sha256 ${got}, expected ${sha256}`);
    write(archive, body);
  }
  mkdirSync(T(name), { recursive: true });
  const unpack = url.endsWith(".zip")
    ? ["unzip", "-q", archive, "-d", T(name)]
    : ["tar", "-xf", archive, "-C", T(name), `--strip-components=${strip}`, "--no-same-owner"];
  run(unpack, { PATH: BASE_PATH });
}

/* ------------------------- tools, homes and projects ------------------------ */

const nodeBin = T("node/bin/node");
const jupBin = join(DIR, "bin", "jup");
const vars = (text) => Object.fromEntries(text.split(" ").map((kv) => kv.split("=")));
const COREPACK_ENV = vars("COREPACK_DEFAULT_TO_LATEST=0 COREPACK_ENABLE_DOWNLOAD_PROMPT=0");

/** The whole environment of a tool's runs, `env -i` style: nothing inherited. */
function envFor(tool) {
  const h = HOME(tool.replace(/-.*/, ""));
  const env = (dirs, extra = {}) => ({
    HOME: h,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
    PATH: [...dirs, BASE_PATH].join(":"),
    ...extra,
  });
  const jup = (dir) => env([dir], { ...COREPACK_ENV, JUP_HOME: `${h}/jup` });
  const mise = vars("MISE_HIDE_UPDATE_WARNING=1 MISE_YES=1");
  for (const d of ["data", "config", "cache", "state"]) {
    mise[`MISE_${d.toUpperCase()}_DIR`] = `${h}/${d}`;
  }
  mise.MISE_GLOBAL_CONFIG_FILE = `${h}/config/config.toml`;
  mise.MISE_TRUSTED_CONFIG_PATHS = join(DIR, "proj");
  const storeNode = `${HOME("jupn")}/jup/v1/node/${NODE}/bin/node`;
  return {
    raw: () => env([]),
    jupn: () => jup(join(DIR, "shims/jupn")),
    "jupn-execpath": () => ({ ...jup(join(DIR, "shims/jupn")), JUP_NODE_EXECPATH: storeNode }),
    jupnode: () => jup(jupNode),
    fnm: () => env([T("fnm")], { FNM_DIR: `${h}/fnm` }),
    volta: () => env([`${h}/volta/bin`], { VOLTA_HOME: `${h}/volta`, VOLTA_FEATURE_PNPM: "1" }),
    mise: () => env([`${h}/data/shims`, T("mise/bin")], mise),
    proto: () => env([`${h}/proto/shims`, `${h}/proto/bin`], { PROTO_HOME: `${h}/proto` }),
    asdf: () =>
      env([`${h}/asdf/shims`, T("asdf")], {
        ASDF_DATA_DIR: `${h}/asdf`,
        ASDF_CONFIG_FILE: `${h}/asdfrc`,
      }),
    nvm: () => env([], { NVM_DIR: `${h}/nvm` }),
    corepack: () =>
      env([join(DIR, "shims/corepack"), T("node/bin")], {
        ...COREPACK_ENV,
        COREPACK_HOME: `${h}/corepack`,
      }),
  }[tool]();
}

function linkShims(dir, target, names) {
  mkdirSync(dir, { recursive: true });
  for (const name of names) if (!existsSync(join(dir, name))) symlinkSync(target, join(dir, name));
}

function copyInto(dir, from, names) {
  mkdirSync(dir, { recursive: true });
  for (const name of names) copyFileSync(join(from, name), join(dir, name));
}

function setup() {
  const pkg = (fields) => `${JSON.stringify({ name: "bench", private: true, ...fields })}\n`;
  const runtime = { devEngines: { runtime: { name: "node", version: NODE } } };
  write(join(PROJ("jup"), "package.json"), pkg({ packageManager: `pnpm@${PNPM}`, ...runtime }));
  write(join(PROJ("jup-npm"), "package.json"), pkg({ packageManager: `npm@${NPM}`, ...runtime }));
  write(join(PROJ("fnm"), ".node-version"), `${NODE}\n`);
  write(join(PROJ("volta"), "package.json"), pkg({ volta: { node: NODE, pnpm: PNPM } }));
  write(join(PROJ("mise"), "mise.toml"), `[tools]\nnode = "${NODE}"\n"npm:pnpm" = "${PNPM}"\n`);
  write(join(PROJ("proto"), ".prototools"), `node = "${NODE}"\npnpm = "${PNPM}"\n`);
  write(join(PROJ("asdf"), ".tool-versions"), `nodejs ${NODE}\n`);
  write(join(PROJ("nvm"), ".nvmrc"), `${NODE}\n`);
  write(join(PROJ("corepack"), "package.json"), pkg({ packageManager: `pnpm@${PNPM}` }));
  write(join(PROJ("raw"), ".keep"), "");

  // jup native: a private copy, and shims that are symlinks to it.
  mkdirSync(dirname(jupBin), { recursive: true });
  copyFileSync(binary, jupBin);
  linkShims(join(DIR, "shims/jupn"), jupBin, ["jup", "node", "npm", "npx", "pnpm", "pnpx"]);
  for (const tool of jupNode ? ["jupn", "jupnode"] : ["jupn"]) {
    run(["node", "--version"], envFor(tool), PROJ("jup"));
    run(["pnpm", "--version"], envFor(tool), PROJ("jup"));
    run(["npm", "--version"], envFor(tool), PROJ("jup-npm"));
  }
  run(["fnm", "install", NODE], envFor("fnm"), PROJ("fnm"));

  copyInto(HOME("volta", "volta/bin"), T("volta"), ["volta", "volta-shim", "volta-migrate"]);
  linkShims(HOME("volta", "volta/bin"), "volta-shim", ["node", "npm", "npx", "pnpm"]);
  run(["volta", "fetch", `node@${NODE}`, `pnpm@${PNPM}`], envFor("volta"), PROJ("volta"));

  write(HOME("mise", "config/config.toml"), "");
  run(["mise", "install"], envFor("mise"), PROJ("mise"));
  run(["mise", "reshim"], envFor("mise"), PROJ("mise"));

  copyInto(HOME("proto", "proto/bin"), T("proto"), ["proto", "proto-shim"]);
  write(
    HOME("proto", "proto/.prototools"),
    "[settings]\ntelemetry = false\nauto-install = false\n",
  );
  run(["proto", "install"], envFor("proto"), PROJ("proto"));

  write(HOME("asdf", "asdfrc"), "");
  const plugin = HOME("asdf", "asdf/plugins/nodejs");
  if (!existsSync(plugin)) {
    run(["asdf", "plugin", "add", "nodejs", ASDF_NODEJS[0]], envFor("asdf"), PROJ("asdf"));
    run(["git", "-C", plugin, "checkout", "-q", "--detach", ASDF_NODEJS[1]], envFor("asdf"));
  }
  run(["asdf", "install", "nodejs", NODE], envFor("asdf"), PROJ("asdf"));

  copyInto(HOME("nvm", "nvm"), T("nvm"), ["nvm.sh", "nvm-exec"]);
  run(["bash", "-c", `. "$NVM_DIR/nvm.sh" --no-use && nvm install ${NODE}`], envFor("nvm"));

  const corepackShims = join(DIR, "shims/corepack");
  mkdirSync(corepackShims, { recursive: true });
  const enable = ["enable", "--install-directory", corepackShims, "pnpm"];
  run([nodeBin, T("node/bin/corepack"), ...enable], envFor("corepack"), PROJ("corepack"));
  run(["pnpm", "--version"], envFor("corepack"), PROJ("corepack"));
}

/* ---------------------------------- rows ---------------------------------- */

// [title, argv, expected stdout, runs, warmup]
const SCENARIOS = {
  s1: ["`node --version`", ["node", "--version"], `v${NODE}`, 300, 20],
  s2: ["`node -e 0`", ["node", "-e", "0"], "", 150, 10],
  s3: [`\`pnpm --version\` (pnpm ${PNPM})`, ["pnpm", "--version"], PNPM, 40, 5],
  s3b: [`\`npm --version\` (npm ${NPM})`, ["npm", "--version"], NPM, 40, 5],
};
const RAW = {
  node: [nodeBin],
  pnpm: [nodeBin, T("pnpm/bin/pnpm.cjs")],
  npm: [nodeBin, T("node/lib/node_modules/npm/bin/npm-cli.js")],
};
const NVM = (a) => ["bash", "-c", `. "$NVM_DIR/nvm.sh" --no-use; nvm exec --silent ${NODE} ${a}`];
const ALL = ["s1", "s2", "s3", "s3b"];
const NO_PNPM = ["s1", "s2", "s3b"];
/**
 * [id, label, env, project, scenarios, argv transform]. Raw Node is the baseline
 * and goes into each table's heading. Shell-hook modes (fnm `--use-on-cd`, mise
 * activate, nvm use, n) put Node itself on PATH, so per call they are raw Node.
 * Corepack, and the Node-hosted jup for pnpm and npm, run the tool inside the
 * node process they start: they have no own process to measure ("in-process").
 */
const inProcess = (sc, id) =>
  id === "corepack" || (id === "jupnode" && (sc === "s3" || sc === "s3b"));
const MODES = [
  ["raw", "raw node", "raw", "raw", ALL, ([bin, ...a]) => [...RAW[bin], ...a]],
  [
    "jupn-execpath",
    "**jup native + `JUP_NODE_EXECPATH` (1 hop)**",
    "jupn-execpath",
    "jup",
    ["s3", "s3b"],
  ],
  ["jupn", "**jup native**", "jupn", "jup", ALL],
  ...(jupNode ? [["jupnode", "jup (Node-hosted)", "jupnode", "jup", ALL]] : []),
  ["fnm-exec", "fnm exec", "fnm", "fnm", NO_PNPM, (a) => ["fnm", "exec", ...a]],
  ["volta", "Volta", "volta", "volta", ALL],
  ["mise-shim", "mise shim", "mise", "mise", ALL],
  ["asdf", "asdf", "asdf", "asdf", NO_PNPM],
  ["proto", "proto", "proto", "proto", ["s1", "s2", "s3"]],
  ["corepack", "Corepack", "corepack", "corepack", ["s3"]],
  ["nvm", "nvm exec", "nvm", "nvm", NO_PNPM, (a) => NVM(a.join(" "))],
];

/** The tool's own files on the call path (Node itself excluded), and what else it needs. */
function toolSizes() {
  const f2 = (bytes) => `${MiB(bytes).toFixed(2)} MiB`;
  const bash = f2(size("/usr/bin/bash"));
  const volta = ["volta", "volta-migrate", "volta-shim"].map((f) => size(T("volta", f)));
  const sizes = {
    jupn: f2(size(jupBin)),
    "fnm-exec": f2(size(T("fnm/fnm"))),
    volta: f2(volta[2]),
    "mise-shim": f2(size(T("mise/bin/mise"))),
    asdf: `${f2(size(T("asdf/asdf")) + size(HOME("asdf", "asdf/shims/node")))} + bash`,
    proto: f2(size(T("proto/proto")) + size(T("proto/proto-shim"))),
    corepack: `${f2(size(T("node/lib/node_modules/corepack")))} JS`,
    nvm: `${f2(size(T("nvm/nvm.sh")) + size(T("nvm/nvm-exec")))} + bash`,
  };
  sizes["jupn-execpath"] = sizes.jupn;
  const also = {
    volta: `\`volta\` + \`volta-migrate\`, ${f2(volta[0] + volta[1] + volta[2])} in total`,
    asdf: `bash (${bash}) and the Node plugin's shell scripts`,
    nvm: `bash (${bash})`,
    corepack: "ships inside Node",
  };
  if (jupNode) {
    const shim = realpathSync(join(jupNode, "node"));
    const host = readFileSync(shim, "utf8").split("\n")[0].slice(2).trim().split(" ")[0];
    sizes.jupnode = `${f2(size(shim) + size(join(dirname(shim), "../dist")))} JS + host Node`;
    also.jupnode = `a ${f2(size(host))} host Node (${host})`;
  }
  return { sizes, also };
}

/* --------------------------------- measure -------------------------------- */

// Preloaded into every node of a probed run: which version ran, and how much
// memory the ancestors that spawned it and wait (up to this script) hold now.
const PROBE = join(DIR, "probe.cjs");
const PROBE_SRC = `const fs = require("fs");
let kib = 0, pid = String(process.ppid);
while (pid !== process.env.BENCH_STOP_PID && pid !== "1" && pid !== "0") {
  const st = fs.readFileSync("/proc/" + pid + "/status", "utf8");
  kib += +(st.match(/^VmRSS:\\s+(\\d+)/m) || [0, 0])[1];
  pid = st.match(/^PPid:\\s+(\\d+)/m)[1];
}
process.stderr.write("[probe] " + process.version + " " + kib + "\\n");
`;

/* Own peak: the tool's peak RSS (VmHWM) at the moment it hands over to Node.
 * A traced run lists the images the final node process passed through (and
 * which pid became node). Then, per hop, strace makes exactly that execve fail
 * and stops the caller (`inject=…:error=ENOENT:signal=SIGSTOP`), so its image is
 * intact; VmHWM is read from /proc for it and for every ancestor still waiting
 * on it (spawn-and-wait wrappers), up to strace. strace's own memory never
 * enters the number. */
const proc = (pid) => readFileSync(`/proc/${pid}/status`, "utf8");
const field = (status, key) => Number(status.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"))[1]);

/** Successful execve calls in an `strace -f -e trace=execve` log, in order. */
function parseExecs(log) {
  const execs = [];
  const pending = new Map();
  for (const [, pid, rest] of log.matchAll(/^(\d+) (.*)$/gm)) {
    const call = rest.match(/^execve\("([^"]*)"/);
    if (call) {
      const moved = rest.match(/<pid changed to (\d+) \.\.\.>$/);
      if (moved || rest.endsWith("<unfinished ...>")) pending.set(moved?.[1] ?? pid, call[1]);
      else if (rest.endsWith(" = 0")) execs.push({ pid, path: call[1] });
    } else if (rest.startsWith("<... execve resumed>") && pending.has(pid)) {
      if (rest.endsWith(" = 0")) execs.push({ pid, path: pending.get(pid) });
      pending.delete(pid);
    }
  }
  return execs;
}

/** One run stopped just before `target` is exec'd: [{ name, hwmKiB }] from that process up. */
async function stopBefore(argv, env, cwd, target) {
  const log = join(DIR, "inject.log");
  write(log, "");
  const inject = ["-e", "inject=execve:error=ENOENT:signal=SIGSTOP", "-P", target];
  const flags = ["-f", "-qq", "-o", log, "-e", "trace=execve", ...inject, "--"];
  const tracer = spawn(STRACE, [...flags, ...argv], { env, cwd, stdio: "ignore" });
  const exited = new Promise((done) => tracer.on("exit", done));
  let pid;
  for (let i = 0; i < 2000 && !pid; i++) {
    const injected = /^(\d+) (?:execve\(|<\.\.\. execve resumed>).*\(INJECTED\)$/m;
    pid = readFileSync(log, "utf8").match(injected)?.[1];
    if (!pid) await sleep(5);
  }
  const chain = [];
  for (let p = pid; p && p !== String(tracer.pid) && p !== "1";) {
    const status = proc(p);
    let name = "?";
    try {
      name = basename(readlinkSync(`/proc/${p}/exe`));
    } catch {}
    chain.push({ pid: p, name, hwmKiB: field(status, "VmHWM") });
    p = String(field(status, "PPid"));
  }
  for (const { pid: p } of chain) process.kill(Number(p), "SIGKILL");
  if (!pid) tracer.kill("SIGKILL");
  await exited;
  if (!pid) throw new Error(`${argv.join(" ")}: never reached the exec of ${target}`);
  return chain;
}

/** Median over runs of the largest tool process seen across the hops to Node. */
async function ownPeak(argv, env, cwd) {
  const log = join(DIR, "trace.log");
  spawnSync(STRACE, ["-f", "-qq", "-o", log, "-e", "trace=execve", "--", ...argv], { env, cwd });
  const execs = parseExecs(readFileSync(log, "utf8"));
  const final = execs.findLast((e) => basename(e.path) === "node");
  // every image the final pid passed through, minus strace's own exec of argv[0]
  const hops = execs.filter((e) => e.pid === final.pid && e !== execs[0]).map((e) => e.path);
  const best = { kib: 0, name: "?", hops: [] };
  for (const target of new Set(hops)) {
    const tops = [];
    for (let i = 0; i < (quick ? 5 : 30); i++) {
      const chain = await stopBefore(argv, env, cwd, target);
      tops.push(chain.reduce((a, b) => (b.hwmKiB > a.hwmKiB ? b : a)));
    }
    const kib = median(tops.map((t) => t.hwmKiB));
    const name = tops.find((t) => t.hwmKiB === kib).name;
    best.hops.push({ before: target, kib, name });
    if (kib > best.kib) Object.assign(best, { kib, name });
  }
  return best;
}

const quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`);

async function measure(sc, [id, label, envName, project, , transform = (a) => a]) {
  const [, base, expect, fullRuns, fullWarmup] = SCENARIOS[sc];
  const env = envFor(envName);
  const cwd = PROJ(id.startsWith("jupn") && sc === "s3b" ? "jup-npm" : project);
  const argv = transform(base);
  const spawn = (extra = {}) =>
    spawnSync(argv[0], argv.slice(1), { cwd, encoding: "utf8", env: { ...env, ...extra } });
  // 1. the right output, then which Node ran it and what waits above it
  const out = spawn();
  if (out.status !== 0 || out.stdout.trim() !== expect) {
    throw new Error(`${sc}/${id}: expected [${expect}], got [${out.stdout.trim()}] ${out.stderr}`);
  }
  let version = `v${NODE}`;
  let wrapperKiB = null; // `node --version` exits before a preload runs: filled in from s2
  if (sc !== "s1") {
    const kib = [];
    const probeEnv = { NODE_OPTIONS: `--require=${PROBE}`, BENCH_STOP_PID: String(process.pid) };
    for (let i = 0; i < (quick ? 5 : 15); i++) {
      const line = spawn(probeEnv)
        .stderr.split("\n")
        .findLast((l) => l.startsWith("[probe]"));
      if (!line) throw new Error(`${sc}/${id}: the probe did not run`);
      const [, v, k] = line.split(" ");
      version = v;
      kib.push(Number(k));
    }
    wrapperKiB = median(kib);
  }
  // 2. own peak, unless the tool runs inside node
  const own = id === "raw" || inProcess(sc, id) ? null : await ownPeak(argv, env, cwd);
  // 3. hyperfine, warm
  const slow = id === "nvm" || (id === "jupnode" && sc === "s1");
  const runs = Math.ceil((slow ? Math.min(fullRuns, 150) : fullRuns) / (quick ? 5 : 1));
  const warmup = quick || slow ? Math.min(fullWarmup, 3) : fullWarmup;
  const json = join(OUT, `${sc}-${id}.json`);
  const hf = ["-N", "--style", "none", "--warmup", warmup, "--runs", runs, "--export-json", json];
  run([T("hyperfine/hyperfine"), ...hf.map(String), argv.map(quote).join(" ")], env, cwd);
  const { measurements, summary } = JSON.parse(readFileSync(json, "utf8")).results[0];
  return {
    id,
    label,
    version,
    wrapperKiB,
    own,
    runs: measurements.length,
    wall: summary.time_wall_clock.mean * 1000,
    sd: summary.time_wall_clock.stddev * 1000,
    cpu: (summary.time_user.mean + summary.time_system.mean) * 1000,
    peaksKiB: measurements.map((m) => m.memory_peak_resident.value / 1024),
  };
}

/** 95% bootstrap CI of median(a) − median(b), seeded so reruns agree. */
function bootstrap(a, b, n = 2000) {
  let seed = 1;
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const resample = (xs) => xs.map(() => xs[Math.floor(rand() * xs.length)]);
  const d = Array.from({ length: n }, () => median(resample(a)) - median(resample(b)));
  d.sort((x, y) => x - y);
  return [d[Math.floor(n * 0.025)], d[Math.floor(n * 0.975)]];
}

/* ---------------------------------- main ---------------------------------- */

mkdirSync(OUT, { recursive: true });
for (const name of Object.keys(ARTIFACTS)) await fetchTool(name);
write(PROBE, PROBE_SRC);
console.error("bench-native: setting up (network) …");
setup();

const results = {};
for (const sc of Object.keys(SCENARIOS)) {
  results[sc] = [];
  for (const mode of MODES.filter((m) => m[4].includes(sc))) {
    const row = await measure(sc, mode);
    console.error(`  ${sc}/${row.id}: ${row.wall.toFixed(2)} ms`);
    results[sc].push(row);
  }
}
for (const row of results.s1) {
  row.wrapperKiB = results.s2.find((r) => r.id === row.id)?.wrapperKiB ?? 0;
}

const { sizes, also } = toolSizes();
const signed = (v, unit) => {
  const text = Math.abs(v).toFixed(2);
  return `${Number(text) === 0 ? "±" : v < 0 ? "−" : "+"}${text} ${unit}`;
};
const load = readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3).join(" ");
const kernel = spawnSync("uname", ["-sr"], { encoding: "utf8" }).stdout.trim();
const lines = [`jup native ${realpathSync(binary)} · Node ${NODE} · ${kernel} · load ${load}`];
const report = {};
for (const [sc, rows] of Object.entries(results)) {
  const raw = rows.find((r) => r.id === "raw");
  const rawPeak = median(raw.peaksKiB);
  lines.push("", `**${SCENARIOS[sc][0]} — raw Node ${raw.wall.toFixed(2)} ms**`);
  lines.push("| Tool / mode | Wall | CPU overhead | Own peak | Resident with Node | Tool size |");
  lines.push("|---|---|---|---|---|---|");
  report[sc] = [];
  for (const r of [raw, ...rows.filter((x) => x !== raw).sort((a, b) => a.wall - b.wall)]) {
    const peakDiffKiB = median(r.peaksKiB) - rawPeak;
    const ci95KiB = bootstrap(r.peaksKiB, raw.peaksKiB);
    report[sc].push({
      ...r,
      peaksKiB: undefined,
      peakKiB: median(r.peaksKiB),
      peakDiffKiB,
      ci95KiB,
    });
    if (r === raw) continue;
    const mib = (kib) => `${(kib / 1024).toFixed(2)} MiB`;
    const own = r.own ? `${mib(r.own.kib)} (${r.own.name})` : "— (in-process)";
    const resident = inProcess(sc, r.id)
      ? `${signed(peakDiffKiB / 1024, "MiB")} (in-process)`
      : r.wrapperKiB > 0
        ? mib(r.wrapperKiB)
        : "0 MiB";
    const label = r.version === `v${NODE}` ? r.label : `${r.label} ⚠ ran on Node ${r.version}`;
    const wall = `${r.wall.toFixed(2)} ± ${r.sd.toFixed(2)} ms (${signed(r.wall - raw.wall, "ms")})`;
    lines.push(
      `| ${label} | ${wall} | ${signed(r.cpu - raw.cpu, "ms")} | ${own} | ${resident} | ${sizes[r.id]} |`,
    );
  }
}
lines.push(
  "",
  "Own peak = the version manager's own peak RSS (VmHWM) when it hands over to Node: the largest of its exec hops, or of the wrappers that spawn Node and wait (process named in brackets; every hop is in `summary.json`); median of 30 runs, each stopped by strace at that exec. Short-lived helpers a tool runs first are not counted: proto's `ldd --version`, and the `npm --version` that `nvm exec` runs. Resident with Node = RSS of those waiting wrappers while Node runs; 0 MiB for a chain of execs. For in-process tools it is peak RSS minus raw Node's; within about ±0.5 MiB that is noise (95% bootstrap CIs in `summary.json`).",
  `Node ${NODE} itself, ${MiB(size(nodeBin)).toFixed(1)} MiB, is the same for every tool and not counted in Tool size.`,
  "Shell-hook tools (fnm `--use-on-cd`, mise activate, nvm use, n) put Node itself on `PATH`, so they cost nothing per call — each call is raw Node — but run a hook on every prompt or `cd`, and do not help callers that never ran it (IDEs, CI steps, `child_process` without that `PATH`). This script does not time the hooks.",
  "",
  "**Size on disk**",
  "| Tool | Files used per call | Also needs |",
  "|---|---|---|",
);
for (const id of [
  "jupn",
  "jupnode",
  "fnm-exec",
  "volta",
  "asdf",
  "proto",
  "mise-shim",
  "corepack",
  "nvm",
]) {
  const label = MODES.find((m) => m[0] === id)?.[1];
  if (sizes[id]) lines.push(`| ${label} | ${sizes[id]} | ${also[id] ?? "—"} |`);
}
const text = `${lines.join("\n")}\n`;
write(join(OUT, "summary.md"), text);
write(join(OUT, "summary.json"), `${JSON.stringify({ quick, load, kernel, report }, null, 2)}\n`);
process.stdout.write(text);
console.error(`bench-native: hyperfine JSON, summary.json and summary.md in ${OUT}`);
