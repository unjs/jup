# 04 — Version Resolution

Input: a `Spec {name, range}` (§03). Output: a `ResolvedSpec {name, reference}`
or `null` ("no release matches").

The proxy path consults, in order: the recorded `jup.lock`, an unexpired memo,
the store, and only then the registry (§4.4). Everything below describes the
resolver those first three steps skip.

## 4.1 The algorithm

`resolveSpec(spec, {allowTags, useCache})`:

```
1. range parses as a URL:
     known name and JUP_ENABLE_UNSAFE_CUSTOM_URLS != 1 → UsageError "Illegal use of URL …"
     → ResolvedSpec {name, reference: range}     # passes through untouched
2. no table entry for name → UsageError "This package manager (<name>) isn't supported…"
3. range is neither an exact version nor a valid range → it is a TAG:
     !allowTags                → UsageError "Packages managers can't be referenced via tags…"
     definition.tags has it    → substitute, NO request, no age cap
     else                      → fetch dist-tags from the LAST band's registry
                                  unknown tag → UsageError "Tag not found (<tag>)"
                                  cap the target to JUP_MINIMUM_RELEASE_AGE
4. useCache → probe the store; a hit returns immediately
5. range is exact → ResolvedSpec {name, reference: range}, unverified
6. query every band in parallel, union the versions satisfying the range under
   §4.2 semantics, drop prereleases unless named or JUP_ENABLE_PRERELEASES=1,
   apply JUP_MINIMUM_RELEASE_AGE, sort descending, take the highest, else null
```

Order matters in ways that are easy to get wrong. Step 4 comes **before** step 5:
for an exact version both return the same reference, so the probe is one `stat`,
and shedding a `+<hash>` suffix on a cache hit is what lets §07.2 re-attach the
marker's own hash instead of demanding a pin-qualified directory. Step 3 resolves
tags against the last band because dist-tags belong to the newest distribution
channel. Step 6 fans out over **every** band because one range may cross package
channels.

Step 5 returns without checking that the version exists, so a typo surfaces later
as a 404 on a tarball URL the user never typed. That 404 is mapped back to
`<name>@<version> does not exist in <registry>. Run 'jup info' …`, or, for a band
declaring `publishedFrom` below which the package was never published, to the
sentence naming the earliest release the user can pin instead. `publishedFrom`
selects a sentence after a 404 and never gates a request.

`useCache: false` is used by `use` and `up`, which must not return the version
already installed.

### Minimum release age

`JUP_MINIMUM_RELEASE_AGE` (hours) filters implicit choices: step 6's candidates
and step 3's dist-tag target, which is the registry choosing on the user's
behalf. An exact pin and a compiled-in tag are exempt — those are the user, or
this table, choosing.

It changes one request: the candidate list is fetched with `Accept:
application/json` instead of the abbreviated packument, because only the full
document carries `time`. Every other request keeps the abbreviated header. A
version the `time` map does not mention is dropped, and a source that publishes
no dates at all is **refused** rather than silently resolved from — a security
control that reports success without having been applied is worse than one that
stops. Only a band that actually matched something refuses, so a range confined
to another band is unaffected.

Unparseable or negative values are refused, not defaulted. Every other numeric
variable falls back on garbage because a mistyped timeout costs latency; this one
would silently turn the protection off on the machine of someone who believes
they turned it on.

## 4.2 The semver subset

`src/version/semver.ts` is zero-dependency and provides exactly:

| Operation | Used by |
|---|---|
| `parse` | build-suffix extraction, LKG bump, directory naming |
| `isValidVersion` / `isValidRange` | descriptor classification, `devEngines` validation |
| `compare` / `rcompare` / `lt` | picking the highest match, LKG bump guard |
| `major` | `up` |
| `satisfies` | the `devEngines` cross-checks — **strict**, standard semver |
| `satisfiesWithPrereleases` | everywhere else — **lenient** |

Range grammar: `||`, whitespace-joined comparators, `^`, `~`, `>`, `>=`, `<`,
`<=`, `=`, exact versions, `*`, `x`/`X` wildcards, hyphen ranges, and partial
versions with an optional leading `v`.

### `satisfiesWithPrereleases`

Standard semver excludes prereleases from ranges: `2.0.0-rc.0` does not satisfy
`>=1.0.0`. That is wrong here — a user pinning `yarn@4.0.0-rc.1` must still land
in the `>=2.0.0` band.

```
strip the prerelease tag from the version AND from every comparator,
then test normally; false, never a throw, on malformed input
```

This is not semver's `includePrerelease`. Build metadata is ignored throughout,
so `4.1.0+sha512.abc` compares equal to `4.1.0`.

Keep the two distinct. The strict form is used only for the `devEngines`
cross-check on read (§03.3) and the same check on write (§03.7); everywhere else
— band selection, cache probe, lockfile validity, candidate filtering — is
lenient, because the recorded version was itself chosen by the lenient rule.

## 4.3 The store probe

```
opendir(<store>/<name>); ENOENT → null
skip entries beginning with "."          # .DS_Store and friends
skip entries carrying build metadata     # pin-qualified directories, §07.2
keep the highest entry satisfying the range (lenient), ties go to the later entry
```

For an exact range this is a single `stat` rather than a scan. The probe uses
prerelease-tolerant matching, so an installed prerelease satisfying the range is
returned without a request.

A range scan **MUST NOT** answer with a pin-qualified directory (§07.2). Such a
directory is itself valid semver, and semver ignores build metadata, so
`1.22.22+sha512.…` both satisfies a range its bare sibling satisfies and *ties*
with it — leaving directory order to decide which one answers. The winner becomes
`locator.reference`, so the tie would put a digest the user never pinned into the
global defaults (§04.5); for a per-host tool it would also route around §07.6's
refusal to attach a per-host digest, the digest arriving by directory name rather
than from the install. Ranges are answered by bare versions. A pin-qualified
directory is reachable only through the exact-reference path that named it.

## 4.4 Project resolution state: `jup.lock` and the memo

A project spec that is a **range or a dist-tag** has no single answer, and asking
the registry on every run is both slow and non-reproducible. Two files close that
gap. Both are keyed by `<name>@<the range exactly as written>`, both hold
`{version, resolutions}` in the same shape, and both degrade to "no answer" on
anything they cannot read.

| | `<project>/jup.lock` | `<project>/node_modules/.jup/jup.lock` |
|---|---|---|
| Written by | `use` and `up` only | any proxy run whose answer came from the registry |
| Committed | yes | no — it lives in `node_modules` |
| Expiry | never; a committed decision does not rot | 24 h stamp |
| Rank | first | second |

`<project>` is the directory of the manifest (or version file) the walk selected,
not the cwd.

An **exact version** or a **URL** never touches either file: the pin is already
its own record.

```jsonc
{ "version": 1,
  "resolutions": {
    "pnpm@^11.0.0": { "resolved": "11.24.0", "integrity": "sha512-…" },
    "bun@^1.4":     { "resolved": "1.4.0",
                      "integrity": { "linux-x64": "sha512-…", "darwin-arm64": "sha512-…" } },
    "pnpm@latest":  { "resolved": "11.24.0", "expires": 1767225600000 }
  } }
```

* `integrity` is SRI, as npm spells it. It becomes the locator's build suffix,
  which is what makes it *used* rather than merely stored: §06.1 treats a
  reference-borne hash as an explicit pin and checks the bytes against it.
* For a **per-host** tool it is a map keyed by normalised `<platform>-<arch>`, so
  a Linux CI job and a Mac laptop pin the same *version* by the same recorded
  decision and each still checks the bytes it downloads. A host with no key yet
  resolves the version from the file with no request and verifies through npm's
  signature, then records its own key. Other hosts' keys are carried across a
  rewrite only while the version is unchanged. A **bare** digest found on a
  per-host entry is dropped rather than applied — it cannot be this host's fact.
* `expires` is memo-only, and is believed only inside the window it may claim: an
  entry without one reads as expired, and so does one further out than the TTL
  from now. A `node_modules` restored from an image, or written under a fast
  clock, would otherwise hold a range pinned for as long as its stamp said.

### Reading

Recorded file first; an unexpired memo second. A recorded resolution is checked
against the range it is keyed by (lenient) and skipped if it no longer satisfies
it; a dist-tag key has no range to violate, so a recorded entry for one stands
until a hand edit removes it, and the memo's TTL is what keeps `pnpm@latest`
meaning "recent".

An **expired** memo is still returned to the caller as the answer of last resort.
If the fresh resolution then fails because the registry is unreachable or
degraded — a transport failure, or 408/425/429/5xx — jup runs the stale version
and says so on stderr, naming the memo's path. The stamp is **not** extended, so
the notice repeats until the registry answers again.

That fallback is scoped to availability and nothing else. A disabled network, a
minimum-release-age refusal, 401, 403, 404, and TLS failures all propagate: each
is a statement about the *request*, which an older memo does not make less true,
and failing open there would turn a rotated credential or a security control into
a silent permanent pin.

### Writing

* A proxy run writes the **memo**, and only when the answer came from the
  registry. Re-stamping an unexpired entry churns a file for no new fact;
  re-stamping an expired one that only stood in because the network was down
  would quietly turn an outage into a pin.
* The memo is never created outside an existing `node_modules`: conjuring the
  package manager's own directory — possibly in a repository holding nothing but
  an `.nvmrc` — for a run asked only to print a version is not jup's to do. The
  `.jup` directory inside it is jup's own and is created on demand.
* `use <name>@<range>` creates the **recorded** resolution and retires the
  replaced key's; `up` refreshes an existing one. Both then drop the memo for
  that key, which would otherwise answer alone wherever the recorded file is not
  visible — an uncommitted write, a `git stash`, a CI cache that restores
  `node_modules` but not the lockfile — with the version just superseded.
* `--no-lockfile` (§09) writes no resolution. It removes the matching recorded
  resolution and memo so the next run does not reuse them. The range still goes
  into the manifest, and its selected release is still resolved and installed.
  If `jup.lock` changed, §12.11's `Removed …` line names it.
* Serialisation is chosen for `git diff`: two-space indent, sorted keys, sorted
  host maps, trailing newline. An unchanged file is not rewritten, so mtime and
  `git status` stay quiet. Writes are temp-then-rename in the destination's own
  directory, under a dot-prefixed temp name so an orphan does not turn up beside
  the file it failed to become.
* A write failure is swallowed: a read-only checkout must still be able to run,
  and the cost is one extra resolution next time. Emptying the last entry removes
  the file.

`JUP_FROZEN_LOCKFILE=1` refuses creation, refresh **and deletion** — the flag
governs the file, not one syntax of pin, so an exact `use` over a project that
currently declares a range is refused too, because removing that entry is a
write. The refusal happens before anything is resolved or downloaded. The same
rule applies to `--no-lockfile`: it is refused when it would remove an entry for
the range or pin being replaced.

Unknown `version` values, malformed entries, and unreadable files all read as "no
resolutions", entry by entry, so one damaged record cannot poison the others and
a future format bump costs one extra network resolution rather than a broken
checkout.

## 4.5 The last-known-good file

`<home>/lastKnownGood.json`, a flat `{"<name>": "<reference>"}` map: the *global*
default, used when a project has no spec. It lives outside `v1`, so `cache clean`
spares it.

Reading is maximally forgiving — missing, unparseable, or non-object content all
read as `{}`, and an entry whose value is not a string is dropped while the rest
are kept. Only an I/O error other than `ENOENT` propagates.

Writing is `mkdir -p` then a temp-then-rename replacement, skipped entirely when
the value is unchanged. A plain truncating write would let two concurrent
processes interleave into a truncated file; because reads tolerate corruption,
the failure would be silent, and the global default would simply vanish.

## 4.6 Default version selection

Consulted lazily, only when the project has no usable spec:

```
1. lastKnownGood has an entry for this tool → return it            [NO NETWORK]
2. JUP_DEFAULT_TO_LATEST=0 → return the compiled-in default        [NO NETWORK]
3. fetch the latest stable version                                 [NETWORK]
   record it as the new last-known-good, swallowing any error
```

Step 1 is why a machine that has ever run online keeps working offline without a
project spec.

`fetchLatestStableVersion` by registry type:

* **npm** — `GET {registry}/{package}/latest`, verify the signature over that
  version's metadata unless verification is disabled, then return a hash-bearing
  reference from `dist.integrity` (or `dist.shasum` on a legacy registry).
* **npm, per-host entry** — the same request, returning the **bare version**.
  `fetchLatestFrom` names the *launcher* package, so everything in its `dist`
  describes a tarball that is never downloaded; pinning it would compare a
  launcher's digest against the artifact's bytes. The artifact's own signature is
  verified at download time instead. The recorded last-known-good is therefore
  bare for such an entry.
* **url** — `GET spec.url` and return `data[fields.tags].stable`. No hash.

`JUP_MINIMUM_RELEASE_AGE` applies here as it does to any tag. Failure in the npm
path is rethrown wrapped in the message naming both escape hatches (§12).

### Transparent-command fallback

When the invocation is transparent (§01.4) and the entry declares
`transparent.default`, that literal is the fallback and `getDefaultVersion` is not
consulted at all — no LKG read, no network. It is a **floor**, applied major-wise:
a recorded default of `4.0.0` meets a `4.2.0` floor, `3.99.99` does not. This
preserves the user's major without forcing minor upgrades.

## 4.7 CLI version override

`jup yarn@4.1.0 install` replaces the descriptor's range verbatim after
reconciliation, and relaxes `requireVersion` on the project spec parse. The name
check still applies, and an override never writes to `jup.lock`: a one-invocation
override must not change the project's recorded resolution.

## 4.8 Last-known-good auto-bump

After a successful install of a supported (non-URL) tool, and unless
`JUP_DEFAULT_TO_LATEST=0`:

```
if an entry exists for this tool
   and major(current) === major(installed)
   and current < installed:
       record the installed reference
```

So installing `yarn@4.9.0` advances a `4.1.0` default; installing `yarn@5.0.0`
does not — major bumps are never automatic. With no existing entry nothing is
written; the entry is created only by §4.6 step 3, by `install -g`, or by `pack`.

Note the blast radius: installing a version in project A moves the default that
unrelated unpinned project B will use. That is inherited behaviour, and confining
the write to `install -g` would be a defensible change.
