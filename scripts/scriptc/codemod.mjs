/**
 * Rewrite `src/` into a tree scriptc can parse, without touching `src/`.
 *
 * scriptc reaches Node builtins only through `import … from "node:x"`. jup's
 * house rule is the opposite — AGENTS.md, "Never `import` a `node:` builtin" —
 * and `process.getBuiltinModule` is what scriptc has no notion of at all: not a
 * missing typing, an absent feature (no mention of the name anywhere in
 * `@scriptc/compiler`). So the 78 call sites have to become imports somewhere,
 * and that somewhere is a derived copy: this writes `<out>/`, and `src/` stays
 * exactly as it ships.
 *
 * Every call site becomes a reference to a namespace import rather than a named
 * one, because the same rewrite then covers all three shapes jup uses without
 * parsing any of them: the top-level `const { x } = …` destructure, the inline
 * `process.getBuiltinModule("node:crypto").randomBytes(…)`, and proxy.ts's
 * `cond ? getBuiltinModule("node:https") : getBuiltinModule("node:http")`.
 * `const { EOL } = __sc_node_os;` is the same binding it was.
 *
 * Two further edits are applied by hand below (`ADAPTATIONS`) — they are not
 * about builtins but about scriptc's language subset, and they are listed
 * individually so the PR can name them.
 *
 * Usage: `node scripts/scriptc/codemod.mjs <src-dir> <out-dir>`
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, relative, dirname } from "node:path";

const SRC = process.argv[2];
const OUT = process.argv[3];

if (!SRC || !OUT) {
  console.error("usage: node scripts/scriptc/codemod.mjs <src-dir> <out-dir>");
  process.exit(2);
}

const CALL_RE = /process\.getBuiltinModule\(\s*"(node:[a-z/_]+)"\s*\)/g;

/**
 * Edits scriptc's *language* subset forces, as opposed to its builtin surface.
 * Both are semantics-neutral, and both are load-bearing for the one module that
 * compiles today (`version/semver.ts`), so they live here rather than in prose.
 */
const ADAPTATIONS = [
  {
    file: "version/semver.ts",
    why: "SC2012 — the `Number.*` statics are dynamic-only; the global is lowered statically.",
    from: /Number\.parseInt\(/g,
    to: "parseInt(",
  },
  {
    file: "version/semver.ts",
    why:
      "SC1090 — under the repo's `noUncheckedIndexedAccess`, `s[i]` types as " +
      "`string | undefined`, an index/result shape scriptc will not lower. `charAt` " +
      'answers `""` where the index read `undefined`, and both comparisons here are ' +
      "against a one-character literal, so neither branch changes.",
    from: `  const head = token[0];`,
    to: `  const head = token.charAt(0);`,
  },
  {
    file: "version/semver.ts",
    why: "SC1090 — as above, on the `~>1.2.3` spelling.",
    from: `token[1] === ">"`,
    to: `token.charAt(1) === ">"`,
  },
  {
    file: "version/semver.ts",
    why:
      "SC1043 — a relational compare needs a narrowed operand, not a `string | number` union. " +
      "`aNum === bNum` holds here, so both branches are exhaustive and the order is unchanged.",
    from: `  if (a === b) return 0;\n  return a < b ? -1 : 1;\n}`,
    to:
      `  if (a === b) return 0;\n` +
      `  if (typeof a === "number" && typeof b === "number") return a < b ? -1 : 1;\n` +
      `  return String(a) < String(b) ? -1 : 1;\n}`,
  },
];

rmSync(OUT, { recursive: true, force: true });

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
})(SRC);

let rewritten = 0;
let preserved = 0;

for (const file of files) {
  const rel = relative(SRC, file);
  const modules = new Set();

  const lines = readFileSync(file, "utf8")
    .split("\n")
    .map((line) => {
      // `shims.ts` carries the *generated* stub bodies as string literals. Those
      // are output, not code we compile: §12 marks the shim source exact, and
      // rewriting it would change the files `enable` writes to a user's PATH.
      const head = line.trimStart();
      if (head.startsWith("`") || head.startsWith('"')) {
        preserved += line.match(CALL_RE)?.length ?? 0;
        CALL_RE.lastIndex = 0;
        return line;
      }
      return line.replace(CALL_RE, (_, specifier) => {
        modules.add(specifier);
        rewritten++;
        return identifierFor(specifier);
      });
    });

  let source = lines.join("\n");
  if (modules.size > 0) source = withImports(source, modules);

  for (const { file: target, from, to } of ADAPTATIONS) {
    if (rel !== target) continue;
    const next = source.replace(from, to);
    if (next === source) throw new Error(`adaptation for ${target} did not apply`);
    source = next;
  }

  const dest = join(OUT, rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, source);
}

/** `node:fs/promises` -> `__sc_node_fs_promises`. Prefixed so it cannot collide. */
function identifierFor(specifier) {
  return `__sc_${specifier.replaceAll(/[:/-]/g, "_")}`;
}

/**
 * Put the imports below the file's own header comment rather than at line 1, so
 * a diff against `src/` reads as an insertion and the module still opens with
 * the paragraph that explains it.
 */
function withImports(source, modules) {
  const imports = [...modules]
    .sort()
    .map((m) => `import * as ${identifierFor(m)} from ${JSON.stringify(m)};`)
    .join("\n");

  const lines = source.split("\n");
  let at = 0;
  if (lines[0]?.startsWith("#!")) at++;
  while (at < lines.length && lines[at].trim() === "") at++;
  if (lines[at]?.trimStart().startsWith("/*")) {
    while (at < lines.length && !lines[at].includes("*/")) at++;
    at++;
  }
  lines.splice(at, 0, imports);
  return lines.join("\n");
}

console.log(
  `${files.length} files -> ${OUT}\n` +
    `  ${rewritten} getBuiltinModule call(s) rewritten to namespace imports\n` +
    `  ${preserved} preserved verbatim inside generated-shim string literals\n` +
    `  ${ADAPTATIONS.length} language-subset adaptation(s) applied`,
);
