# 02 — Data Model

## 2.1 Core value types

Three types carry the whole pipeline. Keeping them distinct is what makes the
resolution stages checkable.

```
Descriptor  { name: string, range: string }    "what the project asked for"
Locator     { name: string, reference: string } "the exact thing to install"
InstallSpec { location, bin, hash }             "where it landed on disk"
```

* **Descriptor** — `name` is a package-manager name (`npm` | `pnpm` | `yarn` | `bun` |
  `deno`) or, in unsafe-URL mode, still one of those names. `range` is *any* of: an exact semver
  version, a semver range, a dist-tag (`latest`, `next`, `canary`, `rc`, `stable`),
  `*`, or a URL. Descriptors are what §03 produces and §04 consumes.
* **Locator** — `reference` is an exact semver version, optionally carrying a build
  suffix (`4.1.0+sha224.abcdef…`), or a URL. Locators are what §04 produces and §07
  consumes.
* **LazyLocator** — identical to Locator except `reference` is a *thunk*
  `() => Promise<string>`. Used for the fallback locator so that the (possibly
  network-hitting) default-version lookup is only performed if the project turns out
  to have no spec. **A conforming implementation MUST preserve this laziness**: it is
  the difference between "offline project with a pinned version works" and "every
  invocation hits the network".

### Reference grammar

```
reference   := version | version "+" build | url
version     := <semver 2.0.0 version>
build       := algo [ "." hexdigest ]
algo        := "sha1" | "sha224" | "sha256" | "sha384" | "sha512" | <any hash name
                                                       the host crypto supports>
url         := <absolute URL, optionally with #algo.hexdigest fragment>
```

Note that the build suffix is semver's build-metadata field, so
`4.1.0+sha224.88b7a7…` is a *valid semver version* that compares equal to `4.1.0`.
This is deliberate: a hash-pinned spec is still range-comparable.

* `build[0]` = hash algorithm. Absent → `sha512`.
* `build[1]` = expected hex digest. Absent → no user-supplied hash to check; the
  registry signature path (§06.3) may synthesise one.

For URL references the fragment carries the same information:
`https://example.com/yarn.js#sha256.deadbeef` → `algo = sha256`,
`digest = deadbeef`.

## 2.2 Registry specs

How to *discover versions* of a package manager. Two shapes:

```jsonc
// npm-style: talk the npm registry protocol (§05.2)
{ "type": "npm", "package": "pnpm", "bin": "bin/yarn.js" /* optional */ }

// url-style: fetch one JSON document and read two fields out of it
{ "type": "url",
  "url": "https://repo.yarnpkg.com/tags",
  "fields": { "tags": "aliases", "versions": "tags" } }
```

For `type: "url"`:
* `fields.tags` names the object mapping dist-tag → version.
* `fields.versions` names either an array of versions or an object whose *keys* are
  versions. Both MUST be accepted.
* `fetchLatestStableVersion` reads `data[fields.tags].stable` — note **`stable`**,
  not `latest`, for URL registries.

`bin` on an npm registry spec is a path *inside the tarball* to a single file. When
present, the downloader extracts only that one file (§07.4) rather than the whole
package — this is how `@yarnpkg/cli-dist` is reduced to a single `yarn.js`.

## 2.3 Package manager definition

Each supported package manager has one definition:

```ts
{
  default: string,              // built-in fallback version, hash-pinned
  fetchLatestFrom: RegistrySpec,// where "what's the newest stable?" is answered
  transparent: {
    default?: string,           // fallback version for transparent commands only
    commands: string[][],       // command prefixes that bypass the project check
  },
  ranges: {                     // semver range → how to fetch that version band
    [range: string]: PackageManagerSpec
  },
  shimByDefault?: boolean,      // §10.5; absent means true
}
```

`default` is hash-pinned, and a conforming table MUST NOT pin a digest that varies
by host. For a per-host entry (§2.4) whose artifact differs per platform — which is
every real one — that means `default` is a **bare version**, and what clears §15.11's
verification tier for it is the registry signature over the host's own artifact
(§06.3) rather than a compiled-in literal. The same rule is why §07.6 step 3 does not
fold such a digest into the locator's reference.

`shimByDefault: false` keeps an entry out of the set a bare `jup enable` installs
(§10.5). It is for a name users routinely install deliberately and reach for outside
any project — `bun` and `deno` are runtimes first — where claiming the name on `PATH`
would be a takeover nobody asked for. Naming the entry (`jup enable bun`) still
installs it, and `disable` with no names still removes it.

`ranges` exists because a package manager's *download shape* changes across major
versions (pnpm's bin moved `.js` → `.cjs` → `.mjs`; Yarn 2+ is a single JS file from
a different host entirely). Lookup rule (`Engine::getPackageManagerSpecFor`):

> Take `Object.keys(ranges)`, **reverse** it, and return the spec for the first key
> whose range is satisfied by the version (using prerelease-tolerant satisfaction,
> §04.2). If none matches, it is an internal assertion failure, not a user error.

Because JS object key order is insertion order for non-integer keys, "reverse" means
**last-declared range wins**. A conforming implementation MUST therefore preserve
declaration order of the range table and check it in reverse. Implementations in
languages without ordered maps MUST store `ranges` as an ordered list of
`(range, spec)` pairs.

The **tag-resolution range** is a separate rule: dist-tags are always resolved
against `ranges[last key]` — the newest band (`Engine::resolveDescriptor`). So
`yarn@latest` consults `https://repo.yarnpkg.com/tags`, never the npm `yarn` package,
even though `yarn@1.22.22` would download from npm.

## 2.4 PackageManagerSpec

```ts
{
  url: string,                  // download URL template; "{}" ← version
  bin: BinSpec | BinList,       // see below
  registry: RegistrySpec,       // version source: which versions exist
  npmRegistry?: NpmRegistrySpec,// used INSTEAD of `registry` when the user has set
                                // a custom npm registry (§05.3)
  commands?: { use?: string[] },// argv to run after `jup use`/`up`

  // §15.28 — per-host artifacts. A band declaring any of these is a per-host band.
  targets?: Record<string, string>, // "<platform>-<arch>" → what "{target}" becomes
  artifactRegistry?: NpmRegistrySpec, // where the BYTES come from, when that is not
                                      // the package `registry` answers about
  exec?: "js" | "native",       // absent/"js" is §08.2's in-process handover
}
```

### Placeholders

`url` always substitutes `{}` with the version. Three more are opt-in per band and
described by §15.28:

| Placeholder | Expands to | Valid in |
|---|---|---|
| `{platform}` | `linux` \| `darwin` \| `win32` | `url`, `artifactRegistry.package` |
| `{arch}` | `x64` \| `arm64` | `url`, `artifactRegistry.package` |
| `{target}` | `targets[<platform>-<arch>]` | `url`, `artifactRegistry.package` |
| `{exe}` | `.exe` on Windows, empty elsewhere | `bin` **paths** (never bin names) |

`{target}` exists because published per-host artifact names are not the product of
two independent axes: bun renames both halves (`windows-aarch64` for what Node calls
`win32`/`arm64`), while deno keeps Node's spelling and suffixes only its Linux builds
(`linux-x64-glibc`). A table also makes the host set a band **declares**, so a host it
does not cover fails with §12's `unsupportedTarget` — naming the host and the versions
that do ship for it — instead of 404ing on a URL the user never typed.

A host outside the `{platform}`/`{arch}` vocabulary is a different error
(`unsupportedPlatform` / `unsupportedArch`), because the tool, not the release, is
what does not cover it. Both are raised **before any request**.

### `registry` vs `artifactRegistry`

For every JavaScript entry these are the same package and `artifactRegistry` is
absent. They separate when a package manager publishes a small **launcher** on npm
and its real binaries as per-host packages — which is how both bun and deno ship:

* `registry` answers §04's questions. Versions and dist-tags live on the launcher.
* `artifactRegistry` answers §06's and §07's. The bytes, the signed `dist.integrity`,
  and npm's signature over it live on `@oven/bun-<target>` / `@deno/<target>`, and
  those are the bytes about to be executed.

Pointing both at the launcher is the mistake this split exists to prevent: the
launcher is a `postinstall` stub that downloads the binary itself, and jup runs no
lifecycle scripts, so installing it would cache something that cannot run.

Consequences a conforming implementation MUST follow, all of them following from
"one version is many artifacts":

* The digest MUST NOT be folded into the locator's reference (§07.6 step 3), because
  that reference is what `use`/`up` write into `packageManager`. A per-host digest
  committed there fails every colleague on another platform with a hash mismatch.
* §15.23's `.jup.lock` records such a digest **per host** (see §15.23).
* The store marker still records the hash: the store is host-local, so there it is
  exactly the right fact.

**`bin` has two shapes and they are not interchangeable:**

* `BinSpec` = `{ [binaryName]: relativePathInPackage }` — used when the download is a
  tarball. e.g. `{"pnpm": "./bin/pnpm.mjs", "pnpx": "./bin/pnpx.mjs"}`.
* `BinList` = `[binaryName, …]` — used when the download is a **single `.js` file**.
  The file is placed at `<location>/<basename of url path>` and every listed name
  maps to it. e.g. Yarn 2+ declares `["yarn", "yarnpkg"]` and both run
  `<location>/yarn.js`.

For a **tarball**, the table's `BinSpec` is a fallback rather than the authority:
§07.7 reads the package's own `bin` first (§15.17), so a band whose paths have gone
stale cannot break an install. A `BinList` *is* authoritative, because a single-file
download carries no manifest to read.

A per-host artifact package is the third case, and it is why `{exe}` exists:
`@oven/bun-<target>` and `@deno/<target>` declare **no `bin` of their own**, so §07.7
finds nothing to read and the table is the authority for a tarball after all.

Two names mapping to one path is already the `BinSpec` spelling for "one file, two
names" (Yarn Classic's `yarn`/`yarnpkg`). For a **native** band it additionally
requires §15.28's `argv[0]` rule: the invoked name reaches the artifact as `argv[0]`,
which is how `bunx` and `bun` — literally the same executable — behave differently.

The union of all `bin` names across all ranges of all package managers is the set of
binary names the tool answers to (`Engine::getPackageManagerFor`,
`Engine::getBinariesFor`). It is also the set of shims `enable` creates (§10).

## 2.5 The embedded registry table

A conforming implementation MUST embed an equivalent of this table. It is the only
"configuration" the tool has, and it is compiled in — there is deliberately no
mechanism for a user to supply a different one at runtime.

> **Size/perf note.** In a native implementation this SHOULD be a `const` static
> structure (arrays of string slices), not a JSON blob parsed at startup. Parsing
> ~5 KB of JSON on every invocation is measurable against a 5 ms budget.

### npm

| Field | Value |
|---|---|
| `default` | `11.14.1+sha1.4a6839650da0005f323fec6abd39d77ee24f842f` |
| `fetchLatestFrom` | `{type: npm, package: npm}` |
| `transparent.commands` | `[["npm","init"], ["npx"]]` |
| `transparent.default` | — |

Single range `*`:
* `url` = `https://registry.npmjs.org/npm/-/npm-{}.tgz`
* `bin` = `{"npm": "./bin/npm-cli.js", "npx": "./bin/npx-cli.js"}`
* `registry` = `{type: npm, package: npm}`
* `commands.use` = `["npm", "install"]`

### pnpm

| Field | Value |
|---|---|
| `default` | `11.1.2+sha1.ed39d701687311ce9345771c62376f9fe7286694` |
| `fetchLatestFrom` | `{type: npm, package: pnpm}` |
| `transparent.commands` | `[["pnpm","init"], ["pnpx"], ["pnpm","dlx"]]` |
| `transparent.default` | — |

Ranges, **in declaration order** (remember: matched in reverse):

| Range | `url` | `bin` |
|---|---|---|
| `<6.0.0` | `https://registry.npmjs.org/pnpm/-/pnpm-{}.tgz` | `{pnpm: ./bin/pnpm.js, pnpx: ./bin/pnpx.js}` |
| `6.x \|\| 7.x \|\| 8.x \|\| 9.x \|\| 10.x` | same | `{pnpm: ./bin/pnpm.cjs, pnpx: ./bin/pnpx.cjs}` |
| `>=11.0.0` | same | `{pnpm: ./bin/pnpm.mjs, pnpx: ./bin/pnpx.mjs}` |

All three: `registry` = `{type: npm, package: pnpm}`, `commands.use` =
`["pnpm", "install"]`.

> The bands are contiguous and exhaustive: reversed, `>=11.0.0` is tested first,
> then `6.x || … || 10.x`, then `<6.0.0`. Prereleases are covered because
> satisfaction strips the prerelease tag before testing (§04.2), so `10.5.0-rc.1`
> matches `10.x` and lands in the `.cjs` band.

### yarn

| Field | Value |
|---|---|
| `default` | `1.22.22+sha1.ac34549e6aa8e7ead463a7407e1c7390f61a6610` |
| `fetchLatestFrom` | `{type: npm, package: yarn}` |
| `transparent.commands` | `[["yarn","init"], ["yarn","dlx"]]` |
| `transparent.default` | `4.14.1+sha224.88b7a7244bbd9040380c417f7eb556d85c67640b651f113cb4c72113` |

Ranges, in declaration order:

**`<2.0.0`** (Yarn Classic — a normal npm tarball)
* `url` = `https://registry.yarnpkg.com/yarn/-/yarn-{}.tgz`
* `bin` = `{"yarn": "./bin/yarn.js", "yarnpkg": "./bin/yarn.js"}`
* `registry` = `{type: npm, package: yarn}`
* `commands.use` = `["yarn", "install"]`

**`>=2.0.0`** (Yarn Berry — a single bundled JS file)
* `url` = `https://repo.yarnpkg.com/{}/packages/yarnpkg-cli/bin/yarn.js`
* `bin` = `["yarn", "yarnpkg"]`  ← BinList, single-file form
* `registry` = `{type: url, url: https://repo.yarnpkg.com/tags,
   fields: {tags: "aliases", versions: "tags"}}`
* `npmRegistry` = `{type: npm, package: "@yarnpkg/cli-dist", bin: "bin/yarn.js"}`
* `commands.use` = `["yarn", "install"]`

The `npmRegistry` fallback is what makes Yarn Berry installable from a corporate npm
mirror: `repo.yarnpkg.com` is not an npm registry and cannot be mirrored, so when the
user sets a custom npm registry the tool switches to the `@yarnpkg/cli-dist` package
and extracts only `bin/yarn.js` from its tarball (§05.3, §07.4).

> **Note.** `default` for yarn is Yarn **1**, but `transparent.default` is Yarn **4**.
> This asymmetry is intentional and MUST be preserved: it keeps `yarn` in a bare
> directory behaving like the classic global yarn, while `yarn dlx` — which classic
> yarn does not have — gets a modern release.

### bun

> §15.21 — added under §15.28's per-host model. Bun is not JavaScript, and on npm it
> ships as a ~15 kB launcher (`bun`) whose `postinstall` downloads a binary out of
> `optionalDependencies`. jup runs no lifecycle scripts, so the launcher is the
> *version source* only; the artifact is the per-host package.

| Field | Value |
|---|---|
| `default` | `1.4.0` — bare, per §2.3 |
| `fetchLatestFrom` | `{type: npm, package: bun}` |
| `transparent.commands` | `[["bun","init"], ["bun","create"], ["bun","x"], ["bunx"]]` |
| `transparent.default` | — |
| `shimByDefault` | `false` |

Every band shares:
* `url` = `https://registry.npmjs.org/@oven/bun-{target}/-/bun-{target}-{}.tgz`
* `bin` = `{"bun": "./bin/bun{exe}", "bunx": "./bin/bun{exe}"}` — one file, two names
* `registry` = `{type: npm, package: bun}`
* `artifactRegistry` = `{type: npm, package: "@oven/bun-{target}"}`
* `exec` = `"native"`
* `commands.use` = `["bun", "install"]`

Ranges, **in declaration order** (matched in reverse), differing only in `targets` —
the host set bun had actually published at that point in its history:

| Range | `targets` adds |
|---|---|
| `*` | `darwin-arm64`→`darwin-aarch64`, `darwin-x64`→`darwin-x64`, `linux-arm64`→`linux-aarch64`, `linux-x64`→`linux-x64` |
| `>=1.1.0` | …and `win32-x64`→`windows-x64` |
| `>=1.3.10` | …and `win32-arm64`→`windows-aarch64` |

> `@oven/bun-*` first appeared in 0.5.0, Windows in 1.1.0, Windows on arm64 in 1.3.10.
> Reversed, the narrowest true answer wins, so `bun@1.2.0` on Windows arm64 reports
> that *that version* has no build for this host rather than 404ing.

### deno

> §15.21, same model. The `deno` npm package is a launcher with the same
> `postinstall` shape; `@deno/<target>` carries a single executable at the package
> root, not under `bin/`.

| Field | Value |
|---|---|
| `default` | `2.9.5` — bare, per §2.3 |
| `fetchLatestFrom` | `{type: npm, package: deno}` |
| `transparent.commands` | `[["deno","init"]]` |
| `transparent.default` | — |
| `shimByDefault` | `false` |

Single range `*`:
* `url` = `https://registry.npmjs.org/@deno/{target}/-/{target}-{}.tgz`
* `bin` = `{"deno": "./deno{exe}"}`
* `registry` = `{type: npm, package: deno}`
* `artifactRegistry` = `{type: npm, package: "@deno/{target}"}`
* `targets` = `darwin-arm64`→`darwin-arm64`, `darwin-x64`→`darwin-x64`,
  `linux-arm64`→`linux-arm64-glibc`, `linux-x64`→`linux-x64-glibc`,
  `win32-arm64`→`win32-arm64`, `win32-x64`→`win32-x64`
* `exec` = `"native"`
* `commands.use` = `["deno", "install"]`

> One band: `@deno/<target>` arrived with the 1.46.0 relaunch of the npm package and
> has kept one layout since. Only `deno init` is transparent — `deno run`, `deno task`
> and `deno add` all act on the project they are standing in, so §03.5's enforcement
> still applies to them.

> **On `transparent.commands` for both.** `bun x` and `bunx` are the same operation
> and both are listed, because §01.4 matches an argv *prefix* and a user types either.

## 2.6 Trust store

```jsonc
"keys": {
  "npm": [
    { "expires": "2025-01-29T00:00:00.000Z",
      "keyid":   "SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA",
      "keytype": "ecdsa-sha2-nistp256",
      "scheme":  "ecdsa-sha2-nistp256",
      "key":     "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE1Olb3zMAFFxXKHiIkQO5cJ3Yhl5i6UPp+IhuteBJbuHcA5UogKo0EWtlWwW6KSaKoTNEYL7JlCQiVnkhBktUgg==" },
    { "expires": null,
      "keyid":   "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U",
      "keytype": "ecdsa-sha2-nistp256",
      "scheme":  "ecdsa-sha2-nistp256",
      "key":     "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEY6Ya7W++7aUPzvMTrezH6Ycx3c+HOKYCcNGybJZSCJq/fd7Qa8uuAKtdIkUQtQiEKERhAmE5lMMJhP8OkDOa2g==" }
  ]
}
```

`key` is a base64 DER **SubjectPublicKeyInfo** for an ECDSA public key — npm's own
keys are NIST P-256, but the curve is read from the key material and a store supplied
for another registry may use any curve. See §06.3 for the verification algorithm and
§11 for the `COREPACK_INTEGRITY_KEYS` override.

> **Divergence (§14.4):** the `expires` field is *present in the data but never
> consulted* by corepack. This spec requires implementations to store it and
> **SHOULD** reject a signature made with an expired key, reporting which key
> expired. See §06.5.

## 2.7 Project-manifest data

```ts
// package.json, the only project file that is read
{
  packageManager?: string,               // "yarn@4.1.0+sha224.…"
  devEngines?: {
    packageManager?: {
      name: string,                      // must not contain "@"
      version?: string,                  // a semver RANGE
      onFail?: "ignore" | "warn" | "error"
    }
  }
}
```

Precedence and validation are specified in §03.3.
