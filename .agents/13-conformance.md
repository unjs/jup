# 13 — Testing

Executable tests are the conformance source. Do not maintain a second numbered
case matrix in prose.

## Suites

* `test/unit/` — local algorithms and edge cases. Start here for a focused change.
* `test/conformance/` — public CLI, process, filesystem, store, shim and local
  network behaviour. Add a regression here when behaviour crosses a module
  boundary or is user-visible.
* `test/corepack/` — an optional compatibility signal. It may use the live
  network or recorded replay data and is not part of the default command. A skip
  must name the current jup replacement test and the reason.

## Harness contract

`test/_setup.ts` runs before every worker in the default suite and takes two
things off the machine the suite is running on: every variable the tool answers
to under either spelling (§11.6 makes `JUP_X` outrank `COREPACK_X`, so a
developer whose own package manager is jup has an ambient `JUP_HOME` and
`JUP_SHIM_DIRECTORY` that would outrank the fixtures and aim the rows at their
real store and shims), and the `HOME`/`XDG_*`/`LOCALAPPDATA` family §07.1 falls
back to. A suite MUST NOT be able to write outside directories it created.

Conformance tests isolate cwd, home, cache, `PATH`, environment, registry and
shim directories, and use the local signed registry/proxy rather than public
services. Assert exit or signal status, exact stdout/stderr where §12 contracts
it, and the relevant filesystem state. Shared fixtures and helpers are exported
from `test/conformance/_harness/index.ts`.

Both vitest configs set `NO_COLOR=1`: §12's rows match byte for byte, and the
runner's own stdout is a terminal when the suite is run by hand (§09.14), so
colour is pinned off rather than left to depend on how the suite was launched.

Keep security cases for credential origin/path scope, redirect stripping, TLS,
project-env deny rules, digest and signature failures, archive traversal and
links, read-only caches, atomic install races, and foreign shim ownership. Keep
platform cases for POSIX links and stubs, Windows wrappers, path separators,
executable modes, and rename behaviour.

## Commands

```sh
pnpm test                          # unit + jup conformance; excludes test/corepack
pnpm vitest run test/unit/<file>.test.ts
pnpm vitest run test/conformance/<file>.test.ts
pnpm build                         # the bundle and, with it, bin/ (§16)
pnpm bench                         # warm-path budget
pnpm test:corepack                 # optional; see test/corepack/README.md
```

Before merging a behaviour change: run the focused file, then `pnpm test` and
`pnpm build`. Use `pnpm bench` for warm-path changes.

## Test maintenance

Name a test by what it does. Preserve assertions for the exact strings in §12,
and update them deliberately when a message changes rather than loosening the
match. When table or trust data changes, test the new data and the review
workflow in §16. Never make a network-dependent test part of the default suite.
