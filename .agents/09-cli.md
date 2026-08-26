# 09 — Command Surface

This is the complete surface. Anything not here is out of scope (§01.7, §17.8).

```
<tool> <binary>[@<version>] [...args]     proxy mode (§01.2)

<tool> [<scope>] cache clean
<tool> [<scope>] cache clear
<tool> [<scope>] disable [--install-directory <path>] [...name]
<tool> [<scope>] enable  [--install-directory <path>] [...name]
<tool> [<scope>] install
<tool> [<scope>] install -g|--global [--cache-only] [...name[@<version>] | <file>.tgz]
<tool> [<scope>] pack [--json] [-o|--output <path>] [...name[@<version>]]
<tool> [<scope>] up
<tool> [<scope>] use <name[@<version>]>
<tool> --version
<tool> --help | -h | help

<scope> := pm | runtime
```

Deprecated, retained for compatibility only:

```
<tool> hydrate [--activate] <file>
<tool> prepare [--activate] [--all] [-o|--output [<path>]] [...spec]
```

> A minimal re-implementation MAY omit `hydrate` and `prepare` entirely and print a
> pointer to `install -g` / `pack`. They are strict subsets of the modern commands.

## 9.0 Scopes and the router

The optional `<scope>` names a role (§17.3). It **narrows** a command; it never
changes what the command does.

| Form | Meaning |
|---|---|
| `jup use pnpm@10` | the role is inferred from the tool named in the spec (§17.4 R10) |
| `jup pm use pnpm@10` | the same command, scope stated explicitly |
| `jup install` | acts on **every** role the project pins, package manager first |
| `jup pm install` | acts on the project's package manager only |
| `jup pm yarn --version` | **usage error** — a scope word is followed by a verb, never a binary |
| `jup yarn --version` | proxy mode; Yarn's version. The proxy test outranks the verb table (§17.4 R7) |
| `corepack <verb> …` | exactly `jup pm <verb> …`, with corepack's spellings and no scope words (§17.4 R12) |

Four properties this MUST have:

1. **The unscoped form is not deprecated** and MUST NOT print a migration notice
   (§17.4 R13). A router that can infer the role is friendlier than a namespace that
   demands one; the namespace exists for the cases where inference cannot decide.
2. **Classification order is fixed** by §17.4 R7. In particular the proxy tests come
   first, so a tool named after a verb would shadow that verb — which is why §17.4 R8
   makes the name sets disjoint at build time.
3. **A scope that excludes the named tool is an error**, not a silent widening
   (§17.4 R9).
4. **Only pin-writing commands need a role at all** (§17.3 R5). `cache`, `info`,
   `--version` and `--help` are role-blind; a scope filters what they *report*.

Each command below is specified once, in its role-blind form. Where a role is needed
the rule is §17.4 R10–R11, not a per-command exception.

## 9.1 Pattern resolution (shared by `install`, `pack`, `up`, `use`)

```
resolvePatternsToDescriptors(patterns):
    if patterns is non-empty:
        load ONLY the env file (§03.2, envOnly mode)
        return patterns.map(p => parseSpec(p, "CLI arguments", {enforceExactVersion: false}))

    # no patterns — fall back to the project
    lookup := discoverProjectSpec(cwd)
    NoProject → UsageError `Couldn't find a project in the local directory - please
                specify the package manager to pack, or run this command from a valid project`
    NoSpec    → UsageError `The local project doesn't feature a 'packageManager' field
                nor a 'devEngines.packageManager' field - please specify the package
                manager to pack, or update the manifest to reference it`
    Found     → [lookup.range ?? lookup.getSpec()]
```

Note `lookup.range ?? lookup.getSpec()` — when `devEngines.packageManager.version` is
present it is preferred over the exact `packageManager` pin. This is what makes
`corepack up` follow a declared range across majors (§09.4).

(The messages say "to pack" in all four commands. That is a copy-paste artefact in
the reference implementation, but it is test-asserted; see §14.14.)

## 9.2 `install`

```
descriptor := resolvePatternsToDescriptors([])         # project only, no args
locator    := resolve(descriptor, {allowTags: true})
    null → UsageError `Failed to successfully resolve '<range>' to a valid <name> release`
stdout: `Adding <name>@<reference> to the cache...\n`
ensureInstalled(locator)
```

Downloads and caches the project's package manager. Does **not** touch
`lastKnownGood.json` — the global default is unchanged. Exit 0, stderr empty.

Primary use: warming a Docker layer so the runtime image needs no network.

## 9.3 `install -g` / `install --global`

Accepts a mixed list of specs and archive paths. `--cache-only` downloads/extracts
without making anything the global default.

**Spec argument** (`name`, `name@version`, `name@range`, `name@tag`):

```
descriptor := parseSpec(arg, "CLI arguments", {enforceExactVersion: false})
locator    := resolve(descriptor, {allowTags: true})
    null → UsageError `Failed to successfully resolve '<range>' to a valid <name> release`
stdout: `Installing <name>@<reference>...\n`          (or `Adding … to the cache...` with --cache-only)
ensureInstalled(locator)
unless --cache-only: lastKnownGood[name] = reference; write
```

Unlike the automatic bump in §04.7, this is **unconditional** — `install -g yarn@1.0.0`
sets the default to 1.0.0 even if the current default is 4.x.

**Archive argument** (ends in `.tgz`): see §07.10.

## 9.4 `up`

No arguments. Updates the project's pin.

```
descriptor := resolvePatternsToDescriptors([])
if descriptor.range is neither a valid version nor a valid range:
    → UsageError `The 'corepack up' command can only be used when your project's
      packageManager field is set to a semver version or semver range`

resolved := resolve(descriptor, {useCache: false})     # note: tags NOT allowed
    null → UsageError `Failed to successfully resolve '<range>' to a valid <name> release`

target := { name, range: `^<major(resolved.reference)>.0.0` }
highest := resolve(target, {useCache: false})
    null → UsageError `Failed to find the highest release for <name> <major>.x`

stdout: `Installing <name>@<reference> in the project...\n`
ensureInstalled(highest)
writePin(highest)  and run the package manager's `use` command (§09.5)
```

The two-step resolve is what confines the update to the current major line. But note
the interaction with §09.1: if `devEngines.packageManager.version` declares a range
like `"1.x || 2.x"`, the *first* resolve already picks the highest version in that
whole range, and the second step then pins to that version's major. So a declared
`devEngines` range **can** carry `up` across a major boundary; a bare
`packageManager` pin cannot. This is intended and is exercised by the conformance
suite.

`useCache: false` on both resolves is required — otherwise `up` would return the
already-installed version and never update anything.

## 9.5 `use <pattern>`

```
descriptor := parseSpec(pattern, "CLI arguments", {enforceExactVersion: false})
resolved   := resolve(descriptor, {allowTags: true, useCache: false})
    null → UsageError `Failed to successfully resolve '<range>' to a valid <name> release`
stdout: `Installing <name>@<reference> in the project...\n`
info := ensureInstalled(resolved)
writePin(info)                                            # §03.7
```

Then, if the resolved range's spec declares `commands.use`:

```
COREPACK_MIGRATE_FROM := previousPackageManager    # "unknown" if there was none
stdout: `\n`
run the package manager: argv = commands.use        # e.g. ["yarn", "install"]
```

So `corepack use yarn@4` prints the banner, a blank line, then everything `yarn
install` prints. If `commands.use` is absent the command returns 0 immediately after
writing the pin.

Notable behaviours, all test-asserted:

* An **existing malformed `packageManager` field** (a range, a bare name, a trailing
  `@`, a non-string) does not block `use` — it is simply overwritten. This is why
  spec parsing is lazy (§03.1).
* If no `package.json` exists anywhere, one is **created** at `cwd`.
* If the project root is an ancestor of `cwd`, the **ancestor's** manifest is updated.
* The written pin always carries a `sha512` hash computed from the actual downloaded
  bytes, regardless of what algorithm the input pattern used.
* Only the top-level `packageManager` field is written, even when
  `devEngines.packageManager` exists — which can *create* the mismatch §03.3 then
  refuses to read. **§15.26 requires every field encoding the pin to be updated
  atomically**, and §15.27 requires the modified path to be printed.
* A `devEngines` mismatch surfaces here through `writePin`'s check, which routes
  through `onFail` (§03.7). With the default `onFail`, the banner has *already* been
  printed to stdout, so the failure output is:
  ```
  Installing yarn@1.22.4 in the project...
  Usage Error: The requested version of yarn@1.22.4+sha512.… does not match the devEngines specification (yarn@2.x)

  $ corepack use <pattern>
  ```
  on **stdout**, with stderr empty and exit code 1.

## 9.6 `pack`

```
descriptors := resolvePatternsToDescriptors(args)
for each:
    resolved := resolve(descriptor, {allowTags: true})
        null → UsageError `Failed to successfully resolve '<range>' to a valid <name> release`
    info := ensureInstalled(resolved)
    setLastKnownGood(resolved)
    collect info.location

output := --output ?? "./jup.tgz"      # §17.6 C9; corepack's default was corepack.tgz
tar.create({gzip: true, cwd: <installFolder>, file: resolve(output)},
           locations.map(l => relative(<installFolder>, l)))

if --json: stdout JSON.stringify(outputPath)
else:      human-readable log
```

Note `pack` **does** update last-known-good as a side effect. That is intentional:
you pack what you intend to run.

## 9.7 `cache clean` / `cache clear`

`rm -rf <home>/v1`, forced. No output. Both spellings are the same command (§07.9).

> **§15.35l requires output here** — a command that deletes things silently gives the
> user no way to tell a successful clean from a no-op.

## 9.8 `enable` / `disable`

See §10. Summary of the CLI contract:

```
enable  [--install-directory <path>] [...name]
disable [--install-directory <path>] [...name]
```

* With no names, the target set is **every tool with the `package-manager` role**,
  npm included, minus `--exclude` (§10.5 — corepack excludes npm, §15.16 reverses
  that, and §17.6 C5 is what confines the set to one role).
* Each name is validated: `Invalid package manager name '<name>'` for anything not in
  the supported set.
* Each name expands to all of its binary names across all range entries
  (`yarn` → `yarn`, `yarnpkg`).
* Both commands are idempotent and both exit 0 with empty stdout/stderr on success.

## 9.9 `--version`, `--help`

`--version` prints the tool's own version. `--help` / `-h` / `help` prints usage.
Both are ordinary management-mode commands and are shadowed by proxy mode — note
that `<tool> yarn --version` is a *proxy* invocation and prints **Yarn's** version.

`--help` is **scope-aware** (§17.6 C6): unscoped it lists both scopes, `jup pm --help`
and `corepack --help` list the package-manager surface, and the usage lines it prints
name the invoked binary and the scope in effect — `$ jup use <pattern>`,
`$ jup pm use <pattern>`, `$ corepack use <pattern>` (§12.1, §17.4 R12).

## 9.10 Deprecated commands

**`hydrate [--activate] <file>`** — the predecessor of `install -g <file>.tgz`. Same
archive handling, except:
* the format error reads `did it get generated by 'corepack prepare'?`
* there is no `.tgz` extension check on the argument
* it prints `All done!` on completion
* activation is opt-in (`--activate`) rather than opt-out (`--cache-only`)

**`prepare [--activate] [--all] [-o|--output [<path>]] [...spec]`** — the predecessor
of `pack` + `install -g`. Its "no spec in project" error omits the `devEngines`
mention: `The local project doesn't feature a 'packageManager' field - please specify
the package manager to pack, or update the manifest to reference it`. `--output`
tolerates a bare flag, defaulting to the same name `pack` uses (§17.6 C9).

## 9.11 Output stream discipline

| Content | Stream |
|---|---|
| `Adding … to the cache...`, `Installing …`, `Installing … in the project...` | stdout |
| `--json` output | stdout |
| Management-mode `Usage Error: …` + usage block | **stdout** |
| Validation warnings (`! Corepack validation warning: …`) | stderr |
| Auto-pin notice (`! The local project doesn't define …`) | stderr |
| Download prompt (`! Corepack is about to download …`) | stderr |
| Yarn Switch skip notice | stderr |
| Proxy-mode `UsageError` message | stderr |
| Everything the package manager prints | passthrough, unmodified |

A conforming implementation MUST NOT wrap, prefix, colourise, or buffer the package
manager's own output. `<tool> yarn --version` prints exactly `1.22.4\n` and nothing
else.
