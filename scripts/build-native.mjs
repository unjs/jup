/**
 * Experimental — compile jup to a native executable with scriptc
 * (https://scriptc.dev), for hosts with no Node and for shims that cost
 * milliseconds rather than a runtime start.
 *
 * `src/` is the mainline release and is not edited for this. The build copies
 * it to `node_modules/.cache/jup-native/`, then:
 *
 * 1. drops `native/scriptc/overrides/` over the copy — the modules whose
 *    native form is a different design rather than a different spelling
 *    (`run/native.ts` execs through FFI, shims dispatch on `argv0`);
 * 2. applies {@link PATCHES}: anchored edits for what scriptc cannot compile
 *    yet, each required to match **exactly once**, so a change in `src/`
 *    fails this build loudly instead of being patched around silently;
 * 3. rewrites `process.getBuiltinModule("node:x")` into static imports
 *    ({@link rewriteBuiltins}) — scriptc cannot destructure its result, and a
 *    native image pays nothing for a static import.
 *
 * What the native build is, in behaviour: exec-only. Every run *becomes* the
 * tool through `execve(2)` — native artifacts directly, JavaScript entry points
 * as `node <bin> …`, where `node` may be our own shim. No in-process handover,
 * no addon, no IPC relay (the channel is inherited whole), no scoped
 * `runMain`. HTTP proxies and `JUP_STRICT_SSL=0` are not supported yet: their
 * `node:http`/`node:tls` transport is beyond scriptc's current lowering.
 *
 * Usage (`pnpm build:native` runs the same thing):
 *   node scripts/build-native.mjs [--out <file>] [-- <extra scriptc flags>]
 *
 * Needs `scriptc` (`SCRIPTC` or on `PATH`, ideally {@link SCRIPTC_VERSION})
 * and a C compiler (`CC`, default `cc`) for the `execve` wrapper.
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const NATIVE = join(ROOT, "native", "scriptc");
const WORK = join(ROOT, "node_modules", ".cache", "jup-native");
const SRC = join(WORK, "src");

/** The release this build was last verified against; others may well work. */
const SCRIPTC_VERSION = "0.4.12";

const ENTRY = "native-bin.ts";

// --- Patches -----------------------------------------------------------------

/**
 * `[file, find, replace]` — `find` must occur exactly once in the *original*
 * `src/` text (before the builtin rewrite). A `find` of `{ from, to }`
 * replaces from `from` up to (not including) `to`, or to the end of the file
 * when `to` is `null`.
 */
const PATCHES = [
  // --- typing gaps: scriptc's type world differs from `tsc`'s ---------------

  // `HeadersInit` is DOM-lib under scriptc.
  [
    "net/proxy.ts",
    "headers: HeadersInit | undefined",
    "headers: ConstructorParameters<typeof Headers>[0] | undefined",
  ],
  // A generic function reference instantiated through `.map` (SC2001).
  [
    "config/env-vars.ts",
    "  ].map(jupSpelling),",
    "  ].map((name: string): string => jupSpelling(name)),",
  ],
  // A structural view of an `Error` subclass (SC1090).
  [
    "errors-cold.ts",
    "const code = (current as { code?: unknown }).code;",
    "const code: unknown = (current as NodeJS.ErrnoException).code;",
  ],
  // `??` whose default widens the result type (SC1090): restate as a `Spec`.
  ...["commands/cli.ts", "commands/info.ts"].map((file) => [
    file,
    "lookup.range ?? lookup.getSpec({ requireVersion: false })",
    "(lookup.range === undefined ? lookup.getSpec({ requireVersion: false }) : { name: lookup.range.name, range: lookup.range.range })",
  ]),

  // --- one invocation per process: no scoped runs ---------------------------

  [
    "main.ts",
    `  if (run?.handover !== true) {
    const { runScoped } = await import("./run/scoped.ts");
    return await runScoped(run, () => dispatch(argv, run));
  }`,
    `  if (run?.handover !== true) throw new TypeError("The native build runs under handover only.");`,
  ],
  // `AsyncLocalStorage` becomes a module slot.
  ["utils/context.ts", `import type { AsyncLocalStorage } from "node:async_hooks";\n`, ""],
  [
    "utils/context.ts",
    "let storage: AsyncLocalStorage<RunContext> | undefined;",
    "let current: RunContext | undefined;",
  ],
  ["utils/context.ts", "return storage?.getStore();", "return current;"],
  [
    "utils/context.ts",
    `  storage ??= new (process.getBuiltinModule("node:async_hooks").AsyncLocalStorage)();
  return storage.run(context, fn);`,
    `  const previous = current;
  current = context;
  try {
    return fn();
  } finally {
    current = previous;
  }`,
  ],
  // `process.env` cannot be reassigned (SC1090): rewrite it in place.
  [
    "utils/context.ts",
    `  if (context === undefined) process.env = env;
  else context.env = env;`,
    `  if (context !== undefined) {
    context.env = env;
    return;
  }
  for (const key of Object.keys(process.env)) if (!Object.hasOwn(env, key)) delete process.env[key];
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (value !== undefined) process.env[key] = value;
  }`,
  ],
  [
    "net/npmrc.ts",
    "return (runContext()?.npmrc as Map<string, NpmrcConfig> | undefined) ?? processCache;",
    "return processCache;",
  ],

  // --- identity: no package root, no bundler define ---------------------------

  // `import.meta.url` is frozen at build time; `COREPACK_ROOT` is the binary's folder.
  [
    "utils/self.ts",
    `  const from = dirname(fileURLToPath(moduleUrl));
  return walkUp(from, (dir) => existsSync(join(dir, "package.json"))) ?? from;`,
    `  void moduleUrl;
  return dirname(process.execPath);`,
  ],
  [
    "utils/self.ts",
    "declare const __JUP_VERSION__: string | undefined;",
    () => `const __JUP_VERSION__: string | undefined = ${JSON.stringify(ownVersion())};`,
  ],
  [
    "run/exec.ts",
    "ownRoot ??= resolveOwnRoot(import.meta.url);",
    "ownRoot ??= resolveOwnRoot(process.execPath);",
  ],

  // --- §08: exec-only --------------------------------------------------------

  ["run/exec.ts", `const { runMain } = process.getBuiltinModule("node:module");\n`, ""],
  [
    "run/exec.ts",
    `import { entryNameFor,`,
    `import { execNative } from "./native.ts";
import { resolveInterpreter } from "./interpreter.ts";
import { entryNameFor,`,
  ],
  [
    "run/exec.ts",
    { from: "export function execPackageManager(", to: null },
    `export function execPackageManager(
  binName: string,
  spec: Installation,
  args: string[],
  fallbackBin?: BinSpec,
  execMode?: "js" | "native",
  binArgs?: readonly string[],
  _run?: RunOptions,
): Promise<number> {
  const binPath = resolveBinPath(binName, spec, fallbackBin);
  const argv = binArgs === undefined || binArgs.length === 0 ? args : [...binArgs, ...args];

  // Both paths replace this process (§08.3.3), so §08.7's additions go into the
  // tool's own block and \`process.env\` is never touched.
  if (execMode === "native") {
    // \`binName\` as argv[0]: §08.3's artifacts dispatch on it (\`bun\`/\`bunx\`).
    return execNative(binPath, argv, childEnvironment(dirname(binPath), false), binName);
  }
  // §08.3.1 — \`[node, binPath, …]\`, and \`node\` may be our own shim.
  const env = childEnvironment(shimDirectoryFor(binName), false);
  const interpreter = resolveInterpreter(binName);
  return execNative(interpreter, [binPath, ...argv], env, interpreter);
}
`,
  ],

  // --- §10: a shim is a symlink to this executable ---------------------------

  // Ownership (§10.6) is "resolves to us" (`run/self-link.ts`). A Node build's
  // marker-bearing stub still counts, so this build takes over those shims; the
  // Node build sees ours as foreign links, which §10.3 displaces and records.
  // `isOurShim` is §08.7's promotion test and `info`'s; `isOurEntry` is
  // `enable`'s and `disable`'s.
  [
    "run/exec.ts",
    `import { messages } from "../errors.ts";\n`,
    `import { messages } from "../errors.ts";\nimport { isSelfLink } from "./self-link.ts";\n`,
  ],
  [
    "run/exec.ts",
    "export function isOurShim(file: string, binName: string): boolean {\n",
    "export function isOurShim(file: string, binName: string): boolean {\n  if (isSelfLink(file)) return true;\n",
  ],
  [
    "commands/shims.ts",
    `import { extractAddon } from "../run/addon.ts";\n`,
    `import { extractAddon } from "../run/addon.ts";\nimport { isSelfLink, selfExecutable } from "../run/self-link.ts";\n`,
  ],
  [
    "commands/shims.ts",
    "async function isOurEntry(file: string, binName: string, stats?: Stats): Promise<boolean> {\n",
    "async function isOurEntry(file: string, binName: string, stats?: Stats): Promise<boolean> {\n  if (isSelfLink(file)) return true;\n",
  ],
  // §10.3 unchanged — `lstat`, the relative link, Yarn Switch, displacement, the
  // idempotent no-write — but the link names the executable, not a stub.
  [
    "commands/shims.ts",
    `  return linkPosixEntry(
    installDirectory,
    await ensureStub(distFolder, binName, interpreter),
    binName,
    options,
  );`,
    `  void distFolder;
  void interpreter;
  return linkPosixEntry(installDirectory, selfExecutable(), binName, options);`,
  ],
  // §10.2 pins a shebang, and a symlink to a native executable has none.
  [
    "commands/shims.ts",
    `  return claimsName || (process.platform !== "win32" && !envFindsInterpreter());`,
    `  void claimsName;
  return false;`,
  ],

  // --- HTTP proxies: transport not lowered yet -------------------------------

  [
    "net/proxy.ts",
    { from: "/**\n * A `fetch`-shaped transport built on `node:http` / `node:https`.", to: null },
    `/** Native build: \`node:http\`/\`node:tls\` are beyond scriptc's lowering, so §05.1's proxy transport is refused. */
export const nodeFetch: typeof globalThis.fetch = async (input) => {
  const href =
    typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  throw new Error(
    \`Unable to fetch \${new URL(href).origin}: HTTP proxies and JUP_STRICT_SSL=0 are not supported by the native build\`,
  );
};
`,
  ],

  // --- file I/O: sync fds, inline O_* flags ----------------------------------

  // \`FileHandle.write\`'s result type does not compile (SC2009).
  [
    "cache/install.ts",
    `const { readFileSync } = process.getBuiltinModule("node:fs");`,
    `const { closeSync, openSync, readFileSync, writeSync } = process.getBuiltinModule("node:fs");`,
  ],
  [
    "cache/install.ts",
    `  const handle = await open(target, "wx");`,
    `  const fd = openSync(target, "wx");`,
  ],
  [
    "cache/install.ts",
    "          await handle.write(value);",
    `          let offset = 0;
          while (offset < value.byteLength) {
            offset += writeSync(fd, value, offset, value.byteLength - offset);
          }`,
  ],
  ["cache/install.ts", "    await handle.close();", "    closeSync(fd);"],
  // Only flags written inline compile (SC2020).
  [
    "commands/shims.ts",
    "fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,",
    "fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,",
  ],
  // No \`Readable.toWeb\`: a local archive is read whole.
  [
    "commands/cli.ts",
    `const { createReadStream, realpathSync } = process.getBuiltinModule("node:fs");`,
    `const { readFileSync, realpathSync } = process.getBuiltinModule("node:fs");`,
  ],
  ["commands/cli.ts", `const { Readable } = process.getBuiltinModule("node:stream");\n`, ""],
  [
    "commands/cli.ts",
    "  return Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>;",
    `  const bytes = new Uint8Array(readFileSync(path));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });`,
  ],

  // --- tar (§07.4) -----------------------------------------------------------

  [
    "cache/tar.ts",
    `const { createReadStream, createWriteStream } = process.getBuiltinModule("node:fs");`,
    `const {
  closeSync,
  constants: syncConstants,
  createReadStream,
  createWriteStream,
  fchmodSync,
  openSync,
  unlinkSync,
  writeSync,
} = process.getBuiltinModule("node:fs");`,
  ],
  // \`Gzip\` where a \`Writable\` is expected does not compile (SC1090).
  [
    "cache/tar.ts",
    `import type { Writable } from "node:stream";`,
    `import type { Gzip } from "node:zlib";`,
  ],
  ["cache/tar.ts", "target: Writable", "target: Gzip", 3],
  ["cache/tar.ts", "const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;\n", ""],
  [
    "cache/tar.ts",
    "const O_NO_SYMLINK = O_NOFOLLOW === 0 ? fsConstants.O_EXCL : O_NOFOLLOW;\n",
    "",
  ],
  // Rule 5 with sync fds and inline flags. POSIX only, so \`O_NOFOLLOW\` exists.
  [
    "cache/tar.ts",
    {
      from: "async function writeFile(target: string, mode: number, body: EntryBody): Promise<void> {",
      to: "\n}\n",
    },
    `async function writeFile(target: string, mode: number, body: EntryBody): Promise<void> {
  let fd: number;
  try {
    fd = openSync(target, syncConstants.O_WRONLY | syncConstants.O_CREAT | syncConstants.O_TRUNC | syncConstants.O_NOFOLLOW, mode);
  } catch (error) {
    const code = errnoOf(error);
    if (code !== "ELOOP" && code !== "EEXIST") throw error;
    unlinkSync(target);
    fd = openSync(target, syncConstants.O_WRONLY | syncConstants.O_CREAT | syncConstants.O_TRUNC | syncConstants.O_NOFOLLOW, mode);
  }
  try {
    for await (const chunk of body.chunks()) {
      let offset = 0;
      while (offset < chunk.byteLength) offset += writeSync(fd, chunk, offset, chunk.byteLength - offset);
    }
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }`,
  ],
  // No \`Gunzip.bytesWritten\`: rule 7's compressed count is taken at the pump,
  // at most one chunk ahead of what zlib consumed.
  [
    "cache/tar.ts",
    "  const pump = (async () => {",
    "  let compressed = 0;\n  const pump = (async () => {",
  ],
  [
    "cache/tar.ts",
    "        if (next.done) break;\n",
    "        if (next.done) break;\n        compressed += next.value.byteLength;\n",
  ],
  ["cache/tar.ts", "      const compressed = gunzip.bytesWritten;\n", ""],
  [
    "cache/tar.ts",
    "for await (const chunk of gunzip as AsyncIterable<Uint8Array>)",
    "for await (const chunk of gunzip)",
  ],
  // `AsyncIterator.return` is not lowered; `AsyncGenerator.return` is.
  [
    "cache/tar.ts",
    "readonly #iterator: AsyncIterator<Uint8Array>;",
    "readonly #iterator: AsyncGenerator<Uint8Array>;",
  ],
  [
    "cache/tar.ts",
    "constructor(source: AsyncIterable<Uint8Array>) {\n    this.#iterator = source[Symbol.asyncIterator]();",
    "constructor(source: AsyncGenerator<Uint8Array>) {\n    this.#iterator = source;",
  ],
  ["cache/tar.ts", "await this.#iterator.return?.();", "await this.#iterator.return(undefined);"],
];

function applyPatch([file, find, replace, count = 1]) {
  const path = join(SRC, file);
  const text = readFileSync(path, "utf8");
  const replacement = typeof replace === "function" ? replace() : replace;

  if (typeof find === "string") {
    const found = text.split(find).length - 1;
    if (found !== count) {
      fail(`${file}: expected ${count} match(es), found ${found}, for:\n${indent(find)}`);
    }
    writeFileSync(path, text.split(find).join(replacement));
    return;
  }

  const start = text.indexOf(find.from);
  if (start === -1 || text.indexOf(find.from, start + 1) !== -1) {
    fail(`${file}: expected exactly one match for:\n${indent(find.from)}`);
  }
  const end = find.to === null ? text.length : text.indexOf(find.to, start);
  if (end === -1)
    fail(`${file}: no end marker ${JSON.stringify(find.to)} after:\n${indent(find.from)}`);
  writeFileSync(path, text.slice(0, start) + replacement + text.slice(end));
}

// --- Builtins ----------------------------------------------------------------

/**
 * `process.getBuiltinModule("node:x")` → a static import. A top-level
 * destructuring becomes named imports; any other use becomes a namespace
 * import. Lines that *write* the call into generated source — `shims.ts`'s
 * stub templates — are left alone: they hold the call inside a string.
 */
function rewriteBuiltins(text) {
  const imports = new Set();

  let out = text.replace(
    /^const \{([^}]*)\}\s*=\s*process\.getBuiltinModule\("(node:[^"]+)"\);\n/gm,
    (_, names, module) => {
      const specifiers = names
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => name.replace(/^(\w+)\s*:\s*(\w+)$/, "$1 as $2"));
      imports.add(`import { ${specifiers.join(", ")} } from "${module}";`);
      return "";
    },
  );

  out = out
    .split("\n")
    .map((line) =>
      line.replace(/process\.getBuiltinModule\("(node:([^"]+))"\)/g, (match, module, name, at) => {
        if (/[`"']/.test(line.slice(0, at))) return match;
        const id = `__builtin_${name.replace(/\W/g, "_")}`;
        imports.add(`import * as ${id} from "${module}";`);
        return id;
      }),
    )
    .join("\n");

  return imports.size === 0 ? out : `${[...imports].join("\n")}\n${out}`;
}

// --- Build -------------------------------------------------------------------

function main() {
  if (process.platform === "win32")
    fail("The native build is POSIX-only: it execs through execve(2).");
  const { out, extra } = parseArgs(process.argv.slice(2));
  const scriptc = process.env.SCRIPTC || "scriptc";
  checkScriptc(scriptc);

  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  cpSync(join(ROOT, "src"), SRC, {
    recursive: true,
    // Shim stubs a source-checkout `enable` writes beside `index.ts`.
    filter: (path) => !path.endsWith(".mjs"),
  });
  cpSync(join(NATIVE, "overrides"), SRC, { recursive: true });
  for (const patch of PATCHES) applyPatch(patch);
  for (const file of walk(SRC)) {
    if (file.endsWith(".ts")) writeFileSync(file, rewriteBuiltins(readFileSync(file, "utf8")));
  }

  // scriptc resolves `@types/node` by walking up to the repository's own
  // `node_modules`, and needs `"type": "module"` beside the sources.
  writeFileSync(
    join(WORK, "package.json"),
    `${JSON.stringify({ type: "module", private: true })}\n`,
  );
  cpSync(join(ROOT, "tsconfig.json"), join(WORK, "tsconfig.json"));

  // The `execve` wrapper, as the archive the FFI manifest names.
  const cc = process.env.CC || "cc";
  run(cc, ["-O2", "-fPIC", "-c", join(NATIVE, "jupexec.c"), "-o", join(WORK, "jupexec.o")]);
  run("ar", ["rcs", join(WORK, "libjupexec.a"), join(WORK, "jupexec.o")]);
  cpSync(join(NATIVE, "ffi.json"), join(WORK, "ffi.json"));

  mkdirSync(dirname(out), { recursive: true });
  run(
    scriptc,
    ["build", join(SRC, ENTRY), "--ffi", join(WORK, "ffi.json"), "--strip", "-o", out, ...extra],
    {
      cwd: WORK,
    },
  );
  console.log(
    `Wrote ${relative(process.cwd(), out)} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MiB)`,
  );
}

function parseArgs(argv) {
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const extra = separator === -1 ? [] : argv.slice(separator + 1);
  let out = join(ROOT, ".native", `jup-${process.platform}-${process.arch}`);
  for (let index = 0; index < own.length; index++) {
    if (own[index] === "--out" && own[index + 1] !== undefined) out = resolve(own[++index]);
    else fail(`Unknown argument ${own[index]}`);
  }
  return { out, extra };
}

function checkScriptc(scriptc) {
  let version;
  try {
    version = execFileSync(scriptc, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    fail(
      `scriptc not found (tried ${JSON.stringify(scriptc)}). Install scriptc@${SCRIPTC_VERSION} or set SCRIPTC.`,
    );
  }
  if (version !== SCRIPTC_VERSION) {
    console.warn(`warning: scriptc ${version}; this build was verified with ${SCRIPTC_VERSION}`);
  }
}

function ownVersion() {
  return JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: "inherit", ...options });
}

function indent(text) {
  return text.replace(/^/gm, "    ");
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

main();
