# 04 — Version Resolution

Input: a `Descriptor {name, range}` (§03). Output: a `Locator {name, reference}` or
`null` (meaning "no release matches").

## 4.1 The algorithm

`resolveDescriptor(descriptor, {allowTags, useCache})`:

```
 1. If descriptor.range parses as a URL:
        if name is a known package manager and COREPACK_ENABLE_UNSAFE_CUSTOM_URLS !== "1":
            → UsageError `Illegal use of URL for known package manager. Instead, select
              a specific version, or set COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=1 in your
              environment (<name>@<range>)`
        → Locator { name, reference: range }        # URL passes through untouched

 2. Look up the definition for `name`.
        missing → UsageError `This package manager (<name>) isn't supported by this jup build`

 3. If range is neither a valid exact version nor a valid semver range → it is a TAG:
        if !allowTags → UsageError `Packages managers can't be referenced via tags in this context`
        registry := registry of the LAST range entry in the definition   (§02.3)
        tags     := fetchAvailableTags(registry)                          [NETWORK]
        if !(range in tags) → UsageError `Tag not found (<range>)`
        range := tags[range]        # now an exact version

 4. Cache probe:  cached := findInstalledVersion(store, {name, range})
        if cached !== null and useCache → Locator { name, reference: cached }   ← FAST PATH

 5. If range is now a valid exact version → Locator { name, reference: range }

 6. Range query:                                                        [NETWORK]
        for each (rangeKey, spec) in definition.ranges, IN PARALLEL:
            versions := fetchAvailableVersions(spec.registry)
            keep those satisfying `range` under prerelease-tolerant satisfaction (§4.2)
        candidates := dedup(flatten(all))
        sort descending by semver
        → candidates.length ? Locator { name, reference: candidates[0] } : null
```

Notes a re-implementation MUST get right:

* **Step 3 uses the *last* range entry's registry, not a per-version one.** Tags are a
  property of the newest distribution channel. For Yarn this means
  `https://repo.yarnpkg.com/tags`, so `yarn@latest` resolves to a Berry version even
  though `yarn@1.22.22` would come from npm.
* **Step 5 returns an exact version without verifying it exists.** A typo'd or
  yanked version therefore surfaces much later, as a bare
  `Server answered with HTTP 404` naming a tarball URL the user never typed.
  §15.35j requires that 404 to be reported as a nonexistent version.
* **Step 4 comes *before* step 5.** So an exact-version descriptor still probes the
  cache first — but since steps 4 and 5 would return the same reference for an exact
  version, the cache probe is pure overhead there. See §14.1.
* **Step 6 queries every range band in parallel** and unions the results, because a
  range like `>=1` legitimately spans Yarn Classic (npm) and Yarn Berry
  (repo.yarnpkg.com).
* **Step 6 leaks prereleases — see §15.24.** Because the filter uses
  `satisfiesWithPrereleases`, which strips the prerelease tag before testing, a
  published `11.0.0-dev.1005` satisfies `*` and then sorts above every stable release.
  So `jup use pnpm` installs a dev build whenever one is the semver maximum.
  §15.24 requires prereleases to be excluded from *implicit* resolution.
* `useCache: false` is used by `use` and `up` so that "give me the latest" actually
  consults the registry rather than returning whatever is already installed.

## 4.2 The semver subset

A conforming zero-dependency implementation must provide exactly these operations.
Nothing more is needed.

| Operation | Used by |
|---|---|
| `parse(version) → {major, minor, patch, prerelease[], build[]}` | build-suffix extraction, LKG bump |
| `isValidVersion(s)` | descriptor classification |
| `isValidRange(s)` | descriptor classification, `devEngines.version` validation |
| `compare(a, b)` / `rcompare` | picking the highest match, sorting |
| `lt(a, b)` | LKG bump guard, npm 9.7.0 compile-cache guard |
| `major(v)` | `jup up` |
| `satisfies(v, range)` | `devEngines` cross-check (**strict**, standard semver) |
| `satisfiesWithPrereleases(v, range)` | everywhere else (**lenient**, see below) |

### Range grammar to support

`||` (union of comparator sets), whitespace-joined comparators (intersection),
`^`, `~`, `>`, `>=`, `<`, `<=`, `=`, exact versions, `*`, `x`/`X` wildcards
(`6.x`, `1.2.x`), and hyphen ranges. This is the full semver range grammar; the
built-in table alone uses `*`, `<6.0.0`, `6.x || 7.x || 8.x || 9.x || 10.x`,
`>=11.0.0`, `<2.0.0`, `>=2.0.0`, and `up` synthesises `^<major>.0.0`.

### `satisfiesWithPrereleases`

Standard semver deliberately excludes prereleases from ranges: `2.0.0-rc.0` does
**not** satisfy `>=1.0.0`. That is wrong for this tool — a user pinning
`yarn@4.0.0-rc.1` must still land in the `>=2.0.0` band.

Normative algorithm:

```
satisfiesWithPrereleases(version, range, loose = false):
    rangeAst := parseRange(range, loose)         # on parse failure → false
    if version is empty/null → false
    v := parseVersion(version, loose)            # on parse failure → false
    v.prerelease := []                           # strip
    return rangeAst.comparatorSets.some(set =>
        set.every(cmp => {
            cmp2 := cmp with cmp.version.prerelease := []
            return cmp2.test(v)
        }))
```

i.e. **strip the prerelease tag from both sides, then test normally**. Note this is
*not* the same as semver's `includePrerelease` flag, whose behaviour corepack
explicitly rejected (see `yarnpkg/berry#575`). Build metadata is ignored throughout,
per semver, so `4.1.0+sha224.abc` compares equal to `4.1.0`.

Returns `false` — never throws — on any malformed input.

> Where **strict** `satisfies` is used instead (the `devEngines` cross-check in §03.3
> and the `use`-time devEngines check in §03.7), the standard prerelease-excluding
> behaviour applies. A conforming implementation MUST keep the two distinct.

## 4.3 Cache probe — `findInstalledVersion`

```
dir := <store>/<name>
opendir(dir)
    ENOENT → null
    other  → propagate
best := null
for each entry name E in dir:
    if E starts with "." → skip          # .DS_Store and friends
    if range.test(E) and (best is null or compare(best, E) !== 1):
        best = E
return best
```

Three things to preserve:

* Dot-entries are skipped (macOS `.DS_Store`).
* The comparison is `maxSV?.compare(name) !== 1`, i.e. **accept when the candidate is
  greater than *or equal to* the current best** — ties keep the later directory entry.
  Immaterial in practice (names are unique) but harmless to mirror.
* This uses **strict** `range.test`, not `satisfiesWithPrereleases`. A directory named
  `4.0.0-rc.1` therefore will **not** satisfy a `>=2.0.0` probe, and the tool falls
  through to the registry. See §14.2 — this is an inconsistency worth fixing, since it
  makes prerelease installs re-hit the network on every run.

## 4.4 The last-known-good file

`<COREPACK_HOME>/lastKnownGood.json`, a flat `{"<pm name>": "<version reference>"}`
map. It is the *global* default: the version used when a project has no spec.

**Reading** (`getLastKnownGood`) is maximally forgiving. Every failure mode returns
`{}` rather than erroring:

| Condition | Result |
|---|---|
| File missing (`ENOENT`) | `{}` |
| Other I/O error | propagate |
| Not valid JSON | `{}` |
| Parses to a falsy value | `{}` |
| Parses to a non-object (incl. arrays? — `typeof [] === "object"`, so arrays pass) | `{}` if not an object |
| Individual entry whose value is not a string | that key is deleted; rest kept |

**Writing** (`createLastKnownGoodFile`): `mkdir -p` the home folder, then write
`JSON.stringify(lkg, null, 2) + "\n"` in UTF-8. Not atomic. Writes are skipped
entirely when the value is unchanged.

> **Divergence (§14.3):** the write is a plain non-atomic `writeFile`, so two
> concurrent processes can interleave and produce a truncated file. Because reads
> tolerate corruption by returning `{}`, the failure is silent-but-degrading (the
> global default is lost). This spec requires a **write-temp-then-rename** here.

## 4.5 Default version selection

`getDefaultVersion(packageManager)` — invoked lazily, only when the project has no
usable spec:

```
1. lkg := readLastKnownGood()
   if lkg has an entry for this package manager → return it              [NO NETWORK]
      (§15.28 — for a per-host entry, drop any build suffix first and
       rewrite the file best-effort; still no network)

2. if COREPACK_DEFAULT_TO_LATEST === "0" → return definition.default     [NO NETWORK]
      (the compiled-in, hash-pinned version)

3. reference := fetchLatestStableVersion(definition.fetchLatestFrom)      [NETWORK]
   try to record it as the new LKG; swallow any error
   return reference
```

Step 1 is why a machine that has ever run the tool online keeps working offline
without a project spec.

### `fetchLatestStableVersion` by registry type

* **npm** — `GET {registry}/{package}/latest`, then (unless integrity checks are
  disabled) verify the signature over that version's metadata (§06.3), then return
  a hash-bearing reference:
  * if `dist.integrity` is present → `` `${version}+sha512.${hex(base64decode(integrity.slice(7)))}` ``
  * else (legacy registries) → `` `${version}+sha1.${dist.shasum}` ``
* **npm, per-host entry (§15.28)** — `GET` as above, but return the **bare
  `version`**, attaching no hash and consulting no `dist`. A per-host entry's
  `fetchLatestFrom` names its *launcher* package (§02.4), so everything in `dist`
  here describes a tarball that is never downloaded; pinning it makes §06.1 row 1
  compare a launcher's digest against the artifact's bytes, which cannot match. The
  artifact's own signature is verified at download time instead (§06.3), which is a
  check about the bytes that will run. This also means the recorded last-known-good
  (step 3) is a bare version for such an entry.
* **url** — `GET spec.url`, return `data[spec.fields.tags].stable`. Note **`stable`**,
  not `latest`. No hash is attached on this path.

On any failure in the npm path the error is re-thrown wrapped, verbatim:

> `Corepack cannot download the latest stable version of <packageName>; you can disable signature verification by setting COREPACK_INTEGRITY_KEYS to 0 in your env, or instruct Corepack to use the latest stable release known by this version of Corepack by setting COREPACK_DEFAULT_TO_LATEST to 0`

(Both env var names in that message are load-bearing — the test suite asserts they
are exactly `COREPACK_INTEGRITY_KEYS` and `COREPACK_DEFAULT_TO_LATEST`, and asserts
that the never-existing names `COREPACK_INTEGRITY_CHECK` / `COREPACK_USE_LATEST` do
**not** appear.)

### Fallback reference for transparent commands

When the invocation is a transparent command (§01.4) and the definition declares
`transparent.default`, that literal string is the fallback reference and
`getDefaultVersion` is **not** consulted at all — no LKG read, no network.

> **Defect — see §15.33.** The expression is
> `definition.transparent.default ?? defaultVersion`, so a compile-time constant
> unconditionally outranks the user's own recorded default. After
> `corepack install -g yarn@4.9.0`, `yarn dlx` still runs the table's pinned version,
> with no way to override. §15.33 makes `transparent.default` a floor rather than an
> override.

## 4.6 CLI version override

If the invocation was `<binary>@<version>` (e.g. `jup yarn@4.1.0 install`), then
after project reconciliation the descriptor's `range` is replaced by that version
verbatim, and `enforceExactVersion` was already relaxed for the project spec parse.
The *name* check still applies: `jup pnpm@9 install` in a Yarn-pinned project is
still an error.

## 4.7 Last-known-good auto-bump

After a successful install of a **supported** (non-URL) package manager, and unless
`COREPACK_DEFAULT_TO_LATEST === "0"`:

```
lkg := readLastKnownGood()
current := lkg[locator.name]
if current exists
   and major(current) === major(installed)
   and lt(current, installed):
       lkg[locator.name] := installed.reference; write
```

So installing `yarn@4.9.0` when the global default is `yarn@4.1.0` silently advances
the default to `4.9.0`, but installing `yarn@5.0.0` does **not** — major bumps are
never automatic. If there is no existing entry, nothing is written (the entry is only
created by §4.5 step 3 or by `install -g`).
