# The upstream Corepack suite, run against jup

A port of `nodejs/corepack@b856c516`'s `tests/` — the same commit §00 pins the
specification to. The point is not to make it pass: it is an outside view of how
jup answers the questions Corepack's own maintainers thought worth asking, and a
place where a real regression shows up as a *new* failure.

The five CLI-level files are copied with their **test bodies untouched**. Three
kinds of edit were made and no others: the import lines were rewritten (below),
rows covering a deliberate divergence were turned into `it.skip` /
`describe.skip` with a `// SKIP (jup §…)` comment above naming the section that
makes them deliberate, and seven path literals renamed by §14.24 were respelled
in place. Every skip is listed under *What it reports*.

The third kind is new and deliberately narrow — `corepack.tgz` → `jup.tgz` in
the three hydration rows, and `.corepack` → `.jup` in the four that hand-write a
store marker. Those rows are about `pack`/`install -g` round-tripping and about
exit codes and ESM handover; the spelling of a path is incidental to every one
of them, and skipping seven rows to preserve it would discard the coverage that
caught **both** of the bugs described under *The two that were not divergences*.
A skip is for a row that asserts something jup deliberately does differently.
This is not that: jup does the same thing, at a different path. It stays a
one-token edit per site so the upstream diff still reads as one.

| Upstream | Here |
| --- | --- |
| `@yarnpkg/fslib` | [`_fslib.ts`](./_fslib.ts) — `xfs` / `ppath` / `npath` on `node:fs` |
| `./_runCli.ts` (spawns `dist/corepack.js`) | [`_runCli.ts`](./_runCli.ts) — spawns `src/bin.ts`, no build step |
| `../config.json`, `../sources/{Engine,types}.ts` | [`_compat.ts`](./_compat.ts) — the embedded table (§02.4) |
| `../sources/folderUtils.ts` | [`_compat-folders.ts`](./_compat-folders.ts) — the store (§07.1) |
| `./recordRequests.js` | [`_nock.mjs`](./_nock.mjs) — same record/replay, ESM |

`_registryServer.mjs` and `_binHelpers.ts` are upstream's, unchanged in
substance. The three files that import Corepack's internals directly —
`config.test.ts`, `corepackUtils.test.ts`, `npmRegistryUtils.test.ts` — are not
ported: jup covers the same ground in `test/unit/`.

`test/corepack/*.test.ts` is excluded from `oxfmt` — a reformat would destroy
the diff against upstream, which is what makes re-porting from a newer Corepack
tractable: `git diff` against the upstream file shows only the import block and
the `SKIP` markers.

## Running it

```sh
pnpm test:corepack                          # compat mode, live network — green
NOCK_ENV=record pnpm test:corepack          # write test/corepack/nocks.db
NOCK_ENV=replay pnpm test:corepack          # offline, from that recording

# jup's real defaults, no compat hatches: 52 rows fail, all of them deliberate
vitest run --config test/corepack/vitest.config.ts
```

It is **not** part of `pnpm test`: it talks to the real npm registry, and
several rows install multi-megabyte package managers.

Every upstream row that writes a `.corepack.env` is left exactly as it is, and
passes: §03.2 still reads that name when the directory has no `.jup.env`, which
is what §14.24 asks for. The suite is therefore also the regression test for the
legacy spelling — the fallback going away would show up here as ten-odd red rows
rather than as a quiet behaviour change in somebody's repository.

Upstream's own `nocks.db` cannot be reused. The recording is keyed on a hash of
the request *including its headers*, and jup sends its own `user-agent` and
abridged-metadata `accept` — so every lookup misses. A local recording has to be
made with `NOCK_ENV=record`; the file is gitignored.

## What it reports

**141 rows: 95 pass, 45 skipped, 1 expected fail, 0 failing.**

> Measured 2026-08-27. The per-cause table below still adds up to 41 of those
> skips and wants a recount; the headline is what a run reports.

`pnpm test:corepack` sets `JUP_COREPACK_COMPAT=1`, because that is the mode in
which green means green. Without it, 52 rows fail — see *Compat mode* below.

Every skip is a deliberate divergence, carries a `// SKIP (jup §…)` comment
naming the section that makes it deliberate, and points at the jup test covering
the behaviour instead. Nothing is skipped for being merely inconvenient: a new
red row is a regression, which is the whole point of keeping the port.

| Skipped | Cause |
| --- | --- |
| 12 | **Message shape.** `use` / `up` print an extra `Updated <path> to use …` line (§09.4), and `use`'s usage line carries `--here` / `--pin-style`, which Corepack has no equivalent for (§15.26, §15.27). |
| 8 | **§15.11** — a registry that publishes no signature is a warning and a fall back to integrity-only verification, not the hard failure Corepack raises. |
| 6 | **§14.16 / §15.13** — `enable` and `disable` will not touch a file jup did not install, and the install directory is `$XDG_BIN_HOME`/`~/.local/bin` rather than a `PATH` lookup of jup's own name. |
| 5 | **§12.1** — `Signature does not match` and `Mismatch hashes` are `Error`, not `UsageError`, so they print on stderr with a stack. Corepack presented every error as a usage error until 0.31.0; §12.1 requires keeping the distinction. |
| 4 | **§15.23** — ranges and tags (`yarn@stable`, `pnpm@6.x`, `npm@^6.14.2`) resolve where Corepack demands an exact version. |
| 2 | **§15 / errors.ts:270** — with the network off and nothing cached, jup names the seeding commands instead of Corepack's bare `Network access disabled by the environment`. Two rows use that string to probe env-file discovery. |
| 1 | **§14** — `yarn`'s built-in default is Berry, not Classic 1.22 (#812), and a custom registry serves it as `@yarnpkg/cli-dist` (§05.3). |
| 1 | **§15, #138** — `enable`'s default target set includes npm. |
| 1 | **§14.15** — a POSIX shim points at one name-agnostic stub, so the corrected link reads `…/shim-proxy.js` rather than `…/yarn.js`. The row's subject, correcting a wrong symlink, is covered by jup's row 123. |
| 1 | **Structurally unportable** — `should expose its root to spawned processes` asserts `COREPACK_ROOT` equals the tests' own parent directory, true only when the suite lives inside the tool's package. |

## Compat mode

`JUP_COREPACK_COMPAT=1` sets three variables, and each answers a divergence too
broad to skip row by row:

| Variable | Rows | Divergence |
| --- | --- | --- |
| `COREPACK_INTEGRITY_KEYS=0` | 20 | §14.4 — npm's retired signing key. Everything published before the 2025-01 rotation still carries a signature from it, which upstream pins heavily (`yarn@1.22.4`, `pnpm@4.11.6`, `npm@6.14.2`). Corepack never reads `expires`; jup fails. Widest reach on a real project. |
| `COREPACK_ALLOW_UNVERIFIED=1` | 18 | §15.11 — a source with no signature and no pinned hash is refused: every Berry release from `repo.yarnpkg.com`, and every URL reference. |
| `COREPACK_QUIET_ADVISORIES=1` | 22 | §14.23 — the advisory `!` lines jup adds. |

The first two are **not** applied to rows that run against the mock registry
(`runCli(..., true)`): `_registryServer.mjs` mints its own keypair, so those rows
are about verification itself and several assert that it *fails* before turning
it off. The advisory mute is applied everywhere, because it changes no outcome —
only how much jup says about it.

Run without it — `vitest run --config test/corepack/vitest.config.ts` — to see
those 52 rows fail, which is what a user with jup's real defaults would hit.

### What was fixed rather than skipped

Four levers were measured against the residual, and all four were taken:

| Lever | Rows | Kind |
| --- | --- | --- |
| Hand over with `Module.runMain`, not `import()` | +6 | **bug** — fixed, see below |
| Leave `process.exitCode` undefined on a plain success | (1 of those 6) | **bug** — fixed, see below |
| Accept trusted keys on curves other than P-256 | +13 | §06.3 scopes its P-256 assertion to *native* implementations; jup is not one |
| Suppress jup's *extra* advisory `!` lines | +22 | `COREPACK_QUIET_ADVISORIES` (§11.5, §14.23) |
| Scrub `YARN_*` / `npm_config_*` from the test environment | +6 | harness — a stray `YARN_NPM_MINIMAL_AGE_GATE` fails every row running an older Yarn |

The advisory lever was the largest, and the one that could not be pulled
bluntly: a global mute costs five rows back, because upstream asserts the exact
`!` text for the `devEngines` warnings, which jup already emits verbatim.
`COREPACK_QUIET_ADVISORIES` is scoped by *origin* instead — it silences the lines
jup adds and leaves Corepack's own six untouched.

## The two that were not divergences

Both were jup bugs rather than deliberate differences, and both have since been
fixed; the row counts above were measured before either fix. They are kept here
because the two failure modes are invisible to jup's own fixtures and would be
re-introduced silently.

**`require.main` was never set.** Both tools clear `process.mainModule` before
handing over (§08.2 — newer pnpm reads `require.main == null` to detect a version
manager), but Corepack then calls `Module.runMain(binPath)`, which makes Node set
`require.main` to the package manager's own entry module. jup used `import()`,
which never sets it. Isolated repro:

```
Module.runMain  → pnpm@4.11.6 prints 4.11.6
import()        → pnpm@4.11.6 prints 0.0.0
```

pnpm 4.x resolves its own `package.json` through
`path.dirname(require.main.filename)` and falls back to a literal `0.0.0`;
**npm 6 does not degrade at all** — it aborts with
`npm ERR! Cannot read properties of undefined (reading 'filename')`. jup's own
conformance fixtures never catch this, because the stand-in entry script answers
`--version` from a constant. Fixed by handing over with `Module.runMain`.

**`process.exitCode` was 0 before the package manager ran.** `bin.ts` assigned
`process.exitCode = await runMain(…)` unconditionally, and the in-process
handover returns `0` to mean "handed over". §08.4's first two cases held anyway —
the handover is on `nextTick`, so a package manager that sets `42` synchronously
overwrites the `0` — but the third did not: a hook that guards on
`process.exitCode === undefined` saw `0` and declined to set anything. jup's own
test 134 sets the code unconditionally, so it passed over the gap. Fixed by
assigning only a non-zero code, in `bin.ts` and in the generated shim stub
alike; test 134b pins the guarded form.
