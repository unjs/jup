# 03 — Project Spec Discovery & Parsing

This stage answers: *"which version range of the requested tool does this directory
want?"* It touches the filesystem only, never the network.

Which manifest field carries the answer depends on the tool's `kind` (§02.3):
`packageManager` and `devEngines.packageManager` for a package manager,
`devEngines.runtime` for a runtime. Everything else in this file — the walk, the env
file, the parse, the reconciliation — is one code path over both.

A tool whose table entry declares a `versionFile` (§02.3) also checks that file.
A manifest wins; the version file answers only when no manifest field names
that tool.

## 3.1 The upward walk

Starting at `cwd`, walk toward the filesystem root. At each directory `d`:

1. Skip a package directory directly inside `node_modules`, including scoped
   packages. Do not skip its descendants.
2. Load the nearest eligible env file once (§3.2).
3. For a tool that declares `versionFile`, record the nearest such file. `ENOENT`
   means absent; other I/O errors propagate. It does not stop the walk.
4. Read `d/package.json`. `ENOENT` means continue; other I/O errors propagate.
   Invalid JSON or a non-object is fatal with the message in §12.2.
5. Stop at the nearest manifest that declares the field for the requested kind:
   either `packageManager` or `devEngines.packageManager` for a package manager,
   and `devEngines.runtime` for a runtime.

Stop at the filesystem root. If no manifest declares the relevant field, retain the
outermost manifest found as the mutation target and return `NoSpec`; return
`NoProject` only when no manifest was found. This makes stop conditions symmetric
and keeps a nested `devEngines` declaration from being bypassed by an ancestor.

### Version files

Step 3 is skipped entirely — no `stat`, no open — unless the requested tool's table
entry declares a `versionFile`, which no package manager does. A conforming
implementation MUST:

* look for it in the directories the walk visits anyway, keep the **first** (nearest)
  one found, and not let it stop the walk;
* skip it on a **mutating** walk. §3.7 writes the `devEngines` member and
  nothing else, so the file a command is about to edit is always the manifest, and an
  unreadable version file must not block the command that would replace it;
* skip it wherever the manifest would also be skipped — `COREPACK_ENABLE_PROJECT_SPEC=0`
  means "never look at the project at all" (§11.1), and that covers this too;
* use it **only** when the walk's result would otherwise be `NoSpec` or `NoProject`
  for the requested tool. A `Found` is never displaced: the `devEngines` member is
  jup's own field, and it is what a user edits to override a version file they are
  not free to delete.

When it is used, the result is a `Found` whose `target` is the version file's path,
with no `devEngines` declaration and `hasPin` false — nothing in it is a committed
pin. Because it is a `Found`, §3.6's auto-pin does not fire: the project has already
said what it wants.

The target being the version file has one visible consequence: a version file
carrying a **range** resolves through `jup.lock` like any other range, and
both that file and the memo in `node_modules` are looked for **beside the version
file** — `dirname(target)`, as for a manifest. In a monorepo that is next to the
`.nvmrc` that declared the range, not at the repository root. An exact version needs
no lockfile and writes none; a range writes only the memo; only `use` and `up` write the recorded file.

The contents are parsed **lazily**, exactly as `parseSpec` is: a version file that
cannot be read must fail the request that needed it, not the walk. Both failures are
errors and neither falls back to §3.5's default — a file written to be obeyed and not
obeyable is a mistake to report, not a reason to silently run something else.

#### `format: "nvm"`

The grammar of `.nvmrc`, as nvm itself reads it (`nvm_process_nvmrc_content`):

1. On each line, remove `#` and everything after it, then trim. Drop blank lines.
2. A line whose text before the first `=` is a non-empty **identifier**
   (`[A-Za-z_][\w.-]*`) is a `key=value` setting, and is **ignored** — those are
   nvm's own settings and jup has no counterpart for any of them. Ignoring rather
   than validating is deliberate: jup is not a linter for another tool's file, and
   rejecting an unrecognised key would break on nvm's next release.
3. Every other non-empty line is a candidate **version**. Exactly one MUST remain; a
   file with two, or with none, is an error.

> A setting requires a non-empty identifier before `=`. This leaves `>=18 <21` and
> the empty-key form `=20` as version lines accepted by §04.2.

The surviving line becomes the descriptor's `range`:

| Content | Range |
| --- | --- |
| `20`, `v20`, `20.10`, `v20.10.0`, `20.x`, `^20`, `>=18 <21` | itself, unchanged |
| `node`, `stable` | the `latest` dist-tag |
| anything else | error |

The first row is the whole point and is not a coincidence worth hiding: §04.2's
partial-version grammar accepts a leading `v`, so the numeric half of nvm's
vocabulary — which is the overwhelming majority of `.nvmrc` files — is *already* jup
range syntax. Ranges nvm would not understand are accepted too; the file is being
read by jup, and narrowing it to nvm's subset would be arbitrary.

The refusals are the rest of nvm's aliases, and they are refused for reasons rather
than for tidiness:

* `lts/*` and `lts/<codename>` have no data source. The `node` launcher package
  publishes `latest` and `v4-lts` … `v20-lts`, and the series tags stop there — so
  `lts/*` cannot be answered at all, and `lts/<codename>` would need a compiled-in
  codename-to-major table growing by one release per LTS line, which is the shape
  the accepted grammar deliberately refuses.
* `system` asks for a node jup did not install and cannot vouch for (§06). `iojs`,
  `default` and any user-defined alias name state in someone's `$NVM_DIR`, not a
  requirement of the project.

All of them take one message, which names the word and points at the `devEngines`
member — the field that can express what the alias meant (§12.12).

### Result type

```
NoProject { target: <cwd>/package.json, envFilePath? }   // no package.json anywhere
NoSpec    { target: <manifest path>,    envFilePath? }   // found a manifest, no spec
Found     { target, getSpec(opts), range?, envFilePath? }
```

`getSpec` is **lazy** — it is a closure that parses and validates the raw spec string
only when called. This matters: commands that don't need a valid spec (e.g.
`jup use`, which is about to overwrite it) must not fail on a malformed existing
`packageManager` field. A conforming implementation MUST defer spec *validation*
until the consumer asks for it.

`range` is populated only when `devEngines.packageManager.version` is present:
`{name, range: version, onFail}`.

## 3.2 Env file (`.jup.env`)

Before reading each directory's manifest, and only until one is found:

* Path = `resolve(d, JUP_ENV_FILE ?? ".jup.env")`. If `JUP_ENV_FILE` is unset and
  `resolve(d, ".jup.env")` is `ENOENT`, try `resolve(d, ".corepack.env")` — see
  *Legacy name* below.
* If `JUP_ENV_FILE === "0"` → env files are disabled entirely; skip.
* Parse as a dotenv-style file (Node's `util.parseEnv` semantics).
* **Filter**: keep only keys carrying one of the tool's two prefixes — `JUP_` or
  `COREPACK_` (§11.6). Everything else is dropped.
* **Merge**: `{...filteredFileVars, ...process.env}` — i.e. the **real environment
  wins**. A `.jup.env` value can only supply a variable the ambient environment
  has not set. "Has not set" means *neither* spelling of it (§11.6): a file's
  `JUP_HOME` must not out-rank a real `COREPACK_HOME`, which a plain key-wise merge
  would let it do, since the two keys do not collide and `JUP_` is the one that
  wins on read. Drop a file variable whose pair is present in the real
  environment, then merge.
* `ENOENT` → not an error, continue walking. Any other error → propagate.
* Only the **closest** env file is loaded; once one is found, no further directories
  are checked for env files (`!localEnv` guard).

### Supported fallback name

`.jup.env` is preferred and `.corepack.env` remains a supported fallback. Apply
§11.6's variable-name rules identically to either file; when both exist in a
directory, `.jup.env` wins.

* The fallback applies **only** when `JUP_ENV_FILE`/`COREPACK_ENV_FILE` is unset. An
  explicitly configured path is used as given, with no second candidate — naming a
  file that is not there is a mistake worth surfacing, not one worth papering over.
* A directory is decided by its **own** two candidates before the walk moves on. A
  parent's `.jup.env` MUST NOT out-rank a child's `.corepack.env`; the closest file
  wins whichever name it carries, because "closest" is the rule a user reasons with
  and the rename must not quietly change which file applies.
* Loading a `.corepack.env` is not a warning. It is a supported spelling, not a
  deprecation, and the walk is on the cold path of every run in a project that has
  no pin yet — a line printed there would be printed constantly.

The fallback costs one extra `openat` per walked directory when neither file exists
(§01.3). It is confined to the directory walk, which the exact-pin fast path already
stops at the first manifest.

Variables that MUST NOT be honoured from an env file, even though they carry a
prefix. The list is keyed by the `COREPACK_` spelling and a key MUST be
canonicalised to it before being checked (§11.6), so `JUP_ENV_FILE` is refused
exactly as `COREPACK_ENV_FILE` is — otherwise the deny-list is one rename away
from useless:

| Variable | Why |
|---|---|
| `COREPACK_ENV_FILE` | Chicken-and-egg: it selects the file being read. |
| `COREPACK_ENABLE_DOWNLOAD_PROMPT` | Its default depends on *how the tool was invoked*, which a project file must not be able to override — otherwise a repo could silently suppress the download confirmation. |

Treat project env files as untrusted. Filter before merging and reject unprefixed
proxy variables. Ignore and warn on every setting marked **no** in §11, after
canonicalizing its `JUP_`/`COREPACK_` name.

The merged environment replaces the process environment for the remainder of the run
(`process.env = localEnv.env`).

### `envOnly` mode

Commands that were given an explicit package-manager pattern on the CLI still need
the env file (for registry/auth settings) but not the manifest. In that mode the walk
loads the env file and stops as soon as it finds one, never reading manifests.

## 3.3 Parsing the manifest

Let `pm = manifest.packageManager` and `de = manifest.devEngines?.packageManager`.

### If `de` is absent or null
Result is `pm` (possibly `undefined`).

### If `de` is present
Validate in this exact order, because each failure has a different outcome:

| Check | Failure behaviour |
|---|---|
| `typeof de !== "object"` | **Always warn** (never throws, regardless of `onFail`), return `pm`.<br>`! jup only supports objects as valid value for devEngines.packageManager. The current value (<JSON>) will be ignored.` |
| `Array.isArray(de)` | **Always warn**, return `pm`.<br>`! jup does not currently support array values for devEngines.packageManager` |
| `typeof de.name !== "string"` or `de.name.includes("@")` | `warnOrThrow`, return `pm`.<br>`The value of devEngines.packageManager.name <JSON> is not a supported string value` |
| `de.version != null` and (not a string, or not a valid semver **range**) | `warnOrThrow`, return `pm`.<br>`The value of devEngines.packageManager.version <JSON> is not a valid semver range` |

Then, cross-check against `packageManager`:

* **If `pm` is set:**
  * `pm` does not start with `` `${de.name}@` `` → `warnOrThrow`:
    > `"packageManager" field is set to <JSON pm> which does not match the "devEngines.packageManager" field set to <JSON de.name>`
  * else if `de.version != null` and `pm.slice(de.name.length + 1)` does not
    `semver.satisfies` `de.version` → `warnOrThrow`:
    > `"packageManager" field is set to <JSON pm> which does not match the value defined in "devEngines.packageManager" for <JSON de.name> of <JSON de.version>`
  * Either way (after warning, if it didn't throw) → **return `pm`**. The
    `packageManager` field always wins when present.
* **If `pm` is absent:** return `` `${de.name}@${de.version ?? "*"}` ``.

### `warnOrThrow(message, onFail)`

```
onFail === "ignore"            → do nothing
onFail === "error" | undefined → throw UsageError(message)      (exit 1)
anything else (incl. "warn")   → console.warn(`! jup validation warning: ${message}`)
```

> Note the default is **error**, and any unrecognised `onFail` value degrades to a
> warning rather than being rejected. Both MUST be preserved.

`<JSON x>` denotes `JSON.stringify(x)` — so strings appear quoted in the message.

### Runtimes read `devEngines.runtime`

Everything above describes a **package manager** — the `kind` §02.3 gives an entry by
default, and the only kind that existed before jup managed anything else. When the
requested tool is a `kind: "runtime"` entry, the manifest speaks through exactly one
field, and the rules collapse accordingly:

* the spec is `devEngines.runtime`. There is no top-level equivalent, `pm` is not
  consulted, and none of the cross-checks against it run — the two members describe
  different tools and cannot disagree.
* validation is the table above with `packageManager` replaced by `runtime`
  throughout, in the checks and in the messages: `de.name` must be a string not
  containing `@`; `de.version`, when present, must be a valid semver **range**;
  failures route through the same `warnOrThrow`.
* the result is `` `${de.name}@${de.version ?? "*"}` `` — the `pm`-absent branch,
  which is the only branch a runtime has.
* `devEngines.runtime` absent, or naming a different tool, yields `NoSpec` for this
  request — and that is the outcome a declared version file may then answer, for an
  entry that declares one. Failing that, §03.5 falls back exactly as it does for a
  package manager in an unpinned project.

A manifest may declare both members. They are read independently and neither
constrains the other, so a pnpm project that also pins `node` is one manifest with
two answers rather than a conflict.

## 3.4 Parsing a spec string

`parseSpec(raw, source, {enforceExactVersion})` → `Descriptor`.

`source` is a human-readable origin used in messages: either
`` `CLI arguments` `` or the manifest path **relative to the initial cwd**.

```
1. typeof raw !== "string"
     → UsageError: `Invalid package manager specification in ${source}; expected a string`

2. atIndex = raw.indexOf("@")
   if atIndex === -1 || atIndex === raw.length - 1:        // "yarn" or "yarn@"
       if enforceExactVersion:
           → UsageError: `No version specified for ${raw} in "packageManager" of ${source}`
       name = (atIndex === -1) ? raw : raw.slice(0, -1)
       if !isSupportedPackageManager(name):
           → UsageError: `Unsupported package manager specification (${name})`
       → { name, range: "*" }

3. name  = raw.slice(0, atIndex)
   range = raw.slice(atIndex + 1)

4. if range is NOT a parseable URL:
       if enforceExactVersion and range is not a valid exact semver version:
           → UsageError: `Invalid package manager specification in ${source} (${raw}); expected a semver version`
           (when enforceExactVersion is false the message ends
            `; expected a semver version, range, or tag` — but that branch is
            unreachable because the check is guarded by enforceExactVersion)
       if !isSupportedPackageManager(name):
           → UsageError: `Unsupported package manager specification (${raw})`
   else (range IS a URL):
       if isSupportedPackageManager(name) and COREPACK_ENABLE_UNSAFE_CUSTOM_URLS !== "1":
           → UsageError: `Illegal use of URL for known package manager. Instead, select a specific version, or set COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=1 in your environment (${raw})`

5. → { name, range }
```

Note that `name` is the substring before the **first** `@`. `@scope/pkg@1.0.0` yields
`name = ""`, which fails the supported-package-manager check.

### a runtime is never a `packageManager` value

When the string being parsed came from a manifest's `packageManager` field, a `name`
whose table entry declares `kind: "runtime"` (§02.3) is a UsageError:

> `"packageManager" cannot name <name>: it is a runtime, not a package manager - declare it in "devEngines.runtime" instead`

The check is on the **field**, not on `parseSpec` in general. `jup node@22`,
`jup use node@22` and `jup install -g node@24` all put a runtime name through this
same function with `source = CLI arguments`, and all three are ordinary. It is only
the committed pin that must not claim a runtime is the project's package manager,
because that is the field §03.5 enforces `pnpm` and `yarn` with.

`enforceExactVersion` is:
* **`true`** when reading `packageManager` from a manifest in proxy mode with no CLI
  version override — the field is a *pin* and must be exact.
* **`false`** when parsing CLI patterns (`jup use yarn@^4`) and when a CLI
  version override is present.

## 3.5 Reconciliation with the requested binary

Input: the discovered spec result, the fallback locator (§04.5), and two flags:
`transparent` (§01.4) and `binaryVersion`.

```
if COREPACK_ENABLE_PROJECT_SPEC === "0":
    → fallbackDescriptor          # never look at the project at all
if COREPACK_ENABLE_STRICT === "0":
    transparent = true            # downgrade mismatches from error to fallback

switch (specResult.type):
  NoProject → fallbackDescriptor
  NoSpec    → if COREPACK_ENABLE_AUTO_PIN === "1": pin it (§3.6)
              fallbackDescriptor
  Found     → spec = getSpec({enforceExactVersion: !binaryVersion})
              if spec.name !== requestedName:
                  transparent ? fallbackDescriptor
                              : UsageError(
                                  `This project is configured to use ${spec.name} because ${target} has a "packageManager" field`)
              else → spec
```

**a version file arrives here as a `Found`.** It is resolved during
discovery (§3.1), not here: by the time reconciliation runs, a version file that
spoke has already become the spec result, so this table is unchanged and the name
mismatch it guards cannot arise (the name comes from the entry that declared the
file). The `NoSpec` branch — and with it auto-pin — is reached only when the version
file was absent, unreadable, or not looked for.

**the spec being reconciled is the one for the requested tool.**
`specResult` is what §03.1 and §03.3 produced *for this request*: the
`packageManager` / `devEngines.packageManager` pair when the requested name is a
package manager, `devEngines.runtime` when it is a runtime. A project's
package-manager pin is therefore never a reason to refuse a runtime, and the `Found`
branch's name mismatch cannot arise across kinds: `jup node` in a pnpm-pinned project
resolves node, and `jup pnpm` in that project is unaffected by a `devEngines.runtime`
declared beside the pin. Within a kind the rule is unchanged — `jup deno` in a
pnpm-pinned project is still the mismatch it always was, because both are package
managers.

Then, unconditionally: **if `binaryVersion` was given on the CLI, it overwrites
`descriptor.range`.** This is why `jup yarn@1.22.4 --version` works inside a
project pinned to Yarn 4 — but note that the *name* still has to match, so
`jup pnpm@9 install` in a Yarn project still errors.

> With `COREPACK_ENABLE_STRICT=0`, using a *different* package manager than the project's falls back to
> the system-wide default version of that other package manager, while using the
> project's *own* package manager still honours the pinned version.

## 3.6 Auto-pin (`COREPACK_ENABLE_AUTO_PIN=1`)

Only in the `NoSpec` case, only in proxy mode, and — per only for a package
manager. Its notice is verbatim about the `packageManager` field, and writing a
runtime into a project nobody asked to pin a runtime in is a larger claim than
recording which package manager a project already uses.

1. Resolve the fallback descriptor to a locator (tags allowed).
   * `null` → `Failed to successfully resolve '<range>' to a valid <name> release`
2. Install it (§07) — this yields the hash, so the written pin is hash-bearing.
3. Emit to **stderr**, verbatim, then a blank line:
   ```
   ! The local project doesn't define a 'packageManager' field. jup will now add one referencing <name>@<reference>.
   ! For more details about this field, consult the documentation at https://nodejs.org/api/packages.html#packagemanager
   ```
4. Write the pin into `dirname(specResult.target)`'s `package.json` (§3.7).

## 3.7 Writing the pin

`setLocalPackageManager(cwd, info)`:

For a `kind: "runtime"` locator the steps below read `devEngines.runtime` in
place of the `packageManager` field: step 2's check and step 6's `previousPackageManager`
come from that member, and step 7 sets `devEngines.runtime.version` to the resolved
`reference` — creating the member if absent — instead of a top-level field. Nothing
else changes; a runtime pin is stored only in `devEngines.runtime`.

1. Re-run the discovery walk from `cwd`.
2. If a `devEngines.packageManager.version` range was found, check the version being
   pinned against it; on mismatch `warnOrThrow` with that entry's `onFail`:
   > `The requested version of <name>@<reference> does not match the devEngines specification (<name>@<range>)`
3. Read the target file's current bytes (empty string if `NoProject`).
4. Parse, **stripping a UTF-8 BOM** if present; empty content parses as `{}`.
5. Detect indentation: the first `/^[ \t]+/m` match in the original content, else two
   spaces. **This preserves tabs-vs-spaces.**
6. `previousPackageManager` = existing `packageManager`, else
   `` `${range.name}@${range.range}` `` if a devEngines range exists, else the literal
   string `unknown`.
7. Set `data.packageManager = `${name}@${reference}`` where `reference` **includes**
   the freshly computed hash suffix.
8. Serialise with `JSON.stringify(data, null, indent)` + `"\n"`, then **normalise line
   endings to match the original file**: count `\r\n` vs bare `\n` in the original; if
   CRLF strictly outnumbers LF use `\r\n`, else `\n`. If the original had no newlines
   at all, use the platform EOL.
9. Write to `lookup.target`. In the `NoProject` case that path is
   `<cwd>/package.json`, so an empty directory gets a new manifest.

Returns `{previousPackageManager}`, which the caller exports as
`COREPACK_MIGRATE_FROM` before running the package manager's `use` command (§09.5).

> **Note.** The BOM is stripped for parsing and is not re-emitted, so a file that had
> a BOM loses it.
