# 16 — Maintenance

This page covers recurring work only. The topical pages own behavior.

## Quality gate

Run focused unit and conformance tests while editing. Before merge, run:

```sh
pnpm test
pnpm build
```

Run `pnpm bench` for startup, project discovery, cache, or execution changes. A warm
exact pin must remain network-free, skip last-known-good and directory scans, and use
the direct marker probe described in §01 and §07.

## Build shape

One entry — `src/index.ts` — is bundled into one self-contained file
(`codeSplitting: false`). Rolldown leaves every module behind a lazy init thunk and
rewrites `import()` accordingly, so the cold path shares the file with the warm one
without being evaluated by it.

There were three entries, and under this shape each was a full copy of the same
module graph: 168 kB apiece for a 527 kB `dist/`. `src/shim.ts` reached a module set
*identical* to `src/index.ts`'s, and `src/bin.ts` added nine lines. Both now ship as
static files that import the bundle by a relative specifier:

| File | Is | Written by |
| --- | --- | --- |
| `dist/index.mjs` | the bundle; also the package's `exports` | `pnpm build` |
| `bin/jup.mjs` | `package.json`'s `bin` target, for `jup` and `corepack` | `pnpm build` |
| `bin/shim-proxy.mjs` | §10.2's one POSIX stub for every name | `pnpm build` |
| `bin/<B>.mjs` | §10.3's per-name stubs, which only Windows reads | `pnpm build` |
| `src/bin.ts` | the CLI entry a source checkout runs (`node src/bin.ts`) | — |

`bin/` is a sibling of `dist/`, not a child, because the bundler empties `dist/` on
every run and §10.7 wants files that a read-only installation still has. One directory
holds both kinds: they are the same sort of thing, and both address the bundle the
same way. `build.config.ts`'s `end` hook writes them from `shimSource`/`cliEntrySource`
after the bundle, so a binary name added to the table gets its stub without a second
command and neither folder is in the repository. `bin/` is not emptied first — a stale
file is removed only when it carries the generated banner, so a scratch file beside
the stubs survives a build. `test/unit/shims.test.ts` asserts what the hook writes.

`enable` from a source checkout still writes its stubs beside `src/index.ts` and
leaves `bin/` alone — including §15.46's shebang pin, which would otherwise land an
absolute path naming one machine in the file `npm publish` ships as our `bin` target.

Two rules keep it honest, both test-asserted in `test/unit/main.test.ts`:

- **No `node:` builtin is imported.** A static import is hoisted to the top of the
  bundle and loaded on every invocation — the cold set alone (`node:crypto`,
  `node:zlib`, `node:child_process`, `node:stream/promises`, `node:fs/promises`)
  measured ~10 ms of startup. Use `process.getBuiltinModule` at the point of use.
  Type-only imports are erased before the bundler sees them and are fine.
- **The warm set is exactly `WARM_MODULES`** in `build.config.ts` — the modules a
  warm proxy invocation evaluates. Cold code belongs behind an `import()`.

The generated shim stubs (§10) follow the first rule too: they are parsed on every
warm run, and four static builtin imports cost ~2 ms of one.

`process.getBuiltinModule` is not the only way to spend the budget. The first read of
`process.stdout` or `process.stderr` *constructs* the stream, which loads 20 native
modules (`stream`, `string_decoder`, the `internal/streams/*` set); a warm run prints
nothing, so `src/utils/log.ts` reaches for a stream only inside the call that writes,
never at module load. `node:util` itself is free — it is in Node's startup snapshot —
and `styleText` adds one module (`internal/util/colors`) when a line is actually
coloured.

## Built-in table and trust keys

The table in §02 is closed, ordered data. A change requires:

1. upstream maintainer consent for a newly supported tool;
2. verified registry packages, release targets, bin paths, and signatures/digests;
3. explicit range boundaries and host mappings;
4. unit and conformance coverage for resolution, installation, execution, and shims;
5. human review of generated changes.

The scheduled `.github/workflows/refresh-table.yml` workflow opens reviewed update
PRs. It MUST NOT auto-merge. Refresh npm trust keys from
`https://registry.npmjs.org/-/npm/v1/keys`; check origin, key IDs, SPKI bytes, expiry,
and rollover behavior. The refresh script removes expired keys, so maintainers MUST
confirm that ending verification for signatures that need those keys matches the
supported verification window before merging.

## Security review checklist

For network, archive, store, or execution changes, confirm:

- secrets never enter logs, redirects, project env, or foreign origins;
- TLS remains verified unless an ambient explicit opt-out is used;
- the verified bytes are the bytes promoted and executed;
- extraction cannot escape through paths, links, existing symlinks, or special files;
- temp data and atomic promotion stay on one filesystem;
- bin paths remain inside the install directory;
- native aliases receive the correct `argv[0]` and JavaScript launchers use a trusted
  runtime outside the managed store.

## Failure posture

Fail closed for verification, unsafe archives, escaped bins, malformed explicit
project intent, and unsupported hosts. Degrade safely for corrupt global defaults,
unwritable optional global state, race losers, and already-present read-only cache
entries. Never turn an internal error into a usage error.

## Source map

Start at `src/bin.ts` for CLI bootstrap and `src/main.ts` for classification and
dispatch. Then follow project/config, resolution/network/verification/cache, and
execution through `src/project`, `src/config`, `src/version`, `src/net`, `src/verify`,
`src/cache`, and `src/run`. Management commands and shims branch from that
path. Use `test/unit` and `test/conformance` as the nearest executable examples.
