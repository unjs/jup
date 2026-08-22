/**
 * Compile the tool to a single native binary with `scriptc`, experimentally.
 *
 * [`scriptc`](https://scriptc.dev) type-checks with the real TypeScript
 * compiler, lowers the program to LLVM IR and links a small native runtime, so
 * the result runs with no Node.js on the machine. That is the shape §16.1 wants
 * for a proxy invocation — a static binary has no interpreter to boot and no
 * module graph to resolve — so this script exists to *measure how far the source
 * is from getting there*. It is not part of `pnpm build`: the shipped artifact
 * is still `dist/`, and nothing here is on the release path.
 *
 * `scriptc` compiles a whole TypeScript program itself, following static imports
 * and honouring the nearest `tsconfig.json`, so the source goes in unbundled and
 * keeps its types — which is the point, since types are what it lowers. Three
 * generated files in `.scriptc/` are all it needs:
 *
 *   - `entry.ts` — `src/bin.ts` with the `import()` of `main.ts` made static.
 *     A dynamic import is a *dynamic site*: `scriptc` will not follow it, so the
 *     real entry compiles to three statements and a call into an engine that a
 *     static build does not contain. The lazy cold path (§01.3) buys startup
 *     time for a module loader that a compiled binary does not have.
 *   - `globals.d.ts` — `HeadersInit`, which `src/net/proxy.ts` takes from
 *     `lib.dom`. `scriptc`'s lib set has no DOM, so the alias is restated
 *     structurally from the `Headers` constructor `@types/node` declares.
 *   - `tsconfig.json` — the root config, flattened. `scriptc` reads
 *     `compilerOptions` without resolving `extends`, and the strictness matters:
 *     with the defaults instead of ours the same source reports 226 errors
 *     rather than 73, most of them noise about index access.
 *
 * Usage:
 *   node scripts/compile.mjs               # build .scriptc/pipack
 *   node scripts/compile.mjs --coverage    # what fraction lowers statically
 *   node scripts/compile.mjs --dynamic     # embed quickjs-ng (~620 KB)
 *   node scripts/compile.mjs -o /tmp/pk    # choose the output path
 *   node scripts/compile.mjs -- --emit-ir  # forward flags to scriptc
 *
 * Cross-compiling is `scriptc`'s contract, not ours — its env passes through:
 *   SCRIPTC_CC=zigcc SCRIPTC_TARGET=wasm32-wasi node scripts/compile.mjs
 *
 * `--dynamic` embeds a JS engine to run what does not lower, which sounds like
 * the way to get a binary today and is not: it pulls the cold path (§01.3) into
 * the program, and its blockers with it. Static is the default here as it is
 * upstream.
 *
 * `scriptc` is deliberately *not* a dependency of this package — it is an
 * experiment, and a zero-dependency tool should not grow an 86 MB devDependency
 * to satisfy one. If it is not installed the script runs it through `npx`.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import { argv, env, exit, stdout, version } from "node:process";

/** Pinned: a compiler release must not change what this reports overnight. */
const SCRIPTC = "scriptc@0.0.34";

/** `scriptc` needs a modern host even though the binary it emits needs none. */
const MINIMUM_NODE = 24;

const root = join(import.meta.dirname, "..");
const outDir = join(root, ".scriptc");

const args = argv.slice(2);
const split = args.indexOf("--");
const forwarded = split === -1 ? [] : args.slice(split + 1);
const own = split === -1 ? args : args.slice(0, split);

const flag = (...names) => own.some((arg) => names.includes(arg));
const option = (...names) => {
  const at = own.findIndex((arg) => names.includes(arg));
  return at === -1 ? undefined : own[at + 1];
};

if (flag("-h", "--help")) {
  stdout.write(
    [
      "Usage: node scripts/compile.mjs [options] [-- <scriptc flags>]",
      "",
      "  -o, --out <path>  Output binary (default .scriptc/pipack)",
      "      --coverage    Report what lowers statically; emit no binary",
      "      --dynamic     Embed quickjs-ng for what does not lower",
      "      --prepare     Write .scriptc/ and stop, without invoking scriptc",
      "  -h, --help        This message",
      "",
    ].join("\n"),
  );
  exit(0);
}

const out = resolve(root, option("-o", "--out") ?? join(outDir, "pipack"));
const entry = join(outDir, "entry.ts");

// ------------------------------------------------------------- 1. preflight

const major = Number.parseInt(version.slice(1), 10);
if (major < MINIMUM_NODE) {
  fail(`scriptc needs Node ${MINIMUM_NODE} or newer to run; this is ${version}.`);
}

// `SCRIPTC_CC` may name a compiler that is not on PATH as written (`zigcc` is a
// shim scriptc resolves itself), so only the default is checked here.
if (env.SCRIPTC_CC === undefined && !which("clang") && !which("cc")) {
  fail("scriptc links with clang; no clang or cc on PATH.");
}

// -------------------------------------------------------------- 2. generate

await mkdir(outDir, { recursive: true });

await writeFile(
  entry,
  `// Generated by scripts/compile.mjs — do not edit.
//
// src/bin.ts, with two changes scriptc needs and Node does not:
//   - main.ts is imported statically, so the program is one compiled unit
//     rather than a call into an engine this build may not contain;
//   - the exit code goes through process.exit, because assignment to a member
//     expression — process.exitCode = n — has no lowering yet (SC1090).
/// <reference path="./globals.d.ts" />

import { runMain } from "../src/main.ts";

// §05.5/§10.1 — the tool's own entry point defaults the prompt off; written out
// rather than \`??=\`, which scriptc does not lower on member expressions.
if (process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT === undefined) {
  process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
}

process.exit(await runMain(process.argv.slice(2)));
`,
);

await writeFile(
  join(outDir, "globals.d.ts"),
  `// Generated by scripts/compile.mjs — do not edit.
//
// \`HeadersInit\` is a lib.dom global. scriptc's lib set has no DOM, so restate
// it from the \`Headers\` constructor @types/node declares — an alias, so the
// undici type and this one stay the same type rather than two lookalikes.
type HeadersInit = NonNullable<ConstructorParameters<typeof Headers>[0]>;
`,
);

// `extends` is not resolved by scriptc, so inline the root options rather than
// pointing at them. `noEmit` has to go: scriptc's program does emit.
const tsconfig = JSON.parse(stripComments(await readFile(join(root, "tsconfig.json"), "utf8")));
delete tsconfig.compilerOptions.noEmit;
tsconfig.include = ["./entry.ts", "./globals.d.ts", "../src/**/*.ts"];

await writeFile(join(outDir, "tsconfig.json"), `${JSON.stringify(tsconfig, undefined, 2)}\n`);

console.log(`Wrote ${rel(outDir)}/{entry.ts,globals.d.ts,tsconfig.json}`);

if (flag("--prepare")) exit(0);

// --------------------------------------------------------------- 3. compile

const local = join(root, "node_modules", ".bin", "scriptc");
const installed = existsSync(local);
const [command, lead] = installed ? [local, []] : ["npx", ["--yes", SCRIPTC]];

// `npx` reads the package.json of its working directory, and ours declares
// devEngines.packageManager: pnpm (§03.3) — which npm honours by refusing to
// run at all. Every path handed to scriptc is absolute, so the fallback runs
// from the temporary directory instead. A local install needs no such dodge.
const cwd = installed ? root : tmpdir();

const invocation = flag("--coverage")
  ? ["coverage", entry]
  : ["build", entry, "-o", out, ...(flag("--dynamic") ? ["--dynamic"] : [])];

const code = await run(command, [...lead, ...invocation, ...forwarded]);

if (code !== 0) {
  console.error(
    "\nscriptc rejected the program. Each error is a construct it does not lower" +
      "\nyet, not a defect here; `--coverage` gives the ratio rather than the list.",
  );
} else if (!flag("--coverage")) {
  console.log(`\nCompiled → ${rel(out)} (${(await stat(out)).size} bytes)`);
}

exit(code);

// ------------------------------------------------------------------ helpers

function rel(path) {
  const from = relative(root, path);
  return from.startsWith("..") ? path : from;
}

function fail(message) {
  console.error(message);
  exit(1);
}

function which(binary) {
  return (env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir !== "" && existsSync(join(dir, binary)));
}

/** tsconfig.json is JSONC; only line comments appear in ours. */
function stripComments(source) {
  return source.replaceAll(/^\s*\/\/.*$/gm, "");
}

function run(command, commandArgs) {
  console.log(`\n$ ${command} ${commandArgs.join(" ")}\n`);
  return new Promise((done, failed) => {
    const child = spawn(command, commandArgs, { cwd, env, stdio: "inherit" });
    child.on("error", failed);
    child.on("close", (code) => done(code ?? 1));
  });
}
