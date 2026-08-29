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
        if definition.tags has own property `range` →
            range := definition.tags[range]   # compiled-in, NO request, no age cap
        else:
            registry := registry of the LAST range entry in the definition   (§02.3)
            tags     := fetchAvailableTags(registry)                          [NETWORK]
            if !(range in tags) → UsageError `Tag not found (<range>)`
            range := tags[range]        # now an exact version

 4. If range is exact:
        if useCache, probe its one marker path; return the cached reference if valid
        otherwise return Locator {name, reference: range}

 5. If useCache, find the highest installed version satisfying the range and return it.

 6. Query every range band in parallel and union versions satisfying the requested
    range under §4.2 band semantics. Unless `JUP_ENABLE_PRERELEASES=1`, exclude
    prereleases not named explicitly. Apply `JUP_MINIMUM_RELEASE_AGE` to implicit
    candidates; exact pins and compiled-in tags are exempt. Sort descending and
    return the highest candidate, or null.
```

A compiled-in tag is checked with an own-property test and uses no network or age
filter. Other tags use the registry of the last range band. Range queries span every
band because one requested range may cross package channels. `useCache: false` is
used by `use` and `up`. If artifact download returns 404 for an exact version, report
`<name>@<version> does not exist in <registry>. Run 'jup info' to see the resolved spec and where it came from.`

A band MAY declare `registry.publishedFrom` — the earliest version its npm package
carries — when the band covers a wider range than the package was published over. On
the 404 above, and only there, a version below it reports instead:

`<name>@<version> does not exist in <registry>. jup installs <name> from <package>, whose earliest published version is <publishedFrom>; releases before it were only ever distributed elsewhere. Pin <publishedFrom> or newer.`

The first sentence is the same one, verbatim. `publishedFrom` MUST NOT gate a
request, filter a candidate, or take part in resolution: it selects a sentence after
a 404 has already happened, so a stale value can only make a message less specific.
Today Yarn Berry is its one user — `@yarnpkg/cli-dist` begins at 2.4.1, while the
band claims `>=2.0.0`, and everything between exists only on a host §15.41 stopped
reading.

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

That is: **strip the prerelease tag from both sides, then test normally**. This is
not semver's `includePrerelease` behavior. Build metadata is ignored throughout, per
semver, so `4.1.0+sha224.abc` compares equal to `4.1.0`.

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

Dot-entries such as `.DS_Store` are skipped. The comparison accepts a candidate
that is greater than or equal to the current best, so an equal candidate replaces
the earlier directory entry. The probe uses prerelease-tolerant range matching, so
an installed prerelease that satisfies the requested range is returned without a
registry request.

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

> **Requirement:** the write is a plain non-atomic `writeFile`, so two
> concurrent processes can interleave and produce a truncated file. Because reads
> tolerate corruption by returning `{}`, the failure is silent-but-degrading (the
> global default is lost). Use **write-temp-then-rename** here.

## 4.5 Default version selection

`getDefaultVersion(packageManager)` — invoked lazily, only when the project has no
usable spec:

```
1. lkg := readLastKnownGood()
   if lkg has an entry for this package manager → return it              [NO NETWORK]

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
* **npm, per-host entry** — `GET` as above, but return the **bare
  `version`**, attaching no hash and consulting no `dist`. A per-host entry's
  `fetchLatestFrom` names its *launcher* package (§02.4), so everything in `dist`
  here describes a tarball that is never downloaded; pinning it makes §06.1 row 1
  compare a launcher's digest against the artifact's bytes, which cannot match. The
  artifact's own signature is verified at download time instead (§06.3), which is a
  check about the bytes that will run. This also means the recorded last-known-good
  (step 3) is a bare version for such an entry.
* **url** — `GET spec.url`, return `data[spec.fields.tags].stable`. Note **`stable`**,
  not `latest`. No hash is attached on this path.

On failure in the npm path, rethrow with the exact jup message in §12.6.

### Fallback reference for transparent commands

When the invocation is a transparent command (§01.4) and the definition declares
`transparent.default`, that literal string is the fallback reference and
`getDefaultVersion` is **not** consulted at all — no LKG read, no network.

`transparent.default` is a floor, not an override: a newer compatible user-recorded
default wins.

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
