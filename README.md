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

### Ranges, and `.corepack.lock`

An exact version is not the only thing either field may hold: a **semver range** or a
**dist-tag** works too, which is what Dependabot, Renovate and pnpm's own generated
`devEngines` block write.

```jsonc
{ "packageManager": "pnpm@^11.0.0" }
```

The version a range resolves to is recorded next to your manifest, with the digest of
the bytes it produced:

`.corepack.lock`:

```json
{
  "version": 1,
  "resolutions": {
    "pnpm@^11.0.0": {
      "resolved": "11.1.2",
      "integrity": "sha512-…"
    }
  }
}
```

Commit that file. From then on the range costs nothing: every run uses the recorded
version with **no network access at all**, and the recorded digest is enforced exactly
like a hash you pinned by hand. The resolution changes only when you run `pipack up`, or
when the recorded version stops satisfying the range.

```sh
pipack up                            # re-resolve the range, keeping the range
COREPACK_FROZEN_LOCKFILE=1 pnpm i    # refuse to resolve anything not already recorded
```

`COREPACK_FROZEN_LOCKFILE` defaults to on in CI (`CI` set), matching what package
managers do with their own lockfiles; set it to `0` to opt back out. A project that pins
an exact version never involves the file at all — nothing is read, nothing is written.

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
| `pipack up`                          | Bump the project's pin within its current major line, or re-resolve its range |
| `pipack install`                     | Download and cache the version this project pins                          |
| `pipack install -g [...name\|<file>]`| Install globally, or seed the cache from a `pack` archive                 |
| `pipack pack [...name]`              | Build a portable archive of cached versions                               |
| `pipack info [--json]`               | Explain what this project resolves to, and why                            |
| `pipack cache list [--json]`         | List the cached versions and the recorded defaults                        |
| `pipack cache clean [--all]`         | Empty the download cache, and with `--all` the recorded defaults too      |
| `pipack --version`, `pipack --help`  | The usual                                                                 |

`enable` and `disable` accept `--install-directory <path>`; `install -g` accepts
`--cache-only`; `pack` accepts `-o/--output <path>` and `--json`.

Note that `pipack yarn --version` prints **Yarn's** version, not pipack's — proxy mode
shadows the built-in commands, by design.

## When something is surprising: `pipack info`

Everything the tool decided, and where each decision came from, in one command. It makes
**no network request** and it does **not fail on a broken project** — telling you *why*
the project is broken is the point.

```console
$ pipack info
pipack 0.1.0
  root            /usr/local/lib/node_modules/pipack

Project
  status          found
  manifest        /home/you/app/package.json
  field           packageManager
  spec            pnpm@^11.0.0  (range)
  devEngines      pnpm@>=11  (onFail: error)

Resolution
  status          locked
  package manager pnpm
  version         11.1.2
  hash            sha512.0102…
  source          /home/you/app/.corepack.lock
  in the store    yes

Lockfile
  path            /home/you/app/.corepack.lock
  present         yes
  key             pnpm@^11.0.0
  resolved        11.1.2
  integrity       sha512-…
  frozen          no (default)

Environment
  env file        /home/you/app/.corepack.env
  applied         COREPACK_ENABLE_STRICT
  refused         COREPACK_NPM_TOKEN
  ignored         FOO
  variables       COREPACK_HOME=/home/you/.cache/node/corepack

Package managers
  npm             https://registry.npmjs.org  (built-in)
                  binaries: npm, npx
                  default: 11.14.1+sha1.4a68… (built-in)
                  cached: (none)
  pnpm            https://registry.npmjs.org  (built-in)
                  binaries: pnpm, pnpx
                  default: 11.1.2+sha1.ed39… (built-in)
                  cached: 11.1.2
  yarn            https://registry.npmjs.org  (built-in)
                  binaries: yarn, yarnpkg
                  default: 1.22.22 (recorded)
                  cached: (none)
                  yarn@>=2.0.0 is fetched from https://repo.yarnpkg.com; setting COREPACK_NPM_REGISTRY switches it to @yarnpkg/cli-dist
  .npmrc          .npmrc files are not read yet (§15.1); set COREPACK_NPM_REGISTRY to point at a mirror

Store
  home            /home/you/.cache/node/corepack
  path            /home/you/.cache/node/corepack/v1
  writable        yes
  versions        pnpm@11.1.2
  defaults        /home/you/.cache/node/corepack/lastKnownGood.json
                  yarn: 1.22.22

Shims
  directory       /usr/local/bin
  npm             not installed   PATH: /usr/local/bin/npm (not ours)
  pnpm            installed       PATH: /usr/local/bin/pnpm
  yarn            installed       PATH: /home/you/.nvm/versions/node/v22/bin/yarn (not ours) — shadowing the shim
```

The last line is the one that answers most "why is it running the wrong version?"
questions: the shim is installed correctly and something earlier on `PATH` is winning
anyway.

A pin the tool cannot resolve is reported rather than resolved, because resolving it
would need the network:

```console
$ pipack info
Resolution
  status          network
  package manager pnpm
  version         (unresolved)
  reason          pnpm@^11.0.0 has no recorded resolution and nothing in the store satisfies it; resolving it needs a registry request, which 'info' does not make
```

### `pipack info --json`

The JSON form is a stable, documented contract — it is what a bug report template or a
CI check should read. It carries its own schema `version` (currently `1`), bumped only
for a breaking change; new fields may be added without one.

| Field | Contents |
| --- | --- |
| `version` | Schema version of this report. Read it first. |
| `tool` | `{ name, version, root }` — pipack's own version and installation root |
| `project` | `status` (`found` / `invalid` / `no-spec` / `no-project`), the absolute `manifest` path, the `field` (`packageManager` or `devEngines.packageManager`), the `spec` as written, its `name` / `range` / `kind` (`exact`, `range`, `tag`, `url`), any `devEngines` block, and `problem` — the sentence explaining why an invalid spec is invalid |
| `resolution` | `status` (`pinned`, `locked`, `cache`, `network`, `frozen`, `fallback`, `unknown`), the `version` and `hash`, the `source` it came from, whether it is `installed`, and a `reason` when nothing could be decided offline |
| `lockfile` | `path`, `present`, the `key` this project's spec uses, the recorded `resolution`, and whether writes are `frozen` (with `frozenSource`: `COREPACK_FROZEN_LOCKFILE`, `CI`, or `default`) |
| `envFile` | The `.corepack.env` in effect and its variables sorted into `applied`, `overridden`, `refused` and `ignored` |
| `environment` | Every `COREPACK_*` variable in the real environment; credentials are `<set>` and URLs are stripped of `user:pass@` |
| `packageManagers` | Per package manager: `binaries`, the effective `registry` and its `registrySource`, `notes` about any band that a registry setting cannot redirect, the `builtinDefault`, the `recordedDefault`, and the `cached` versions |
| `npmrc` | `{ consulted: false, note }` — `.npmrc` support is not implemented yet ([§15.1](./.agents/15-gaps.md)) and the report says so rather than implying your `.npmrc` was honoured |
| `store` | `home`, `path`, `writable`, and every complete install as `{ name, version }` |
| `defaults` | The `lastKnownGood.json` path and its `entries` |
| `shims` | The shim `directory` (or a `problem` explaining why it could not be determined) and, per binary name, whether a `shim` is installed, what `PATH` resolves it to, whether that is `ours`, and whether the shim is `shadowed` |

`pipack cache list [--json]` is the store half of the same report — `version`, `store`
and `defaults` — for answering "did my container image actually get seeded?"

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
| `COREPACK_FROZEN_LOCKFILE=1`        | Never resolve or record a range that `.corepack.lock` does not already answer (default in CI) |
| `COREPACK_CAFILE`                   | PEM bundle to verify registry certificates against, replacing the platform trust store |
| `COREPACK_STRICT_SSL=0`             | Disable TLS certificate verification, loudly                      |
| `COREPACK_NETWORK_TIMEOUT`          | Connect and idle timeout in milliseconds (default `30000`)        |
| `COREPACK_NETWORK_RETRIES`          | Attempts per request, the first included (default `3`); `0` disables retrying |

A project may also ship a `.corepack.env` file supplying the *behavioural* variables.
Security-relevant ones are deliberately not settable that way — see
[Divergences](#divergences). `COREPACK_CAFILE` and `COREPACK_STRICT_SSL` are among them:
a repository you have just cloned does not get to choose which certificate authority its
own downloads are checked against.

## Networks that get in the way

Corporate networks are where a version manager spends its worst days, so the failures
have their own sentences rather than one shared "request failed".

- **A TLS-inspecting proxy** re-signs every certificate with a CA your trust store has
  never heard of. That is reported as such, naming the host and `COREPACK_CAFILE` —
  point it at the bundle your IT department publishes and the same command works. An
  expired certificate and a certificate issued for another name are also called by name.
  `COREPACK_STRICT_SSL=0` switches verification off if you must, and says so on stderr
  every run it does.
- **A proxy** is honoured from `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`
  with no second flag to discover, and a proxy that refuses to open the tunnel names
  itself and its status code instead of hiding behind the URL you asked for.
- **A registry that stumbles.** Idempotent GETs are retried three times with jittered
  exponential backoff on transport errors and on `408`, `425`, `429` and `5xx`,
  honouring `Retry-After` in either of its forms. Every other `4xx` is final. Requests
  have a connect *and* an idle timeout, so a stalled download fails in half a minute
  instead of hanging until CI kills the job.

Whatever goes wrong, the underlying reason — the errno, the TLS code, the proxy's answer
— is printed with the error rather than swallowed by it. A URL that carries credentials
is stripped of them first, everywhere.

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
- **`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY` just work.** Corepack leaves
  proxying to the host runtime, which needs `NODE_USE_ENV_PROXY=1` before any of them do
  anything; pipack tunnels through the proxy itself, with no second flag to discover.
- **TLS failures say what went wrong.** Corepack has no TLS surface at all, so an
  interception proxy, an expired certificate and a wrong hostname are all the same
  sentence; here each has its own, and there is a `COREPACK_CAFILE` to point at.
- **Requests time out and are retried.** Corepack has no timeout, no retry and no
  backoff, so one hiccup is fatal and the message says nothing about what happened.
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
| Conformance suite (§13 rows 1–147, plus §15 rows so far) | Passing — 3 rows skipped (two Windows-only, one needs a real TTY) |
| Unit tests | 762 passing |
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

- **Most of [`.agents/15`](./.agents/15-gaps.md)** — `.npmrc` support, signing-key
  rotation, per-package-manager registries, native (non-JavaScript) package managers, and
  the rest. Semver ranges in the pin with `.corepack.lock`
  ([§15.23](./.agents/15-gaps.md)), and `pipack info` ([§15.30](./.agents/15-gaps.md)),
  are done.

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
