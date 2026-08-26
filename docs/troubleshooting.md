---
icon: i-lucide-circle-help
title: Troubleshooting
---

# Fix common problems

Start with:

```sh
jup info
```

It does not contact the network. It reports invalid project fields instead of stopping, and it hides credential values.

## The wrong package manager version runs

Check the `Shims` section of `jup info`.

If the shim directory is not on `PATH`, add the line printed by `jup enable`, open a new terminal, and try again. In an existing POSIX shell, run `hash -r`.

If another path is listed first, another version manager or system install is shadowing jup. Put jup's shim directory earlier on `PATH`, or remove the conflicting command.

## The project says to use a different manager

jup normally stops commands that conflict with the project pin. For example, a pnpm project will reject `yarn install`.

Use the package manager named in the error. If you intentionally need a different one, run it with:

```sh
COREPACK_ENABLE_STRICT=0 jup yarn install
```

For a permanent project choice, run `jup use <name>@<version>`.

## jup found an unexpected `package.json`

The error names the manifest that supplied the pin. A stray `packageManager` in `$HOME/package.json` can affect folders with no closer project manifest.

Remove that field if it is accidental. For a write in the current directory, use:

```sh
jup use --here pnpm@11
```

## A range works locally but fails in CI

CI freezes `.corepack.lock` by default. Commit the lockfile after resolving the range locally:

```sh
jup up
git add .corepack.lock package.json
```

You can allow an implicit CI update with `COREPACK_FROZEN_LOCKFILE=0`, but committing the resolution is more repeatable.

## The version is not in the cache

Prepare it while online:

```sh
jup install
```

Or seed one exact version:

```sh
jup install -g --cache-only pnpm@11.1.2
```

For an isolated machine, use `jup pack` and import the archive. See [Cache, offline use, and security](./cache-and-security).

## A registry request fails

Run `jup info` and check the `Package managers` and `.npmrc` sections. Confirm which registry and config file won.

Common fixes:

- Set `COREPACK_NPM_REGISTRY` for an npm-compatible mirror.
- Use `COREPACK_REGISTRY_YARN`, `COREPACK_REGISTRY_PNPM`, or `COREPACK_REGISTRY_NPM` to mirror only one manager.
- Move credentials from a project `.npmrc` to your user `.npmrc` or real environment. Project credentials are refused for safety.
- Set `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, or `NO_PROXY` when required.
- Increase `COREPACK_NETWORK_TIMEOUT` for a slow network.

jup prints the underlying network or HTTP reason. URLs in errors have embedded credentials removed.

## TLS certificate verification fails

If your company uses a TLS-inspecting proxy, ask for its CA certificate bundle and set:

```sh
COREPACK_CAFILE=/path/to/company-ca.pem jup install
```

An expired certificate or wrong hostname needs to be fixed by the registry or proxy owner.

`COREPACK_STRICT_SSL=0` disables certificate checks and warns every run. Use it only as a short-lived diagnostic, not as the normal fix.

## Verification or signing fails

- **Hash mismatch:** do not copy the reported value until you know why the downloaded bytes changed. Check the registry and lockfile first.
- **Unknown signing key:** allow network access so jup can refresh npm's public keys, or update jup.
- **Expired signing key:** update the package source or use an exact digest from a trusted source. jup does not silently accept expired keys.
- **No signature:** a mirror may have removed it. jup can use the registry digest with a warning. If `COREPACK_REQUIRE_SIGNATURES=1` is set, use a signing registry or remove that setting after reviewing your policy.
- **No signature or digest:** pin a digest. `COREPACK_ALLOW_UNVERIFIED=1` is a visible, one-run escape hatch for bootstrapping only.

Direct Yarn Berry downloads need special handling. Follow [Yarn Berry and unsigned downloads](./cache-and-security#yarn-berry-and-unsigned-downloads).

## `enable` cannot install a shim

jup will not overwrite a foreign binary without permission. Review the path in the error. If replacement is intentional:

```sh
jup enable --force
```

`jup disable` restores what was there before.

For a read-only directory, choose a user-owned location on `PATH`:

```sh
jup enable --install-directory "$HOME/bin"
```

## `package.json` is invalid

Fix its JSON syntax first. A declared `packageManager: null` is invalid; it does not mean “no pin.” A malformed child manifest also stops the upward search so jup does not silently use an ancestor's pin.

A valid simple pin looks like:

```json
{
  "packageManager": "pnpm@11.1.2"
}
```

Use `jup use pnpm@11.1.2` to replace an old or malformed pin and add its digest.

## Get machine-readable details

```sh
jup info --json > jup-info.json
```

The report includes a schema `version`. Credentials are shown only as set or unset, never as their values. This is the best attachment for a bug report.
