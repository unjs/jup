# scriptc feasibility spike

[scriptc](https://github.com/vercel-labs/scriptc) compiles TypeScript to native
executables with no JS engine in the binary. This asks whether jup could ship
that way. Measured against **scriptc 0.0.35**.

**Answer: no, and not close.** The blockers are on scriptc's side and are not
the kind jup can work around. Nothing here changes `src/`.

## Run it

```sh
npm i -g scriptc          # needs Node >= 24
node scripts/scriptc/try-build.mjs
```

Everything lands in `.scriptc-work/` (gitignored). Exits non-zero while the
divergence in stage 4 stands.

| File | What it is |
| --- | --- |
| `try-build.mjs` | The spike: rewrite, coverage, build, and verify against Node |
| `codemod.mjs` | `src/` → a tree scriptc can parse. Every adaptation is listed in `ADAPTATIONS` |
| `regex-repro.ts` | Standalone repro of the correctness bug, for filing upstream |

## Blocker 1 — `process.getBuiltinModule` does not exist

Not a missing typing; the name appears nowhere in `@scriptc/compiler`. scriptc
reaches builtins only via `import … from "node:x"`, which is the form AGENTS.md
forbids, across **78 call sites**. Cold, jup is 168 preflight errors.

`codemod.mjs` rewrites each site to a namespace import in a derived tree. That
is fine for a spike and unshippable as a real port — it inverts a house rule
that exists to keep the warm path's module graph honest.

## Blocker 2 — the surface jup is built on isn't implemented

With blocker 1 gone, **146 errors remain**, all missing runtime members. The
modules resolve; the members don't:

| Area | Missing |
| --- | --- |
| `URL` | `origin`, `username`, `password`, `hash`, `port`, `canParse` — 46 errors, and §05's credential scoping |
| `crypto` | `verify`, `createPublicKey`, `timingSafeEqual` — §06 signature verification |
| `zlib` | `createGunzip`, `createGzip`, `createInflate`, `createBrotliDecompress` |
| `fs` | `createReadStream`/`WriteStream`, `symlinkSync`, `readlinkSync`, `lstat`, `realpath`, `Stats.mode`/`uid` |
| streams | `Readable.toWeb`, `TransformStream`, `ReadableStream.tee`/`pipeThrough`, `HeadersInit` |
| misc | `module.runMain`, `util.styleText`, `os.constants`, `process.exitCode` |

By file: `net/proxy.ts` 30, `commands/shims.ts` 19, `net/http.ts` 15,
`run/native.ts` 12, `cache/tar.ts` 11. Those are registry auth, symlink shims,
archive extraction and signature verification — jup's whole reason to exist.
There is no subset of jup worth shipping that avoids them.

## Blocker 3 — what does compile is silently wrong

`src/version/semver.ts` builds: **603 KB, fully static**, no embedded engine,
against Node's 124 MB. It needs four semantics-neutral edits, all in
`ADAPTATIONS` — `Number.parseInt` is dynamic-only, a relational compare on a
`string | number` union won't lower, and `s[i]` under the repo's
`noUncheckedIndexedAccess` won't either.

It also answers **5 of 11 differential cases wrong**, with exit 0 and no
diagnostic:

```
isValidRange("9.x")       node: true   native: false
isValidRange("^4")        node: true   native: false
isValidRange(">=18 <21")  node: true   native: false
isValidRange("*")         node: true   native: false
```

Cause, minimised in `regex-repro.ts`: a **non-participating capture group reads
`""` where ECMA-262 specifies `undefined`**.

```
PARTIAL_RE.exec("4")   node: ["4","4",null,null]   native: ["4","4","",""]
```

`semver.ts:255` reads an absent component as a wildcard (`isWildcard(match[2])`),
and `semver.ts:409` does `match[1] ?? "="`. `""` is neither absent nor a
wildcard, so every partial range becomes a parse failure — silently, in the
code that decides which package manager version a project gets.

## Revisit when

scriptc grows `process.getBuiltinModule`, `URL`'s auth members, and the
`crypto`/`zlib`/symlink surface — and the capture-group bug is fixed. Until
then a compiled binary can't be trusted without a differential harness, which
is more than the size win is worth.
