# 03 — Project Spec Discovery & Parsing

This stage answers: *"which package manager, at which version range, does this
directory want?"* It touches the filesystem only, never the network.

## 3.1 The upward walk

Starting at `cwd`, walk toward the filesystem root. At each directory `d`:

1. **Skip** `d` entirely (for manifest purposes) if `d` matches
   `/[\\/]node_modules[\\/](@[^\\/]*[\\/])?([^@\\/][^\\/]*)$/` — i.e. `d` is a
   package directory *inside* a `node_modules`. This prevents a dependency's own
   `packageManager` field from hijacking the host project. Note the regex matches
   only the *last* segment pair, so `…/node_modules/foo/src` is **not** skipped;
   only `…/node_modules/foo` and `…/node_modules/@scope/foo` are.
2. If no env file has been loaded yet and env files are enabled, attempt to load one
   from `d` (§3.2).
3. Read `d/package.json`.
   * `ENOENT` → continue to parent.
   * Any other I/O error → propagate.
   * Content parses to a non-object or fails to parse → **fatal**:
     > `Invalid package.json in <path relative to d>`
   * Otherwise → record it as the *selection* and stop walking **iff** it has a
     `packageManager` key.

The loop condition is `while (nextCwd !== currCwd && (!selection || !selection.data.packageManager))`.

> **Defect — see §15.25.** Only `packageManager` stops the walk. A nested manifest
> declaring *only* `devEngines.packageManager` does **not**, so the walk climbs past it
> and a parent's spec (or the global default) silently wins. §15.25 requires both
> fields to be stop conditions; the description below records corepack's current
> behaviour.

Two consequences a re-implementation MUST reproduce:

* The walk terminates at the root (when `dirname(d) === d`).
* A `package.json` **without** `packageManager` does **not** stop the walk. The tool
  keeps climbing, and a *later* (more distant) ancestor that does declare
  `packageManager` wins. But the *last* manifest seen is what gets recorded — so in a
  monorepo where `packages/app/package.json` has no `packageManager` and the root
  does, the root is selected. If **no** ancestor declares it, the selection is the
  outermost `package.json` found, and the result is `NoSpec` pointing at that file.

> **Consequence worth knowing.** In a monorepo where neither `packages/app/package.json`
> nor the root manifest declares `packageManager`, running from `packages/app` yields
> `NoSpec` targeting the **root** manifest — so auto-pin (§3.6) and `corepack use`
> write the pin at the repository root, not next to the package you were standing in.
> That is usually the right answer for a monorepo, but it is surprising and
> undocumented. A conforming implementation MUST reproduce it, and SHOULD name the
> file it is about to modify in the auto-pin notice.

### Result type

```
NoProject { target: <cwd>/package.json, envFilePath? }   // no package.json anywhere
NoSpec    { target: <manifest path>,    envFilePath? }   // found a manifest, no spec
Found     { target, getSpec(opts), range?, envFilePath? }
```

`getSpec` is **lazy** — it is a closure that parses and validates the raw spec string
only when called. This matters: commands that don't need a valid spec (e.g.
`corepack use`, which is about to overwrite it) must not fail on a malformed existing
`packageManager` field. A conforming implementation MUST defer spec *validation*
until the consumer asks for it.

`range` is populated only when `devEngines.packageManager.version` is present:
`{name, range: version, onFail}`.

## 3.2 Env file (`.corepack.env`)

Before reading each directory's manifest, and only until one is found:

* Path = `resolve(d, COREPACK_ENV_FILE ?? ".corepack.env")`.
* If `COREPACK_ENV_FILE === "0"` → env files are disabled entirely; skip.
* Parse as a dotenv-style file (Node's `util.parseEnv` semantics).
* **Filter**: keep only keys with the prefix `COREPACK_`. Everything else is dropped.
* **Merge**: `{...filteredFileVars, ...process.env}` — i.e. the **real environment
  wins**. A `.corepack.env` value can only supply a variable the ambient environment
  has not set.
* `ENOENT` → not an error, continue walking. Any other error → propagate.
* Only the **closest** env file is loaded; once one is found, no further directories
  are checked for env files (`!localEnv` guard). *(This is the behaviour of commit
  `70bb9c5`/#891 "only load closest env file, for every commands".)*

Variables that MUST NOT be honoured from an env file, even though they carry the
prefix:

| Variable | Why |
|---|---|
| `COREPACK_ENV_FILE` | Chicken-and-egg: it selects the file being read. |
| `COREPACK_ENABLE_DOWNLOAD_PROMPT` | Its default depends on *how the tool was invoked*, which a project file must not be able to override — otherwise a repo could silently suppress the download confirmation. |

> **Security note.** The env file is read from directories the tool walks, which in a
> `cd`-into-untrusted-repo scenario is attacker-controlled. The `COREPACK_` prefix
> filter is the whole sandbox. A conforming implementation MUST apply the filter
> before merging, and MUST NOT allow the file to set proxy/registry variables that
> are not `COREPACK_`-prefixed (`HTTP_PROXY` etc. are therefore *not* settable this
> way — correct, and MUST be preserved).
>
> **See §14.5** — this spec additionally recommends refusing to honour
> `COREPACK_ENABLE_UNSAFE_CUSTOM_URLS`, `COREPACK_INTEGRITY_KEYS`, and
> `COREPACK_NPM_TOKEN` from an env file, which corepack currently permits.

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
| `typeof de !== "object"` | **Always warn** (never throws, regardless of `onFail`), return `pm`.<br>`! Corepack only supports objects as valid value for devEngines.packageManager. The current value (<JSON>) will be ignored.` |
| `Array.isArray(de)` | **Always warn**, return `pm`.<br>`! Corepack does not currently support array values for devEngines.packageManager` |
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
anything else (incl. "warn")   → console.warn(`! Corepack validation warning: ${message}`)
```

> Note the default is **error**, and any unrecognised `onFail` value degrades to a
> warning rather than being rejected. Both MUST be preserved.

`<JSON x>` denotes `JSON.stringify(x)` — so strings appear quoted in the message.

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

`enforceExactVersion` is:
* **`true`** when reading `packageManager` from a manifest in proxy mode with no CLI
  version override — the field is a *pin* and must be exact.
* **`false`** when parsing CLI patterns (`corepack use yarn@^4`) and when a CLI
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

Then, unconditionally: **if `binaryVersion` was given on the CLI, it overwrites
`descriptor.range`.** This is why `corepack yarn@1.22.4 --version` works inside a
project pinned to Yarn 4 — but note that the *name* still has to match, so
`corepack pnpm@9 install` in a Yarn project still errors.

> `COREPACK_ENABLE_STRICT=0` "treats it like transparent" (changelog 0.15.0): the
> effect is that using a *different* package manager than the project's falls back to
> the system-wide default version of that other package manager, while using the
> project's *own* package manager still honours the pinned version.

## 3.6 Auto-pin (`COREPACK_ENABLE_AUTO_PIN=1`)

Only in the `NoSpec` case, and only in proxy mode:

1. Resolve the fallback descriptor to a locator (tags allowed).
   * `null` → `Failed to successfully resolve '<range>' to a valid <name> release`
2. Install it (§07) — this yields the hash, so the written pin is hash-bearing.
3. Emit to **stderr**, verbatim, then a blank line:
   ```
   ! The local project doesn't define a 'packageManager' field. Corepack will now add one referencing <name>@<reference>.
   ! For more details about this field, consult the documentation at https://nodejs.org/api/packages.html#packagemanager
   ```
4. Write the pin into `dirname(specResult.target)`'s `package.json` (§3.7).

## 3.7 Writing the pin

`setLocalPackageManager(cwd, info)`:

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
   `<cwd>/package.json`, so an empty directory gets a new manifest created — this is
   required behaviour (changelog 0.24.1).

Returns `{previousPackageManager}`, which the caller exports as
`COREPACK_MIGRATE_FROM` before running the package manager's `use` command (§09.5).

> **Note.** The BOM is stripped for parsing but **not** re-emitted. A file that had a
> BOM loses it. This spec keeps that behaviour for byte-compatibility but flags it in
> §14.7 as a candidate fix.
