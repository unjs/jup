# The upstream Corepack suite, run against jup

A port of `nodejs/corepack@b856c516`'s `tests/` — the same commit §00 pins the
specification to. The point is not to make it pass: it is an outside view of how
jup answers the questions Corepack's own maintainers thought worth asking, and a
place where a real regression shows up as a *new* failure.

The five CLI-level files are copied **verbatim**. Only the import lines were
rewritten:

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

Because the bodies are verbatim, `test/corepack/*.test.ts` is excluded from
`oxfmt` — a reformat would destroy the diff against upstream. Re-porting is
`sed` on the import block and nothing else.

## Running it

```sh
pnpm test:corepack                          # live network
JUP_COREPACK_COMPAT=1 pnpm test:corepack    # known divergences switched off
NOCK_ENV=record pnpm test:corepack          # write test/corepack/nocks.db
NOCK_ENV=replay pnpm test:corepack          # offline, from that recording
```

It is **not** part of `pnpm test`: it talks to the real npm registry, and
several rows install multi-megabyte package managers.

Upstream's own `nocks.db` cannot be reused. The recording is keyed on a hash of
the request *including its headers*, and jup sends its own `user-agent` and
abridged-metadata `accept` — so every lookup misses. A local recording has to be
made with `NOCK_ENV=record`; the file is gitignored.

## What it reports

141 rows. **46 pass live; 72 with `JUP_COREPACK_COMPAT=1`**, which sets
`COREPACK_INTEGRITY_KEYS=0` and `COREPACK_ALLOW_UNVERIFIED=1` — the two escape
hatches jup already documents for its two widest divergences:

| Rows | Cause |
| --- | --- |
| 20 | §14.4 — npm's retired signing key. Everything published before the 2025-01 rotation still carries a signature from it, which upstream pins heavily (`yarn@1.22.4`, `pnpm@4.11.6`, `npm@6.14.2`). Corepack never reads `expires`; jup fails. Widest reach on a real project. |
| 18 | §15.11 — a source with no signature and no pinned hash is refused: every Berry release from `repo.yarnpkg.com`, and every URL reference. |

Compat mode is a blunt instrument — five rows *want* verification to fail and
pass spuriously under it. It is a regression detector, not a score.

### The residual, and what moves it

Measured by applying each lever and re-running:

| Lever | Rows | Kind |
| --- | --- | --- |
| Hand over with `Module.runMain`, not `import()` | +6 | **bug** — see below |
| Leave `process.exitCode` undefined on a plain success | (1 of those 6) | **bug** — see below |
| Scrub `YARN_*` / `npm_config_*` from the test environment | +6 | harness (already applied) |
| Suppress jup's *extra* advisory `!` lines on stderr | +17 | policy |
| Accept trusted keys on curves other than P-256 | +13 | policy |

The advisory lever is the largest and the least safe to pull bluntly: a global
mute costs five rows back, because upstream asserts the exact `!` text for the
`devEngines` warnings, which jup already emits verbatim. What is actually needed
is a way to silence the lines jup adds — §06.2's weak-hash notice, §15.11's
"publishes no signatures", §15.13's shim diagnostics — without touching the
lines Corepack also prints. There is no environment variable for that today.

What no lever reaches, roughly 25 rows:

- **Message shape.** `use` / `up` print an extra `Updated <path> to use …` line,
  and jup's usage line carries flags Corepack has no equivalent for. (12)
- **Deliberate §15 behaviour the rows predate.** Ranges and tags resolve where
  Corepack errors (§15.23); `yarn`'s built-in default is Berry, not Classic
  1.22; `disable` will not remove a file it did not install; a hand-written
  `.corepack` marker of `{}` is not a complete install (§07.2, §15.11). (11)
- **Structurally unportable.** `should expose its root to spawned processes`
  asserts `COREPACK_ROOT` equals the tests' own parent directory, which is only
  true when the suite lives inside the tool's package. (1)

## The two that are not divergences

**`require.main` is never set.** Both tools clear `process.mainModule` before
handing over (§08.2 — newer pnpm reads `require.main == null` to detect a version
manager), but Corepack then calls `Module.runMain(binPath)`, which makes Node set
`require.main` to the package manager's own entry module. jup uses `import()`,
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
`--version` from a constant.

**`process.exitCode` is 0 before the package manager runs.** `bin.ts` assigns
`process.exitCode = await runMain(…)` unconditionally, and the in-process
handover returns `0` to mean "handed over". §08.4's first two cases still hold —
the handover is on `nextTick`, so a package manager that sets `42` synchronously
overwrites the `0` — but the third does not: a hook that guards on
`process.exitCode === undefined` sees `0` and declines to set anything. jup's own
test 134 sets the code unconditionally, so it passes over the gap.
