/**
 * What jup ships, and what it costs to start — the two numbers §16.1 puts a
 * budget on ("Small", and the warm proxy invocation).
 *
 * Two sections, both measured against what ships — the built `dist/` and the
 * static `bin/` beside it — because that is what a user installs and what Node
 * actually parses:
 *
 * - *size*: the bytes loaded on a cached proxy run (the stub and the bundle it
 *   imports), and the bytes the package ships in total, raw and gzipped.
 * - *startup*: wall clock for a whole process, spawned repeatedly. Two floors
 *   are measured alongside so the numbers can be read: bare `node -e ""` is what
 *   the runtime costs before any of our code runs, and the seeded package
 *   manager run *directly* is the same work without a trampoline — the gap
 *   between it and the proxy row is jup's own cost, which is the only figure
 *   here that is really about jup.
 *
 * The project is exactly pinned and the store is seeded with a fake package
 * manager (the conformance harness's), so every proxy run takes §16.3's warm
 * path: manifest, marker, handover, no network.
 *
 * When corepack is on `PATH` its rows are measured too, against a copy of the
 * same seeded store — its marker file is the same JSON under a different name.
 * Both entry points call `enableCompileCache()`, so both sides are served from a
 * V8 code cache after the warm-up runs; `envFor` below is what makes that true
 * rather than accidental.
 *
 * Usage: `node scripts/bench.mjs [--runs=30] [--json] [--no-compare]`
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { getSpecFor } from "../src/config/table.ts";
import {
  cleanupFixtures,
  createFixture,
  seedPackageManager,
} from "../test/conformance/_harness/index.ts";

const REPO = join(import.meta.dirname, "..");
const DIST = join(REPO, "dist");
const BIN = join(REPO, "bin");

/** The pin every scenario shares: a real table entry, seeded rather than downloaded. */
const TOOL = "npm";
const VERSION = "10.9.2";

const args = process.argv.slice(2);
const runs = Number(args.find((a) => a.startsWith("--runs="))?.slice(7) ?? 30);
const asJson = args.includes("--json");
const compare = !args.includes("--no-compare");

if (!Number.isInteger(runs) || runs < 1) {
  console.error("--runs must be a positive integer.");
  process.exit(1);
}

if (!existsSync(join(DIST, "index.mjs"))) {
  console.error("No build in dist/ — run `pnpm build` first.");
  process.exit(1);
}

/* -------------------------------------------------------------------------- */
/* Size                                                                        */
/* -------------------------------------------------------------------------- */

/** Every relative specifier a bundled module names, `import` and `export` alike. */
const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\b[^;\n]*?from\s*"(\.[^"]+)"/g;

/**
 * The static closure of `entries` — the modules Node links before the first line
 * of a run executes. Dynamic `import()` is deliberately *not* followed: those are
 * the cold-path chunks a warm run never touches (§01.3).
 */
function eagerClosure(entries) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const [, specifier] of source.matchAll(STATIC_IMPORT)) {
      queue.push(resolve(dirname(file), specifier));
    }
  }
  return [...seen];
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}

/** Raw and gzipped bytes for a set of files, gzipped as one stream like a tarball. */
function weigh(files) {
  const bodies = files.map((file) => readFileSync(file));
  return {
    files: files.length,
    raw: bodies.reduce((total, body) => total + body.length, 0),
    gzip: gzipSync(Buffer.concat(bodies), { level: 9 }).length,
  };
}

const kB = (bytes) => `${(bytes / 1000).toFixed(1)} kB`;

// The stub dispatches into `dist/index.mjs`, which is the whole of a proxy run.
// The edge from the stub is a dynamic `import()`, so it is named here rather
// than discovered; everything below the bundle is static and gets walked.
//
// One bundle now serves both entries, so this row no longer measures a chunk
// sized for the warm path: it is the whole file, of which a warm run *evaluates*
// only §16.3's set. What it still measures honestly is the bytes Node reads and
// compiles on every `yarn`, `npm` and `pnpm` invocation on the machine.
const WARM_ENTRIES = [join(BIN, "shim-proxy.mjs"), join(DIST, "index.mjs")];

const sizes = [
  { label: "jup, loaded on a warm proxy run", ...weigh(eagerClosure(WARM_ENTRIES)) },
  { label: "jup, shipped in full", ...weigh([...walk(DIST), ...walk(BIN)]) },
];

/* -------------------------------------------------------------------------- */
/* The pinned project, and the stores behind it                                */
/* -------------------------------------------------------------------------- */

const fixture = createFixture({ name: "bench", packageManager: `${TOOL}@${VERSION}` });
const store = seedPackageManager(fixture.home, TOOL, VERSION);
const directBin = join(store, getSpecFor(TOOL, VERSION).bin[TOOL]);

/**
 * corepack's `dist/`, when a corepack is on `PATH`.
 *
 * The shim there is a symlink into the package, so the real path of the entry
 * *is* `dist/corepack.js` — no package layout has to be guessed.
 */
function findCorepack() {
  if (!compare) return undefined;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, "corepack");
    if (!existsSync(candidate)) continue;
    const dist = dirname(realpathSync(candidate));
    if (existsSync(join(dist, "lib", "corepack.cjs"))) return dist;
  }
  return undefined;
}

const corepackDist = findCorepack();
let corepackHome;

if (corepackDist !== undefined) {
  // Same tree, same fake package manager, same version — only the marker's name
  // differs, and its contents are the same JSON (`{locator, bin, hash}`).
  corepackHome = `${fixture.home}-corepack`;
  cpSync(fixture.home, corepackHome, { recursive: true });
  renameSync(
    join(corepackHome, "v1", TOOL, VERSION, ".jup"),
    join(corepackHome, "v1", TOOL, VERSION, ".corepack"),
  );

  sizes.push({
    label: "corepack, loaded on a warm proxy run",
    ...weigh([join(corepackDist, "npm.js"), join(corepackDist, "lib", "corepack.cjs")]),
  });
  // `dist/` against `dist/`: the shims corepack ships in a sibling directory are
  // the same thing as the stubs jup writes into its own (§10.1), and neither
  // package's README belongs in a code-size number.
  sizes.push({ label: "corepack, dist/ in full", ...weigh(walk(corepackDist)) });
}

/* -------------------------------------------------------------------------- */
/* Startup                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A deliberate environment: no ambient `COREPACK_*`, no network, no auto-latest.
 *
 * `TMPDIR` is set rather than inherited because `enableCompileCache()` with no
 * argument writes under `os.tmpdir()`, and a shared `/tmp/node-compile-cache`
 * owned by another user makes the call fail silently — the rows would then
 * measure a no-op and say nothing about it. `NODE_COMPILE_CACHE` would be the
 * more direct lever and is deliberately *not* used: it enables the cache by
 * itself, which would hide whether the entry points ask for it.
 */
function envFor(home) {
  return {
    PATH: process.env.PATH ?? "",
    HOME: home,
    TMPDIR: join(home, "tmp"),
    COREPACK_HOME: home,
    COREPACK_ENABLE_NETWORK: "0",
    COREPACK_DEFAULT_TO_LATEST: "0",
  };
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

/** Spawn `argv` `runs` times from the pinned project and keep the wall clock of each. */
function measure(label, argv, home) {
  const env = envFor(home);
  mkdirSync(env.TMPDIR, { recursive: true });
  const options = { cwd: fixture.cwd, env, encoding: "utf8" };
  const samples = [];
  for (let index = 0; index < runs + 3; index++) {
    const started = performance.now();
    const result = spawnSync(process.execPath, argv, options);
    const elapsed = performance.now() - started;
    if (result.status !== 0) {
      throw new Error(`${label} exited ${result.status}: ${result.stderr || result.stdout}`);
    }
    // The first three are warm-up: page cache, and both sides' compile caches.
    if (index >= 3) samples.push(elapsed);
  }
  samples.sort((a, b) => a - b);
  return {
    label,
    min: samples[0],
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
  };
}

const timings = [
  measure(`node -e "" (runtime floor)`, ["-e", ""], fixture.home),
  measure(
    `${TOOL} ${VERSION} run directly (no trampoline)`,
    [directBin, "--version"],
    fixture.home,
  ),
  measure("jup --version", [join(BIN, "jup.mjs"), "--version"], fixture.home),
  measure(
    `jup ${TOOL} --version (warm proxy)`,
    [join(BIN, `${TOOL}.mjs`), "--version"],
    fixture.home,
  ),
];

if (corepackDist !== undefined) {
  timings.push(
    measure("corepack --version", [join(corepackDist, "corepack.js"), "--version"], corepackHome),
    measure(
      `corepack ${TOOL} --version (warm proxy)`,
      [join(corepackDist, `${TOOL}.js`), "--version"],
      corepackHome,
    ),
  );
}

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

const direct = timings[1].p50;
const overhead = timings.filter((row) => row.label.includes("warm proxy"));

if (asJson) {
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        runs,
        pin: `${TOOL}@${VERSION}`,
        size: sizes,
        startup: timings,
        overheadOverDirect: Object.fromEntries(
          overhead.map((row) => [row.label, row.p50 - direct]),
        ),
      },
      undefined,
      2,
    ),
  );
} else {
  const pad = Math.max(
    ...sizes.map((row) => row.label.length),
    ...timings.map((r) => r.label.length),
  );
  const cell = (text, width = 9) => String(text).padStart(width);
  const heading = (text, ...columns) =>
    `${text.padEnd(pad + 2)}${columns.map((column) => cell(column)).join("")}`;

  console.log(`\njup bench · node ${process.version} · ${process.platform} ${process.arch}`);
  console.log(`pinned ${TOOL}@${VERSION}, store seeded, network off\n`);

  console.log(heading("size", "files", "raw", "gzip"));
  for (const row of sizes) {
    console.log(
      `  ${row.label.padEnd(pad)}${cell(row.files)}${cell(kB(row.raw))}${cell(kB(row.gzip))}`,
    );
  }

  console.log(`\n${heading(`startup · ${runs} runs · ms`, "min", "p50", "p95")}`);
  for (const row of timings) {
    console.log(
      `  ${row.label.padEnd(pad)}${cell(row.min.toFixed(1))}${cell(row.p50.toFixed(1))}${cell(row.p95.toFixed(1))}`,
    );
  }

  console.log("\ntrampoline cost · p50 over the same package manager run directly");
  for (const row of overhead) {
    console.log(
      `  ${row.label.replace(" (warm proxy)", "").padEnd(pad)}${cell(`+${(row.p50 - direct).toFixed(1)} ms`)}`,
    );
  }
  console.log();
}

if (corepackHome !== undefined) rmSync(corepackHome, { recursive: true, force: true });
cleanupFixtures();
