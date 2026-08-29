# 13 — Testing

Executable tests are the conformance source. Do not maintain a second numbered case
matrix in prose.

## Suites

- `test/unit/` covers local algorithms and edge cases. Start here for a focused
  change.
- `test/conformance/` covers public CLI, process, filesystem, store, shim, and local
  network behavior. Add a regression here when behavior crosses a module boundary
  or is user-visible.
- `test/corepack/` is an optional compatibility signal. It can use the live network
  or recorded replay data and is not part of the default test command. A skip must
  name the current jup replacement test and reason.

## Harness contract

Conformance tests MUST isolate cwd, home, cache, PATH, environment, registry, and
shim directories. They MUST use the local signed registry/proxy rather than public
network services. Assert exit or signal status, exact stdout/stderr where contracted,
and relevant filesystem state. Shared fixtures and helpers are exported from
`test/conformance/_harness/index.ts`.

Both vitest configs set `NO_COLOR=1`. Rows match §12's text byte for byte, and the
runner's own stdout is a terminal when the suite is run by hand (§09.11) — so colour
is pinned off rather than left to depend on how the suite was launched.

Keep security cases for credential origin/path scope, redirect stripping, TLS,
project-env deny rules, digest and signature failures, archive traversal/links,
read-only caches, atomic install races, and foreign shim ownership. Keep platform
cases for POSIX links/stubs and Windows wrappers, path separators, executable modes,
and rename behavior.

## Commands

```sh
pnpm test
pnpm vitest run test/unit/<file>.test.ts
pnpm vitest run test/conformance/<file>.test.ts
pnpm build                         # the bundle and, with it, bin/ (§16)
pnpm bench
pnpm test:corepack                 # optional; see test/corepack/README.md
```

The default suite is unit plus jup conformance and excludes `test/corepack/`. Before
merging a behavior change, run the focused file, then `pnpm test` and `pnpm build`.
Use `pnpm bench` for warm-path changes.

## Test maintenance

Name a new test by what it does. The §-numbered file names and the `<n>:` row
prefixes are existing citation labels — `src/` and `test/corepack/README.md` point
at them — so preserve them through a rename rather than renumbering, and do not
mint new ones for new work. Preserve assertions for exact strings in §12. When
table or trust data changes, test the new data and the review workflow described
in §16. Never make a network-dependent test part of the default suite.
