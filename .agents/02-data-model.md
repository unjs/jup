# 02 — Data Model

## 2.1 Core value types

Three types carry the whole pipeline. Keeping them distinct is what makes the
resolution stages checkable.

```
Descriptor  { name: string, range: string }    "what the project asked for"
Locator     { name: string, reference: string } "the exact thing to install"
InstallSpec { location, bin, hash }             "where it landed on disk"
```

* **Descriptor** — `name` is a tool name (`npm` | `pnpm` | `yarn` | `bun` | `deno` |
  `aube` | `nub` | `node`) or, in unsafe-URL mode, still one of those names. `range` is *any* of: an exact semver
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
{ "type": "npm", "package": "pnpm" }

// url-style: fetch one JSON document and read two fields out of it.
// No entry in the table declares one since §15.41; the shape is retained for a
// tool published somewhere that is not an npm registry.
{ "type": "url",
  "url": "https://example.invalid/tags",
  "fields": { "tags": "aliases", "versions": "tags" } }
```

For `type: "url"`:
* `fields.tags` names the object mapping dist-tag → version.
* `fields.versions` names either an array of versions or an object whose *keys* are
  versions. Both MUST be accepted.
* `fetchLatestStableVersion` reads `data[fields.tags].stable` — note **`stable`**,
  not `latest`, for URL registries.

An npm registry spec has no `bin`. It named a path *inside the tarball* and made
the downloader extract only that one file, which existed so `@yarnpkg/cli-dist`
could be reduced to a single `yarn.js`. §15.41 removed it along with the rest of
the single-file machinery; §07.4 always extracts the whole archive.

## 2.3 Tool definition

Each supported tool has one definition:

```ts
{
  kind?: "package-manager" | "runtime", // §15.39; absent means "package-manager"
  default: string,              // built-in fallback version, hash-pinned
  tags?: Record<string,string>, // §15.42 — dist-tags the table answers itself,
                                // before the registry is asked and never age-capped
  fetchLatestFrom: RegistrySpec,// where "what's the newest stable?" is answered
  transparent: {
    default?: string,           // fallback version for transparent commands only
    commands: string[][],       // command prefixes that bypass the project check
  },
  ranges: {                     // semver range → how to fetch that version band
    [range: string]: PackageManagerSpec
  },
  shimByDefault?: boolean,      // §10.5; absent means true
  versionFile?: {               // §15.40; absent means "this tool has none"
    path: string,               // file name, looked for in §3.1's walk
    format: "nvm",              // content grammar
  },
}
```

### `kind`

`kind` is what makes jup a **tool** manager rather than strictly a package-manager
manager, and it is the only field that decides which of §03's rules an entry is
subject to. Absent means `"package-manager"` — which is every entry corepack ever
had, and every entry above.

| | `"package-manager"` | `"runtime"` |
|---|---|---|
| Project pin is read from | `packageManager`, else `devEngines.packageManager` (§03.3) | `devEngines.runtime` (§03.3) |
| May be named in `packageManager` | yes | **no** (§03.4, §12.12) |
| §03.5's name mismatch | enforced | never applies |
| `transparent.commands` | consulted (§01.4) | unused: nothing needs to bypass an enforcement that never runs |
| `commands.use` | run by `use` / `up` (§09.5) | absent — a runtime installs nothing |
| Default shim set | `shimByDefault` decides (§10.5) | same rule, and the answer MUST be `false` |

The split is deliberately narrow. A runtime resolves, downloads, verifies, caches and
executes through the *same* pipeline (§04–§08) — §15.28's per-host model in
particular is the whole of what a runtime needs. What differs is only which field of
the manifest speaks for it, and whether standing in someone else's project is an
error.

The last row is a requirement, not an observation: §10.5's test is whether the name
means anything outside a project, and a runtime's name means something outside a
project by definition. An entry with `kind: "runtime"` and no `shimByDefault: false`
is a malformed table.

`default` is hash-pinned, and a conforming table MUST NOT pin a digest that varies
by host. For a per-host entry (§2.4) whose artifact differs per platform — which is
every real one — that means `default` is a **bare version**, and what clears §15.11's
verification tier for it is the registry signature over the host's own artifact
(§06.3) rather than a compiled-in literal. The same rule is why §07.6 step 3 does not
fold such a digest into the locator's reference.

`shimByDefault: false` keeps an entry out of the set a bare `jup enable` installs
(§10.5). It is for a name users routinely install deliberately and reach for outside
any project — `bun`, `deno` and `nub` all run a file you hand them — where claiming
the name on `PATH` would be a takeover nobody asked for. Naming the entry
(`jup enable bun`) still installs it, and `disable` with no names still removes it.

### `versionFile`

`versionFile` names a file the tool's **own ecosystem** already writes the wanted
version into — `.nvmrc` for node — and is what lets jup answer correctly in a
repository that has never heard of it. §15.40 states the rule; the parts that belong
to the data model are these:

* It is a per-entry **table** fact, so the file name appears in the table and nowhere
  else. §15.21 requires that adding one be a data-only change, and §03's walk
  therefore must not know what it is looking for.
* It is **not** a property of `kind`. A runtime whose ecosystem has no such
  convention declares none, and nothing stops a package manager from declaring one if
  its ecosystem grows a file worth reading.
* `format` is the grammar of the contents, not the file name. Two ecosystems spelling
  the same grammar differently are two formats; two file names carrying one grammar
  are one.
* It ranks strictly **below** the manifest and strictly **above** §03.5's fallback,
  and jup never writes it (§03.7 writes the `devEngines` member and only that).

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
`yarn@latest` consults `@yarnpkg/cli-dist`'s dist-tags, never the npm `yarn` package,
even though `yarn@1.22.22` would download from that one. Before §15.41 the newest
band was `https://repo.yarnpkg.com/tags`, so the two differed in protocol as well.

## 2.4 PackageManagerSpec

> Spelled `ToolSpec` in the implementation since §15.39, along with
> `PackageManagerDefinition` → `ToolDefinition`. The section keeps its number and
> its old title so the several hundred cross-references to "§02.4's `bin`" and
> "a `PackageManagerSpec`" elsewhere in these files stay accurate; the type
> describes a band of any tool, of either `kind`.

```ts
{
  url: string,                  // download URL template; "{}" ← version
  bin: BinSpec,                 // see below
  registry: RegistrySpec,       // version source: which versions exist — always
                                // `type: "npm"` (§15.41)
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
| `{target}` | `targets[<host>]` | `url`, `artifactRegistry.package` |
| `{exe}` | `.exe` on Windows, empty elsewhere | `bin` **paths** (never bin names) |

`<host>` — the key `targets` is indexed by — is `<platform>-<arch>`, and on a musl
Linux `<platform>-<arch>-musl`. Linux is the one platform where the pair alone does
not name a binary interface, and publishers that ship both say so in the artifact
name (`@oven/bun-linux-x64-musl`, `@nubjs/nub-linux-x64-musl`). glibc stays
unsuffixed, so an existing `targets` map and an existing `.jup.lock` key keep meaning
what they meant; a musl host is the only one that sees a new key, and it is the host
that was previously being handed a glibc binary that could not start.

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

**`bin` has one shape:** `BinSpec` = `{ [binaryName]: relativePathInPackage }`,
e.g. `{"pnpm": "./bin/pnpm.mjs", "pnpx": "./bin/pnpx.mjs"}`.

There used to be a second, `BinList` = `[binaryName, …]`, for a download that was a
single `.js` file: the file landed at `<location>/<basename of url path>` and every
listed name mapped to it, which is how Yarn 2+ declared `["yarn", "yarnpkg"]`.
§15.41 moved Berry to a tarball and no band declares a single file any more. Two
remnants are deliberate: a **URL reference** to a `.js` (§04.1 step 1) still
produces one, recording a `BinSpec` that names the file; and a `bin` **array** in a
marker an earlier release wrote MUST still be read (§07.1).

The table's `BinSpec` is a fallback rather than the authority: §07.7 reads the
package's own `bin` first (§15.17), so a band whose paths have gone stale cannot
break an install.

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
* `url` = `https://registry.npmjs.org/yarn/-/yarn-{}.tgz`  ← `registry.yarnpkg.com` before §15.41
* `bin` = `{"yarn": "./bin/yarn.js", "yarnpkg": "./bin/yarn.js"}`
* `registry` = `{type: npm, package: yarn}`
* `commands.use` = `["yarn", "install"]`

**`>=2.0.0`** (Yarn Berry — `@yarnpkg/cli-dist`, an ordinary npm tarball since §15.41)
* `url` = `https://registry.npmjs.org/@yarnpkg/cli-dist/-/cli-dist-{}.tgz`
* `bin` = `{"yarn": "./bin/yarn.js", "yarnpkg": "./bin/yarn.js"}`
* `registry` = `{type: npm, package: "@yarnpkg/cli-dist"}`
* `commands.use` = `["yarn", "install"]`

  Before §15.41 this band was a single `yarn.js` on `repo.yarnpkg.com`, with a
  url-type `registry` reading `aliases`/`tags` and an `npmRegistry` fallback that
  swapped in `@yarnpkg/cli-dist` only once the user had configured an npm registry.

The `npmRegistry` fallback was what made Yarn Berry installable from a corporate npm
mirror: `repo.yarnpkg.com` is not an npm registry and cannot be mirrored, so setting a
custom npm registry switched the tool to the `@yarnpkg/cli-dist` package and extracted
only `bin/yarn.js` from its tarball. §15.41 made that package the band for everyone
and removed the filtered extraction, so **no entry declares `npmRegistry`** and the
fallback has no subject (§05.3, §07.4).

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
| `>=1.1.39` | …and `linux-arm64-musl`→`linux-aarch64-musl`, `linux-x64-musl`→`linux-x64-musl` |
| `>=1.3.10` | …and `win32-arm64`→`windows-aarch64` |

> `@oven/bun-*` first appeared in 0.5.0, Windows in 1.1.0, the musl builds in 1.1.39,
> Windows on arm64 in 1.3.10. Reversed, the narrowest true answer wins, so `bun@1.2.0`
> on Windows arm64 reports that *that version* has no build for this host rather than
> 404ing.

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

> Deno publishes no musl build, and the `-glibc` suffix on its Linux target names says
> so. A musl host is therefore outside its declared set and gets `unsupportedTarget`,
> naming `linux-x64-musl` — which is the true answer, and better than the glibc
> artifact it would otherwise be handed.

> **On `transparent.commands` for both.** `bun x` and `bunx` are the same operation
> and both are listed, because §01.4 matches an argv *prefix* and a user types either.

### aube

> §15.21, the same per-host model a third time. `@endevco/aube` is a ~12 kB package
> whose `preinstall` runs `npm install @endevco/aube-<host>` and hardlinks the three
> binaries out of it; jup asks for that package directly.

| Field | Value |
|---|---|
| `default` | `2.2.0` — bare, per §2.3 |
| `fetchLatestFrom` | `{type: npm, package: "@endevco/aube"}` |
| `transparent.commands` | `[["aube","init"], ["aube","create"], ["aube","dlx"], ["aubx"]]` |
| `transparent.default` | — |
| `shimByDefault` | absent — **yes**, aube is a package manager, not a runtime (§10.5) |

Single range `*`:
* `url` = `https://registry.npmjs.org/@endevco/aube-{target}/-/aube-{target}-{}.tgz`
* `bin` = `{"aube": "./bin/aube{exe}", "aubr": "./bin/aubr{exe}", "aubx": "./bin/aubx{exe}"}`
* `registry` = `{type: npm, package: "@endevco/aube"}`
* `artifactRegistry` = `{type: npm, package: "@endevco/aube-{target}"}`
* `targets` = the identity on `darwin-arm64`, `linux-arm64`, `linux-arm64-musl`,
  `linux-x64`, `linux-x64-musl`, `win32-arm64`, `win32-x64`
* `exec` = `"native"`
* `commands.use` = `["aube", "install"]`

> **Why an identity map is still a map.** aube publishes under `<host>` verbatim, musl
> suffix included, so `{target}` could in principle have been `{platform}-{arch}`. It
> is a `targets` map because a map is a *declaration of the host set*, and aube's has
> a hole: **there is no `darwin-x64` build.** An Intel Mac must be told that before any
> request rather than after a 404 on a package that has never existed.

> **One band, deliberately.** aube's host set moved once — the musl artifacts start at
> `1.0.0-beta.12` — and that boundary is unexpressible: §2.3 matches bands with
> prerelease-tolerant satisfaction, which strips the prerelease from both sides, so
> `>=1.0.0-beta.12` and `>=1.0.0` are the same range and neither excludes
> `1.0.0-beta.2`. bun's bands work because its boundaries are releases. Declaring a
> band the lookup cannot honour would be worse than the 404 the eleven affected
> prereleases get on Alpine.

> **`aubr` and `aubx`** are `aube run` and `aube dlx` — three names over hardlinks of
> one executable, dispatching on `argv[0]`, the same arrangement as `bun`/`bunx`. Only
> `aubx` and `aube dlx` are transparent, along with `aube init` and `aube create`,
> which are how a project comes to exist. `aubr <script>` and `aube exec` act on the
> project they stand in and stay subject to §03.5.

> Unlike bun's and deno's, aube's per-host packages **do** declare a `bin`, so §07.7
> reads it and the table's copy is the ordinary fallback. The two agree.

### nub

> §15.21, the per-host model a fourth time. `@nubjs/nub` is a ~30 kB Node launcher
> that resolves an `optionalDependencies` entry named after the host and spawns the
> binary inside it; jup resolves no dependency graph, so it asks for that package.

| Field | Value |
|---|---|
| `default` | `0.7.5` — bare, per §2.3 |
| `fetchLatestFrom` | `{type: npm, package: "@nubjs/nub"}` |
| `transparent.commands` | `[["nub","init"], ["nub","dlx"], ["nub","x"], ["nubx"]]` |
| `transparent.default` | — |
| `shimByDefault` | `false` — nub is a package manager *and* a runtime (§10.5) |

Single range `*`:
* `url` = `https://registry.npmjs.org/@nubjs/nub-{target}/-/nub-{target}-{}.tgz`
* `bin` = `{"nub": "./bin/nub{exe}", "nubx": "./bin/nub{exe}"}` — one file, two names
* `registry` = `{type: npm, package: "@nubjs/nub"}`
* `artifactRegistry` = `{type: npm, package: "@nubjs/nub-{target}"}`
* `targets` = the identity on all eight of `darwin-arm64`, `darwin-x64`,
  `linux-arm64`, `linux-arm64-musl`, `linux-x64`, `linux-x64-musl`, `win32-arm64`,
  `win32-x64`
* `exec` = `"native"`
* `commands.use` = `["nub", "install"]`

> **The identity, without a hole.** nub's launcher computes
> `${process.platform}-${process.arch}` and appends `-musl` on a musl Linux — this
> section's `<host>` rule, written out in someone else's repository — so `{target}`
> is `<host>` for every host the table can name. The map is still written out, on
> aube's reasoning minus the hole: a band with no `targets` claims every host
> forever, and the map is where a host leaving the set would be said.

> **One band.** The eight have been the eight since `0.0.2`, the first release whose
> per-host packages carried a binary. (`0.0.1` published 273-byte placeholders with
> nothing inside; that version resolves to a missing entry point, which is what a
> version with no artifact should do.) The package's internal layout has moved
> several times; `bin/nub{exe}` has been in all of them, and it is the only path the
> band names.

> **`nub` and `nubx` are one file.** The per-host packages shipped a byte-identical
> `bin/nubx` until 0.7.0 and dropped it because it doubled a ~50 MB artifact per
> host. So the table points both names at `bin/nub{exe}` and relies on §15.28's
> `argv[0]` rule, exactly as `bun`/`bunx` does. Only `nubx`, `nub x`, `nub dlx` and
> `nub init` are transparent; `nub run`, `nub install` and `nub <file>` act on the
> project they stand in and stay subject to §03.5.

> Like bun's and deno's — and unlike aube's — nub's per-host packages declare **no
> `bin`**, so §07.7 finds nothing to read and the table is the authority.

### node

> §15.39 — the entry that makes jup a tool manager rather than a package-manager
> manager. Node is a runtime and nothing else, so it is the first entry carrying
> `kind: "runtime"`, and it needs no machinery §15.28 had not already built.
>
> The `node` npm package is the launcher shape, in its oldest instance: ~1.8 kB, a
> `preinstall` that runs `node-bin-setup`, which `npm install`s one per-host package
> and hardlinks the binary out of it. jup runs no lifecycle scripts, so it asks for
> that package directly.

| Field | Value |
|---|---|
| `kind` | `runtime` |
| `default` | `24.20.0` — bare, per §2.3 |
| `tags` | `{lts: "24.20.0"}` — §15.42; npm's own tags cannot answer `lts` |
| `fetchLatestFrom` | `{type: npm, package: node}` |
| `transparent.commands` | `[]` — a runtime is never enforced against (§2.3) |
| `transparent.default` | — |
| `shimByDefault` | `false` — required of a runtime (§2.3, §10.5) |
| `versionFile` | `{path: ".nvmrc", format: "nvm"}` — §15.40 |

Single range `*`:
* `url` = `https://registry.npmjs.org/node-{target}/-/node-{target}-{}.tgz`
* `bin` = `{"node": "./bin/node{exe}"}`
* `registry` = `{type: npm, package: node}`
* `artifactRegistry` = `{type: npm, package: "node-{target}"}`
* `targets` = `darwin-arm64`→`bin-darwin-arm64`, `darwin-x64`→`darwin-x64`,
  `linux-arm64`→`linux-arm64`, `linux-x64`→`linux-x64`,
  `win32-arm64`→`win-arm64`, `win32-x64`→`win-x64`
* `exec` = `"native"`
* `commands.use` = — (§2.3: a runtime installs nothing)

> **Why `{target}` renames three of the six.** The per-host packages are
> `node-<platform>-<arch>` with `win32` spelled `win` — and on Apple Silicon the
> prefix is `node-bin-`, because `node-darwin-arm64` belongs to an unrelated
> publisher and stops at 18.9.0. `node-bin-setup` makes exactly that substitution,
> unconditionally, so folding it into `{target}` is the launcher's own rule rather
> than an invention of this table. It is also why one band is enough: the mapping
> has not moved.

> **These packages declare their own `bin`** — `bin/node`, and `bin/node.exe` on the
> two Windows targets — so §07.7 reads it and the table's copy is the ordinary
> fallback, as with aube. The two agree.

> **No musl build.** Node publishes none officially, so an Alpine host is outside the
> declared set and gets `unsupportedTarget` naming `linux-x64-musl` before any
> request, exactly as deno's absence does (§15.28). `linux-armv7l` — which node
> *does* publish — is outside §15.28's `{arch}` vocabulary altogether and is the
> other error, `unsupportedArch`.

> **`.nvmrc`.** The one field here that is not about fetching bytes. `node` is the
> first entry whose ecosystem has a version file of its own, and it is a widely
> written one — so a checkout that has never heard of jup still says which node it
> wants, and §15.40 is jup reading it. It ranks below `devEngines.runtime`, is never
> written, and answers only what a semver range can answer: the numeric forms need no
> translation at all, `node` and `stable` are the newest release, and the LTS aliases
> are refused because the launcher's dist-tags cannot answer them (§15.40).

> **On consent.** §15.21's requirement covers this entry too, and it is the one where
> the launcher package is not published by the project whose name it carries: `node`
> on npm is a community package, maintained separately from Node.js itself. §15.39
> records what that changes and what it does not.

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
  packageManager?: string,               // "yarn@4.1.0+sha224.…"; never a runtime
  devEngines?: {
    packageManager?: {
      name: string,                      // must not contain "@"
      version?: string,                  // a semver RANGE
      onFail?: "ignore" | "warn" | "error"
    },
    // §15.39 — the same shape, and the only place a `kind: "runtime"` entry
    // (§2.3) can be pinned. There is no top-level field for a runtime.
    runtime?: {
      name: string,
      version?: string,
      onFail?: "ignore" | "warn" | "error"
    }
  }
}
```

Precedence and validation are specified in §03.3. The two `devEngines` members are
validated by one rule with the member name substituted into its messages, and they
are read independently: which one speaks is decided by the `kind` of the tool being
requested, so a project may pin both and neither constrains the other.

`devEngines` also standardises `os`, `cpu` and `libc`. jup reads neither, and adding
them would be a scope change (§01.7), not a completion.
