---
icon: i-lucide-shield-check
title: Cache, offline use, and security
---

# Cache package managers and verify downloads

jup keeps downloaded package manager versions in a local **store**, also called the cache. The default is under your operating system's user cache directory. Set `COREPACK_HOME` or `JUP_HOME` to move it.

## Prepare a project for offline use

While online, run:

```sh
jup install
```

This caches the version pinned by the current project. Then require offline operation:

```sh
COREPACK_ENABLE_NETWORK=0 pnpm install
```

A cache miss explains which version is missing and suggests commands to seed it.

## Seed a container image

Put the download in an earlier build layer:

```dockerfile
COPY package.json ./
RUN jup install

ENV COREPACK_ENABLE_NETWORK=0
COPY . .
RUN pnpm install
```

If your project uses a range pin, copy its committed `.corepack.lock` before running `jup install` too.

If the target machine cannot access the registry, create an archive elsewhere:

```sh
jup pack -o package-managers.tgz pnpm@11.1.2
```

Packing also records that version as jup's global fallback for projects without a pin.

Copy it to the target, then run:

```sh
jup install -g package-managers.tgz
```

`jup cache list` confirms which versions are available.

## How jup checks a download

jup accepts a package manager only after one of these checks:

1. **Pinned digest.** A digest in `packageManager`, `devEngines.packageManager.integrity`, or `.corepack.lock` must match the downloaded bytes.
2. **Registry signature.** For npm registry packages, jup checks the registry's digital signature with a trusted public key. A digital signature proves who approved the package metadata.
3. **Registry digest.** Some mirrors remove signatures. jup can check the registry's digest instead and prints a warning. Set `COREPACK_REQUIRE_SIGNATURES=1` to refuse unsigned metadata.

If there is no signature, digest, or pinned hash, jup refuses the install. `COREPACK_ALLOW_UNVERIFIED=1` is an explicit, one-run escape hatch and prints a warning. Prefer pinning a digest instead.

A failed check is not cached. Cache hits are checked against the project's pin too.

## Yarn Berry and unsigned downloads

Direct Yarn Berry downloads from `repo.yarnpkg.com` do not provide the signature or digest jup requires. Safe options are:

1. Set `COREPACK_NPM_REGISTRY` to an npm registry. jup then gets Yarn Berry from the signed `@yarnpkg/cli-dist` package.
2. Run `COREPACK_ALLOW_UNVERIFIED=1 jup use yarn@4` once, review what you are installing, and commit the digest jup writes.
3. For a range, create and commit `.corepack.lock`; the first resolution still needs the one-time opt-out.

An exact digest pin is checked on every machine afterward.

## Signing keys

jup has built-in npm signing keys. If npm rotates to a new key, jup may fetch npm's official key list and cache the new key under `COREPACK_HOME`. This happens only for an unknown key ID. Offline use continues to work after the key was cached.

Set `COREPACK_INTEGRITY_KEYS` in the real process environment to provide a fixed trust store. Setting it to `0` disables signature checks. Both are advanced trust decisions and cannot come from a project's `.corepack.env`.

jup honors key expiry. An expired signing key causes a clear error instead of being silently trusted.

## Clean the cache

```sh
jup cache clean
```

This removes downloaded versions. It keeps the global fallback choices and cached signing keys.

To remove downloaded versions and recorded global defaults:

```sh
jup cache clean --all
```

Signing-key cache files can be deleted manually; jup can fetch them again when needed.
