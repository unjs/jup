# 16 — Maintenance

Recurring work only. The topical pages own behaviour.

## Quality gate

Run focused unit and conformance tests while editing. Before merge:

```sh
pnpm test
pnpm build
```

Run `pnpm bench` for startup, project discovery, cache or execution changes. A
warm exact pin must stay network-free, skip the last-known-good and any directory
scan, and use the direct marker probe (§01.3, §07.2).

## Build shape

One entry — `src/index.ts` — bundles into one self-contained file
(`codeSplitting: false`). Rolldown leaves every module behind a lazy init thunk
and rewrites `import()` accordingly, so the cold path shares the file with the
warm one without being evaluated by it.

There were three entries, and under this shape each was a full copy of the same
module graph — 168 kB apiece for a 527 kB `dist/`. `src/shim.ts` reached a module
set *identical* to `src/index.ts`'s and `src/bin.ts` added nine lines, so both
now ship as static files that import the bundle by a relative specifier:

| File | Is | Written by |
|---|---|---|
| `dist/index.mjs` | the bundle; also the package's `exports` | `pnpm build` |
| `bin/jup.mjs` | `package.json`'s `bin` target, for `jup` and `corepack` | `pnpm build` |
| `bin/<B>.mjs` | §10.1's per-name stubs, one per table binary, read on every platform | `pnpm build` |
| `src/bin.ts` | the CLI entry a source checkout runs (`node src/bin.ts`) | — |

`bin/` is a sibling of `dist/`, not a child, because the bundler empties `dist/`
on every run and §10.8 wants files a read-only installation still has. One
directory holds both kinds: they address the bundle the same way.
`build.config.ts`'s `end` hook writes them after the bundle, so a binary name
added to the table gets its stub without a second command, and neither folder is
in the repository. `bin/` is not emptied first — a stale file is removed only
when it carries the generated banner, so a scratch file beside the stubs survives
a build. `test/unit/shims.test.ts` asserts what the hook writes.

`enable` from a source checkout writes its stubs beside `src/index.ts` and leaves
`bin/` alone — including §10.2's shebang pin, which would otherwise put an
absolute path naming one machine into the file `npm publish` ships as our `bin`
target.

The bundle's **public surface is one function**: `src/index.ts` exports
`runMain` and nothing else, which is what `package.json`'s `exports` gives an
embedder (`docs/10.api.md`). `parseArgs`, `parseSpec`, `findProjectSpec`,
`resolveSpec`, `ensureInstalled`, `UsageError` and the types were all exported
once; each was a second contract to keep stable for a caller who had not asked
for one, and every argument routed through `runMain` already reaches them. Add
one back when a user names the script they cannot write — adding an export is a
minor release, withdrawing one is not. The rule also protects the graph: a
static re-export of `version/resolve.ts` or `cache/install.ts` drags §04's
fan-out and the download-and-verify stack onto the warm path, which is why both
were `await import()` wrappers while they lasted.

Two rules keep the shape honest, both asserted in `test/unit/main.test.ts`:

* **No `node:` builtin is imported.** A static import is hoisted to the top of the
  bundle and loaded on every invocation; the cold set alone (`node:crypto`,
  `node:zlib`, `node:child_process`, `node:stream/promises`, `node:fs/promises`)
  measured ~10 ms of startup. Use `process.getBuiltinModule` at the point of use.
  Type-only imports are erased before the bundler sees them and are fine.
* **The warm set is exactly `WARM_MODULES`** in `build.config.ts` — the modules a
  warm proxy invocation evaluates. Cold code belongs behind an `import()`.

The generated stubs follow the first rule too: they are parsed on every warm run,
and four static builtin imports cost ~2 ms of one.

`process.getBuiltinModule` is not the only way to spend the budget. The first
read of `process.stdout` or `process.stderr` *constructs* the stream, which loads
20 native modules; a warm run prints nothing, so `src/utils/log.ts` reaches for a
stream only inside the call that writes, never at module load. `node:util` itself
is free (it is in Node's startup snapshot), and `styleText` adds one module when a
line is actually coloured.

## Source map

Start at `src/bin.ts` for the CLI bootstrap and `src/main.ts` for classification
and dispatch. Then follow project and config, resolution, network, verification
and cache, and execution:

```
src/project   discovery, env file, manifest, pin writing, jup.lock
src/config    the table, the trust keys, the environment inventory
src/version   semver, resolution
src/net       http, registry, npmrc, tls, proxy
src/verify    integrity, trust
src/cache     store, install, tar
src/run       exec, native
src/commands  cli, info, shims, self-install, self-upgrade, usage
```

`test/unit` and `test/conformance` are the nearest executable examples.

## Built-in table and trust keys

The table is closed, ordered data (§02). A change requires:

1. upstream maintainer consent for a newly supported tool;
2. verified registry packages, release targets, bin paths, and signatures or
   digests;
3. explicit range boundaries and host mappings;
4. unit and conformance coverage for resolution, installation, execution and
   shims;
5. human review of generated changes.

`scripts/refresh-table.mjs` and the scheduled `.github/workflows/refresh-table.yml`
open reviewed update PRs. **They must not auto-merge.** Because that script is
what keeps `default` versions and digests current, §02 deliberately documents the
table's *shape* and points at the code for its values; do not reintroduce a copy
of the data into the docs.

Refresh npm trust keys from `https://registry.npmjs.org/-/npm/v1/keys` and check
origin, key IDs, SPKI bytes, expiry and rollover. The refresh script removes
expired keys, so confirm that ending verification for signatures needing those
keys matches the supported verification window before merging. Note that jup also
refreshes keys at runtime on an unmatched keyid (§06.3); the embedded set is the
floor, not the only source.

## Security review checklist

For network, archive, store or execution changes, confirm:

* secrets never enter logs, redirects, project env files, or foreign origins;
* TLS stays verified unless an ambient explicit opt-out is used;
* the verified bytes are the bytes promoted and executed;
* extraction cannot escape through paths, links, existing symlinks or special
  files;
* temp data and atomic promotion stay on one filesystem;
* bin paths stay inside the install directory;
* native aliases receive the correct `argv[0]`, and any JavaScript launcher uses
  a trusted runtime outside the managed store.

## Failure posture

Fail closed for verification, unsafe archives, escaped bins, malformed explicit
project intent, and unsupported hosts. Degrade safely for corrupt global
defaults, unwritable optional state, race losers, and already-present read-only
cache entries. Never turn an internal error into a usage error.

## Known debts

Carried deliberately; each is a decision, not an oversight, and each is worth
revisiting when the surrounding code is next touched:

* **The interpreter pin** (§10.2) reaches into `cache clean`, native child
  environments and three `enable` failure modes. This is the one entry here that
  is *not* a debt, and is listed only so the next reader stops re-deriving the
  same dead end: the state-file collapse that suggests itself is unimplementable,
  because a POSIX shim's shebang is what the kernel executes and nothing reads a
  file before it. Buying it costs a `#!/bin/sh` fork per invocation, against
  §01.3's warm-path budget. The feature is kept, so the mechanism is its price.
* **`targets` maps** (§02.4) fail closed on a host the table has not caught up
  with, which for platform availability is a trade against a 404.
* **`node`'s compiled-in `lts` tag** (§02.3) is a version pointer to an alias that
  moves every six months.
* **Single-user table fields** — `publishedFrom`, `binArgs`, `tags`,
  `transparent.default`, `versionFile` — each a permanent code path for one row.
* **§12.13's inherited message warts.**
* **The agent colour-detection list** (§09.14) is vendored from another project
  and drifts.
