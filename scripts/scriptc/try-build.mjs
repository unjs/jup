/**
 * Try to compile jup to a native binary with scriptc, and report where it stops.
 *
 * Four stages, each of which prints its own verdict and none of which writes
 * anything into the repository — the rewritten tree, the entries and the
 * binaries all land under `<work>` (default `.scriptc-work/`, gitignored):
 *
 *   1. rewrite   `src/` -> a tree scriptc can parse (`codemod.mjs`)
 *   2. coverage  the whole CLI: how many preflight errors, and in which files
 *   3. build     the whole CLI, which is expected to fail; and `version/semver.ts`,
 *                which is expected to succeed
 *   4. verify    the semver binary against Node running the same source
 *
 * Stage 4 is the point of the script. Stage 3 succeeding is not evidence that
 * the output is correct, and on scriptc 0.0.35 it is not: see `regex-repro.ts`.
 *
 * Usage: `node scripts/scriptc/try-build.mjs [--work=<dir>] [--scriptc=<bin>]`
 * Requires Node >=24 and `scriptc` on PATH (or `--scriptc`).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");

const args = new Map(
  process.argv.slice(2).map((a) => {
    const eq = a.indexOf("=");
    return eq === -1 ? [a.replace(/^--/, ""), ""] : [a.slice(2, eq), a.slice(eq + 1)];
  }),
);
const WORK = resolve(args.get("work") || join(REPO, ".scriptc-work"));
const SCRIPTC = args.get("scriptc") || "scriptc";
const TREE = join(WORK, "src");

mkdirSync(WORK, { recursive: true });

/** Run scriptc, capturing both streams; a non-zero exit is data, not a crash. */
function scriptc(...argv) {
  const r = spawnSync(SCRIPTC, argv, { encoding: "utf8", cwd: WORK });
  if (r.error) {
    console.error(`\ncannot run ${SCRIPTC}: ${r.error.message}`);
    console.error("install it with `npm i -g scriptc` (needs Node >=24), or pass --scriptc=<path>");
    process.exit(2);
  }
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

function heading(n, text) {
  console.log(`\n${"=".repeat(64)}\n${n}. ${text}\n${"=".repeat(64)}`);
}

// 1 -------------------------------------------------------------------------
heading(1, "rewrite src/ into a tree scriptc can parse");
console.log(
  execFileSync(process.execPath, [join(HERE, "codemod.mjs"), join(REPO, "src"), TREE], {
    encoding: "utf8",
  }).trim(),
);

// The shipped entry (`src/bin.ts`) reaches main through `await import()` and
// calls `enableCompileCache`; neither survives a static compile, so the CLI gets
// an entry that only differs in those two lines.
writeFileSync(
  join(TREE, "entry-cli.ts"),
  `import { runMain } from "./main.ts";\n\n` +
    `const { code } = await runMain(process.argv.slice(2), { handover: true });\n` +
    `if (code !== 0) process.exitCode = code;\n`,
);

// The one module that compiles today, driven through its real exports.
writeFileSync(
  join(TREE, "entry-semver.ts"),
  `import { parse, satisfies, compare, isValidRange, major } from "./version/semver.ts";\n\n` +
    `const [version = "10.12.1", range = "^10.0.0"] = process.argv.slice(2);\n` +
    `const parsed = parse(version);\n` +
    `console.log("parse:", parsed ? \`\${parsed.major}.\${parsed.minor}.\${parsed.patch}\` : "null");\n` +
    `console.log("major:", major(version));\n` +
    `console.log("isValidRange:", isValidRange(range));\n` +
    `console.log("satisfies:", satisfies(version, range));\n` +
    `console.log("compare vs 9.0.0:", compare(version, "9.0.0"));\n`,
);

// 2 -------------------------------------------------------------------------
heading(2, "coverage: the whole CLI");
const coverage = scriptc("coverage", join(TREE, "entry-cli.ts"));
const errors = [...coverage.out.matchAll(/\/src\/([\w/.-]+\.ts):\d+/g)].map((m) => m[1]);
const byFile = new Map();
for (const file of errors) byFile.set(file, (byFile.get(file) ?? 0) + 1);

console.log(coverage.out.split("\n").slice(0, 3).join("\n").trim() || "(no summary line)");
if (byFile.size > 0) {
  console.log(`\n${errors.length} preflight errors, by file:`);
  for (const [file, n] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
    console.log(`  ${String(n).padStart(4)}  ${file}`);
  }
}

// 3 -------------------------------------------------------------------------
heading(3, "build");
const cli = scriptc("build", join(TREE, "entry-cli.ts"), "-o", join(WORK, "jup"));
console.log(`whole CLI      -> ${cli.code === 0 ? "BUILT (unexpected!)" : "refused, as expected"}`);

const semverBin = join(WORK, "jup-semver");
const semver = scriptc("build", join(TREE, "entry-semver.ts"), "-o", semverBin);
if (semver.code !== 0) {
  console.log("version/semver -> FAILED");
  console.log(semver.out.trim());
  process.exit(1);
}
console.log(
  `version/semver -> built, ${(statSync(semverBin).size / 1024).toFixed(0)} KB static` +
    " (no embedded engine)",
);

// 4 -------------------------------------------------------------------------
heading(4, "verify the binary against Node on the same source");

const oracle = join(WORK, "oracle.mjs");
writeFileSync(
  oracle,
  `import { parse, satisfies, compare, isValidRange, major } from ${JSON.stringify(join(REPO, "src/version/semver.ts"))};\n` +
    `const [version, range] = process.argv.slice(2);\n` +
    `const parsed = parse(version);\n` +
    `console.log("parse:", parsed ? \`\${parsed.major}.\${parsed.minor}.\${parsed.patch}\` : "null");\n` +
    `console.log("major:", major(version));\n` +
    `console.log("isValidRange:", isValidRange(range));\n` +
    `console.log("satisfies:", satisfies(version, range));\n` +
    `console.log("compare vs 9.0.0:", compare(version, "9.0.0"));\n`,
);

const CASES = [
  ["10.12.1", "^10.0.0"],
  ["1.2.3-beta.1", ">=1.0.0"],
  ["9.0.0", "9.x"],
  ["0.0.1", "~0.0.1"],
  ["4.1.0+sha224.abc", "^4"],
  ["20.11.0", ">=18 <21"],
  ["bogus", "^1"],
  ["1.0.0-rc.10", "1.0.0-rc.2"],
  ["2.0.0", "*"],
  ["1.2.3-alpha.00000000000000000001", "^1.0.0-alpha"],
  ["10.0.0-0", "^9.0.0-0"],
];

const run = (cmd, argv) => spawnSync(cmd, argv, { encoding: "utf8" }).stdout?.trim() ?? "";
let diffs = 0;

for (const [version, range] of CASES) {
  const expected = run(process.execPath, ["--experimental-strip-types", oracle, version, range]);
  const actual = run(semverBin, [version, range]);
  const label = `${version} | ${range}`;
  if (expected === actual) {
    console.log(`  ok    ${label}`);
    continue;
  }
  diffs++;
  console.log(`  DIFF  ${label}`);
  const e = expected.split("\n");
  actual.split("\n").forEach((line, i) => {
    if (line !== e[i]) console.log(`          node: ${e[i]}\n        native: ${line}`);
  });
}

console.log(
  `\n${CASES.length - diffs}/${CASES.length} agree with Node.` +
    (diffs > 0 ? ` ${diffs} silently wrong — see scripts/scriptc/regex-repro.ts.` : ""),
);
process.exitCode = diffs > 0 ? 1 : 0;
