# Implementation Plan — §17

**Non-normative.** The contract is `.agents/01`–`17`. This file is the *remaining* work
breakdown: what is left, in what order, and which conformance rows prove each piece.
Section-by-section verdicts on §15 live in [`S15-AUDIT.md`](./S15-AUDIT.md).

## Where things stand — `2261d95` + D1 + D3, 2026-08-26

* **§01–§16 are implemented.** Every row of §13 (1–147) and §15.38 (148–207) has a test
  whose title names it. `pnpm vitest run`: **1733 passed, 3 skipped**, the skips all
  platform-conditional (Windows, root, no TTY). `pnpm test:corepack` (corepack's own
  suite): **100 passed, 1 expected fail, 40 skipped**, each skip a §14/§17 divergence with
  a stated reason.
* **§17 is partly implemented.** Two pieces landed early: the one-executable
  / two-names packaging (`bin.corepack` and `bin.jup` are the same file, C1′) and the
  `JUP_`/`COREPACK_` pair resolution in `src/config/env-vars.ts`. The latter is **tier 1
  only** — C4's second tier, under which §11.5's and §15.37's invented variables are named
  `JUP_` and merely *accept* the `COREPACK_` spelling, is not implemented; the table treats
  every variable as an equal pair — **superseded by D3**, which split `ENV` into §11.6's
  two closed tiers. D0 landed §17.3's noun and its roles as data plus §17.9's table
  fixture, D1 the command router, the entry-point name, and C6/C10, and D3 the renames
  (C2, C3, C8, C9) and C4's second tier. What is left is role-sensitive *behaviour* (D2)
  and the shim policy and interpreter guard (D4). Rows 208–221 have tests; 222–233 do
  not.
* **Nothing is published**; `package.json` is at `0.0.0`.

## Remaining work — §17

Order is dependency order. D0 unblocks D2 and D4; the rest are independent.

### D0 — The test-only table fixture §17.9 — **done**

`Role`, `Tool` and `ToolSpec` are in `src/types.ts` (§17.3's rename, no aliases kept), every
§02.5 entry carries `roles: ["package-manager"]`, and `config/table.ts` exports `getRoles`
and `hasRole`. **Nothing branches on a role yet** — R3's seam is open, R4's four behaviours
are D2's and D4's.

The seam, for the steps that use it:

* `run(args, { …, table })` merges entries into the *spawned* tool's table.
  `test/conformance/_harness/table-preload.ts` is a second `--import` module beside
  `intercept.ts`: it imports the very `config/table.ts` the tool is about to load — named
  in the payload, so `copyTool()`'s copy is patched rather than the checkout's — mutates
  the exported `DEFINITIONS`, and calls `table.ts`'s new `reindexTable()`, which re-derives
  `SUPPORTED_NAMES` and the binary/registry maps that were built at module load.
* `useFixtureTable(tools?)` does the same to *this* process's table, so
  `packageManagerTarball` / `seedPackageManager` read the fixture's own `bin` layout out of
  the table. Call both: they are different processes.
* `FIXTURE_TOOLS` is `fixture-runtime` (`roles: ["runtime"]`) and `fixture-dual` (both
  roles), npm-protocol entries on `registry.npmjs.org` so the existing mock serves them.
  `FIXTURE_VERSION` is `1.0.0`; publish it yourself. Names chosen to be clear of R8's
  `SCOPE_WORDS`, verbs and `RESERVED`, so D1's build-time assertion has nothing to trip on.
* Entries are merged, not substituted, and JSON is the wire format — so a step needing a
  different shape (D4's C7 `node`-like interpreter, an overridden `npm`) passes its own
  entries without another harness change.
* The payload variable, `JUP_TEST_TABLE`, is read **only** by the preload; `src/` has no
  reader and `cleanEnv()` strips an inherited one. `test/conformance/17-00-fixture.test.ts`
  is the seam's own test — not a numbered row — and asserts both halves: the fixtures
  install and run through the mock, and a run that passes no `table` has never heard of
  them.

The §13.1 amendment needed nothing new: `options.env`'s explicit `undefined` already
deletes `COREPACK_HOME`, which is all rows 216–217 want. What was missing was isolation —
`cleanEnv()` passed the developer's own `XDG_CACHE_HOME` and `XDG_BIN_HOME` through, so a
row on §07.1's fallback chain would have read *their* cache. Both are now stripped, `HOME`
is already repointed at the fixture, and the rows that want either set it themselves.

### D1 — The command router §17.4, C1′, C6, C10 — **done**

R7's classification order splits across the existing warm/cold boundary. Steps 0–2 (the
proxy tests) stay in `classifyInvocation` in `src/main.ts`, on the warm path; steps 3–7 are
`src/commands/router.ts`, behind the lazy import, so the scope word and the verb table cost
the proxy path nothing. `jup pm yarn --version` therefore reaches step 4 → step 7 (row 209)
while `jup yarn --version` is still step 1 (row 210) — the same rule read from both ends.

* **The entry-point name (C1′).** `utils/self.ts` gained `entryNameFrom(argv[1])`:
  `basename`, a known script extension stripped, matched against `{ jup, corepack }`,
  **defaulting to `jup`**. `process.argv[1]` is not realpathed, so npm's bin link arrives
  spelled `corepack` and a §10.1 shim arrives spelled `pnpm` — neither name, and correctly
  `jup`. Not cached: two string operations, reached only while building a message, and a
  cache would want a test hook in shipped code.
* **Both harnesses spawn through a `corepack`-named entry** (§13.1). `test/_fixtures/entry.ts`
  is shared by `test/conformance/_harness/run.ts` and `test/corepack/_runCli.ts`: a symlink
  in a temp directory, verified against Node 24 — it is resolved for module identity (so
  `import.meta.url` still lands in `src/` and `self.ts`'s upward walk is unaffected) while
  `argv[1]` keeps the link's name. A one-line launcher is the fallback where an
  unprivileged symlink is refused. `run()` takes `as: "jup" | "corepack"`, **defaulting to
  `corepack`**, so §17.9's rows opt into `jup` and no existing row changed.
* **`VERBS` is single-sourced.** `usage.ts`'s `COMMANDS` carries each verb's usage line and
  its `--help` synopsis lines; `VERBS` is `Object.keys`, the help text renders from it, and
  `cli.ts`'s dispatch table is typed `Record<DispatchedVerb, …>` — derived from the same
  object — so a verb in one place and not the other is a **compile** error rather than a
  word that silently does nothing. §15.34's `project` sits in the table marked `pending`:
  R8 needs the word reserved, and `pending` keeps it out of `--help` and out of the
  dispatch, so it still answers `Unknown command`.
* **R8 runs in `pnpm build`** (`scripts/check-name-sets.mjs`, which prints the count), and
  the checking function is exercised against a poisoned table by row 215's tests. That pair
  is what §17.9 permits in place of a `(exitCode, stdout, stderr)` row.
* **C10** is `${tool()}` / `${Tool()}` at each call site rather than a pass over finished
  text, so "a name substitution, not a rewrite" is a property of the code: one copy of each
  sentence, one thing varying. `https://github.com/nodejs/corepack#troubleshooting` is
  **not** substituted — it names a *repository*, `nodejs/jup` does not exist, and aiming
  the sentence elsewhere would be the rewrite C10 forbids. The corepack-named files are C9
  and untouched.
* **C6** — `jup --help` describes both scopes, `jup pm --help` and `corepack --help` print
  the package-manager surface. The proxy line keeps the bare entry name under a scope,
  because R7 makes `jup pm yarn` an error and advertising it would advertise something that
  does not work.

The scope reaches the commands as `Route.scope`, on the object every handler receives.
Nothing branches on it yet — that is R9/R10/R11 — and R13 requires the two forms to agree
until then, which row 208 asserts.
**Rows:** 208–215, in `test/conformance/17-01-router.test.ts`; the classification table,
the `argv[1]` shapes and C10's two sides are `test/unit/router.test.ts`.

### D2 — Roles in the data model §17.3, §17.5

R1–R6's remainder (the types and the roles landed in D0), R10's inference for an unscoped command, R11's
dual-role specs, and R4's per-role enforcement — a runtime-only pin must not produce a
package-manager mismatch error. R14 parses, validates, and reconciles `devEngines.runtime`
while it stays inert; R15 keeps `engines.node` out of selection; R16 defers `.nvmrc` and
friends. §15.26's single atomic manifest write has to carry both pins at once.
**Rows:** 225–233.

### D3 — The renames C2, C3, C4 tier 2, C8, C9 — **done**

One rule, five files: **write the `jup` spelling, accept the `corepack` spelling on read,
prefer `jup` in every message.** The store home is `JUP_HOME` ?? `COREPACK_HOME` ??
`<cache>/jup` (§15.13's Windows-only `LOCALAPPDATA` narrowing unchanged); `.jup` is the
marker written and `.corepack` still accepted; `.jup.env`, `.jup.lock`, `jup.tgz`,
`jup-<pid>-<hex>` temp dirs, and `%LOCALAPPDATA%\jup\bin`. C8 holds: **nothing migrates**.

* **The dual-read costs a store this tool wrote nothing.** `.jup` is probed first at all
  three marker sites (`readMarker`, the §04.1 step-4 fast path, `listInstalled`), so the
  second `stat`/`open` happens only after the first missed. An inherited corepack store
  pays one extra `stat` per warm probe until its entries are reinstalled — C3's stated
  price. The env-file walk is the one place the cost is *not* conditional on an old store:
  a directory with no `.jup.env` costs one extra `ENOENT` `open` before `.corepack.env` is
  tried, on each directory the walk visits until a manifest is found. §03.2 mandates it.
* **`save()` retires the legacy lockfile.** A write always produces `.jup.lock`; when a
  `.corepack.lock` supplied the data, every resolution it held has just been rewritten, so
  it is removed rather than left as a duplicate that wins the moment `.jup.lock` is
  deleted. `removeResolution` removes both names when the last key goes, for the same
  reason. This is a *record* moving, not the cache migration C8 forbids.
* **C4's tier 2 is recorded in the table, not beside it.** `config/env-vars.ts` defines
  `TIER_1` (§11.1–§11.3) and `TIER_2` (§11.5, §15.37) and composes `ENV` from them, so a
  variable is in exactly one tier by construction. `envTier()` answers under either
  spelling and treats `COREPACK_REGISTRY_*` as tier 2 by prefix; `canonicalEnvName()` is
  what a diagnostic prints for a variable the user has **not** set, while `envEntry()`
  keeps naming the spelling they did set (§11.6's last paragraph) — which is why
  `frozenSource`, the registry source and `minimumReleaseAge`'s error all go through it.
  Reading is unchanged: both spellings resolve, `JUP_` wins, presence beats truthiness.
* `messages.lockfileUnresolved` and `messages.cafileUnreadable` both take the name as a
  parameter now — C9 requires the frozen-mode error to name the file it actually looked
  at, and `(set by COREPACK_CAFILE)` was a lie whenever an `.npmrc` `cafile` supplied the
  path. That closes the `errors.ts` follow-up.

**Rows:** 216–221, in `test/conformance/17-02-renames.test.ts`; the tier table is
`test/unit/env.test.ts`, including a scan that fails if `errors.ts` or `usage.ts` prints a
tier-2 variable under its legacy spelling.

### D4 — Shim policy and the interpreter guard C5, C7

C5: `jup enable` with no names shims the `package-manager` role only; a runtime shim needs
an explicit name or `jup runtime enable`. C7 is the one genuinely new failure mode the
extension introduces, and it is silent-and-fatal: **no interpreter lookup may resolve to a
shim.** Guard all four paths (§08.3.1's sibling preference, the generated shims' own `node`
lookup, `#!/usr/bin/env node`, our own `PATH` search), recognising a shim from the
§15.15 record rather than by identity with our own executable — under §10.1's generated-
script model the identity test never fires. §15.32's `PATH` prepending is what makes this
reachable without any `PATH` of the user's.
**Rows:** 222–224.

## Standing hazards

* **The warm byte ceiling is at 223,000** (`test/unit/main.test.ts`), raised from 212,000
  by D3's renames: `store.ts` +2,307, `env-vars.ts` +3,047, `lockfile.ts` +2,699,
  `env.ts` +929 (measured, `warm.mjs` 80,413 -> 81,644, **+1,231 bytes, +1.53%**, against
  +10,087 of source — the widest gap yet between the two, because a rename is nearly all
  explanation). The next warm-path change raises it deliberately, with a reason. It is a tripwire, not a budget. The
  companion assertion — the modules statically reachable from `src/shim.ts` **equal**
  `build.config.ts`'s `WARM_MODULES` — is what pins the emitted chunk; a new static import
  on the warm path fails until the build config is updated.
* **`test/conformance/15-28-native.test.ts` flakes under full-suite load.** The §08.5
  row asserting `exitCode 55` / `signal null` — the child stayed in the process group and
  the tool did not die of the same signal — failed once in two consecutive full runs and
  passes alone every time. 1707 passed / 3 skipped is the green baseline; a single failure
  in that file is the flake, not a regression. Worth a timing fix before it costs someone
  an afternoon.
* **The sandbox has live network and the conformance harness does not disable it.** A row
  relying on a *fallback* version can pass over the wire. Seed the store and set
  `COREPACK_ENABLE_NETWORK=0` wherever the answer must come from the fixture.
* **A mock that collapses two sources into one cannot distinguish them.** Two high-severity
  bugs survived a green suite because the harness rewrote every host to a single mock, so
  "the mirror was used" passed whether or not the substitution happened. D0's fixture is
  the same shape of risk, which is why `17-00-fixture.test.ts` asserts that a run *without*
  `table` does not see the fixtures — a substitution that silently did nothing would
  otherwise leave every role row passing against three package managers.
* **A plan organised by value will miss requirements.** Phase 2 shipped twelve items and
  left eight §15 sections unassigned; a walk of the spec found five real gaps. Walk §17
  section by section before ranking anything.
* **A test that exercises only the source tree cannot catch a layout assumption.** Three
  separate bugs came from counting `dirname` calls; all three were invisible from source
  and real in the shipped package. `src/self.ts` walks up instead — build `dist/` and run
  it by hand before believing anything about paths.

## Open follow-ups, all verified open

* **§15.38 row 153's text is now stale.** It says the unknown-CA message names
  `COREPACK_CAFILE`; C4 makes every tier-2 variable `JUP_`-named in this spec's own
  diagnostics (§11.6: "not used in this spec's own documentation, diagnostics, or `info`
  output"), so the message says `JUP_CAFILE` and the row asserts that. §17 taking
  precedence over §15 is what resolves it, so the implementation is right and the row's
  prose is what wants amending on the next spec pass. The same reading applies to any
  other §15 row that quotes a tier-2 variable's legacy spelling in a *diagnostic*.
* `src/version/resolve.ts` still carries its own `hasRegistryOverride()` reading only
  `COREPACK_NPM_REGISTRY`. The consequence is neutralised (§05.2 rewrite 1 also applies
  inside `registry.ts`'s fetchers, idempotently), but the redundant, incomplete copy
  should go.
* `manifest.ts`'s private `hashFromIntegrity` duplicates `lockfile.ts`'s exported one; both
  are warm now, so the copy buys nothing.
* **`use` and `install -g <spec>` never load the project env file.** Both call `parseSpec`
  directly rather than going through §09.1's `envOnly` walk, so a project's registry, auth,
  and TLS settings are not applied during *their* resolve or download — `writePin` loads it
  afterwards, too late. Consistent with §09.5's pseudocode, so it is a spec question first.
* `COREPACK_REGISTRY_<NAME>` is env-file eligible per §15.37, a weaker form of what §14.5
  guards against. Worth a line in §14.5's rationale.
* §15.4's expired / not-yet-valid certificate branch is unit-tested by code path only; the
  committed fixture is valid until 2126 and an expired cert needs a second fixture.
* **§15.24's SHOULD** — a bare name or `*` still takes the semver maximum rather than the
  registry's `latest` dist-tag. Honouring it would resolve `yarn@*` against the last band's
  registry only, silently dropping the Yarn Classic candidates §04.1 step 6 unions in. Row
  184 asserts the decision rather than leaving it invisible.
* **§15.14's native half.** Verified, against corepack's stated reason for avoiding it:
  `process.argv[1]` is **not** realpathed, so a JS distribution could do §14.15's
  `basename(argv[1])` dispatch on POSIX today — one shipped `dist/shim.mjs` and six
  symlinks, no generator, #751 closed at the root. It does not help on Windows, where the
  `.cmd`/`.ps1` wrappers pass the stub path to `node` and the invocation name is lost. It
  changes the shim contract, not enablement, so it is its own item — and C7 interacts.
* **Bare `yarn` with `COREPACK_DEFAULT_TO_LATEST=1` fails online.** npm signs the `yarn`
  packument's `latest` with a keyid its own `/-/npm/v1/keys` marks `expires: 2025-01-29`;
  §15.9's refresh cannot help because the key is expired at the source. Either §14.4's
  lenient branch is turned on (`ACCEPT_EXPIRED_KEY_WITH_WARNING` in `src/verify/integrity.ts`,
  `false` today because §13 row 82 wants the strict answer) or that spec conflict is
  resolved. `npm` and `pnpm` are unaffected; `COREPACK_DEFAULT_TO_LATEST=0` is unaffected.

## Decisions that are not engineering decisions

Shipping is not a neutral act here. The package installs a `corepack` bin alias, and
§15.33 moved yarn's compiled-in default from Classic 1.x to Berry 4.x, so a bare `yarn` in
an unpinned project behaves differently from corepack's. Both are deliberate and
documented; both want a human to agree before a release carries them. §17.7 lists five
questions — which runtimes and on whose agreement, Node's bundled npm versus the table's,
and the three precedence questions — that MUST be decided before any runtime enters §02.5.
