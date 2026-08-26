# Implementation Plan — §17

**Non-normative.** The contract is `.agents/01`–`17`. This file is the *remaining* work
breakdown: what is left, in what order, and which conformance rows prove each piece.
Section-by-section verdicts on §15 live in [`S15-AUDIT.md`](./S15-AUDIT.md).

## Where things stand — `2b80f1e`, 2026-08-26

* **§01–§16 are implemented.** Every row of §13 (1–147) and §15.38 (148–207) has a test
  whose title names it. `pnpm vitest run`: **1648 passed, 3 skipped**, the skips all
  platform-conditional (Windows, root, no TTY). `pnpm test:corepack` (corepack's own
  suite): **103 passed, 1 expected fail, 37 skipped**, each skip a §14 divergence with a
  stated reason.
* **§17 is specified and unimplemented.** Two pieces have landed early: the one-executable
  / two-names packaging (`bin.corepack` and `bin.jup` are the same file, C1′) and the
  `JUP_`/`COREPACK_` pair resolution in `src/config/env-vars.ts`. The latter is **tier 1
  only** — C4's second tier, under which §11.5's and §15.37's invented variables are named
  `JUP_` and merely *accept* the `COREPACK_` spelling, is not implemented; the table treats
  every variable as an equal pair. Nothing else — no scope words, no roles, no rename of
  the store home, marker, env file, or lockfile. Rows 208–233 have no tests.
* **Nothing is published**; `package.json` is at `0.0.0`.

## Remaining work — §17

Order is dependency order. D0 unblocks D2 and D4; the rest are independent.

### D0 — The test-only table fixture §17.9

§02.5 has no runtime, so every role-sensitive requirement is vacuously satisfied by an
implementation that ignores roles. The harness needs to substitute a table carrying one
`roles: ["runtime"]` tool and one dual-role tool, served by the existing mock registry.
A test seam only: not reachable from a released binary, the environment, or any project
file (§01.7, §15.21). Also amend the harness so rows 216–217 set the store-home variables
themselves instead of inheriting a fresh home (§13.1 exempts them).

### D1 — The command router §17.4, C1′, C6, C10

R7's classification order, R8's disjointness invariant (a build-time check, not a runtime
one), R9's narrowing (whose row, 230, needs D0's fixture and so lands with D2), and
R12's `corepack` entry point — which must recognise the scope
words *in order to refuse them*. C10 is a **name** substitution in message bodies, not a
rewrite: same sentence, same punctuation, same interpolations, and never applied to
`packageManager`, `devEngines`, legacy `COREPACK_*` spellings, or the nodejs.org URL.
`src/commands/usage.ts` becomes scope-aware.
**Rows:** 208–215.

### D2 — Roles in the data model §17.3, §17.5

R1–R6 (one entry per tool, roles as data), R10's inference for an unscoped command, R11's
dual-role specs, and R4's per-role enforcement — a runtime-only pin must not produce a
package-manager mismatch error. R14 parses, validates, and reconciles `devEngines.runtime`
while it stays inert; R15 keeps `engines.node` out of selection; R16 defers `.nvmrc` and
friends. §15.26's single atomic manifest write has to carry both pins at once.
**Rows:** 225–233.

### D3 — The renames C2, C3, C9

Write the `jup` spelling, accept the `corepack` spelling on read, prefer `jup` in every
message: `JUP_HOME` ?? `COREPACK_HOME` ?? `<cache>/jup`; `.jup` marker written, `.corepack`
still accepted; `.jup.env`, `.jup.lock`, `jup.tgz`, `jup-<pid>-<hex>` temp dirs, and the
Windows shim directory. C8: **no migration** — an abandoned corepack cache costs one
re-download, migration code costs the hot path forever. The lockfile is the urgent one: it
sits at the project root, is committed, and is named in a verbatim error.

C4's tier 2 belongs here too: `JUP_NODE_EXECPATH` and `JUP_QUIET_ADVISORIES` (§11.5) and
§15.37's twelve are `JUP_`-named, keep the `COREPACK_` spelling as a legacy alias, and are
reported under `JUP_` by `info` unless that is the spelling the user set. §12's
`JUP_NODE_EXECPATH` message and §15.4's `set by JUP_CAFILE` move with them.
**Rows:** 216–221.

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

* **The warm byte ceiling is at 204,000** (`test/unit/main.test.ts`). The next warm-path
  change raises it deliberately, with a reason. It is a tripwire, not a budget. The
  companion assertion — the modules statically reachable from `src/shim.ts` **equal**
  `build.config.ts`'s `WARM_MODULES` — is what pins the emitted chunk; a new static import
  on the warm path fails until the build config is updated.
* **`test/conformance/15-28-native.test.ts` flakes under full-suite load.** The §08.5
  row asserting `exitCode 55` / `signal null` — the child stayed in the process group and
  the tool did not die of the same signal — failed once in two consecutive full runs and
  passes alone every time. 1648 passed / 3 skipped is the green baseline; a single failure
  in that file is the flake, not a regression. Worth a timing fix before it costs someone
  an afternoon.
* **The sandbox has live network and the conformance harness does not disable it.** A row
  relying on a *fallback* version can pass over the wire. Seed the store and set
  `COREPACK_ENABLE_NETWORK=0` wherever the answer must come from the fixture.
* **A mock that collapses two sources into one cannot distinguish them.** Two high-severity
  bugs survived a green suite because the harness rewrote every host to a single mock, so
  "the mirror was used" passed whether or not the substitution happened. D0's fixture is
  the same shape of risk.
* **A plan organised by value will miss requirements.** Phase 2 shipped twelve items and
  left eight §15 sections unassigned; a walk of the spec found five real gaps. Walk §17
  section by section before ranking anything.
* **A test that exercises only the source tree cannot catch a layout assumption.** Three
  separate bugs came from counting `dirname` calls; all three were invisible from source
  and real in the shipped package. `src/self.ts` walks up instead — build `dist/` and run
  it by hand before believing anything about paths.

## Open follow-ups, all verified open

* `src/version/resolve.ts` still carries its own `hasRegistryOverride()` reading only
  `COREPACK_NPM_REGISTRY`. The consequence is neutralised (§05.2 rewrite 1 also applies
  inside `registry.ts`'s fetchers, idempotently), but the redundant, incomplete copy
  should go.
* `errors.ts`'s `cafileUnreadable` hardcodes `(set by COREPACK_CAFILE)`, which is wrong for
  an `.npmrc` `cafile`. §12 wants a parameterised message.
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
