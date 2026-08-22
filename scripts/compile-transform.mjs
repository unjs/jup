/**
 * Prototype: make the cold path visible to `scriptc` by rewriting the source
 * tree, not by editing it.
 *
 * `compile.mjs` measures the warm path and stops there, because everything past
 * an `import()` is a *dynamic site* `scriptc` will not follow — 93% of 1336
 * statements lower, and the cold path (§01.3) is simply not judged. This script
 * copies `src/**.ts` into `.scriptc/transformed/`, still as TypeScript, with
 * every `import("./x.ts")` turned into a hoisted static import plus a plain
 * object literal. Twelve sites. The whole program then compiles as one unit.
 *
 * The honest number that falls out: **315 blockers**, concentrated in
 * `net/proxy.ts` (57), `cache/tar.ts` (42) and `commands/shims.ts` (25). Split
 * by `scriptc`'s own error codes, which is the only cut that stays honest as
 * the compiler moves:
 *
 *   - 140  SC2020  a typed standard-library or `@types/node` member with no
 *          lowering yet: `URL.canParse` ×9, `fs/promises.lstat` ×7,
 *          `O_NOFOLLOW`, `Writable`, `createGzip`
 *   -  85  SC1xxx  constructs unsupported so far — `Function.prototype.call`
 *          ×13, assignment to non-variables ×7, checked casts of `unknown`
 *          ×8, class values, generator methods, `for await`
 *   -  46  SC2004  cascades that vanish with whatever they inherit from
 *   -  32  SC2011/SC2012  what runs only in the embedded engine, so
 *          `--dynamic` compiles it and a static build does not
 *   -  12  SC2009/SC2003/SC2001  type-shape blockers: unions and `Promise`
 *          arms `scriptc` will not re-tag
 *
 * Recount rather than trust: every number above is `grep -oE 'error SC[0-9]+'`
 * over this script's own output.
 *
 * Two things that total hides. Fixing a blocker can *raise* it — the two errors
 * on `nodeFetch`'s old `typeof globalThis.fetch` signature were masking the
 * whole rest of `net/proxy.ts`, and clearing them took 254 to 315. And the
 * mechanical-looking half is not always mechanical: `Object.hasOwn` and
 * `Object.prototype.hasOwnProperty.call(o, k)` are one function to the spec and
 * both unsupported here, so trading one for the other changed each error's code
 * (`SC2020` to `SC1090`) and not the count.
 *
 * So a transform layer is worth exactly one thing — this rewrite, which is true
 * of the compiled target and false of Node, and which no source edit should
 * make. Anything that is a one-line source change costing nothing in Node
 * belongs in `src/`: doing it here instead would mean the code the tests run
 * and the code that compiles are different files.
 *
 * Prototype-grade, and deliberately so: export names are found by regex rather
 * than by parsing, which holds because every dynamic-import target in `src/`
 * declares its exports inline (`export function`, `export const`) with no
 * `export {}` blocks or star re-exports. It would not survive one.
 *
 * Usage:
 *   node scripts/compile-transform.mjs             # build, report the count
 *   node scripts/compile-transform.mjs --coverage  # the ratio instead
 *   node scripts/compile-transform.mjs --prepare   # emit the tree only
 */

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { argv, exit } from "node:process";
import {
  flattenedTsconfig,
  GLOBALS_DTS,
  outDir,
  preflight,
  rel,
  root,
  runScriptc,
} from "./scriptc.mjs";

/** `import("./x.ts")` in a value position — `typeof import(...)` is a type. */
const DYNAMIC = /(?<!typeof\s{0,4})\bimport\(\s*"([^"]+)"\s*\)/g;

/** Value exports of a module, in declaration order. See the note above. */
const EXPORTED = /^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z\d_$]+)/gm;

const args = argv.slice(2);
const flag = (...names) => args.some((arg) => names.includes(arg));

const source = join(root, "src");
const tree = join(outDir, "transformed");
const entry = join(tree, "__entry.ts");
const out = resolve(root, join(tree, "pipack"));

preflight();

// ------------------------------------------------------------- 1. transform

const files = [];
for (const file of await readdir(source, { recursive: true })) {
  if (file.endsWith(".ts")) files.push(join(source, file));
}

let rewritten = 0;

for (const file of files) {
  let code = await readFile(file, "utf8");
  const preamble = [];
  const tagFor = new Map();

  for (const [, specifier] of code.matchAll(DYNAMIC)) {
    if (tagFor.has(specifier)) continue;
    const names = await valueExports(resolve(dirname(file), specifier));
    if (names.length === 0) continue;

    const tag = `__ns${rewritten++}`;
    tagFor.set(specifier, tag);
    const alias = (name) => `${tag}_${name}`;
    preamble.push(
      `import { ${names.map((name) => `${name} as ${alias(name)}`).join(", ")} } from ${JSON.stringify(specifier)};`,
      // A record literal, not a namespace: scriptc lowers records, and the
      // getter-backed namespace object a bundler would synthesise is exactly
      // what it cannot compile.
      `const ${tag} = { ${names.map((name) => `${name}: ${alias(name)}`).join(", ")} };`,
    );
  }

  code = code.replace(DYNAMIC, (whole, specifier) => {
    const tag = tagFor.get(specifier);
    return tag === undefined ? whole : `Promise.resolve(${tag})`;
  });

  // `typeof import("x")` in a type position has to name the object we built,
  // since the namespace it referred to is no longer materialised.
  for (const [specifier, tag] of tagFor) {
    code = code.replaceAll(`typeof import(${JSON.stringify(specifier)})`, `typeof ${tag}`);
  }

  if (preamble.length > 0) {
    const shebang = code.startsWith("#!") ? code.indexOf("\n") + 1 : 0;
    code = `${code.slice(0, shebang)}${preamble.join("\n")}\n${code.slice(shebang)}`;
  }

  const target = join(tree, relative(source, file));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, code);
}

await writeFile(
  entry,
  `// Generated by scripts/compile-transform.mjs — do not edit.
/// <reference path="./__globals.d.ts" />

import { runMain } from "./main.ts";

if (process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT === undefined) {
  process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
}

process.exit(await runMain(process.argv.slice(2)));
`,
);
await writeFile(join(tree, "__globals.d.ts"), GLOBALS_DTS);
await writeFile(join(tree, "tsconfig.json"), await flattenedTsconfig(["./**/*.ts"]));

console.log(`Rewrote ${rewritten} dynamic imports across ${files.length} files → ${rel(tree)}`);

if (flag("--prepare")) exit(0);

// --------------------------------------------------------------- 2. compile

const code = await runScriptc(
  flag("--coverage") ? ["coverage", entry] : ["build", entry, "-o", out],
);

if (code === 0 && !flag("--coverage")) {
  console.log(`\nCompiled → ${rel(out)} (${(await stat(out)).size} bytes)`);
}

exit(code);

// ------------------------------------------------------------------ helpers

async function valueExports(specifier) {
  let code;
  try {
    code = await readFile(specifier, "utf8");
  } catch {
    return [];
  }
  return [...code.matchAll(EXPORTED)].map(([, name]) => name);
}
