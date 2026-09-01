# 01 — Architecture Overview

These pages are the maintainer's map of jup's behaviour. They describe what the
code does and why; `src/` and the test suites are the final word on detail.
Values that a script refreshes — table versions, digests, trust keys — live in
code and are never copied here.

## 1.1 What jup is

jup is a **trampoline**. It occupies the name of every binary its built-in table
declares (§02) — `npm`, `npx`, `pnpm`, `pnpx`, `yarn`, `bun`, `node` and the rest
— on `PATH`. Invoked under one of those names it:

1. works out *which version* of that tool this project wants,
2. makes sure that exact version is present locally and verified,
3. transfers control to it, transparently.

Running `yarn` under jup must be indistinguishable from running an installed
`yarn`, except that the version is now project-pinned.

### Tools, not only package managers

Every table entry is a **tool**, and its `kind` says which sort:

* a **package manager** (`npm`, `pnpm`, `yarn`, `bun`, `deno`, `aube`, `nub`) is
  what a project declares in `devEngines.packageManager` — or in `packageManager`,
  which is still read and still written when it is there (§03.3, §03.7) — and is
  what §03.5 enforces when you stand in someone else's project;
* a **runtime** (`node`) is declared in `devEngines.runtime`, is never enforced
  against, and is never a legal `packageManager` value.

`bun`, `deno` and `nub` are both: package managers by `kind`, and runtimes by the
`alsoRuntime` flag beside it (§02.3). The flag buys them the runtime's exemption
from §03.5 and nothing else — someone else's pnpm pin cannot refuse `bun
server.ts`, while their own pin is read, written and enforced against the way
every package manager's is.

Both kinds run through one pipeline: `jup node@22 --version` resolves, downloads,
verifies, caches and executes by the same rules as `jup yarn@4`.

## 1.2 Entry dispatch

Dispatch is on the first argument (`argv[0]`-equivalent — the name the binary was
invoked as, or the first word after `jup`).

Let `arg0` match `/^([^@]*)(?:@(.*))?$/`, yielding `binaryName` and an optional
`binaryVersion`.

* `binaryName` names a known binary → **proxy mode**.
* Otherwise the argument contained an `@` → **proxy mode** with an unknown tool,
  which is how `jup foo@1.2.3` reaches "unsupported package manager
  specification" rather than "unknown command".
* Otherwise → **management mode** (§09), where a word §09's dispatch does not
  know is the project's own script (§09.17) rather than an error.

`[^@]*` means a scoped spec never matches as a name: `@scope/pkg@1.0.0` yields an
empty `binaryName`, which fails the supported-name check. That is the intended
outcome, reached by an accident of the pattern; if the classifier is ever
rewritten, keep the outcome and state it directly.

Proxy mode is entered two ways, both landing on the same code path:

| Entry | argv seen | Notes |
|---|---|---|
| Via a shim (`yarn add x`) | `["yarn", "add", "x"]` | The normal path once `enable` has run (§10) |
| Directly (`jup yarn add x`) | `["yarn", "add", "x"]` | The shim is only a `PATH` convenience |
| Version-pinned (`jup yarn@4.1.0 add x`) | `["yarn@4.1.0", "add", "x"]` | `binaryVersion` overrides the project spec (§04.7) |

## 1.3 The proxy pipeline

This is the hot path.

```
 1. classify invocation ............................ §01.2
      binaryName, binaryVersion, args
 2. build fallback locator ......................... §04.6
      lazy: forced only if the project has no spec
 3. discover project spec .......................... §03
      walk up from cwd reading package.json,
      loading .jup.env on the way
      → NoProject | NoSpec | Found
 4. reconcile ...................................... §03.5
      name mismatch → error (strict) or fallback (transparent)
      binaryVersion → overrides everything
 5. resolve descriptor → locator ................... §04
      recorded jup.lock → memo → store probe        ← FAST PATH ENDS HERE
      → registry
 6. ensure installed ............................... §07
      hit:  read <store>/<name>/<version>/.jup      ← FAST PATH ENDS HERE
      miss: download → verify (§06) → atomic rename
 7. execute ........................................ §08
      rewrite argv, set env, hand over the process
```

### Fast-path budget

A warm proxy invocation — the project pins an exact version already in the store
— completes with **no** network request, **no** read of `lastKnownGood.json`, and
bounded filesystem probes: at most two env-file `open` attempts per directory
walked (`.jup.env`, then `.corepack.env` only on `ENOENT`), one `package.json`
read per directory until the declaring one, one marker read (a second only when a
pin collides on a store directory, §07.2), plus the execution syscalls.

For an exact descriptor, probe `<store>/<name>/<version>/.jup` directly — do not
list the tool directory, and do not read `lastKnownGood.json` before the project
walk proves a fallback is needed. `pnpm bench` guards this.

## 1.4 Transparent commands

Some invocations are *bootstrapping* ones: they must work even when the current
project is configured for a different package manager, or for none. `pnpx foo`
inside a Yarn project is not an error.

An invocation is transparent when either holds:

* it matches a **command prefix** the package manager declares — `prefix[0]`
  equals `binaryName` and every remaining segment equals the corresponding
  argument, so the prefix matches the leading segments (`npm init`, `npx`,
  `pnpm dlx`, `yarn dlx`, `bunx`, …);
* it is a **global invocation** — `-g`, `--global`, `--location=global`, or
  `--location global` among the leading arguments. The scan stops at `--` or at
  the second operand, so a trailing flag cannot bypass the project pin. A global
  install is not asking the project for anything, exactly as a bootstrapping
  command is not.

Effects:

1. A name mismatch against the project spec is not an error; jup falls back to
   the requested tool (§03.5).
2. If the entry declares `transparent.default`, that version becomes the fallback
   floor. It is a floor, not an override: a newer user-recorded default in the
   same major wins.

## 1.5 Management mode

A small, flat command set (§09). It shares the resolution engine with proxy mode
and never hands over the process except for `use`/`up`, which run the newly
pinned package manager's install command as their last act.

## 1.6 State

Managed state lives under `JUP_HOME` (§07.1):

```
<home>/
├── lastKnownGood.json     # {"<tool>": "<reference>"} — the global default per tool,
│                          # plus "#stamps" (§04.5), which §04.6's TTL reads
├── shims.json             # entries displaced by `enable --force` (§10.6)
├── self/<version>/        # jup's own copy, installed by self-install (§07.11)
└── v1/                    # the store, versioned by layout revision
```

jup writes to the project only when asked — `use`, `up`, or
`JUP_ENABLE_AUTO_PIN=1` — and then only to the pin field for the tool in question
(§03.7) plus, for a range pin, `jup.lock` beside it (§04.4). It writes to a bin
directory only during `enable`, `disable`, `self-install` and `self-upgrade`.

## 1.7 Non-goals

jup does not:

* install project dependencies,
* manage anything outside the compiled-in table — no user-extensible registry, no
  plugin API, no build-from-source, no arbitrary version manager,
* run lifecycle scripts from anything it downloads,
* phone home, collect telemetry, or update itself without being asked
  (`self-upgrade` is an explicit command, §09.13),
* rewrite any project file other than the pin fields and `jup.lock`.

The table is closed and changes only in a release; users cannot add tools at
runtime.
