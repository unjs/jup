# 02 — Data Model & the Built-in Table

The table lives in `src/config/table.ts` and its types in `src/types.ts`. **This
page describes the shape and the rules; the code holds the values.** Versions,
digests and host maps are refreshed by `scripts/refresh-table.mjs`, so copying
them here only guarantees they go stale.

## 2.1 Core value types

```
Descriptor  { name, range }              "what the project asked for"
Locator     { name, reference }          "the exact thing to install"
InstallSpec { location, bin, hash }      "where it landed on disk"
```

* **Descriptor** — `range` is any of: an exact semver version, a semver range, a
  dist-tag (`latest`, `lts`, …), `*`, or a URL. Produced by §03, consumed by §04.
* **Locator** — `reference` is an exact version, optionally carrying a build
  suffix (`4.1.0+sha512.abcdef…`), or a URL. Produced by §04, consumed by §07.
* **LazyLocator** — a Locator whose `reference` is a thunk. Used for the fallback
  locator so that the default-version lookup, which may read `lastKnownGood.json`
  and hit the network, happens only if the project turns out to have no spec.
  Keeping it lazy is the difference between "an offline project with a pinned
  version works" and "every invocation hits the network". `main.ts` forces it in
  exactly one place.

### Reference grammar

```
reference := version | version "+" build | url
build     := algo [ "." hexdigest ]        # algo defaults to sha512
url       := absolute URL, optionally with #algo.hexdigest
```

The build suffix is semver build metadata, so `4.1.0+sha512.…` is a valid semver
version that compares equal to `4.1.0`. A hash-pinned spec stays range-comparable.
A URL reference carries the same information in its fragment.

## 2.2 Registry specs

```jsonc
{ "type": "npm", "package": "pnpm" }

// `publishedFrom`: the earliest version the package carries, for a band that
// covers a wider range than the package was published over.
{ "type": "npm", "package": "@yarnpkg/cli-dist", "publishedFrom": "2.4.1" }

// url-style: fetch JSON and read configured fields. For a tool published
// somewhere other than an npm registry.
{ "type": "url", "url": "https://…/tags",
  "fields": { "tags": "aliases", "versions": "tags" } }
```

For `type: "url"`, `fields.versions` may name an array of versions or an object
keyed by version; both are accepted. "Latest stable" reads
`data[fields.tags].stable` — **`stable`**, not `latest`.

`publishedFrom` takes no part in resolution. It selects which sentence an
exact-version 404 prints (§04.1), and nothing else, so a stale value costs a less
specific message.

Every band in the table today points at the npm registry. Nothing reaches a
vendor's own distribution host, which is what lets §06's verification tier hold
for every entry without an opt-in, and lets `JUP_NPM_REGISTRY` mirror all of it.

## 2.3 Tool definition

```ts
{
  kind?: "package-manager" | "runtime",   // absent means package-manager
  default: string,                        // built-in fallback version
  tags?: Record<string, string>,          // dist-tags the table answers itself
  fetchLatestFrom: RegistrySpec,          // where "newest stable?" is answered
  transparent: { default?: string, commands: string[][] },
  ranges: [range, ToolSpec][],            // ORDERED, matched last-to-first
  shimByDefault?: boolean,                // absent means true
  versionFile?: { path: string, format: "nvm" },
}
```

### `kind`

| | `package-manager` | `runtime` |
|---|---|---|
| Project pin read from | `packageManager`, else `devEngines.packageManager` | `devEngines.runtime` |
| May appear in `packageManager` | yes | **no** (§03.4) |
| §03.5 name mismatch | enforced | never applies |
| `transparent.commands` | consulted | unused — nothing to bypass |
| `commands.use` | run by `use`/`up` | absent; a runtime installs nothing |
| `shimByDefault` | per entry | must be `false` — a runtime's name means something outside any project, so a bare `enable` never claims it |

The split is deliberately narrow. Resolution, download, verification, caching and
execution are identical; only which manifest field speaks, and whether standing
in someone else's project is an error, differ.

### `default` and `tags`

`default` is the compiled-in fallback. It is hash-pinned **only where the
artifact is portable**: for a per-host entry (§2.4) the artifact differs per
platform, so `default` is a bare version and the verification tier is npm's
signature over this host's artifact (§06.3) rather than a compiled-in literal.
Never pin a host-specific digest anywhere portable.

`tags` are dist-tags the table answers itself, before any request and with no
release-age cap. `node`'s `lts` is the only one: the `node` launcher package
publishes `latest` and `v4-lts` … `v20-lts`, and those series tags stop short of
the current LTS line, so npm's own tags cannot answer `lts`. It is a compiled-in
version pointer to an alias that moves every six months, and it is the entry most
likely to be stale — refresh it with the table, or retire the alias.

### `ranges`

A tool's *download shape* changes across major versions (pnpm's bin moved
`.js` → `.cjs` → `.mjs` and then went native; Yarn 2+ ships from a different
package). `ranges` is an **ordered list of `[range, spec]` pairs, matched
last-to-first**: the last declared range that the version satisfies wins, using
prerelease-tolerant satisfaction (§04.2), so `12.0.0-rc.1` lands in the `>=12.0.0`
band. Bands are expected to be contiguous and exhaustive; a version no band
covers is an internal assertion failure, not a user error, and §07.7 will not let
such a version take a `bin` from the table.

Dist-tags are a property of the newest distribution channel, so they always
resolve against the **last** band's registry — `yarn@latest` consults
`@yarnpkg/cli-dist`, even though `yarn@1.22.22` downloads from the `yarn` package.

### `versionFile`

Names a file the tool's own ecosystem already writes the wanted version into
(`.nvmrc` for node), so jup answers correctly in a repository that has never heard
of it. Rules:

* It is per-entry table data. §03's walk does not know what it is looking for, so
  adding one is a data-only change.
* It is not a property of `kind`. `format` is the grammar of the contents, not
  the file name.
* It ranks strictly below the manifest and strictly above §03.5's fallback, and
  jup never writes it.

## 2.4 ToolSpec — one version band

```ts
{
  url: string,                        // download template; "{}" ← version
  bin: BinSpec,                       // { name: relative path }
  registry: RegistrySpec,             // which versions exist
  npmRegistry?: NpmRegistrySpec,      // npm-protocol alternative to `registry`
  artifactRegistry?: NpmRegistrySpec, // where the BYTES come from
  commands?: { use?: string[] },      // argv run after `use`/`up`
  targets?: Record<string, string>,   // "<platform>-<arch>" → "{target}"
  exec?: "js" | "native",             // absent/"js" is §08.2's in-process load
  binArgs?: Record<string, string[]>, // argv prepended for one bin NAME
}
```

### Placeholders

`url` always substitutes `{}` with the version. The rest are opt-in per band:

| Placeholder | Expands to | Valid in |
|---|---|---|
| `{platform}` | `linux` \| `darwin` \| `win32` | `url`, `artifactRegistry.package` |
| `{arch}` | `x64` \| `arm64` | `url`, `artifactRegistry.package` |
| `{target}` | `targets[<host>]` | `url`, `artifactRegistry.package` |
| `{exe}` | `.exe` on Windows, empty elsewhere | `bin` **paths**, never bin names |

`<host>` is `<platform>-<arch>`, plus a `-musl` suffix on a musl Linux. Linux is
the one platform where the pair alone does not name a binary interface, and
publishers that ship both say so in the artifact name. glibc stays unsuffixed, so
existing `targets` maps and `jup.lock` keys keep their meaning; only a musl host
sees a new key, and it is the host that was previously handed a glibc binary that
could not start.

### The host model

`{target}` exists because published artifact names are not the product of two
independent axes: bun renames both halves (`windows-aarch64` for `win32`/`arm64`),
deno keeps Node's spelling and suffixes only Linux (`linux-x64-glibc`), and node's
Apple Silicon package is `node-bin-darwin-arm64` rather than `node-darwin-arm64`.

A `targets` map is also a **declaration of the host set**. A host it does not
cover fails with `unsupportedTarget` — naming the host and what the version does
ship for — before any request, instead of 404ing on a URL the user never typed. A
host outside the `{platform}`/`{arch}` vocabulary is a different error
(`unsupportedPlatform` / `unsupportedArch`), because there the *tool*, not the
release, is what does not cover it. All three are raised before any request.

Two consequences follow, and both are worth weighing before adding an entry:

* the table must ship a release for every new platform of every tool, and
* a **stale** map fails closed on a host that actually works. Fail-closed is
  right for verification; for platform availability it is a trade against a 404.
  Bands whose only difference is which hosts existed at that version (bun) are
  the cost of that choice.

An entry with no `targets` claims every host forever, which is why even an
identity map is written out: the map is where a host leaving the set is said.

### `registry`, `npmRegistry`, `artifactRegistry`

* `registry` answers §04's question — which versions and dist-tags exist.
* `npmRegistry` is an npm-protocol alternative used in place of `registry` when
  the user has configured an npm registry that would serve it. No band declares
  one today; the field exists for a `type: "url"` source with an npm mirror.
* `artifactRegistry` answers §06's and §07's — the bytes, the signed
  `dist.integrity`, and npm's signature over it.

`registry` and `artifactRegistry` separate when a tool publishes a small
**launcher** on npm and its real binaries as per-host packages. bun, deno, aube,
nub, node, and pnpm from 12 all ship that way: the launcher's `postinstall` (or
`preinstall`) downloads or hardlinks the host binary. jup runs no lifecycle
scripts, so installing the launcher would cache something that cannot run —
pointing both fields at it is the mistake this split prevents.

Because one version is then many artifacts:

* the digest is **not** folded into the locator's reference (§07.6), because that
  reference is what `use`/`up` write into `packageManager`, and a per-host digest
  committed there fails every colleague on another platform;
* `jup.lock` records the digest **per host** (§04.4);
* the store marker still records it — the store is host-local, so there it is
  exactly the right fact.

### `bin` and `binArgs`

`bin` is always a `BinSpec` map, `{ name: relativePathInPackage }` — never an
array. A marker containing an array where `bin` is expected is invalid and §07.2
treats it as absent. A direct `.js` URL reference still records a map naming the
downloaded file.

The table's `bin` is a **fallback**: §07.7 reads the package's own `bin` first, so
a band whose paths have gone stale cannot break an install. Per-host artifact
packages that declare no `bin` of their own (bun, deno, nub) are the case where
the table is the authority — which is also why `{exe}` exists.

Two names mapping to one path is the spelling for "one file, two names"
(`yarn`/`yarnpkg`, `bun`/`bunx`). For a **native** band it additionally requires
§08.3's `argv[0]` rule: the invoked name reaches the artifact as `argv[0]`, which
is how one executable behaves differently under two names.

`binArgs` is keyed by the same names and prepends argv words. Use it where names
share a path but the artifact distinguishes them by its own file name rather than
by `argv[0]`, which a spawn cannot set. pnpm's native band is the only user
(`{pnpx: ["dlx"]}`), matching what pnpm's own POSIX `pnpx` script does. A tidier
long-term shape would fold it into `BinSpec` (`{pnpx: {path, args}}`).

The union of all `bin` names across all bands of all entries is the set of names
jup answers to, and the set of shims `enable` creates (§10).

## 2.5 The entries

`src/config/table.ts` is authoritative. As of writing:

| Entry | kind | Binaries | Native | Per-host artifact | Shimmed by default |
|---|---|---|---|---|---|
| npm | pm | `npm`, `npx` | no | no | yes |
| pnpm | pm | `pnpm`, `pnpx` | ≥12 only | ≥12 only | yes |
| yarn | pm | `yarn`, `yarnpkg` | no | no | yes |
| bun | pm | `bun`, `bunx` | yes | yes | no |
| deno | pm | `deno` | yes | yes | no |
| aube | pm | `aube`, `aubr`, `aubx` | yes | yes | yes |
| nub | pm | `nub`, `nubx` | yes | yes | no |
| node | runtime | `node` | yes | yes | no |

Entry-specific rules that are *rules*, not values:

* **pnpm** is the entry where `exec` is per band rather than per tool: the `pnpm`
  npm package is a wrapper whose `preinstall` installs the host binary, so from
  12 jup fetches `@pnpm/exe.<host>` instead. The wrapper would put a network
  request behind a cache hit and leave a seeded store unable to run offline.
* **yarn** resolves 1.x from the `yarn` package and 2+ from `@yarnpkg/cli-dist`,
  whose 2.x line begins at 2.4.1 — hence `publishedFrom`. Releases below it
  existed only on `repo.yarnpkg.com`, which jup does not read.
* **aube** ships no `darwin-x64` build, which is why its identity-shaped
  `targets` map is still a map: an Intel Mac must be told before any request.
* **deno and node** publish no musl build, and say so by omission; an Alpine host
  gets `unsupportedTarget` rather than a glibc binary that cannot start.
  `linux-armv7l`, which node does publish, is outside the `{arch}` vocabulary and
  is the other error.
* **`shimByDefault: false`** keeps a name out of the set a bare `jup enable`
  installs. It is for names users install deliberately and reach for outside any
  project — `bun`, `deno` and `nub` all run a file you hand them — where claiming
  the name would be a takeover nobody asked for. `jup enable bun` still installs
  it, and `disable` with no names still removes it.
* **Transparent prefixes** cover the commands that create or bypass a project
  (`init`, `create`, `dlx`, `x`, and the `…x` binaries). Commands that act on the
  project the user is standing in (`deno run`, `nub run`, `aube exec`) stay
  subject to §03.5.

### Fields with exactly one user

`publishedFrom` (yarn), `binArgs` (pnpm), `tags` (node), `transparent.default`
(yarn), `versionFile` (node). Each is a permanent code path serving one row. When
touching any of them, prefer generalising or removing over adding a sixth.

## 2.6 Trust store

`src/config/keys.ts` holds npm's signing keys:

```jsonc
{ "npm": [ { "expires": null | "<ISO-8601>", "keyid": "SHA256:…",
             "keytype": "…", "scheme": "…", "key": "<base64 SPKI>" } ] }
```

`key` is a base64 DER SubjectPublicKeyInfo. npm's keys are NIST P-256, but the
curve is read from the key material, so a store supplied for another registry may
use another. `expires` is stored and consulted (§06.5). Only unexpired keys ship;
the refresh workflow removes expired ones and a maintainer confirms the
verification window before merging. §06.3 has the algorithm, §11.2 the override.

## 2.7 Project-manifest data

```ts
{
  packageManager?: string,          // "yarn@4.1.0+sha512.…"; never a runtime
  devEngines?: {
    packageManager?: { name, version?, onFail?, integrity? },
    runtime?:        { name, version?, onFail? },
  }
}
```

`version` is a semver **range**; `onFail` is `ignore` | `warn` | `error`;
`integrity` is §03.7's sidecar digest. The two `devEngines` members are validated
by one rule with the member name substituted into its messages, and are read
independently — which one speaks is decided by the `kind` of the tool being
requested, so a project may pin both and neither constrains the other.

`devEngines` also standardises `os`, `cpu` and `libc`. jup reads none of them;
adding them would be a scope change (§01.7), not a completion.
