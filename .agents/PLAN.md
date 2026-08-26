# Implementation Plan — §17

**Non-normative.** The contract is `.agents/01`–`17`. This file is the *remaining* work
breakdown: what is left, in what order, and which conformance rows prove each piece.
Section-by-section verdicts on §15 live in [`S15-AUDIT.md`](./S15-AUDIT.md).

## Where things stand — §17 is complete (D0–D4), 2026-08-26

* **§01–§16 are implemented.** Every row of §13 (1–147) and §15.38 (148–207) has a test
  whose title names it. `pnpm vitest run`: **1754 passed, 3 skipped**, the skips all
  platform-conditional (Windows, root, no TTY). `pnpm test:corepack` (corepack's own
  suite): **100 passed, 1 expected fail, 40 skipped**, each skip a §14/§17 divergence with
  a stated reason.
* **§17 is implemented.** Two pieces landed early: the one-executable
  / two-names packaging (`bin.corepack` and `bin.jup` are the same file, C1′) and the
  `JUP_`/`COREPACK_` pair resolution in `src/config/env-vars.ts`. The latter is **tier 1
  only** — C4's second tier, under which §11.5's and §15.37's invented variables are named
  `JUP_` and merely *accept* the `COREPACK_` spelling, is not implemented; the table treats
  every variable as an equal pair — **superseded by D3**, which split `ENV` into §11.6's
  two closed tiers. D0 landed §17.3's noun and its roles as data plus §17.9's table
  fixture, D1 the command router, the entry-point name, and C6/C10, D2 the role-sensitive
  behaviour (R4, R9, R10, R11, R14–R16), D3 the renames (C2, C3, C8, C9) and C4's second
  tier, and D4 the shim policy and the interpreter guard (C5, C7). **Rows 208–233 all have
  tests.** What remains is not implementation: §17.7's eight undecided questions, the open
  follow-ups below, and the release decisions at the foot of this file.
* **Nothing is published**; `package.json` is at `0.0.0`.

## The §17 work, as landed

Order was dependency order: D0 unblocked D2 and D4; the rest were independent. All five
are done, and each section below is the record of what was decided and why.

### D0 — The test-only table fixture §17.9 — **done**

`Role`, `Tool` and `ToolSpec` are in `src/types.ts` (§17.3's rename, no aliases kept), every
§02.5 entry carries `roles: ["package-manager"]`, and `config/table.ts` exports `getRoles`
and `hasRole`. Nothing branched on a role at the time: R4's enforcement, R10's inference
and R11 landed in D2, and C5's `enable` default set in D4.

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

The scope reaches the commands as `Route.scope`, on the object every handler receives; D2
is what reads it (R9, R10, R11). R13 requires the two forms to agree on the success path,
which row 208 asserts.
**Rows:** 208–215, in `test/conformance/17-01-router.test.ts`; the classification table,
the `argv[1]` shapes and C10's two sides are `test/unit/router.test.ts`.

### D2 — Roles in the data model §17.3, §17.5 — **done**

**The project has pins, plural.** `SpecResult`'s `Found` carries
`pins: Partial<Record<Role, ProjectPin>>` instead of one `getSpec`/`range`/`hasPin`
triple, built by running §03.3 once per role in `ROLE_ORDER`; `Found` means *some* role
is pinned and `NoSpec` means none is, which for a package-manager-only table is the same
test written once per role. Which fields a role reads is `manifest.ts`'s `PIN_FIELDS` —
`{top: "packageManager", block: "packageManager"}` and `{block: "runtime"}` — so R14's
"parsed, validated, and reconciled by the same rules §03.3 applies" holds *by
construction* rather than by a second copy of §03.3, and R14's "there is no top-level
`runtime` field" is the absence of a `top`.

* **R4 row 2 — `reconcile` picks the pin by the invoked binary's role.** It intersects
  `getRoles(requestedName)` with the roles the project pins, matches against each in
  order, and takes §03.5's ordinary fallback when the intersection is empty. A tool the
  table does not carry keeps the package-manager pin (`UNKNOWN_BINARY_ROLES`), which is
  what leaves `jup foo@1.2.3` in a pinned project on §12.5. Rows 225 and 226.
* **§09.1 returns a list.** `resolveProjectPlans` yields one `{role, pin, descriptor}` per
  pinned role; `resolvePatternsToDescriptors([])` is its `.map(descriptor)`. `install`,
  `up` and `pack` loop over it through `forEachRole`, which **rethrows untouched when
  there is exactly one plan** — so every project that pins one role gets §12.1's
  presentation byte for byte — and otherwise prints each role's failure and returns 1.
  Rows 227 and 228.
* **`writePin` takes a list.** One `writeFileSync` for however many pins (R10's third
  consequence, §15.26). Row 229's second half is the assertion that makes it observable:
  a runtime pin refused mid-write by its own declared range leaves the package manager's
  pin — composed into the same string a statement earlier — off the disk too.
* **R9** is `narrowToScope`, called before any resolve in `use`, `install -g` and `pack`;
  **R11** is `resolvePinRole`, whose step 3 (the roles the project already declares for
  that tool) costs a second walk and is therefore reached **only** for a genuinely
  dual-role spec. Rows 230 and 231.
* **R11 step 2 is unanswerable today, and says so.** `pin.ts`'s `autoRoleFor` is where:
  nothing distinguishes a package-manager use of a dual-role binary from a runtime use —
  R2 keeps the surface one flat namespace, R3 keeps roles data, and §02.4's binary map
  answers a name with a *tool*. R11's last paragraph settles it and row 232 is satisfied
  **by that fallback**, deliberately not by a bin-name-to-role map.
* **R10 row 5** refuses a scope **word** on `cache clean`/`clear`, not the role in effect:
  R12 makes `corepack cache clean` implicitly package-manager-scoped and it must keep
  working. `cache list` filters (row 4). Row 233.
* **R15 and R16 needed no code and got none.** `engines.node` is not in `PIN_FIELDS` and
  no reader looks at it; the walk's stop conditions are untouched, per §03.8's "nothing in
  §3.1–§3.7 changes", so `.nvmrc` and friends are not in it either. The comment on
  `stopsWalk` records why `devEngines.runtime` is *not* a stop condition: a runtime-only
  manifest stopping the climb would strip a parent's package-manager pin, which is a
  precedence question §17.7 has not answered.

**R3 has a test.** `17-03-roles.test.ts` scans `src/` with comments stripped and fails if
any file outside six spells a role literally — `types.ts` (the union), `config/table.ts`
(§02.5's entries, `ROLE_ORDER`), `project/manifest.ts` (`PIN_FIELDS`, R4's enforcement),
`project/pin.ts` (R11's tie-break), `commands/cli.ts` (R9, R11), `commands/router.ts`
(scope words, role nouns). Everything else is parameterised by a `Role` its caller supplies
or asks `hasRole`, which is why `cache list`'s filter and `enable`'s default set are not
role branches.
**Rows:** 225–233, in `test/conformance/17-03-roles.test.ts`. Every role-sensitive row was
verified to **fail** with the behaviour reverted — the reverts are named in each test's
comment.

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

### D4 — Shim policy and the interpreter guard C5, C7 — **done**

**C5 is one filter and one argument.** `targetBinaries` takes the role in effect and, with
no names, selects the tools that have it; `DEFAULT_SHIM_ROLE` lives in `config/table.ts`
beside `ROLE_ORDER` so that `shims.ts` never spells a role (R3). An explicit name is not
second-guessed — §10.5 shims a runtime "when it is named explicitly *or* the command is
scoped", so `jup enable node` works without a scope word — and `--exclude` is untouched.
`disable` reads the same target set: §10.5 defines one, `jup disable` is the inverse of
`jup enable`, and `jup runtime disable` takes what `jup runtime enable` wrote.

**C7 needed a decision before it needed code.** §08.3 is written for a native
implementation and this one hands over **in process**, so §08.3.1's numbered lookup has no
caller in the tool: by the time any of our code runs, `process.execPath` is already a
runtime. Guarding a lookup that never happens would have produced two rows that pass for
the wrong reason. The four paths of C7's table, honestly classified for *this*
implementation:

| C7 row | Here |
| --- | --- |
| §08.3.1's sibling preference | **Unreachable** — no caller; `win32ShSource`'s comment records why. |
| §08.3.1 step 3's `PATH` search | **Unreachable** — same. |
| §10.3's generated wrappers | **Live, and ours.** The one place this implementation picks an interpreter, so §08.3.1's search lives there — steps 1–4, both step-4 errors included. |
| `#!/usr/bin/env node` | **Live, and not fixable here** — see the follow-up below. |

The sh wrapper *is* §08.3.1: `JUP_NODE_EXECPATH` (either spelling) first, no sibling
preference at all, then `PATH` in order skipping every candidate carrying the shim marker,
then the two errors — `Every 'node' on PATH is a jup shim…` when candidates existed and
were all ours, `Unable to locate a Node.js runtime…` when none existed. The `.cmd` and
`.ps1` name `node.exe` explicitly, which `enable` never writes (a Windows shim is `node`,
`node.cmd`, `node.ps1`), so neither can select a shim anywhere on `PATH` — which also
retires §10.3's `PATHEXT` surgery, whose only purpose was to stop a bare `node` resolving
into a `node.js` and which handed the package manager a doctored `PATHEXT` on the way past.

**The recognition rule is content, and it is in one place** (`utils/shim-id.ts`): the
`@jup-shim` marker in the file's head, following symlinks so a POSIX shim is answered by
its stub; an older build's §10.3 wrapper by shebang plus the `<binName>.js` it invokes; and
*then* identity with our own entry module, C7's stated fallback for §14.15's link model —
never with `process.execPath`, which in a JavaScript implementation is the runtime and
would exclude the real `node`. `enable`, `disable`, `info` and the wrapper's own scan share
it, and all three wrappers now carry the marker, which is what lets that scan be one
`grep`. **§15.15's record is not the instrument C7 assumes:** it records what `enable`
*displaced*, and a name that was free — the usual case, and the certain case for `node` —
leaves no entry at all.

**Rows:** 222–224, in `test/conformance/17-04-shims.test.ts`. 222 goes through the spawned
CLI. 223 and 224 run a **generated shim** with a generated `node` shim planted beside it
and assert which interpreter it chose; `generateWin32Link` is platform-independent by
design and row 131 already leans on that. Each row was verified to fail with the guard
reverted: 222 by dropping `hasRole` from `targetBinaries`'s default set, 223 and 224 by
restoring §10.3's `if [ -x "$basedir/node" ]` preference — which makes 223 report
`["node", "<dist>/pnpm.js", …]` and hangs 224 in the recursion the row exists to prevent.

## Standing hazards

* **The warm byte ceiling is at 232,000** (`test/unit/main.test.ts`), raised from 223,000
  by D2's per-role pins: `manifest.ts` +6,897 (`PIN_FIELDS`, the per-role loop in
  `describe`, the role parameter through `readSpecFromManifest`, role-aware `reconcile`),
  `errors.ts` +1,598, `table.ts` +600, `main.ts` +287. Measured, `_warm.mjs` 81,644 ->
  83,425, **+1,781 bytes, +2.18%**, against +9,382 of source. **It costs no I/O:**
  `devEngines` was already one of the two fields `scanTopLevelFields` extracts, so the
  second pin is read out of bytes already in memory, and the walk visits the same
  directories and reads the same files it did before. The next warm-path change raises it
  deliberately, with a reason. It is a tripwire, not a budget. The
  companion assertion — the modules statically reachable from `src/shim.ts` **equal**
  `build.config.ts`'s `WARM_MODULES` — is what pins the emitted chunk; a new static import
  on the warm path fails until the build config is updated. D4 spent 597 of the remaining
  bytes (`config/table.ts`'s `DEFAULT_SHIM_ROLE`, `errors.ts`'s C7 message) and left
  **1,106**; its own machinery — `utils/shim-id.ts` and the generator — is cold.
* **`test/conformance/15-28-native.test.ts` flakes under full-suite load.** The §08.5
  row asserting `exitCode 55` / `signal null` — the child stayed in the process group and
  the tool did not die of the same signal — failed once in two consecutive full runs and
  passes alone every time. 1754 passed / 3 skipped is the green baseline; a single failure
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

* **§03.6's auto-pin notice is package-manager-shaped, and D2 left it that way.** The
  verbatim sentence is `The local project doesn't define a 'packageManager' field. …will
  now add one referencing <name>@<reference>.` For a **runtime-only** tool `autoRoleFor`
  answers `runtime`, so the pin is written into `devEngines.runtime` while the notice
  still names `packageManager`. No §17.9 row covers it (row 232 is the dual-role case,
  where R11's tie-break makes the notice true), and §12's text is frozen — so this wants a
  spec ruling on what the runtime spelling of that notice is, not an invented one.

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
* **§15.14's native half — now also C7's third row, and the only part of C7 left open.**
  `#!/usr/bin/env node` at the top of every §10.1 stub resolves through `PATH` before the
  tool gets control, and the shim `env` would find is itself a `#!/usr/bin/env node`
  script: the loop is in the kernel and `env`, and no guard we can write is ever reached.
  D4 could not close it and did not pretend to — `shimSource`'s comment says so at the
  source, and no row asserts it. C7's own table defers this row to §15.14 ("§15.14 already
  requires replacing these; this is a second reason"), and the mitigation until then is C5:
  no `node` shim exists unless a user asks for one by name.
  D1 has since proved the mechanism §15.14 needs. `process.argv[1]` is **not** realpathed,
  so `entryNameFrom` already dispatches on `basename(argv[1])` for the tool's own two
  names; extending that to the shimmed binaries is one shipped `dist/shim.mjs` plus a
  symlink per name, no generator, no shebang of ours in the loop, and #751 closed at the
  root. It does not help on Windows, where the `.cmd`/`.ps1` wrappers pass the stub path to
  `node` and the invocation name is lost — but those two are guarded by naming `node.exe`,
  so what is left there is the extensionless sh wrapper's scan. **What D4 makes cheaper:**
  the recognition rule is already one function, the sh wrapper's search is already written,
  and both survive the change; what moves is `generatePosixLink`'s target and the six
  shipped stubs.

* **A runtime shim cannot work under §10.1 in a JavaScript implementation, and no row says
  so.** The generated stub for binary `B` is a JavaScript file run by `node` — so the stub
  for `node` itself needs the very runtime it exists to select. `jup enable node` writes
  it (row 222's second half requires that), and running it would recurse. Nothing breaks
  today because §02.5 ships no runtime, and §17.7 #7 already reserves "Windows shim
  behaviour for a runtime"; this is the POSIX half of the same question, and it wants
  either §15.14's model or a spec ruling on what a runtime shim *is*.
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
