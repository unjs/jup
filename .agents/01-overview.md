# 01 — Architecture Overview

## 1.1 What the tool is

jup is a **trampoline**. It occupies the name of every binary the table declares
(§02.4) — `npm`, `npx`, `pnpm`, `pnpx`, `yarn`, `yarnpkg` and the rest — on `PATH`.
When invoked under one of those names it:

1. determines *which version* of that tool this project wants,
2. makes sure that exact version is present locally and verified,
3. transfers control to it, transparently.

The user must not be able to tell the difference between running `yarn` under jup
and running a directly-installed `yarn`, except that the version is now
project-pinned.

### Tools, not only package managers

Every entry in the table is a **tool**, and §02.3's `kind` says which sort:

* a **package manager** — `npm`, `pnpm`, `yarn`, `bun`, `deno`, `aube`, `nub` — is
  what a project declares in `packageManager` or `devEngines.packageManager`, and is
  what §03.5 enforces when you stand in someone else's project;
* a **runtime** — `node` — is declared in `devEngines.runtime`, is never enforced
  against, and is never a legal `packageManager` value.

The model remains deliberately narrow. Everything from
§04 through §08 is one pipeline over both kinds: `jup node@22 --version` resolves,
downloads, verifies, caches and executes by the same rules as `jup yarn@4`.

## 1.2 Entry dispatch

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

Let `arg0` be the first CLI argument. Match it against `/^([^@]*)(?:@(.*))?$/`,
yielding `binaryName` and optional `binaryVersion`.

* If `binaryName` maps to a known tool (§02.4) → **proxy mode**. This is the whole
  of what makes `jup node@22 --version` work: `node` is a table entry, so it names a
  binary, and §04.6's version override does the rest.
* Else if `binaryVersion` is present (i.e. the argument contained `@`) → **proxy
  mode** with an unknown tool (this is how `jup foo@1.2.3` reaches
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
 │      loading .jup.env on the way;
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
 │      hit:  read <store>/<name>/<version>/.jup        ← FAST PATH ENDS HERE
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
* at most: two env-file `open` attempts per directory walked — `.jup.env`, then
  `.corepack.env` only if the first is `ENOENT` (§03.2) — one `package.json` read,
  one `.jup` read, plus the execution syscalls.

For an exact descriptor, probe `<store>/<name>/<version>/.jup` directly. Do not list
the tool directory. Do not read `lastKnownGood.json` before the project path proves a
fallback is needed.

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
2. If the package manager declares `transparent.default`, that value replaces the
   normal fallback. See the current tool table in §02.

## 1.5 Management mode

Management mode is a small, flat command set (§09). It shares the resolution engine
with proxy mode but never hands over the process except for `use`/`up`, which run
the newly-pinned package manager's install command as their last act.

## 1.6 State

The tool's managed state lives under `COREPACK_HOME` (§07.1):

```
<home>/
├── lastKnownGood.json     # {"<tool name>": "<version>"} — the global default per tool
└── v1/                    # store, versioned by layout revision
    ├── npm/<version>/…
    ├── pnpm/<version>/…
    └── yarn/<version>/…
```

It writes to the project only when explicitly asked (`use`, `up`, or
`COREPACK_ENABLE_AUTO_PIN=1`), and then only to the `package.json` field that encodes
the pin for the tool in question (§03.7): `packageManager` and
`devEngines.packageManager` for a package manager, `devEngines.runtime` for a
runtime.

It writes to a bin directory only during `enable` / `disable` (§10).

## 1.7 Non-goals

A conforming implementation MUST NOT:

* install project dependencies itself,
* manage anything not named by the compiled-in table (§02.5) — no user-extensible
  registry, no plugin API, no build-from-source, no arbitrary version manager,
* provide a plugin/hook system,
* phone home, collect telemetry, or auto-update itself,
* rewrite any project file other than the pin fields listed in §1.6.

The compiled-in table is closed and changes only in a release; users cannot add
tools at runtime.
