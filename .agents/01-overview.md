# 01 — Architecture Overview

## 1.1 What the tool is

A PMVM is a **trampoline**. It occupies the names `npm`, `npx`, `pnpm`, `pnpx`,
`yarn`, `yarnpkg` on `PATH`. When invoked under one of those names it:

1. determines *which version* of that package manager this project wants,
2. makes sure that exact version is present locally and verified,
3. transfers control to it, transparently.

The user must not be able to tell the difference between running `yarn` under the
PMVM and running a directly-installed `yarn`, except that the version is now
project-pinned.

## 1.2 The two entry modes

The binary dispatches on `argv[0]`-equivalent (the name it was invoked as) and on
`argv[1]`.

```
                    invocation
                        │
        ┌───────────────┴────────────────┐
        │                                │
  first token names a               otherwise
  known binary (npm, npx,                │
  pnpm, pnpx, yarn, yarnpkg)             │
  OR is `<anything>@<version>`           │
        │                                │
        ▼                                ▼
  PROXY MODE                       MANAGEMENT MODE
  run the package manager          run the PMVM's own CLI
  (§08)                            (`enable`, `use`, …) (§09)
```

### Proxy mode trigger

Normative rule (from corepack `main.ts::getPackageManagerRequestFromCli`):

Let `arg0` be the first CLI argument. Match it against `/^([^@]*)(?:@(.*))?$/`,
yielding `binaryName` and optional `binaryVersion`.

* If `binaryName` maps to a known package manager (§02.4) → **proxy mode**.
* Else if `binaryVersion` is present (i.e. the argument contained `@`) → **proxy
  mode** with an unknown package manager (this is how `jup foo@1.2.3` reaches
  the "unsupported package manager" error rather than the CLI's "unknown command").
* Else → **management mode**.

> **Note.** The regex `[^@]*` means `@scope/pkg@1.0.0` never matches as a name;
> `binaryName` is `` (empty) and `binaryVersion` is `scope/pkg@1.0.0`. A conforming
> implementation MUST preserve this, because it is how the `Unsupported package
> manager specification` error path is reached.

In practice proxy mode is entered two ways:

| Entry | `argv` seen by the tool | Notes |
|---|---|---|
| Via a shim (`yarn add x`) | shim re-execs the PMVM with `["yarn", "add", "x"]` | The normal path once `enable` has run (§10) |
| Directly (`jup yarn add x`) | `["yarn", "add", "x"]` | Same code path — the shim is only a PATH convenience |
| Version-pinned (`jup yarn@4.1.0 add x`) | `["yarn@4.1.0", "add", "x"]` | `binaryVersion` overrides the project spec (§04.6) |

## 1.3 End-to-end proxy pipeline

This is the hot path. Every step is specified in the referenced file.

```
 ┌─ 1. classify invocation ───────────────────────── §01.2
 │      binaryName, binaryVersion, args
 │
 ├─ 2. build fallback locator ────────────────────── §04.5
 │      lazy: only resolved if the project has no spec
 │      transparent-command check (§01.4) may swap in
 │      a different fallback version
 │
 ├─ 3. discover project spec ─────────────────────── §03
 │      walk up from cwd looking for package.json,
 │      loading .corepack.env on the way;
 │      → NoProject | NoSpec | Found
 │
 ├─ 4. reconcile ─────────────────────────────────── §03.5
 │      Found + name mismatch  → hard error (strict)
 │                             → fallback (transparent)
 │      NoSpec / NoProject     → fallback descriptor
 │      binaryVersion present  → overrides everything
 │
 ├─ 5. resolve descriptor → locator ──────────────── §04
 │      tag?    → registry dist-tags lookup
 │      cached? → highest matching installed version   ← FAST PATH ENDS HERE
 │      exact?  → use as-is
 │      range?  → fetch version list, pick highest
 │
 ├─ 6. ensure installed ──────────────────────────── §07
 │      hit:  read <store>/<name>/<version>/.corepack   ← FAST PATH ENDS HERE
 │      miss: download → verify (§06) → atomic rename
 │
 └─ 7. execute ───────────────────────────────────── §08
        rewrite argv, set env, hand over the process
```

### Fast path budget

A conforming implementation **MUST** be able to complete a warm proxy invocation
(project pins an exact version that is already in the store) with:

* **zero** network requests,
* **zero** reads of the last-known-good file,
* at most: one `.corepack.env` `open` attempt per directory walked, one
  `package.json` read, one `.corepack` read, plus the execution syscalls.

Corepack itself satisfies this because `findInstalledVersion` short-circuits before
any registry call and `installVersion` returns early on a `.corepack` hit. Any
re-implementation that, for example, always reads `lastKnownGood.json` or always
lists the store directory violates the budget.

> **Divergence (see §14.1):** corepack's warm path still `opendir`s the whole
> `<store>/<name>/` directory whenever the descriptor is a *range*. When the
> descriptor is an exact version (the overwhelmingly common case, since
> `packageManager` normally pins exactly) an implementation SHOULD `stat`
> `<store>/<name>/<version>/.corepack` directly and skip the directory scan.

## 1.4 Transparent commands

Some commands are *bootstrapping* commands: they must work even when the current
project is configured for a **different** package manager, or for no package manager
at all. Running `pnpx foo` inside a Yarn project must not be an error.

Each package manager declares a list of transparent command prefixes (§02.3). A
command is transparent iff:

* `prefix[0] === binaryName`, **and**
* every remaining segment `prefix[i]` equals `args[i-1]`.

i.e. the prefix matches the *leading* segments of the invocation.

Built-in transparent commands:

| Package manager | Prefixes |
|---|---|
| npm | `npm init`, `npx` |
| pnpm | `pnpm init`, `pnpx`, `pnpm dlx` |
| yarn | `yarn init`, `yarn dlx` |

Effects of a command being transparent:

1. A name mismatch against the project spec is **not** an error — the tool falls
   back to the requested package manager (this is `transparent = true` in §03.5).
2. If the package manager declares `transparent.default`, that version is used as
   the fallback instead of the normal default. Only `yarn` does this today, pinning
   `4.14.1+sha224.…` so that `yarn dlx` in a non-Yarn project gets a modern Yarn
   rather than the classic 1.x default.

## 1.5 Management mode

Management mode is a small, flat command set (§09). It shares the resolution engine
with proxy mode but never hands over the process except for `use`/`up`, which run
the newly-pinned package manager's install command as their last act.

## 1.6 State

The tool owns exactly one directory (`COREPACK_HOME`, §07.1) containing:

```
<home>/
├── lastKnownGood.json     # {"<pm name>": "<version>"} — the global default per PM
└── v1/                    # store, versioned by layout revision
    ├── npm/<version>/…
    ├── pnpm/<version>/…
    └── yarn/<version>/…
```

It writes to the project only when explicitly asked (`use`, `up`, or
`COREPACK_ENABLE_AUTO_PIN=1`), and then only to `package.json`'s `packageManager`
field.

It writes to a bin directory only during `enable` / `disable` (§10).

## 1.7 Non-goals

A conforming implementation MUST NOT:

* install project dependencies itself,
* manage Node.js versions,
* provide a plugin/hook system,
* phone home, collect telemetry, or auto-update itself,
* rewrite any project file other than the `packageManager` field of `package.json`.
