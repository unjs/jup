#!/usr/bin/env bun
/**
 * Compile the built `dist/` into self-contained executables with Bun, one per
 * supported platform, into `dist-bin/`.
 *
 * Bun's bundler bundles an entry module together with the Bun runtime into one
 * file, so the result runs on a machine with no Node.js and no npm install —
 * which is the one distribution shape the published package cannot cover. What
 * goes in is `dist/index.mjs`, the same bundle `package.json`'s `bin` target
 * loads, so the binary is the CLI users already have rather than a second one
 * assembled here. `obuild` emits that bundle as one file with no lazy chunks
 * beside it, so there is nothing for Bun's bundler to chase.
 *
 * It cannot be handed `bin/jup.mjs` itself. That file reaches the bundle through
 * `new URL(…, realpathSync(import.meta.filename))` rather than a literal
 * specifier — deliberately, so an `npm` bin symlink or `--preserve-symlinks-main`
 * cannot send it looking in `node_modules/dist/` (§10.1's reasoning, one file
 * over) — and a runtime URL is exactly what a bundler cannot follow. So the four
 * lines that make the bundle *run* are written beside it as a scratch entry,
 * where `./index.mjs` is literal, and removed afterwards. Those lines are
 * `cliEntrySource()`'s minus the resolution dance; if that function grows a
 * behaviour, this needs it too.
 *
 * The one place the scratch entry may not copy it is the shape of the call:
 * `cliEntrySource()` awaits `runMain` at the top level, and this cannot, because
 * top-level await forces ESM output and `bytecode` below only accepts CommonJS.
 * `.then` is the same program without the syntax that would refuse to compile.
 *
 * Usage: `pnpm compile`, or `./scripts/compile.ts`. There are no options: every
 * target is built, always into `dist-bin/`, and each binary is packed into a
 * `<target>.tar.xz` beside it — the shape a `sh` installer downloads — with the
 * uncompressed binary kept for local use.
 *
 * Compression dominates the run — around 30 s a target against a few seconds to
 * build one — so it happens in a second pass, after every binary exists, several
 * targets at a time. Each `xz` is single-threaded whatever `-T` asks for: this
 * input is smaller than the block size a 64 MiB dictionary implies, so there is
 * one block and nothing to split, which is exactly why the parallelism has to be
 * across targets and not inside one. Eight sequential runs pinning one core is
 * four minutes; the pass below is under one.
 *
 * `xz -9e` is what packs them, measured on the linux-x64 binary against every
 * alternative available: 26.9 MB with the branch filter below, 27.6 MB without
 * it, 28.4 MB for `brotli -q 11`, 29.2 MB for `zstd --ultra -22` and 36.7 MB for
 * `gzip -9`. Unpacking needs 65 MiB of memory and well under a second. It is a
 * `.tar.xz` rather than a bare `.xz` because macOS ships no `xz` command of its
 * own, and its `tar` decodes the format in process through libarchive; `tar -xJO`
 * writes the one member to stdout, so its name inside the archive does not
 * matter. Whatever consumes these must not `strip` the binary first: that drops
 * the bundle Bun appended and leaves a bare runtime, which answers `--version`
 * with Bun's own version rather than jup's.
 *
 * The binaries are compiled `format: "cjs"` with `bytecode: true`: Bun caches the
 * parsed bytecode inside the executable instead of parsing the bundle on every
 * start, which measured 25 ms → 19 ms on `--version` and 32 ms → 23 ms on `info`
 * here, for 82.7 MB → 84.4 MB. Both are one decision — bytecode is cached only
 * for a CommonJS entry — and the cost of the CommonJS half is paid in `self.ts`:
 * Bun resolves `import.meta.url` at *build* time there, so every module reports
 * the path its source held on the machine that compiled it, and standalone
 * detection reads `Bun.main` instead. Without that, `COREPACK_ROOT` would name
 * the build machine's checkout and `npm` would take the in-process handover that
 * cannot load it (below), failing with `Cannot find module 'graceful-fs'`.
 *
 * What the binaries can and cannot do:
 *
 * - Native table entries — `node`, `bun`, `deno` — work: resolution, download,
 *   signature checks, extraction and the spawn all run inside the binary, and
 *   `jup node@22.18.0 --version` answers from a cold store.
 * - Most package managers work too: `pnpm` and `yarn`, both 4.x and classic,
 *   hand over in process through `module.runMain` and run from a cold store,
 *   because each is one bundled file that requires nothing beside it.
 * - `npm` works too, but not in process, and the cause is narrower than "it
 *   cannot see a nested `node_modules`". A standalone Bun executable resolves a
 *   bare specifier off disk *without reading the package's `package.json`*: it
 *   walks up to `node_modules/<name>/` correctly, then tries only `index.js`,
 *   ignoring `main` and `exports`. npm's first require is `graceful-fs`, whose
 *   `main` is `graceful-fs.js` with no `index.js` beside it, so §08.2's handover
 *   dies on `Cannot find module 'graceful-fs'` and exits 7. The quieter half of
 *   the same bug: where a package has both, `main` is skipped and `index.js`
 *   loads in its place with no error at all. Relative and deep specifiers —
 *   `graceful-fs/graceful-fs.js` — still resolve, which is why one-file `pnpm`
 *   and `yarn` are untouched. `run/exec.ts` answers it by re-entering this same
 *   binary as the `bun` CLI under `BUN_BE_BUN`, whose resolver is correct; that
 *   branch is what `isStandaloneBinary` gates, and why the CommonJS output above
 *   may not be allowed to break it.
 * - `jup enable` fails with "The stub folder doesn't exist": it needs the entry
 *   module on disk to write stubs against, and a binary has no `dist/` to find.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { cpus } from "node:os";

/**
 * Bun's bundler, typed to the surface used below. `@types/bun` would supply the
 * real definitions, but its globals replace enough of `@types/node`'s to break
 * `pnpm typecheck` for the rest of the repo, so this is declared locally — and
 * module-locally, so it stays out of everyone else's scope.
 */
declare const Bun: {
  build(options: {
    entrypoints: string[];
    format?: "cjs" | "esm";
    minify?: boolean;
    bytecode?: boolean;
    compile?: { target?: string; outfile?: string };
  }): Promise<{ success: boolean; logs: unknown[] }>;
};

const REPO = join(import.meta.dirname, "..");
const BUNDLE = join(REPO, "dist", "index.mjs");
const ENTRY = join(REPO, "dist", "_compile-entry.mjs");
const OUTDIR = join(REPO, "dist-bin");

/** §05.5 — the download prompt defaults to `0` here, as it does in `bin/jup.mjs`. */
const ENTRY_SOURCE = `import { runMain } from "./index.mjs";
if (process.env.JUP_ENABLE_DOWNLOAD_PROMPT === undefined)
  process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT ??= "0";
runMain(process.argv.slice(2)).then((code) => {
  if (code !== 0) process.exitCode = code;
});
`;

/** Bun's cross-compilation targets, as of Bun 1.4. */
const TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-linux-x64-musl",
  "bun-linux-arm64-musl",
  "bun-darwin-x64",
  "bun-darwin-arm64",
  "bun-windows-x64",
  "bun-windows-arm64",
];

if (!existsSync(BUNDLE)) {
  console.error(`No ${BUNDLE}. Run \`pnpm build\` first.`);
  process.exit(1);
}

// Asked for before the first build rather than after the last one, so a host
// without it fails in a second instead of eight compiles later.
const xz = spawnSync("xz", ["--version"], { encoding: "utf8" });
if (xz.status !== 0) {
  console.error("xz is not on PATH. Install XZ Utils: `apt install xz-utils`, `brew install xz`.");
  process.exit(1);
}

/**
 * xz's branch-conversion filters rewrite the relative call and jump targets in
 * machine code into absolute ones before LZMA sees them, so one function called
 * from twenty places compresses as twenty copies of the same bytes rather than
 * twenty different ones. It is worth 27.6 MB → 26.9 MB on the linux-x64 binary
 * and costs nothing to undo. The filter has to match the architecture, and only
 * that: the container — ELF, Mach-O, PE — does not enter into it. `--arm64`
 * arrived in xz 5.4, so where the host's xz predates it those targets are packed
 * unfiltered rather than not at all.
 *
 * Naming a filter replaces the whole chain rather than adding to it, so the
 * compression stage `-9e` would have selected has to be spelled out after it —
 * `--x86` on its own is a chain that only reorders bytes and never compresses
 * them, which xz rejects as "Unsupported options in filter chain 0".
 */
const [xzMajor = 0, xzMinor = 0] = (/(\d+)\.(\d+)/.exec(xz.stdout) ?? []).slice(1).map(Number);
const arm64Filter = xzMajor > 5 || (xzMajor === 5 && xzMinor >= 4);

function filterChain(target: string): string[] {
  if (target.includes("-x64")) return ["--x86", "--lzma2=preset=9e"];
  if (target.includes("-arm64") && arm64Filter) return ["--arm64", "--lzma2=preset=9e"];
  return ["-9e"];
}

/** Run a build-host tool, or explain which one failed and stop everything. */
function run(command: string, args: string[], label: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "inherit"] });
    const fail = (): never => {
      console.error(`${command} failed for ${label}.`);
      // Siblings are mid-write; leaving them to finish would leave a `.tar.xz`
      // beside the message that says the run failed. `exit` takes them with it.
      process.exit(1);
    };
    child.on("error", fail);
    child.on("exit", (code) => (code === 0 ? resolve() : fail()));
  });
}

/**
 * How many to pack at once. One `xz -9e` holds around 674 MiB while it runs, so
 * this is what bounds the pass's memory, and a core each is what it can actually
 * use — a four-core runner packing four at a time peaks near 2.7 GB, and there
 * is no point going wider than there are targets.
 */
const LANES = Math.min(TARGETS.length, cpus().length);

/** Run `jobs` at most `LANES` at a time, settling when the last one is done. */
async function pool(jobs: (() => Promise<void>)[]): Promise<void> {
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: LANES }, async () => {
      for (let job = queue.shift(); job !== undefined; job = queue.shift()) await job();
    }),
  );
}

const megabytes = (path: string): string => `${(statSync(path).size / 1e6).toFixed(1)} MB`;

mkdirSync(OUTDIR, { recursive: true });
writeFileSync(ENTRY, ENTRY_SOURCE);

// `dist/` is the bundler's, and a stray entry in it would be the next `npm
// pack`'s problem. `process.exit` below skips a `finally` but does fire this.
process.on("exit", () => rmSync(ENTRY, { force: true }));

const packs: (() => Promise<void>)[] = [];

try {
  for (const target of TARGETS) {
    // `bun-linux-arm64` → `dist-bin/jup-linux-arm64`; Windows wants the suffix.
    const name = `jup-${target.slice("bun-".length)}`;
    const outfile = join(OUTDIR, target.includes("windows") ? `${name}.exe` : name);

    const { success, logs } = await Bun.build({
      entrypoints: [ENTRY],
      // One decision, two options: bytecode is cached only for CommonJS output.
      // See the header for what it buys and what it costs.
      format: "cjs",
      bytecode: true,
      minify: true,
      compile: { target, outfile },
    });

    if (!success) {
      for (const log of logs) console.error(log);
      console.error(`bun build failed for ${target}.`);
      process.exit(1);
    }

    console.log(`built   ${outfile}  ${megabytes(outfile)}`);

    packs.push(async () => {
      // `tar` first so the archive carries a name and an executable bit, then xz
      // over it in place — without `-k` it removes the tar it just read, leaving
      // `<name>.tar.xz` and the uncompressed binary beside it.
      const archive = join(OUTDIR, `${name}.tar`);
      await run("tar", ["-cf", archive, "-C", OUTDIR, basename(outfile)], name);
      await run("xz", ["-T0", "-f", ...filterChain(target), archive], name);

      console.log(`packed  ${archive}.xz  ${megabytes(`${archive}.xz`)}`);
    });
  }
} finally {
  // Every build has read it by here, and the packing below never wants it.
  rmSync(ENTRY, { force: true });
}

await pool(packs);
