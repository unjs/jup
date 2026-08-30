# 03 — Project Discovery, Parsing & Pin Writing

This stage answers *"which version range of the requested tool does this
directory want?"* It touches the filesystem only, never the network.

Which manifest field carries the answer depends on the tool's `kind` (§02.3):
`packageManager` and `devEngines.packageManager` for a package manager,
`devEngines.runtime` for a runtime. Everything else — the walk, the env file, the
parse, the reconciliation — is one code path over both.

## 3.1 The upward walk

From `cwd` toward the filesystem root. At each directory `d`:

1. Skip a package directory directly inside `node_modules`, scoped packages
   included. Descendants are not skipped.
2. Load the nearest eligible env file, once (§3.2).
3. For a tool declaring a `versionFile`, record the nearest such file. `ENOENT`
   means absent; other I/O errors propagate. It does not stop the walk.
4. Read `d/package.json`. `ENOENT` continues; other I/O errors propagate.
   Invalid JSON or a non-object is fatal (§12).
5. Stop at the nearest manifest that **declares the field for the requested
   kind** — key presence, even with an invalid value, so validation happens at
   the manifest that declared it.

If no manifest declares the field, keep the **outermost** manifest found as the
mutation target and return `NoSpec`; return `NoProject` only when no manifest was
found anywhere. So in a monorepo with no declaration, `NoSpec` targets the root.

### Result type

```
NoProject { target: <cwd>/package.json, envFilePath? }
NoSpec    { target: <manifest path>,    envFilePath? }
Found     { target, getSpec(opts), range?, devEngines?, hasPin, envFilePath? }
```

`getSpec` is **lazy** — a closure that parses and validates the raw spec only
when called. Commands that do not need a valid spec (`use`, about to overwrite
it) must not fail on a malformed existing `packageManager`. `range` is populated
only when `devEngines.…​.version` is present.

### Walk modes

| Mode | Effect |
|---|---|
| default (proxy read) | as above |
| `envOnly` | load the env file and stop; never read manifests. For commands given an explicit pattern on the CLI, which still need registry/auth settings |
| `mutating` | additionally stop at a **workspace root** — a manifest with `workspaces`, or a directory with `pnpm-workspace.yaml` — and never climb past it. Skip the version file entirely |
| `here` | select `cwd`'s own manifest and nothing else (`--here`) |
| `projectSpecFlag` | honour `JUP_ENABLE_PROJECT_SPEC=0` by degrading to `envOnly` the moment the flag is seen, so a broken manifest cannot defeat the escape hatch users reach for *because* their manifest is broken |

The `workspaces` field is requested only on a mutating walk: it is often a large
array, and the warm path must keep answering a two-field question.

`JUP_SPEC_FILE` replaces the manifest's two fields with those of an external file
in `package.json` shape, resolved against the initial cwd. A missing file is an
error, not a fallback — quietly reverting to the manifest on a typo would run the
package manager the variable was set to override.

### Version files

Step 3 is skipped entirely — no `stat`, no open — unless the requested tool's
entry declares a `versionFile`, which no package manager does. The nearest file
found wins, it never stops the walk, and it is used **only** when the walk's
result would otherwise be `NoSpec` or `NoProject` for the requested tool. A
`Found` is never displaced: `devEngines.runtime` is jup's own field, and it is
what a user edits to override a version file they are not free to delete.

When it speaks, the result is a `Found` whose `target` is the version file's
path, with no `devEngines` declaration and `hasPin` false — nothing in it is a
committed pin, so §3.6's auto-pin does not fire and §04.4 treats it as a
synthesised spec. One visible consequence: a version file carrying a **range**
resolves through `jup.lock` like any other range, and both that file and the memo
are looked for beside the version file (`dirname(target)`). In a monorepo that is
next to the `.nvmrc` that declared the range, not at the repository root.

Contents are parsed **lazily**, as `getSpec` is: a version file that cannot be
read fails the request that needed it, not the walk. Both failures are errors and
neither falls back to §3.5's default — a file written to be obeyed and not
obeyable is a mistake to report, not a reason to silently run something else.

#### `format: "nvm"`

The grammar of `.nvmrc`, as nvm reads it:

1. On each line, remove `#` and everything after it, then trim. Drop blanks.
2. A line whose text before the first `=` is a non-empty identifier
   (`[A-Za-z_][\w.-]*`) is a `key=value` setting and is **ignored** — those are
   nvm's own settings, jup has no counterpart for any of them, and rejecting an
   unrecognised key would break on nvm's next release.
3. Exactly one other non-empty line must remain; it is the version.

The requirement of a real identifier before `=` is what keeps `>=18 <21` and the
empty-key form `=20` on the version side.

| Content | Range |
|---|---|
| `20`, `v20`, `20.10`, `20.x`, `^20`, `>=18 <21` | itself, unchanged |
| `node`, `stable` | the `latest` dist-tag |
| anything else | error |

The first row needs no translation: §04.2's partial-version grammar already
accepts a leading `v`, so the numeric half of nvm's vocabulary — the overwhelming
majority of `.nvmrc` files — is already jup range syntax.

The refusals are the rest of nvm's aliases. `lts/*` and `lts/<codename>` have no
data source: the launcher package's series tags stop short of the current LTS
line, and a codename table would grow by one entry per LTS release. `system`
asks for a node jup did not install and cannot vouch for; `iojs`, `default` and
user-defined aliases name state in someone's `$NVM_DIR`, not a requirement of the
project. All take one message naming the word and pointing at `devEngines.runtime`
— the field that can express what the alias meant.

## 3.2 Env file (`.jup.env`)

Before reading each directory's manifest, until one is found:

* Path is `resolve(d, JUP_ENV_FILE ?? ".jup.env")`. With `JUP_ENV_FILE` unset and
  `.jup.env` absent, try `.corepack.env` in the **same** directory.
* `JUP_ENV_FILE=0` disables env files entirely.
* Parse as dotenv (matching Node's `util.parseEnv`; jup has its own parser to
  keep `node:util` off the warm path, and differential tests hold the two
  together).
* **Filter** to keys carrying `JUP_` or `COREPACK_`. Everything else is dropped.
  This prefix filter is the entire sandbox against a hostile repository.
* **Merge** as `{...fileVars, ...process.env}` — the real environment wins.
  For a setting in §11.7's compatibility set, "has not set" means *neither*
  spelling: drop a file variable whose pair is present in the real environment
  before merging, or a file's `JUP_HOME` would out-rank a real `COREPACK_HOME`.
  Outside that set only the `JUP_` spelling is read, so only it can shadow — a
  real `COREPACK_CAFILE` names nothing jup consults and MUST NOT displace a
  file's `JUP_CAFILE`. The prefix filter above still admits both spellings, and
  §11.8's deny list still refuses both, because a merged variable is inherited
  by every child process whether or not jup itself reads it.
* `ENOENT` continues the walk; any other error propagates.
* Only the **closest** file is loaded, and the search stops at the **project
  boundary** — a directory holding a `package.json` or a `.git` entry. Config
  above the project belongs to another project.
* Anything *under* a `node_modules` is skipped for the env-file step, not just a
  package directory: a dependency that cannot supply a `packageManager` from
  `node_modules/evil` could otherwise supply a whole environment from
  `node_modules/evil/src/.jup.env`.

The merged environment replaces the process environment for the rest of the run.

### The `.corepack.env` fallback

A supported spelling, not a deprecation, so loading one prints nothing. It
applies only when `JUP_ENV_FILE`/`COREPACK_ENV_FILE` is unset; an explicitly
configured path is used as given, with no second candidate. A directory is
decided by its **own** two candidates before the walk moves on, so a parent's
`.jup.env` never out-ranks a child's `.corepack.env` — closest wins whichever
name it carries. The cost is one extra `openat` per walked directory when neither
file exists.

### Variables an env file may never supply

Keys are canonicalised to their `COREPACK_` spelling before the check, so
`JUP_ENV_FILE` is refused exactly as `COREPACK_ENV_FILE` is — otherwise the deny
list would be one rename away from useless. §11 marks each variable's
eligibility; the ineligible ones are those that select the file being read,
configure credentials or trust, weaken TLS, or nominate a location code is loaded
and run from. A denied *security* variable warns (§12); a denied compatibility
variable is silently ignored.

## 3.3 Parsing the manifest

Let `pm = manifest.packageManager` and `de = manifest.devEngines.packageManager`
(or `.runtime` for a runtime, with the member name substituted throughout).

**If `de` is absent or null** the result is `pm`.

**If `de` is present**, validate in this order — each failure has a different
outcome:

| Check | On failure |
|---|---|
| not an object | **always warn**, regardless of `onFail`; return `pm` |
| an array | **always warn**; return `pm` |
| `name` not a string, or contains `@` | `warnOrThrow`; return `pm` |
| `version` present and not a valid semver **range** | `warnOrThrow`; return `pm` |
| `integrity` present and not a usable SRI string | `warnOrThrow`; ignore it |

Then cross-check against `packageManager`:

* **`pm` set:** if it does not start with `` `${de.name}@` ``, or `de.version` is
  set and the pinned version does not `satisfies` it (**strict** semver here),
  `warnOrThrow`. Either way the answer is decided by `de.version`, not by the
  warning: return `` `${de.name}@${de.version}` `` when it is set, else `pm`.
* **`pm` absent:** return `` `${de.name}@${de.version ?? "*"}` ``.

**A valid `de` naming a version wins over `packageManager`.** It is the richer
declaration — name, range, `onFail` and a sidecar digest against one string — so
it is the field jup treats as the pin and the field §3.7 writes. The two shapes
that still fall back to `pm` fall back because `de` has not answered the
question: a member failing any validation above is not a declaration at all, and
a member carrying no `version` names the tool without naming the release, where
`pm` is strictly more specific. The cross-checks still run and still report a
disagreement through `onFail`; they no longer pick the winner.

`ProjectSpec` carries which field the returned spec actually came from, because
§3.4's runtime refusal is about the `packageManager` *field* and a spec read out
of `de` did not come from it.

A `devEngines.packageManager.integrity` is folded into the returned spec string
as a build suffix (§3.7's sidecar form). If both spellings are present and
disagree, that is a `warnOrThrow`.

```
warnOrThrow(message, onFail):
  "ignore"              → nothing
  "error" | undefined   → throw UsageError (exit 1)
  anything else         → warn `⚠ jup validation warning: <message>`
```

The default is **error**, and an unrecognised value degrades to a warning. That
is an inconsistent enum inherited from corepack; it is currently load-bearing for
compatibility, and changing it is a deliberate decision, not a cleanup.

### Runtimes

A `kind: "runtime"` request reads `devEngines.runtime` and nothing else. `pm` is
not consulted and none of the cross-checks run — the two members describe
different tools and cannot disagree. The result is always the `pm`-absent branch.
An absent member, or one naming a different tool, yields `NoSpec`, which a
declared version file may then answer, and failing that §3.5's fallback.

## 3.4 Parsing a spec string

`parseSpec(raw, {source, requireVersion, packageManagerField})` → `Spec`. Every
option is optional: `source` names the input in §12's messages and defaults to
`CLI arguments` — the alternative is the manifest path relative to the initial
cwd — and `requireVersion` defaults to `false`.

```
1. not a string                       → "expected a string"
2. no "@", or a trailing "@":
     requireVersion                   → "No version specified for …"
     name unsupported                 → "Unsupported package manager specification (<name>)"
     → { name, range: "*" }
3. split at the FIRST "@"
4. range is not a URL:
     requireVersion and not an exact version → "expected a semver version"
     name unsupported                        → "Unsupported package manager specification (<raw>)"
   range IS a URL:
     known name and JUP_ENABLE_UNSAFE_CUSTOM_URLS != 1 → "Illegal use of URL …"
5. → { name, range }
```

A name must also be usable as a store directory segment: the npm package-name
shape, minus `\`, `:`, control characters, and the dot segments. A name reaches
the filesystem verbatim in `join(installFolder, name)`.

`requireVersion` is **true** only when reading `packageManager` from a manifest in
proxy mode with no CLI version override — the field is a pin and must be exact.
It is false for CLI patterns (`jup use yarn@^4`) and when a version override is
present.

### A runtime is never a `packageManager` value

When the string came from a manifest's `packageManager` field, a name whose entry
declares `kind: "runtime"` is a UsageError pointing at `devEngines.runtime`. The
check is on the **field**, not on `parseSpec` in general: `jup node@22`,
`jup use node@22` and `jup cache install -g node@24` all pass a runtime name through
the same parser from `CLI arguments` and are ordinary. Only the committed pin must
not claim a runtime is the project's package manager, because that is the field
§3.5 enforces.

## 3.5 Reconciliation

Input: the spec result, the fallback locator (§04.6), and two flags —
`transparent` (§01.4) and `binaryVersion`.

```
JUP_ENABLE_PROJECT_SPEC=0 → fallback            # never look at the project
JUP_ENABLE_STRICT=0       → transparent = true  # mismatch falls back instead of erroring

NoProject → fallback
NoSpec    → auto-pin if enabled (§3.6); fallback
Found     → spec = getSpec({requireVersion: !binaryVersion})
            name mismatch → transparent ? fallback
                                        : UsageError "This project is configured to use …"
            else spec
```

Then, unconditionally: **a CLI `binaryVersion` overwrites `descriptor.range`.**
This is why `jup yarn@1.22.4 --version` works in a Yarn-4 project — but the
*name* still has to match, so `jup pnpm@9 install` there is still an error.

The spec being reconciled is the one **for the requested tool**, so a project's
package-manager pin is never a reason to refuse a runtime: `jup node` in a
pnpm-pinned project resolves node, and a `devEngines.runtime` beside that pin does
not affect `jup pnpm`. Within a kind the rule is unchanged — `jup deno` in a
pnpm-pinned project is still a mismatch.

A version file arrives here as a `Found`, resolved during discovery, so the name
mismatch cannot arise for it (the name comes from the entry that declared the
file). The `NoSpec` branch, and with it auto-pin, is reached only when the version
file was absent, unreadable, or not looked for.

With `JUP_ENABLE_STRICT=0`, invoking a *different* package manager falls back to
that tool's global default, while invoking the project's *own* still honours the
pin.

## 3.6 Auto-pin (`JUP_ENABLE_AUTO_PIN=1`)

Only on `NoSpec`, only in proxy mode, and only for a package manager — writing a
runtime into a project nobody asked to pin one is a larger claim than recording
which package manager a project already uses.

1. Resolve the fallback descriptor (tags allowed).
2. Install it — this is what produces the hash, so the written pin is
   hash-bearing and therefore verifiable on every later run.
3. Print the two-line notice to **stderr**, then a blank line (§12).
4. Write the pin beside `specResult.target`'s manifest (§3.7), then print the
   `Updated …` line, also on stderr: stdout belongs to the package manager.

## 3.7 Writing the pin

`writePin(cwd, info, {here, integrity})`:

1. Re-run discovery in `mutating` mode from `cwd` — the file to edit is not
   necessarily in `cwd`, and the workspace stop and `--here` apply here and only
   here, because this is the write.
2. Read the target's current bytes (empty for `NoProject`, which creates the
   file), parse tolerantly, stripping a UTF-8 BOM.
3. Validate against any `devEngines` declaration, **against the state being
   written** rather than the state on disk: a declared name that differs from the
   pin, or a version outside a declared range that this write does not itself
   replace, goes through `warnOrThrow` with that entry's `onFail`.
4. Edit surgically and write atomically.

### Which field is written

The pin goes to `devEngines` — the field §3.3 reads first, and the only one that
can carry a name, a version and a digest together.

| Manifest declares | Written |
|---|---|
| neither field | `devEngines.packageManager`, created |
| `devEngines.packageManager` for this tool, no `packageManager` | `devEngines.packageManager.version` (+ `integrity`) |
| `packageManager` only | `devEngines.packageManager`, created; `packageManager` refreshed |
| both, for this tool | both refreshed |
| `devEngines.packageManager` for a *different* tool | `packageManager`; the mismatch reported |
| the pin is a **runtime** | `devEngines.runtime`, created if absent |

Rows one and two write one field because that is the whole pin: §3.3 reads the
member, and a second, thinner copy in `packageManager` states nothing the member
does not. Rows three and four refresh the top-level field only because it is
already there — a `packageManager` left holding the version before last is a
false statement about what will run, to jup and to every tool that reads only
that field. No `packageManager` is ever **created**.

A declared **range is replaced**, not preserved. While `packageManager` carried
the pin and won the read, `1.x || 2.x` beside it was a statement of intent worth
keeping; now that the member is the pin, leaving the range there would mean
`jup use pnpm@1.9.0` resolved `1.x` on the next run and the pin never took.
§9.4's cross-major `up` is unaffected: it refreshes `jup.lock` and does not write
a pin when the descriptor is a range. Step 3's version cross-check still guards
the declared constraint, since only an *exact* declared version counts as
"replaced by this write".

When the declared name is a *different* package manager, `devEngines` is not
describing this pin at all: the mismatch is reported through `onFail` and, if
that does not throw, the pin goes to `packageManager` where a reader can still
see both statements — the one case where the top-level field is still the pin's
only home.

A runtime has exactly one home, so the question of refreshing a second field
does not arise.

### Where the digest goes

| Field written | Digest |
|---|---|
| `devEngines.<member>` | `integrity`, as SRI, beside a clean semver `version` |
| `packageManager` | `<version>+<algo>.<hex>` in the string itself |

The field decides where the digest goes. A `devEngines` version is a semver
*range*, so its digest goes in `integrity`. The top-level string has no separate
key, so its digest stays in the version suffix. Both forms are read the same way
(§3.3). If `integrity` cannot be edited, the version keeps the suffix so the pin
is still written.

`--no-integrity` (§09) writes no digest and removes any existing digest from
either field. This removes §06.1's explicit-hash check. The download is still
checked with its signature.

A **range** pin (`jup use pnpm@^11`) puts the range in the field and the resolved
version in `jup.lock` (§04.4); no digest reaches the manifest, because the field
holds no version for one to describe. A **per-host** locator never contributes a
digest to the manifest either (§02.4).

### Formatting

Indentation is the first `/^[ \t]+/m` match in the original, else two spaces, so
tabs survive. Line endings match the original: CRLF if `\r\n` strictly outnumbers
bare `\n`, else `\n`, else the platform EOL. Key order, the BOM and untouched
whitespace are preserved by editing spans rather than re-serialising the whole
document.

The write is temp-then-rename in the manifest's own directory: a truncating write
interrupted by Ctrl-C or a full disk leaves the user's `package.json` empty, and
that is a source file, not a cache entry. The temp file is opened `O_EXCL` under
an unguessable name so a planted symlink is not written through, and a symlinked
`package.json` is resolved first so the rename replaces the file rather than the
link. The mode is carried across.

`writePin` returns the previous pin value, in §3.3's order — the `devEngines`
spec where it named a version, else the existing `packageManager`, else the
`devEngines` spec, else the literal string `unknown` — which the caller exports as
`JUP_MIGRATE_FROM` before running the package manager's `use` command (§09.5).
Every mutating command prints each path it changed.
