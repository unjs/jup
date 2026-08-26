---
icon: i-lucide-settings
title: Configuration
---

# Configure jup

jup uses environment variables and a small, safe subset of `.npmrc`. It has no plugin system and sends no telemetry.

## Variable names and priority

Every jup setting has two names. For example, `JUP_HOME` and `COREPACK_HOME` mean the same thing. Existing Corepack settings keep working.

If both names are set, `JUP_*` wins. A real process environment variable wins over the same setting in `.corepack.env`.

Most users need only these settings:

| Setting | Purpose |
| --- | --- |
| `COREPACK_HOME` | Change the cache and recorded-defaults directory. |
| `COREPACK_ENABLE_NETWORK=0` | Block all network requests. |
| `COREPACK_ENABLE_STRICT=0` | Allow a different package manager from the one named by the project. |
| `COREPACK_ENABLE_AUTO_PIN=1` | Add a pin when a project has none. |
| `COREPACK_ENABLE_PRERELEASES=1` | Allow jup to choose prerelease versions. |
| `COREPACK_FROZEN_LOCKFILE=1` | Refuse missing or changed range resolutions. This is the default in CI. |
| `COREPACK_MINIMUM_RELEASE_AGE=24` | Choose only releases that are at least 24 hours old. Exact pins and cached versions are not filtered. |
| `COREPACK_SHIM_DIRECTORY` | Choose where `enable` installs shims. |
| `COREPACK_SPEC_FILE` | Read the project pin from another file instead of `package.json`. |

`COREPACK_DEFAULT_TO_LATEST=0` avoids looking up the latest default and uses jup's built-in default. `COREPACK_ENABLE_PROJECT_SPEC=0` ignores the project's pin completely.

## Project settings in `.corepack.env`

A project may place simple behavior settings in `.corepack.env`:

```dotenv
COREPACK_ENABLE_STRICT=0
COREPACK_NETWORK_TIMEOUT=60000
```

jup uses the closest file it finds while walking toward the project root. Set `COREPACK_ENV_FILE` to another file name or path. Set it to `0` to disable env files.

For safety, a repository cannot use this file to set credentials or change trust. jup refuses settings such as tokens, passwords, custom trust keys, certificate files, unsafe URLs, and TLS verification controls when they come from `.corepack.env`.

## Registry and authentication

| Setting | Purpose |
| --- | --- |
| `COREPACK_NPM_REGISTRY` | Use another npm-compatible registry. |
| `COREPACK_REGISTRY_NPM`, `COREPACK_REGISTRY_PNPM`, `COREPACK_REGISTRY_YARN` | Mirror only one package manager. |
| `COREPACK_NPM_TOKEN` | Send a bearer token to the configured registry origin. |
| `COREPACK_NPM_USERNAME` and `COREPACK_NPM_PASSWORD` | Send basic authentication when both are present. |

Credentials are sent only to the configured registry's origin. They are removed on a redirect to another origin.

To mirror Yarn without moving npm and pnpm:

```sh
COREPACK_REGISTRY_YARN=https://mirror.example.com/yarn jup yarn --version
```

## Supported `.npmrc` settings

jup reads the registry configuration you already use:

- `registry`
- `@scope:registry`
- scoped `_authToken`, `_auth`, or `username` plus `_password`
- `cafile` or `ca`
- `strict-ssl`

It reads global, user, and project files. Closer files win. A project-level `.npmrc` may choose `registry` and `@scope:registry`, but it may not provide credentials or certificate settings. jup warns when it ignores one. User and global credentials are limited to the host and path prefix written in `.npmrc`.

Run `jup info` to see which files and settings won. Secret values are never printed.

## Proxies, TLS, timeout, and retry

jup directly supports uppercase and lowercase forms of:

- `HTTP_PROXY`
- `HTTPS_PROXY`
- `ALL_PROXY`
- `NO_PROXY`

No extra Node.js flag is needed.

Use these settings for difficult networks:

| Setting | Purpose |
| --- | --- |
| `COREPACK_CAFILE` | Replace the platform trust store with a PEM certificate bundle. |
| `COREPACK_STRICT_SSL=0` | Disable TLS certificate checks and warn on every run. Avoid this when possible. |
| `COREPACK_NETWORK_TIMEOUT` | Set connect and idle timeout in milliseconds. Default: `30000`. |
| `COREPACK_NETWORK_RETRIES` | Set total attempts per request. Default: `3`; `0` disables retries. |

## Download and verification controls

| Setting | Purpose |
| --- | --- |
| `COREPACK_ENABLE_DOWNLOAD_PROMPT=1` | Announce downloads and ask on an interactive terminal. |
| `COREPACK_REQUIRE_SIGNATURES=1` | Refuse registry metadata without a signature. |
| `COREPACK_ALLOW_UNVERIFIED=1` | Allow an artifact with no signature, digest, or pin, with a warning. |
| `COREPACK_INTEGRITY_KEYS` | Replace trusted signing keys; `0` disables signature verification. |
| `COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=1` | Allow known package managers to use custom URLs. |

Trust settings must be set in the real environment, not `.corepack.env`.

For the full effective setup, including masked credentials, run:

```sh
jup info
jup info --json
```
