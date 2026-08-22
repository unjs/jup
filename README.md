# pipack

<!-- automd:badges color=yellow -->

[![npm version](https://img.shields.io/npm/v/pipack?color=yellow)](https://npmjs.com/package/pipack)
[![npm downloads](https://img.shields.io/npm/dm/pipack?color=yellow)](https://npm.chart.dev/pipack)

<!-- /automd -->

A fast, small, zero-dependency **package manager version manager**: it reads the package
manager your project declares, fetches that exact version, verifies it, caches it, and
runs it.

```jsonc
// package.json
{ "packageManager": "pnpm@11.1.2+sha1.ed39d701687311ce9345771c62376f9fe7286694" }
```

```sh
pnpm install   # runs pnpm 11.1.2 — the version this project pinned, not whatever is installed
```

> [!NOTE]
> **Early, but it runs.** Every module specified in [`.agents/`](./.agents/) is
> implemented, the conformance suite passes, and the CLI works end to end. There is no
> published release yet, so treat this as pre-1.0. See [Status](#status).

## Why

A project that pins `pnpm@11.1.2` and gets pnpm 9 produces a different lockfile, a
different dependency tree, and a bug that reproduces on one machine and not another.
Pinning the package manager fixes that — but only if something enforces the pin.

pipack is that something. It occupies the names `npm`, `npx`, `pnpm`, `pnpx`, `yarn`, and
`yarnpkg` on your `PATH`. When you type `yarn`, it works out which Yarn this project
wants, makes sure that exact version is present and verified, and hands over. You should
not be able to tell the difference from a directly-installed Yarn, except that the
version is now correct.

It is a drop-in re-implementation of [corepack](https://github.com/nodejs/corepack): the
same `packageManager` field, the same `COREPACK_*` environment variables, the same cache
layout, the same error messages. Where it deliberately differs — mostly to close security
holes — those differences are listed under [Divergences](#divergences).

## Install

```sh
npm install -g pipack
```

Then put the shims on your `PATH`:

```sh
pipack enable
```

## Usage

### Pinning a package manager

```sh
pipack use pnpm@11        # resolve, install, and write the pin into package.json
pipack up                 # bump the pin to the newest release in the same major line
```

Both write a hash-bearing pin, computed from the bytes actually downloaded:

```jsonc
{ "packageManager": "pnpm@11.1.2+sha1.ed39d701687311ce9345771c62376f9fe7286694" }
```

`devEngines.packageManager` is read too, and takes part in validation:

```jsonc
{
  "devEngines": {
    "packageManager": { "name": "pnpm", "version": "11.x", "onFail": "error" },
  },
}
```

### Running a package manager

Once `pipack enable` has run, nothing is different — `yarn add x`, `pnpm install`, and
`npx cowsay` all work as they always did, at the version your project declares. You can
also be explicit, which needs no shims:

```sh
pipack yarn add lodash
pipack yarn@1.22.4 --version   # override the project's pin for one invocation
```

### Offline and container images

Warm the cache in a build layer, then run with no network at all:

```sh
pipack install                       # cache the version this project pins
pipack pack pnpm@11.1.2              # or: build a portable archive on a networked machine
pipack install -g corepack.tgz       # and seed a cache from it elsewhere
```

## Commands

| Command                              | What it does                                                             |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `pipack <binary>[@<version>] [...]`  | Run a package manager at the project's version, or an explicit one        |
| `pipack enable [...name]`            | Install shims for each package manager onto `PATH`                        |
| `pipack disable [...name]`           | Remove them again                                                         |
| `pipack use <name[@<version>]>`      | Resolve, install, pin into `package.json`, then run the install command   |
| `pipack up`                          | Bump the project's pin within its current major line                      |
| `pipack install`                     | Download and cache the version this project pins                          |
| `pipack install -g [...name\|<file>]`| Install globally, or seed the cache from a `pack` archive                 |
| `pipack pack [...name]`              | Build a portable archive of cached versions                               |
| `pipack cache clean`                 | Empty the download cache                                                  |
| `pipack --version`, `pipack --help`  | The usual                                                                 |

`enable` and `disable` accept `--install-directory <path>`; `install -g` accepts
`--cache-only`; `pack` accepts `-o/--output <path>` and `--json`.

Note that `pipack yarn --version` prints **Yarn's** version, not pipack's — proxy mode
shadows the built-in commands, by design.

## Configuration

Every knob is an environment variable. There is no config file, no plugin system, and no
telemetry; the full list lives in [`.agents/11-environment.md`](./.agents/11-environment.md).
The ones you are most likely to want:

| Variable                            | Effect                                                            |
| ----------------------------------- | ----------------------------------------------------------------- |
| `COREPACK_HOME`                     | Where the store and recorded defaults live                        |
| `COREPACK_NPM_REGISTRY`             | Fetch package managers from a mirror                              |
| `COREPACK_ENABLE_NETWORK=0`         | Refuse every network request; run from cache only                 |
| `COREPACK_ENABLE_STRICT=0`          | Don't error when you invoke a package manager the project doesn't use |
| `COREPACK_ENABLE_AUTO_PIN=1`        | Write a pin automatically when a project has none                 |
| `COREPACK_ENABLE_DOWNLOAD_PROMPT=1` | Announce (and on a TTY, confirm) each download                    |
| `COREPACK_INTEGRITY_KEYS`           | Replace the built-in trust store, or set `0` to skip verification  |
| `COREPACK_REQUIRE_SIGNATURES=1`     | Refuse a registry that publishes no signature, rather than warning |

A project may also ship a `.corepack.env` file supplying the *behavioural* variables.
Security-relevant ones are deliberately not settable that way — see
[Divergences](#divergences).

## How a version is verified

Every artifact must clear a check before it is allowed into the cache:

- **A hash you pinned.** `pnpm@11.1.2+sha1.ed39…` is checked against the downloaded
  bytes. An explicit hash is the strongest assertion available, and it takes precedence
  over everything else.
- **npm's registry signature.** With no pinned hash, the ECDSA signature over
  `<name>@<version>:<integrity>` is verified against a built-in trust store, and the
  `integrity` it covers becomes the expected hash. That chains a trusted key all the way
  to the bytes on disk.
- **The registry's own digest, with a warning.** Proxies such as Artifactory and Nexus
  routinely strip `dist.signatures`. When they do — and only then — pipack asks the
  package-root endpoint once, and if that is unsigned too it falls back to checking the
  bytes against the registry's `integrity`, saying so once. Set
  `COREPACK_REQUIRE_SIGNATURES=1` to refuse instead. A registry publishing neither a
  signature nor a digest is always refused, and metadata with no `dist` section at all
  names the registry rather than crashing.

A failed check discards the download and caches nothing, so a re-run fails the same way
rather than silently succeeding.

## Divergences

pipack matches corepack's observable behaviour — same fields, same variables, same
strings — with a set of deliberate departures, each closing a defect or a security hole.
The full list with rationale is in
[`.agents/14-divergences.md`](./.agents/14-divergences.md); the ones you might notice:

- **A project's `.corepack.env` cannot disable signature verification**, supply trust
  keys, allow arbitrary download URLs, or set registry credentials. Those come from the
  real environment only. Cloning a repository and running `yarn` should not hand it your
  npm token.
- **Credentials never leave the configured registry's origin**, on any request path.
- **Signing-key expiry is honoured** rather than stored and ignored.
- **Tarball URLs are validated** against the configured registry rather than accepted for
  starting with the letters `http`.
- **Digests are compared in constant time**, SRI strings are parsed properly rather than
  assumed to be `sha512`, and unknown hash algorithms produce a clear error.
- **Archive extraction is hardened**: no path traversal, no symlink escapes, no device
  entries, no setuid bits, and bounded output.
- **The UTF-8 BOM survives** a `use` or `up` that rewrites your `package.json`.

## Status

Phase 1 — the behavioural contract in [`.agents/01`](./.agents/01-overview.md)–[`14`](./.agents/14-divergences.md) — is complete:

| Area | State |
| --- | --- |
| Specification (`.agents/`) | 16 normative documents |
| Implementation | 13 modules, zero runtime dependencies |
| Conformance suite (§13, rows 1–147) | Passing — 5 rows skipped, each documenting why |
| Unit tests | 794 passing |
| Audit (correctness / speed / security / simplicity) | Complete, findings applied |
| Published release | Not yet |

Measured, not hoped for:

- **22 kB** min+gzipped, **zero** runtime dependencies.
- **~38 ms** for a warm proxy invocation against **~22 ms** for bare Node — so ~16 ms of
  actual work — and ~53 ms for corepack on the same machine.
- A warm run makes **zero** network requests, never reads the recorded default, and never
  scans the store. That is asserted by a test which patches `fetch` and `readFileSync`
  and fails if either is touched, and was independently confirmed with `strace`.

Not done, deliberately:

- **Proxy support** (`HTTP_PROXY` and friends). `fetch` cannot do it without a custom
  dispatcher, so it is deferred behind a single seam in `src/http.ts`. Conformance rows
  71 and 72 are skipped until then.
- **Everything in [`.agents/15`](./.agents/15-gaps.md)** — `.npmrc` support, semver ranges
  in the pin, `pipack info`, signing-key rotation, per-package-manager registries, native
  (non-JavaScript) package managers, and the rest.

### What the audit found

Four independent audits ran against a green suite. The findings worth knowing about, all
fixed:

- Yarn Berry **resolved from the public internet despite a configured mirror**, because
  the `npmRegistry` substitution was applied only when downloading, not when resolving.
- Signature verification **hard-failed for every custom npm registry**, because the trust
  store was keyed by origin — breaking exactly the mirrored deployments that
  verification exists to protect.
- Registry credentials embedded in `COREPACK_NPM_REGISTRY` were **printed to stderr**,
  including on a successful run.
- `use` checked the `devEngines` version but not its name, so pinning the wrong package
  manager **succeeded and left the project permanently unrunnable**.
- `corepack install` silently repointed the machine-wide default, from the command
  documented for warming a Docker layer.

## Development

<details>

<summary>local development</summary>

- Clone this repository
- Install the latest LTS version of [Node.js](https://nodejs.org/en/)
- Enable [Corepack](https://github.com/nodejs/corepack) using `corepack enable`
- Install dependencies using `pnpm install`
- Run interactive tests using `pnpm dev`

</details>

## License

Published under the [MIT](https://github.com/pi0/pipack/blob/main/LICENSE) license 💛.
