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
> **Early, but it runs.** The whole behavioural contract in [`.agents/`](./.agents/) is
> implemented, the conformance suite passes, and the CLI works end to end. There is no
> published release yet, so treat this as pre-1.0, and see [Status](#status) for the four
> items still outstanding.

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

### Which file gets edited

Every command that changes your project prints the path it changed:

```console
$ pipack use pnpm@11.1.2
Installing pnpm@11.1.2 in the project...
Updated /home/you/monorepo/package.json to use pnpm@11.1.2+sha512.b0c1…

<pnpm install output>
```

That line exists because "corepack edited a file I did not expect" is a whole class of
bug report ([#607]), and it is invisible without it. `pipack cache clean` reports the
same way — `Removed 3 cached version(s) from …`, or `Nothing to remove` — so you can
tell a successful clean from a no-op.

The file itself is chosen by walking up from where you are standing, and the walk
**stops at the repository**: a manifest declaring `workspaces`, or a directory holding a
`pnpm-workspace.yaml`. Standing in `packages/app` of a monorepo, `pipack use` pins at
the workspace root — which is what you want — and never climbs past it into a manifest
that happens to live in your home directory.

`--here` overrides that and writes `./package.json`, creating it if it does not exist:

```sh
pipack use --here pnpm@11.1.2   # pins packages/app/package.json, not the root
```

Reading is deliberately unchanged: a package with no pin of its own still inherits its
ancestor's, which is what makes a monorepo work at all. Only *writing* stops early.

### Which field gets the pin

`packageManager` wins on read when both fields are present, but a command that writes a
pin updates **every** field that encodes one — so a project can never be left in a state
the next run refuses to read ([#874]).

| The manifest declares | `use` / `up` writes |
| --- | --- |
| `packageManager` only, or neither | `packageManager` |
| `devEngines.packageManager` only | `devEngines.packageManager.version`, plus an `integrity` beside it — and **no** `packageManager` is created |
| both | `packageManager`; `devEngines` is updated too when it named an exact version |

The distinction in the last row is between a *pin* and a *constraint*. An exact
`devEngines.packageManager.version` says "this release", so it is replaced. A **range**
says "anything in here", so it is honoured and left alone — collapsing `1.x || 2.x` into
`2.4.3` would destroy the declaration `pipack up` relies on to cross a major boundary,
and would silently narrow what the project accepts. A pin that violates a declared range
is still refused, through that entry's own `onFail`.

Because `devEngines.packageManager.version` stays a valid semver range, the digest goes
into a sibling `integrity` field rather than a `+sha512.…` suffix inside it:

```json
{
  "devEngines": {
    "packageManager": {
      "name": "pnpm",
      "version": "11.1.2",
      "integrity": "sha512-Nm9F…"
    }
  }
}
```

Both fields are also **stop conditions for the upward walk**. A nested project declaring
only `devEngines.packageManager` is no longer walked past in favour of a parent's pin
([#779]), and a `"packageManager": null` counts as declared-and-invalid — it stops the
walk and reports a spec error — rather than being read as absent.

[#607]: https://github.com/nodejs/corepack/issues/607
[#779]: https://github.com/nodejs/corepack/issues/779
[#874]: https://github.com/nodejs/corepack/issues/874

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

### Prereleases

A version you did not spell out is never a prerelease.

`pipack use pnpm` resolves to the newest **stable** release, even on the days when a
`11.2.0-dev.1005` is the semver maximum of everything published. Corepack picks the dev
build, every prerelease cycle, and has done since 2023 ([#473], [#774]).

What still resolves to a prerelease, because you asked for one:

```sh
pipack use pnpm@11.2.0-dev.1005      # an exact pin
pipack use 'pnpm@>=11.0.0-0'         # a range that names a prerelease
COREPACK_ENABLE_PRERELEASES=1 pipack use pnpm
```

An already-pinned prerelease keeps running from the cache exactly as a stable release
does; what narrowed is only the set of candidates the tool will choose *for* you.

[#473]: https://github.com/nodejs/corepack/issues/473
[#774]: https://github.com/nodejs/corepack/issues/774

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

A cache miss with the network off names the two commands that would have filled it,
which is what a Dockerfile author needs to read:

```console
$ COREPACK_ENABLE_NETWORK=0 pnpm install
pnpm@11.1.2 is not in the cache and network access is disabled. Seed it with
'corepack install -g --cache-only pnpm@11.1.2', or run 'corepack pack pnpm@11.1.2'
on a networked machine.
```

A typo'd or yanked pin names itself too, rather than surfacing as a bare HTTP 404 on a
tarball URL you never typed ([#204]):

```console
$ pnpm --version
pnpm@11.9.9 does not exist in https://registry.npmjs.org. Run 'corepack info' to see the
resolved spec and where it came from.
```

Both name `corepack` rather than `pipack`: error strings are matched verbatim by
real-world scripts and CI, so they are reproduced byte for byte.

[#204]: https://github.com/nodejs/corepack/issues/204

## Enabling the shims

```sh
pipack enable
```

That puts `npm`, `npx`, `pnpm`, `pnpx`, `yarn` and `yarnpkg` on your `PATH`, each pointing
back at pipack. `disable` takes them off again.

**Two differences from corepack you will notice immediately.**

*npm is shimmed by default.* Corepack excludes it deliberately, but the exclusion is an
inter-team agreement between the corepack and npm maintainers ([#138]), not a technical
limit, and pipack is not party to it. What the exclusion costs is the very thing the tool
exists to prevent: a project pinned to `yarn` correctly blocks `pnpm`, while `npm install`
silently works anyway and writes the inconsistent lockfile state. `pipack enable --exclude
npm` restores the old default.

*Shims go to a per-user directory, and never need `sudo`.* Corepack writes them next to
its own binary — `C:\Program Files\nodejs` on Windows, `/usr` under a distro package, a
read-only path on NixOS ([#71], 34 👍 and open since 2021; also [#265], [#416]). pipack
uses `--install-directory`, else `COREPACK_SHIM_DIRECTORY`, else `$XDG_BIN_HOME` or
`~/.local/bin` (`%LOCALAPPDATA%\node\corepack\bin` on Windows). The directory is created
and probed for writability *before* anything is written; if it is not writable, pipack
falls back to the per-user default and says so rather than failing. To keep corepack's
behaviour: `pipack enable --install-directory "$(dirname "$(command -v pipack)")"`.

`LOCALAPPDATA` is read **only on Windows** — corepack honours it everywhere, which is why
a Linux process started through WSL interop puts its cache on `/mnt/c` with alien
permissions ([#673]). The same rule governs the store, and it is the one place pipack
deliberately breaks cache-location compatibility.

### `enable` tells you when it did nothing

`corepack enable` exits 0 in silence even when `yarn` still resolves to the previous
install ([#507], 12 👍). pipack checks its own post-condition — if the shim directory is
not on `PATH` it prints the exact line to add, for the shell you are using:

```
! /home/you/.local/bin is not on your PATH, so the shims installed there will not be found.
! Add it by running:
!     export PATH="/home/you/.local/bin:$PATH"
! A shell that is already open may need `hash -r` before the change is visible.
```

And if something else on `PATH` wins anyway — Volta, asdf, a distro package — it names the
winner:

```
! yarn on PATH resolves to /home/you/.volta/bin/yarn, not the shim just installed at /home/you/.local/bin/yarn. Another version manager may be shadowing it.
```

Both are warnings; the exit code stays 0.

### `enable` will not eat your package manager

It refuses to replace a binary it did not install. With `--force` it goes ahead, but
records what it displaced — path, type, symlink target, and for a regular file the file
itself — under `<COREPACK_HOME>/shims.json`. `disable` removes only what pipack created,
restores anything on that record, and clears it, so this round-trips:

```sh
pipack enable --force     # your distro's yarn is set aside
pipack disable            # ...and put back, mode and all
```

Corepack deletes whatever occupies the name, in both directions ([#112], 10 👍). A shim
left pointing at a `dist/` that no longer exists — what happens when Node stops bundling a
version manager ([#751]) — is recognised as a shim rather than as a missing file, so
`enable` replaces it and `disable` removes it.

[#71]: https://github.com/nodejs/corepack/issues/71
[#112]: https://github.com/nodejs/corepack/issues/112
[#138]: https://github.com/nodejs/corepack/issues/138
[#265]: https://github.com/nodejs/corepack/issues/265
[#416]: https://github.com/nodejs/corepack/issues/416
[#507]: https://github.com/nodejs/corepack/issues/507
[#673]: https://github.com/nodejs/corepack/issues/673
[#751]: https://github.com/nodejs/corepack/issues/751

## Commands

| Command                              | What it does                                                             |
| ------------------------------------ | ------------------------------------------------------------------------ |
| `pipack <binary>[@<version>] [...]`  | Run a package manager at the project's version, or an explicit one        |
| `pipack enable [...name]`            | Install shims for each package manager onto `PATH`                        |
| `pipack disable [...name]`           | Remove them again                                                         |
| `pipack use [--here] <name[@<version>]>` | Resolve, install, pin into `package.json`, then run the install command |
| `pipack up [--here]`                 | Bump the project's pin within its current major line, or re-resolve its range |
| `pipack install`                     | Download and cache the version this project pins                          |
| `pipack install -g [...name\|<file>]`| Install globally, or seed the cache from a `pack` archive                 |
| `pipack pack [...name]`              | Build a portable archive of cached versions                               |
| `pipack info [--json]`               | Explain what this project resolves to, and why                            |
| `pipack cache list [--json]`         | List the cached versions and the recorded defaults                        |
| `pipack cache clean [--all]`         | Empty the download cache, and with `--all` the recorded defaults too      |
| `pipack --version`, `pipack --help`  | The usual                                                                 |

`enable` and `disable` accept `--install-directory <path>` and `--exclude <name>`, and
`enable` also takes `--force`; `install -g` accepts `--cache-only`; `pack` accepts
`-o/--output <path>` and `--json`. `use` and `up` accept `--here`, which confines the
write to the manifest in the current directory — see
[Which file gets edited](#which-file-gets-edited).

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
  npm             https://npm.corp.example.com/api/npm/npm-remote  (.npmrc registry (/home/you/app/.npmrc))
                  binaries: npm, npx
                  default: 11.14.1+sha1.4a68… (built-in)
                  cached: (none)
  pnpm            https://npm.corp.example.com/api/npm/npm-remote  (.npmrc registry (/home/you/app/.npmrc))
                  binaries: pnpm, pnpx
                  default: 11.1.2+sha1.ed39… (built-in)
                  cached: 11.1.2
  yarn            https://npm.corp.example.com/api/npm/npm-remote  (.npmrc registry (/home/you/app/.npmrc))
                  binaries: yarn, yarnpkg
                  default: 1.22.22 (recorded)
                  cached: (none)
                  yarn@>=2.0.0 is fetched from https://npm.corp.example.com/api/npm/yarn-remote as @yarnpkg/cli-dist  (.npmrc @yarnpkg:registry (/home/you/.npmrc))

.npmrc
  files           /home/you/app/.npmrc  (project)
                    read: registry
                    refused (project-level): //npm.corp.example.com/:_authToken
                  /home/you/.npmrc  (user)
                    read: registry, @yarnpkg:registry, //npm.corp.example.com/api/npm/:_authToken, cafile
  registry        https://npm.corp.example.com/api/npm/npm-remote  (/home/you/app/.npmrc)
  @yarnpkg:registry https://npm.corp.example.com/api/npm/yarn-remote  (/home/you/.npmrc)
  auth            //npm.corp.example.com/api/npm/  token  (/home/you/.npmrc)

TLS
  verify          yes
  trust store     /etc/ssl/corp-ca.pem  (cafile (/home/you/.npmrc))

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

The `.npmrc` section answers the other recurring one — "our mirror is configured and it
is still reaching the public registry". Files are listed highest precedence first, so
the winner is the top line, and each is followed by the keys it supplied and, for a
project-level file, the keys that were **refused**. Credential values are never printed;
only the prefix they are scoped to and whether they are a token or basic auth.

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
| `packageManagers` | Per package manager: `binaries`, the effective `registry` and its `registrySource`, `notes` about any band a registry setting redirects differently, the `builtinDefault`, the `recordedDefault`, and the `cached` versions. `registrySource` names the setting that actually decided it — `COREPACK_REGISTRY_<NAME>`, `COREPACK_NPM_REGISTRY`, `.npmrc <key> (<path>)`, or `built-in` — and is resolved **per package manager**, so mirroring Yarn alone shows up here |
| `npmrc` | `files` (every `.npmrc` read, **lowest precedence first**, each with its `path`, `level` — `global` / `user` / `project` — the `keys` it supplied and the `refused` keys a project-level file was not allowed to supply), the effective `registry`, the `scopes` (`@scope` → registry), and `auth`: one entry per credential **scope**, as `{ prefix, type, source }`. Credential *values* are never included |
| `tls` | `cafile` and `cafileSource` (the PEM bundle replacing the platform trust store, and whether `COREPACK_CAFILE` or an `.npmrc` `cafile`/`ca` set it), `verify`, and `verifySource` when verification has been switched off |
| `store` | `home`, `path`, `writable`, and every complete install as `{ name, version }` |
| `defaults` | The `lastKnownGood.json` path and its `entries` |
| `shims` | The shim `directory` (or a `problem` explaining why it could not be determined) and, per binary name, whether a `shim` is installed, what `PATH` resolves it to, whether that is `ours`, and whether the shim is `shadowed` |

`pipack cache list [--json]` is the store half of the same report — `version`, `store`
and `defaults` — for answering "did my container image actually get seeded?"

## Configuration

Every knob is an environment variable. There is no config format of pipack's own, no
plugin system, and no telemetry — the only file it reads for configuration is the
`.npmrc` you already wrote, and only for the handful of keys described
[below](#the-npmrc-you-already-wrote). The full list lives in
[`.agents/11-environment.md`](./.agents/11-environment.md); the ones you are most likely
to want:

| Variable                            | Effect                                                            |
| ----------------------------------- | ----------------------------------------------------------------- |
| `COREPACK_HOME`                     | Where the store and recorded defaults live                        |
| `COREPACK_NPM_REGISTRY`             | Fetch package managers from a mirror                              |
| `COREPACK_REGISTRY_<NAME>`          | Mirror **one** package manager — `COREPACK_REGISTRY_YARN`, `COREPACK_REGISTRY_PNPM`, `COREPACK_REGISTRY_NPM` — without redirecting the others |
| `COREPACK_ENABLE_NETWORK=0`         | Refuse every network request; run from cache only                 |
| `COREPACK_ENABLE_STRICT=0`          | Don't error when you invoke a package manager the project doesn't use |
| `COREPACK_ENABLE_AUTO_PIN=1`        | Write a pin automatically when a project has none                 |
| `COREPACK_ENABLE_PRERELEASES=1`     | Let an unspecified version resolve to a prerelease                |
| `COREPACK_ENABLE_DOWNLOAD_PROMPT=1` | Announce (and on a TTY, confirm) each download                    |
| `COREPACK_INTEGRITY_KEYS`           | Replace the built-in trust store (per registry origin), or set `0` to skip verification; either way, key refresh is off |
| `COREPACK_REQUIRE_SIGNATURES=1`     | Refuse a registry that publishes no signature, rather than warning |
| `COREPACK_FROZEN_LOCKFILE=1`        | Never resolve or record a range that `.corepack.lock` does not already answer (default in CI) |
| `COREPACK_CAFILE`                   | PEM bundle to verify registry certificates against, replacing the platform trust store |
| `COREPACK_STRICT_SSL=0`             | Disable TLS certificate verification, loudly                      |
| `COREPACK_NETWORK_TIMEOUT`          | Connect and idle timeout in milliseconds (default `30000`)        |
| `COREPACK_NETWORK_RETRIES`          | Attempts per request, the first included (default `3`); `0` disables retrying |
| `COREPACK_SHIM_DIRECTORY`           | Where `enable` installs shims and `disable` looks for them |
| `XDG_BIN_HOME`                      | Per-user shim directory on Linux and BSD; not consulted on macOS or Windows |

A project may also ship a `.corepack.env` file supplying the *behavioural* variables.
Security-relevant ones are deliberately not settable that way — see
[Divergences](#divergences). `COREPACK_CAFILE` and `COREPACK_STRICT_SSL` are among them:
a repository you have just cloned does not get to choose which certificate authority its
own downloads are checked against. Nor does its `.npmrc` — see below.

## The `.npmrc` you already wrote

If your organisation runs a mirror, you have already configured it once. pipack reads a
deliberately small part of that file rather than making you configure it again:

| Key | Effect |
| --- | --- |
| `registry` | The registry package managers are fetched from |
| `@scope:registry` | The registry for that scope — this is how Yarn Berry's `@yarnpkg/cli-dist` gets mirrored |
| `//host/path/:_authToken` | Bearer token for URLs under that prefix |
| `//host/path/:_auth` | Pre-encoded basic credentials for that prefix |
| `//host/path/:username` + `:_password` | Basic credentials (`_password` is base64, as npm writes it) |
| `cafile` / `ca` | PEM bundle to verify registry certificates against |
| `strict-ssl` | `false` disables verification, loudly |

Everything else in the file is ignored. This is not npm-config compatibility; it is one
lookup table and a prefix matcher.

Files are read from `<prefix>/etc/npmrc`, then `$HOME/.npmrc`, then `./.npmrc` walking up
to the project root — closest wins. `${VAR}` is expanded in the keys above; a variable the
environment does not define drops the key rather than sending the literal text `${VAR}` to
a registry.

The whole configuration space, highest precedence first:

```
1. COREPACK_REGISTRY_<NAME>                       per package manager
2. COREPACK_NPM_REGISTRY / COREPACK_NPM_TOKEN / …
3. .npmrc — @scope:registry, then registry        project > user > global
4. the built-in default
```

**A project-level `.npmrc` may set `registry` and `@scope:registry`, and nothing else.**
npm honours project-level auth; pipack does not, because unlike npm it runs *before* you
have decided to trust the repository — `git clone && yarn install` executes this code with
the clone's `.npmrc` already on disk. A project file's `_authToken`, `_auth`, `_password`,
`ca`, `cafile` and `strict-ssl` are refused, and refused out loud:

```console
$ pipack pnpm --version
! Ignoring //npm.corp.example.com/:_authToken from /home/you/app/.npmrc: a project-level .npmrc may only set registry and @scope:registry
```

Credentials from the user and global files are **prefix-scoped by construction**. A
`//host/team/:_authToken` is attached only to requests whose host *and* path prefix fall
inside it — `//host/team-other` does not match — which is stricter than the origin scoping
`COREPACK_NPM_TOKEN` gets, and is what makes reading a credential out of a file safe.

### Mirroring one package manager

`COREPACK_NPM_REGISTRY` redirects everything that speaks the npm protocol, which is not
always what you want: Yarn Berry lives on `repo.yarnpkg.com`, which is not an npm registry
at all, and pointing `COREPACK_NPM_REGISTRY` at a mirror to reach it also redirects npm and
pnpm as collateral.

`COREPACK_REGISTRY_<NAME>` mirrors exactly one:

```sh
COREPACK_REGISTRY_YARN=https://mirror.corp.example.com/yarn pipack yarn --version
```

Every URL derived from that package manager's table entry moves — the download, the tag
document, and the version list — by **origin replacement**, not string substitution, with
the mirror's own path prefix prepended. npm and pnpm keep using whatever they were using.
Credentials follow the per-package-manager registry, so an authenticated internal mirror
works without widening anything.

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

### When npm rotates its signing keys

The trust store ships inside the binary, which is why npm's February 2025 key rotation
[broke every released corepack at once][#612] and the remedy was "upgrade". pipack keeps
the built-in keys and adds one repair on top of them:

- The **only** thing that triggers it is a signature whose key id matches nothing in the
  trust store. An expired key, a signature that does not verify, and a registry that
  publishes no signature at all are all answers, not questions — refreshing keys would
  change none of them.
- The refresh is one `GET https://registry.npmjs.org/-/npm/v1/keys`, whatever registry
  served the package. Asking a *mirror* which keys to trust would hand it the one thing
  it does not have, and npm's signature travelling with the package is the entire reason
  a compromised mirror is defended against in the first place.
- The result is written to `<COREPACK_HOME>/keys.json` with a timestamp and **merged**
  with the built-in keys — never substituted for them. A refresh can add key ids; it
  cannot retire or re-date one this binary shipped. The file is a cache: deleting it is
  always safe, and `cache clean` leaves it alone.
- Once a key id is on disk, it is used at any age, so the steady state after a rotation
  costs nothing. A refresh that did *not* explain the signature is retried at most every
  five minutes, so a failing build in a loop cannot hammer the endpoint.
- `COREPACK_INTEGRITY_KEYS` disables the whole mechanism: a pinned trust store is final,
  and neither the cache nor the endpoint is consulted. `COREPACK_ENABLE_NETWORK=0`
  disables the fetch alone — a machine that refreshed while it had a network keeps
  working after it loses one.

**A successful verification never reads that file and never makes that request**, so
neither the warm path nor an ordinary install is affected. Tests count the requests
rather than the outcomes, and `strace` confirms it on the built binary.

There is a visible consequence today. npm currently signs `yarn@latest` — and much else —
with a key its own endpoint marks `expires: 2025-01-29`. Before the refresh the failure
read *"The package was not signed by any trusted keys"*, which sounds like a bug in the
tool; now it reads:

```
The package was signed with an expired key (SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA, expired 2025-01-29T00:00:00.000Z)
```

Same outcome, honest reason. corepack ships that expired key and never looks at the field.

### Trust for a registry that signs its own packages

A private registry that re-signs what it serves (Cloudsmith and similar) fails against
npm's keys, and corepack has [no way to say otherwise][#884]. pipack's trust store is
keyed by registry origin:

```jsonc
COREPACK_INTEGRITY_KEYS='{
  "https://npm.internal.example": [{ "expires": null, "keyid": "SHA256:…", "keytype": "ecdsa-sha2-nistp256", "scheme": "ecdsa-sha2-nistp256", "key": "<base64 SPKI>" }]
}'
```

corepack's `{"npm": [...]}` shape is still accepted and means the default registry. An
origin gets its own keys **and** npm's — because a mirror serving npm-signed packages must
keep verifying — but never another origin's, so configuring keys for one private registry
does not let them vouch for anything else. Origins are compared parsed, so a trailing
slash, a differing host case and a path-scoped registry URL all select the same entry.
Keys for a non-default origin come from the environment only: a `.corepack.env` committed
to a repository cannot introduce one, and no registry is ever asked for its own keys.

**TLS is not one of those checks.** When none of the three is available the install is
refused rather than trusted to the transport:

```
Refusing to install yarn@4.14.1: https://repo.yarnpkg.com provides no signature and no hash was pinned. Pin a hash in the packageManager field, or set COREPACK_ALLOW_UNVERIFIED=1.
```

corepack's model has two tiers and [`.agents/06`](./.agents/06-integrity.md) §06.6 records
where they run out: an npm-hosted package gets a signature chain, Yarn Berry from
`repo.yarnpkg.com` gets TLS and nothing else, and Yarn Berry through a custom npm registry
gets nothing at all. Open PR [#548] would have closed the first and has sat unmerged;
[#495] is twenty-two comments of a Node.js TSC member arguing the asymmetry is a
supply-chain risk.

`COREPACK_ALLOW_UNVERIFIED=1` opts out for one run and says so. Like every other trust
decision it can only be set in the real environment — a `.corepack.env` committed to a
repository cannot open the hole that repository would benefit from.

**This is a breaking change for Yarn Berry from `repo.yarnpkg.com`** — every form of it,
since that origin publishes nothing to verify against: a range (`yarn@4.x`), a tag
(`yarn@stable`), a bare `pipack use yarn`, and an exact version with no hash are all
refused. The remedies, best first:

1. **Point `COREPACK_NPM_REGISTRY` at an npm registry.** Berry then comes from
   `@yarnpkg/cli-dist`, which npm signs, and nothing needs an opt-out at all.
2. **Pin the digest.** `COREPACK_ALLOW_UNVERIFIED=1 pipack use yarn@4` once writes
   `yarn@4.x.y+sha512.…` into `package.json`; every later run, on every machine, is
   verified against it.
3. **Keep the range and commit `.corepack.lock`.** It records the resolved version *and*
   its integrity, which is a pin — but the run that creates it is itself the unverified
   one, so the bootstrap still needs the opt-out exactly once.

Nothing about a default install changes: the embedded table pins a hash on both `default`
and `transparent.default`, so a bare `npm`, `pnpm` or `yarn dlx` clears a tier with no
configuration.

### The pin is checked on a cache hit too

The store directory is named after the plain semver version, so `pnpm@9.0.0+sha512.<A>`
and `pnpm@9.0.0+sha512.<B>` share one directory — and corepack re-attaches the marker's
hash to the locator rather than comparing it, so the second project silently runs whatever
the first installed. pipack compares them. When they disagree the pinned reference gets a
directory of its own, `<version>+<algo>.<hex>`, so both projects get the bytes they asked
for and neither has to wipe a cache. The cost on the warm path is one file: the probe that
used to `stat` the marker now reads it. No request, no directory scan, nothing new loaded.

### `--pin-style=sidecar`

If you would rather `packageManager` held clean semver — which is what tools that parse it
as a version expect ([#316]) — the digest can live beside it instead:

```json
{
  "packageManager": "yarn@4.14.1",
  "devEngines": {
    "packageManager": { "name": "yarn", "version": "4.14.1", "integrity": "sha512-…" }
  }
}
```

Both spellings are read as the same pin and enforced identically. The suffixed form stays
the default because it is the interoperable one.

A failed check discards the download and caches nothing, so a re-run fails the same way
rather than silently succeeding.

[#316]: https://github.com/nodejs/corepack/issues/316
[#495]: https://github.com/nodejs/corepack/issues/495
[#548]: https://github.com/nodejs/corepack/pull/548
[#612]: https://github.com/nodejs/corepack/issues/612
[#884]: https://github.com/nodejs/corepack/issues/884

## Divergences

pipack matches corepack's observable behaviour — same fields, same variables, same
strings — with a set of deliberate departures, each closing a defect or a security hole.
The full list with rationale is in
[`.agents/14-divergences.md`](./.agents/14-divergences.md); the ones you might notice:

- **A project's `.corepack.env` cannot disable signature verification**, supply trust
  keys, allow arbitrary download URLs, or set registry credentials. Those come from the
  real environment only. Cloning a repository and running `yarn` should not hand it your
  npm token. A project-level `.npmrc` is held to the same line: it may redirect the
  registry, and may not supply a credential or a certificate authority.
- **The `.npmrc` you already have is honoured.** Corepack reads none, at any level
  ([#540]): an organisation configures one registry, every other tool on the machine
  obeys it, and corepack reaches the public internet anyway. See
  [The `.npmrc` you already wrote](#the-npmrc-you-already-wrote).
- **Credentials never leave the configured registry's origin**, on any request path.
- **`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY` just work.** Corepack leaves
  proxying to the host runtime, which needs `NODE_USE_ENV_PROXY=1` before any of them do
  anything; pipack tunnels through the proxy itself, with no second flag to discover.
- **TLS failures say what went wrong.** Corepack has no TLS surface at all, so an
  interception proxy, an expired certificate and a wrong hostname are all the same
  sentence; here each has its own, and there is a `COREPACK_CAFILE` to point at.
- **Requests time out and are retried.** Corepack has no timeout, no retry and no
  backoff, so one hiccup is fatal and the message says nothing about what happened.
- **`enable` never needs `sudo`, and `disable` gives back what it displaced.** Shims go to
  a per-user directory, `npm` is shimmed like everything else, and `enable` verifies it
  actually won on `PATH` instead of exiting 0 in silence. See
  [Enabling the shims](#enabling-the-shims).
- **An unspecified version never resolves to a prerelease** ([#473], [#774]), and a
  mutating command prints the file it changed and stops its walk at the workspace root
  ([#607], [#679]). See [Prereleases](#prereleases) and
  [Which file gets edited](#which-file-gets-edited).
- **A pin is one logical value** ([#874], [#779]). Whichever of `packageManager` and
  `devEngines.packageManager` a project declares is what gets written, so the two can
  never disagree — and either one stops the upward walk.
- **`transparent.default` is a floor, not an override.** After
  `pipack install -g yarn@4.9.0`, `yarn dlx` runs 4.9.0; corepack keeps running the
  table's compiled-in pin with no way to change it ([#202]). A recorded default from an
  older *major line* does not shadow the floor, so `yarn create` cannot fall back to Yarn
  Classic ([#812]).
- **A package manager does not have to be JavaScript.** Corepack's most-upvoted open
  issue is Bun support ([#295], 146 👍), blocked by an architectural assumption rather
  than by effort: *"Corepack was written with assumption that package managers would be
  implemented in JS."* Here a band's `url` may carry `{platform}` and `{arch}`, and a band
  may declare `"exec": "native"` so its binaries run directly, with no JavaScript runtime
  looked up and none interposed — exit codes, signals and stdio behave exactly as they do
  on the JavaScript path, so a child killed by `SIGTERM` kills pipack with `SIGTERM`
  rather than with exit code 143. **No package manager was added**: §15.21 requires a
  project's maintainers to agree first, and Bun's asked not to be. The built-in table is
  still npm, pnpm and yarn — this is headroom, and adding an entry stays a data-only
  change, which the conformance suite demonstrates by adding exactly one table entry and
  no code at all.
- **Every artifact clears a verification tier.** corepack accepts TLS alone for Yarn
  Berry, and nothing at all for Berry through a custom registry ([#548], [#495]); here a
  pinned hash, a verified signature or a registry digest is required, and a cache hit is
  checked against the pin rather than trusted. See
  [How a version is verified](#how-a-version-is-verified).
- **Signing-key expiry is honoured** rather than stored and ignored — which is why a bare
  `pipack yarn` currently fails online, and corepack does not. npm signs the `yarn`
  packument's `latest` with a key its own `/-/npm/v1/keys` marks
  `expires: 2025-01-29`; corepack ships that key and ignores expiry, so the signature is
  effectively unchecked. `COREPACK_DEFAULT_TO_LATEST=0` uses the table's hash-pinned
  Yarn Classic instead, and `npm` and `pnpm` are unaffected.
- **Tarball URLs are validated** against the configured registry rather than accepted for
  starting with the letters `http`.
- **Digests are compared in constant time**, SRI strings are parsed properly rather than
  assumed to be `sha512`, and unknown hash algorithms produce a clear error.
- **Archive extraction is hardened**: no path traversal, no symlink escapes, no device
  entries, no setuid bits, and bounded output.
- **The UTF-8 BOM survives** a `use` or `up` that rewrites your `package.json`.

[#202]: https://github.com/nodejs/corepack/issues/202
[#295]: https://github.com/nodejs/corepack/issues/295
[#540]: https://github.com/nodejs/corepack/issues/540
[#679]: https://github.com/nodejs/corepack/issues/679
[#812]: https://github.com/nodejs/corepack/issues/812

## Status

Phase 1 — the behavioural contract in [`.agents/01`](./.agents/01-overview.md)–[`14`](./.agents/14-divergences.md) — is complete, and so is
phase 2 ([`.agents/15`](./.agents/15-gaps.md)) apart from one item noted below:

| Area | State |
| --- | --- |
| Specification (`.agents/`) | 16 normative documents |
| Implementation | 33 modules, zero runtime dependencies |
| Conformance suite (§13 rows 1–147, §15.38 rows 148–203) | 326 passing, 3 skipped (two Windows-only, one needs a real TTY) |
| Unit tests | 1186 passing |
| Audit (correctness / speed / security / simplicity) | Complete, findings applied |
| Published release | Not yet |

Measured, not hoped for:

- **42 kB** min+gzipped, **zero** runtime dependencies.
- **~28 ms** for a warm proxy invocation against **~19 ms** for bare Node — so **~9 ms**
  of actual work — against **~51 ms** for corepack on the same machine. (Best of 150
  spawns, interleaved in one loop; absolute timings taken minutes apart on a loaded
  machine are noise wider than the effect, which we learned the hard way.)
- A warm run loads **two** Node built-ins beyond what the measuring harness itself costs,
  and a test fails if that reaches seven.
- A warm run makes **zero** network requests, never reads the recorded default, and never
  scans the store. That is asserted by a test which patches `fetch` and `readFileSync`
  and fails if either is touched, and was independently confirmed with `strace`.

Landed from [`.agents/15`](./.agents/15-gaps.md): the `.npmrc` subset and
per-package-manager registries (§15.1–§15.3), TLS diagnostics, retries and proxies
(§15.4–§15.6), registry-metadata tiering (§15.7, §15.8), shims and enablement (§15.13,
§15.15, §15.16, §15.29), semver ranges in the pin with `.corepack.lock` (§15.23),
prereleases (§15.24), the manifest-walk and pin-write defects (§15.25–§15.27),
`pipack info` (§15.30), stale and shadowed defaults (§15.33), native package-manager
support (§15.28), one verification tier for every source with sidecar integrity
(§15.11, §15.12), signing-key rotation and per-origin trust (§15.9, §15.10), and parts of
§15.14, §15.19 and §15.35.

Not done yet:

- **`COREPACK_MINIMUM_RELEASE_AGE`** (§15.35e) — it needs per-version publish times, which
  the abbreviated packument the registry client requests does not carry.

One limitation worth stating: a **native** package manager must currently ship as a
`.tgz`. §07.4 dispatches on the URL path's extension and requires an unrecognised one to
fail loudly rather than be guessed at, and the only other extension it recognises is
`.js`. A package manager distributing a bare, extension-less binary would need §07.4
extended — not §15.28.

### What the audit found

Four independent audits ran against a green suite. The findings worth knowing about, all
fixed:

- Yarn Berry **resolved from the public internet despite a configured mirror**, because
  the `npmRegistry` substitution was applied only when downloading, not when resolving.
- Signature verification **hard-failed for every custom npm registry**, because the trust
  store was keyed by origin — breaking exactly the mirrored deployments that
  verification exists to protect. (§15.10 has since landed the shape that satisfies both
  requirements: an origin gets its own keys *and* npm's, and never a third party's.)
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
