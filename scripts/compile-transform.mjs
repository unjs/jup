/**
 * Prototype: make the cold path visible to `scriptc`, and fix what it rejects,
 * by rewriting a copy of the source tree rather than by editing `src/`.
 *
 * `compile.mjs` measures the warm path and stops there, because everything past
 * an `import()` is a *dynamic site* `scriptc` will not follow — 93% of 1336
 * statements lower, and the cold path (§01.3) is simply not judged. This script
 * copies `src/**.ts` into a tree of its own, still as TypeScript, and rewrites
 * it with oxc — the parser rolldown re-exports, which obuild vendors.
 *
 * **Parse for locations, splice the original text, never re-print.** oxc's
 * `transformSync` would strip the types, and the types are what `scriptc`
 * lowers; its `parseSync` keeps them in the AST and hands back UTF-16 offsets
 * into the source we already have. So every rewrite is a byte range swapped in
 * the original file: comments, formatting and every type annotation survive
 * untouched, because nothing regenerates them.
 *
 * Two kinds of rewrite:
 *
 *   1. `import("./x.ts")` becomes a hoisted static import plus a record
 *      literal — a record, not a namespace, because `scriptc` lowers records
 *      and cannot compile the getter-backed namespace object a bundler would
 *      synthesise. Twelve sites. This is the one that is *true of the compiled
 *      target and false of Node*, so it belongs here and nowhere else.
 *   2. The call-site rules in `transform-rules.mjs`, each replacing one
 *      expression with another of the same static type, routed through a
 *      generated `__compat.ts`.
 *
 * What keeps (2) honest is `--typecheck`: it runs the repo's own `tsc` over the
 * rewritten tree. A rule that changed a type — `.origin` on something that is
 * not a URL, say — fails there rather than silently compiling a different
 * program. Run it after touching a rule.
 *
 * The rules are not a recommendation. Every one of them is also a one-line
 * source change that costs nothing in Node, and doing them here means the code
 * the tests run and the code that compiles are different files. They exist to
 * answer one question with a number: *how much of what `scriptc` rejects is
 * mechanical?*
 *
 * The answer, on this tree:
 *
 *   `--rules none`   315 blockers   the floor — imports made static, nothing else
 *   default          285 blockers   51 rewrites across 6 rules
 *   ------------------------------------------------------------------------
 *   mechanical        30 blockers   under a tenth of the program
 *
 * 51 rewrites clear 30 errors because a rule fires wherever it is *safe*, not
 * only where `scriptc` complained, and because clearing one error in an
 * expression can reveal a second behind it. Two modules go to zero and stay
 * there: `utils/json.ts` — §03's top-level field scanner, which compiles to a
 * native binary and matches Node — and `version/resolve.ts`.
 *
 * The residual is the wall, and it is not mechanical: `net/proxy.ts` (57) and
 * `cache/tar.ts` (42) are together a third of it, and neither moves without
 * either FFI or a rewrite of the module. Read `transform-rules.mjs` for the
 * rewrites that were considered and rejected, each with the reason.
 *
 * One caveat the count cannot show: `utils/json.ts` compiling does not make
 * §03 compilable. It hands back `Record<string, unknown>`, and *reading* an
 * `unknown` has no static representation at all — the probe that exercises it
 * has to stop at `Object.keys(...).length`. That is the type-shape half of the
 * wall, and no transform reaches it.
 *
 * Usage:
 *   node scripts/compile-transform.mjs               # rewrite, build, count
 *   node scripts/compile-transform.mjs --typecheck   # tsc over the tree first
 *   node scripts/compile-transform.mjs --rules none  # imports only: the floor
 *   node scripts/compile-transform.mjs --coverage    # the ratio instead
 *   node scripts/compile-transform.mjs --prepare     # emit the tree only
 *   node scripts/compile-transform.mjs --out "$(mktemp -d)"
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { argv, exit } from "node:process";
import { COMPAT_TS } from "./transform-compat.mjs";
import { RULES } from "./transform-rules.mjs";
import {
  flattenedTsconfig,
  GLOBALS_DTS,
  loadOxc,
  outDir,
  preflight,
  rel,
  root,
  runScriptc,
  runTsc,
} from "./scriptc.mjs";

const args = argv.slice(2);
const flag = (...names) => args.some((arg) => names.includes(arg));
const option = (...names) => {
  const at = args.findIndex((arg) => names.includes(arg));
  return at === -1 ? undefined : args[at + 1];
};

const source = join(root, "src");
const tree = resolve(root, option("-o", "--out") ?? join(outDir, "transformed"));
const entry = join(tree, "__entry.ts");
const out = join(tree, "pipack");

const enabled = new Set(
  option("--rules") === "none"
    ? []
    : (option("--rules") ?? RULES.map((rule) => rule.name).join(",")).split(","),
);
const rules = RULES.filter((rule) => enabled.has(rule.name));

preflight();

const { parseSync } = await loadOxc();

// ------------------------------------------------------------- 1. transform

const files = [];
for (const file of await readdir(source, { recursive: true })) {
  if (file.endsWith(".ts")) files.push(join(source, file));
}

/** Value exports per module, parsed rather than guessed, for the import rule. */
const exportsOf = new Map();
for (const file of files) exportsOf.set(file, valueExports(await parseFile(file)));

const applied = new Map(rules.map((rule) => [rule.name, 0]));
let imports = 0;
let skipped = 0;

await rm(tree, { recursive: true, force: true });

for (const file of files) {
  const code = await readFile(file, "utf8");
  const program = await parseFile(file, code);

  const edits = [];
  const preamble = [];
  const helpers = new Map();
  const tagFor = new Map();

  const text = (node) => code.slice(node.start, node.end);
  const helper = (name) => {
    helpers.set(name, `__c_${name}`);
    return `__c_${name}`;
  };

  /** One tag per (file, specifier), naming a record of that module's exports. */
  const tagOf = (specifier) => {
    const existing = tagFor.get(specifier);
    if (existing !== undefined) return existing;
    const names = exportsOf.get(resolve(dirname(file), specifier)) ?? [];
    if (names.length === 0) return undefined;
    const tag = `__ns${imports++}`;
    tagFor.set(specifier, tag);
    const alias = (name) => `${tag}_${name}`;
    preamble.push(
      `import { ${names.map((name) => `${name} as ${alias(name)}`).join(", ")} } from ${JSON.stringify(specifier)};`,
      `const ${tag} = { ${names.map((name) => `${name}: ${alias(name)}`).join(", ")} };`,
    );
    return tag;
  };

  walk(program, (node) => {
    // `import("./x.ts")` in a value position.
    if (node.type === "ImportExpression" && node.source?.type === "Literal") {
      const tag = tagOf(node.source.value);
      if (tag !== undefined)
        edits.push({
          start: node.start,
          end: node.end,
          text: `Promise.resolve(${tag})`,
          rule: "import",
        });
      return;
    }
    // `typeof import("./x.ts")` in a type position has to name the record we
    // built, since the namespace it referred to is no longer materialised.
    if (node.type === "TSImportType" && node.source?.type === "Literal") {
      const tag = tagOf(node.source.value);
      if (tag !== undefined)
        edits.push({ start: node.start, end: node.end, text: tag, rule: "import" });
      return;
    }
    for (const rule of rules) {
      const edit = rule.match(node, { text, helper });
      if (edit === undefined) continue;
      edits.push({ ...edit, rule: rule.name });
      return;
    }
  });

  if (helpers.size > 0) {
    const from = relative(dirname(join(tree, relative(source, file))), tree) || ".";
    const specifier = `${from.startsWith(".") ? from : `./${from}`}/__compat.ts`;
    preamble.unshift(
      `import { ${[...helpers].map(([name, alias]) => `${name} as ${alias}`).join(", ")} } from ${JSON.stringify(specifier)};`,
    );
  }

  const target = join(tree, relative(source, file));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, splice(code, edits, preamble));
}

// ---------------------------------------------------------------- 2. emit

await writeFile(join(tree, "__compat.ts"), COMPAT_TS);
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

console.log(`Rewrote ${files.length} files → ${rel(tree)}`);
console.log(`  ${String(imports).padStart(3)}  dynamic imports made static`);
for (const [name, count] of applied) {
  if (count > 0) console.log(`  ${String(count).padStart(3)}  ${name}`);
}
if (skipped > 0)
  console.log(`  ${String(skipped).padStart(3)}  skipped (nested inside another rewrite)`);

// ------------------------------------------------------------ 3. typecheck

if (flag("--typecheck")) {
  console.log("\nType-checking the rewritten tree — a rule that changed a type fails here.");
  const code = await runTsc([
    "--noEmit",
    "--skipLibCheck",
    "--project",
    join(tree, "tsconfig.json"),
  ]);
  if (code !== 0) {
    console.error("\nThe rewrite is not type-preserving. Fix the rule; do not compile this.");
    exit(code);
  }
  console.log("Types are unchanged.");
}

if (flag("--prepare")) exit(0);

// -------------------------------------------------------------- 4. compile

const code = await runScriptc(
  flag("--coverage") ? ["coverage", entry] : ["build", entry, "-o", out],
);

if (code === 0 && !flag("--coverage")) {
  console.log(`\nCompiled → ${rel(out)} (${(await stat(out)).size} bytes)`);
}

exit(code);

// ------------------------------------------------------------------ helpers

async function parseFile(file, code) {
  const text = code ?? (await readFile(file, "utf8"));
  const result = parseSync(file, text, { lang: "ts", sourceType: "module" });
  if (result.errors.length > 0) {
    console.error(`${rel(file)}: ${result.errors[0].message}`);
    exit(1);
  }
  return result.program;
}

/** Value exports in declaration order — what a record literal has to carry. */
function valueExports(program) {
  const names = [];
  for (const node of program.body) {
    if (node.type !== "ExportNamedDeclaration" || node.declaration === null) continue;
    const declaration = node.declaration;
    if (declaration === undefined || declaration.type.startsWith("TS")) continue;
    if (declaration.type === "VariableDeclaration") {
      for (const one of declaration.declarations) {
        if (one.id?.type === "Identifier") names.push(one.id.name);
      }
    } else if (declaration.id?.type === "Identifier") {
      names.push(declaration.id.name);
    }
  }
  return names;
}

/** Every node reachable from `root`, parents before children. */
function walk(node, visit) {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type === "string") visit(node);
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    walk(node[key], visit);
  }
}

/**
 * Apply the edits back-to-front, then hoist the preamble.
 *
 * A rewrite that quotes its receiver copies the *original* text of that
 * receiver, so an edit nested inside another one would be lost. Rather than
 * render ranges recursively, the outer edit wins and the inner one is dropped
 * and counted — the result is still correct code, just with one blocker left
 * standing. With the current rules it never happens; if a new rule makes it
 * happen the count says so instead of the output quietly being wrong.
 */
function splice(code, edits, preamble) {
  edits.sort((a, b) => a.start - b.start || b.end - a.end);

  const kept = [];
  for (const edit of edits) {
    const previous = kept.at(-1);
    if (previous !== undefined && edit.start < previous.end) {
      skipped++;
      continue;
    }
    kept.push(edit);
  }

  let out = code;
  for (const edit of kept.reverse()) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    if (edit.rule !== "import") applied.set(edit.rule, (applied.get(edit.rule) ?? 0) + 1);
  }

  if (preamble.length === 0) return out;
  const shebang = out.startsWith("#!") ? out.indexOf("\n") + 1 : 0;
  return `${out.slice(0, shebang)}${preamble.join("\n")}\n${out.slice(shebang)}`;
}
