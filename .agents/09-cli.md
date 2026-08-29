# 09 — Command Surface

This is the complete surface. Anything not here is out of scope (§01.7).

```
<tool> <binary>[@<version>] [...args]     proxy mode (§01.2)

<tool> cache clean [--all]
<tool> cache clear [--all]
<tool> disable [--install-directory <path>|--system] [...name]
<tool> enable  [--install-directory <path>|--system] [--force] [--exclude npm] [...name]
<tool> install
<tool> install -g|--global [--cache-only] [...name[@<version>] | <file>.tgz]
<tool> pack [--json] [-o|--output <path>] [...name[@<version>]]
<tool> self-install [--install-directory <path>|--system] [--force]
<tool> self-upgrade | upgrade [--install-directory <path>|--system] [--force]
<tool> up
<tool> use <name[@<version>]>
<tool> --version
<tool> --help | -h | help
```

Deprecated, retained for compatibility only:

```
<tool> hydrate [--activate] <file>
<tool> prepare [--activate] [--all] [-o|--output [<path>]] [...spec]
```

> A minimal re-implementation MAY omit `hydrate` and `prepare` entirely and print a
> pointer to `install -g` / `pack`. They are strict subsets of the modern commands.

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
`jup up` follow a declared range across majors (§09.4).

The exact messages retain the words `to pack`; §12 and conformance tests are
authoritative.

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
    → UsageError `The 'jup up' command can only be used when your project's
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

For a **declared range**, when the pin the project declares
holds one — in `packageManager`, or in `devEngines.packageManager.version` where
there is no top-level field — `up` refreshes the recorded
resolution in `jup.lock` and leaves that field alone — the range is the user's statement of intent, and there is no second,
major-confining resolve, because a range already says how far the user will move. A
dist-tag pin is still refused by the error above, and `COREPACK_FROZEN_LOCKFILE=1`
turns the refresh into a hard error.

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

So `jup use yarn@4` prints the banner, a blank line, then everything `yarn
install` prints. If `commands.use` is absent the command returns 0 immediately after
writing the pin — which is every `use` of a runtime (§02.3), so `jup use node@22`
writes `devEngines.runtime` (§03.7) and stops there.

When the pattern names a **semver range** — typed, so neither
a bare `jup use pnpm` nor a dist-tag counts — the range goes into the field as written
and the version it resolved to is recorded in `jup.lock` beside the manifest. Both
paths are printed, the digest goes to the recorded file rather than the field,
and `COREPACK_FROZEN_LOCKFILE=1` refuses the command *before* it resolves. Every other
pattern pins exactly, as below.

Notable behaviours, all test-asserted:

* An **existing malformed `packageManager` field** (a range, a bare name, a trailing
  `@`, a non-string) does not block `use` — it is simply overwritten. This is why
  spec parsing is lazy (§03.1).
* If no `package.json` exists anywhere, one is **created** at `cwd`.
* If the project root is an ancestor of `cwd`, the **ancestor's** manifest is updated.
* The written pin always carries a `sha512` hash computed from the actual downloaded
  bytes, regardless of what algorithm the input pattern used.
* Update every existing field that encodes the package-manager pin atomically and
  print each modified path. Do not create a top-level field that conflicts with an
  existing `devEngines.packageManager` declaration.
* A `devEngines` mismatch surfaces here through `writePin`'s check, which routes
  through `onFail` (§03.7). With the default `onFail`, the banner has *already* been
  printed to stdout, so the failure output is:
  ```
  Installing yarn@1.22.4 in the project...
  Usage Error: The requested version of yarn@1.22.4+sha512.… does not match the devEngines specification (yarn@2.x)

  $ jup use [--here] [--pin-style=suffix|sidecar] <pattern>
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

output := --output ?? "./jup.tgz"
tar.create({gzip: true, cwd: <installFolder>, file: resolve(output)},
           locations.map(l => relative(<installFolder>, l)))

if --json: stdout JSON.stringify(outputPath)
else:      human-readable log
```

Note `pack` **does** update last-known-good as a side effect. That is intentional:
you pack what you intend to run.

## 9.7 `cache clean` / `cache clear`

Both aliases use the cache-clean behavior and exact output defined in §07.9.

## 9.8 `enable` / `disable`

Syntax:

```
enable  [--install-directory <path> | --system] [--force] [--exclude npm] [...name]
disable [--install-directory <path> | --system] [...name]
```

§10 defines directory selection, validation, target expansion, ownership,
replacement, restoration, output, and idempotency.

## 9.9 `--version`, `--help`

`--version` prints the tool's own version. `--help` / `-h` / `help` prints usage.
Both are ordinary management-mode commands and are shadowed by proxy mode — note
that `<tool> yarn --version` is a *proxy* invocation and prints **Yarn's** version.

## 9.10 Deprecated commands

**`hydrate [--activate] <file>`** — the predecessor of `install -g <file>.tgz`. Same
archive handling, except:
* the format error reads `did it get generated by 'jup prepare'?`
* there is no `.tgz` extension check on the argument
* it prints `All done!` on completion
* activation is opt-in (`--activate`) rather than opt-out (`--cache-only`)

**`prepare [--activate] [--all] [-o|--output [<path>]] [...spec]`** — the predecessor
of `pack` + `install -g`. Its "no spec in project" error omits the `devEngines`
mention: `The local project doesn't feature a 'packageManager' field - please specify
the package manager to pack, or update the manifest to reference it`. `--output`
tolerates a bare flag, defaulting to `jup.tgz`.

## 9.11 Output stream discipline

| Content | Stream |
|---|---|
| `Adding … to the cache...`, `Installing …`, `Installing … in the project...` | stdout |
| `--json` output | stdout |
| Management-mode `Usage Error: …` + usage block | **stdout** |
| Validation warnings (`! jup validation warning: …`) | stderr |
| Auto-pin notice (`! The local project doesn't define …`) | stderr |
| Download prompt (`! jup is about to download …`) | stderr |
| Yarn Switch skip notice | stderr |
| Proxy-mode `UsageError` message | stderr |
| Everything the package manager prints | passthrough, unmodified |

A conforming implementation MUST NOT wrap, prefix, colourise, or buffer the package
manager's own output. `<tool> yarn --version` prints exactly `1.22.4\n` and nothing
else.

## 9.12 `self-install`

```
<tool> self-install [--install-directory <path>|--system] [--force]
```

Installs **the tool itself**: it copies the running installation into the store and
puts its own two names (§10.8) on `PATH`.

```
payload := the running installation — <root>/dist, <root>/bin, <root>/package.json
  a source checkout (no dist/ and no bin/) → UsageError naming what it looked for
version := the tool's own version
hash    := digest over the payload's (relative path, mode bit, bytes)

stdout: `Installing <tool>@<version>...\n`
unless readMarker(<home>/self/<version>).hash === hash:
    stage the payload in a temp directory, write its .jup marker, promote it
    an occupied <home>/self/<version> is renamed aside first and deleted after
stdout: `<tool> <version> -> <home>/self/<version>\n`

install the shims (§10.8) into §10.4's directory
stdout: `<names> -> <install directory>\n`      omitted when nothing was installed
verify the result is on PATH (§15.29)
```

It resolves nothing, opens no socket, and never reads the project: the bytes it
installs are the ones already running, which is the only way a command that installs
the tool can be run by the tool it installs. It does not touch
`lastKnownGood.json` — the tool is not a table entry.

Both halves are idempotent. An unchanged payload writes nothing to the store, and a
shim that is already correct is left alone (§10.2 property 4). The digest is what
makes the first of those true, and it is also what makes a *changed* payload at the
same version replace what is there — the case §07.5's promotion alone would treat as
a lost race.

The flags are §10.4's and §14.16's, with the meanings they have for `enable`.
`--force` is what takes a name another tool owns, which is what replacing a
Node-bundled `corepack` needs.

## 9.13 `self-upgrade` (also spelled `upgrade`)

```
<tool> self-upgrade [--install-directory <path>|--system] [--force]
```

§09.12 with the payload fetched from the registry instead of copied from the
running process. It is the only command that installs **the tool** from the network,
and the only one whose artifact is not a table entry.

```
version+digest := §04.5's `latest` lookup for the tool's own package
    signature-verified, release-age gated, and refused outright when it clears
    no verification tier (§15.11)
a version that is not semver → UsageError naming what the registry answered

stdout: `Installing <tool>@<version>...\n`
unless <home>/self/<version> holds a readable marker:
    metadata → tarball URL (§07.3), download prompt (§05.5),
    one pass: hash the stream while extracting it (§16.5, §07.4 strip 1)
    digest mismatch → discard the temp directory, install nothing (§06.2)
    the archive must contain dist/, bin/<cli entry> and bin/<shared stub>,
      otherwise UsageError — a registry publishing something else under our name
    grant the execute bit to those two files (§15.45)
    write the .jup marker, promote (§07.5), replacing as §09.12 replaces

<same as §09.12 from here>: announce, shim (§10.8), verify on PATH (§15.29)
```

Two differences from §09.12 are normative.

1. **The marker's `hash` is the artifact's digest**, as it is for every other
   download (§07.2) — not §09.12's digest over the copied payload. Nothing compares
   contents here: a complete marker for that version is what says the work is done,
   and it is what makes a second run cost one metadata request and no transfer.
2. **Nothing downloaded is rewritten.** The shims are linked at the *published*
   stub (§10.8's `verbatim` target); regenerating it from the running version's
   source would put an old stub in front of a new bundle. The one permitted edit is
   §15.46's shebang, and only under the condition that already governs it.

`upgrade` is an accepted spelling of the same command. It is deliberately not `up`,
which writes the project's `packageManager` field (§09.4); §12.1's usage line names
whichever word was typed.
