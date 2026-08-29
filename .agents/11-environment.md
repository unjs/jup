# 11 — Environment Variables

Environment variables are jup's only configuration input. The inventory of names
lives in one file, `src/config/env-vars.ts`, so that eligibility sets, `info`'s
masking list, and the read sites are all built from the same constants — which is
what stops a new variable being readable but unclassified.

Every setting is spelled `JUP_<NAME>`. The settings **corepack itself defined**
also answer to `COREPACK_<NAME>`: they are one setting, and `JUP_` wins by
presence. That compatibility set is closed — it is listed in §11.7, and
`COMPATIBILITY_ENV` in `src/config/env-vars.ts` is the implementation of it.
Everything jup invented is `JUP_`-only, because a CI written against corepack
cannot be setting a name corepack never had. Ambient variables such as `PATH`
and `CI` have no prefixed alias.

The **Env file** column says whether `.jup.env` may supply the variable (§03.2).
A real environment variable always beats the file.

## 11.1 Behaviour

| Variable | Values | Effect | Env file |
|---|---|---|---|
| `JUP_ENABLE_PROJECT_SPEC` | `0` | Ignore the project's pin fields and version file entirely; always use the fallback version | yes |
| `JUP_ENABLE_STRICT` | `0` | Do not error when the invoked tool differs from the project's; behave as if every command were transparent | yes |
| `JUP_ENABLE_AUTO_PIN` | `1` | On `NoSpec`, resolve and write a pin before running (§03.6) | yes |
| `JUP_DEFAULT_TO_LATEST` | `0` | Never query "latest", never auto-bump the last-known-good; use the compiled-in default | yes |
| `JUP_ENABLE_NETWORK` | `0` | Refuse every network request | yes |
| `JUP_ENABLE_UNSAFE_CUSTOM_URLS` | `1` | Allow a URL reference for a *known* tool. Unknown names may always use URLs | **no** |
| `JUP_ENABLE_DOWNLOAD_PROMPT` | `0`/`1` | Announce and confirm artifact downloads. Default `0` invoked as jup, `1` through a shim | **no** |
| `JUP_ENABLE_PRERELEASES` | `1` | Allow prereleases in implicit resolution | yes |
| `JUP_MINIMUM_RELEASE_AGE` | hours | Filter younger releases from implicit resolution; exact pins exempt (§04.1) | yes |
| `JUP_FROZEN_LOCKFILE` | `1` | Refuse lockfile creation, refresh, and deletion (§04.4) | yes |
| `JUP_SPEC_FILE` | path | External file supplying the project's pin fields (§03.1) | **no** |
| `JUP_ENV_FILE` | `0` or a path | `0` disables env files; otherwise the file to look for instead of `.jup.env` | **no** |
| `JUP_HOME` | path | Root of the store and the global state (§07.1) | **no** |

## 11.2 Registry, auth and trust

| Variable | Values | Effect | Env file |
|---|---|---|---|
| `JUP_NPM_REGISTRY` | URL | Base registry for the whole table; trailing slashes stripped | yes |
| `JUP_REGISTRY_<NAME>` | URL | Per-tool registry/download origin; `<NAME>` is the upper-cased tool name with non-alphanumerics folded to `_` | yes |
| `JUP_NPM_TOKEN` | string | Origin-scoped Bearer auth; presence counts | **no** |
| `JUP_NPM_USERNAME` / `JUP_NPM_PASSWORD` | string | Origin-scoped Basic auth; a username alone sends nothing, and an explicitly empty password is meaningful | **no** |
| `JUP_INTEGRITY_KEYS` | `""`/`0`/JSON | `""` or `0` disables signature verification; anything else replaces the trust store (§06.4) | **no** |
| `JUP_REQUIRE_SIGNATURES` | `1` | Turn §06.1's unsigned soft-fail into a hard failure | yes |
| `JUP_ALLOW_UNVERIFIED` | `1` | Per-run opt-out from §06.1's fail-closed tier, warning per artifact | **no** |
| `JUP_CAFILE` | path | PEM bundle added to TLS trust | **no** |
| `JUP_STRICT_SSL` | `0` | Disable TLS verification, with a warning naming the source | **no** |
| `JUP_NETWORK_TIMEOUT` | ms | Connect and idle timeout; default 30000 | yes |
| `JUP_NETWORK_RETRIES` | integer | GET retry attempts; default 3, `0` disables, capped at 10 | yes |

## 11.3 Execution and shims

| Variable | Values | Effect | Env file |
|---|---|---|---|
| `JUP_NODE_EXECPATH` | path | JavaScript runtime used to execute a spawned JS entry point (§08.3) | **no** |
| `JUP_SHIM_DIRECTORY` | path | Default shim directory (§10.5) | **no** |
| `JUP_HOST_RUNTIME` | path | A validated absolute runtime outside the install folder, forwarded through native child chains and read by `enable` (§10.2) | **no** |
| `JUP_QUIET_ADVISORIES` | `1` | Silence added advisory `!` lines. Never silences errors, the download prompt, auto-pin, validation warnings, or Yarn Switch notices | **no** |

## 11.4 Set by jup, read by others

| Variable | Value |
|---|---|
| `COREPACK_ROOT` / `JUP_ROOT` | The directory containing jup's own installation root, exported so a tool can detect it runs under a version manager. No effect on jup itself |
| `COREPACK_MIGRATE_FROM` / `JUP_MIGRATE_FROM` | Set only during `use`/`up`: the previous pin, or the literal `unknown` |

Both are written under **both** spellings, so a tool that has learnt the new name
finds it too.

## 11.5 Consumed from the ambient environment

| Variable | Effect |
|---|---|
| `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` and lowercase forms | Proxy configuration (§05.1); lowercase is consulted first |
| `CI` | Any non-empty value: the download prompt announces but does not wait |
| `XDG_CACHE_HOME`, `LOCALAPPDATA`, `HOME`/`USERPROFILE` | Store location chain (§07.1) |
| `XDG_BIN_HOME`, `ProgramData` | Shim directory candidates (§10.5) |
| `PATH`, `PATHEXT` | Shim directory choice, executable lookup |
| `npm_config_prefix`, `PREFIX` | Locating the global `.npmrc` (§05.3) |
| `SHELL`, `PSModulePath` | Shell detection for `enable`'s `PATH` hint |
| `DEBUG` | Containing `jup` (or `corepack`) enables diagnostic logging to stderr |
| `NO_COLOR`, `FORCE_COLOR`, `TERM` | Colour decisions (§09.14). `FORCE_COLOR` wins over both `NO_COLOR` and agent detection |
| The agent variables | An AI coding agent announces itself; jup's own output is not coloured (§09.14). The list is vendored from `unjs/std-env`'s agent table and includes three agents detected by value rather than by a variable of their own |

## 11.6 Precedence

```
1. real environment, JUP_<NAME>                       (highest)
2. real environment, COREPACK_<NAME>, compatibility set only
3. .jup.env, any spelling the setting answers to, if eligible
4. the built-in default                               (lowest)
```

Step 2 exists only for §11.7's set. For every other variable the `COREPACK_`
spelling names nothing and is read by nobody.

The env-file deny-list carries **both** spellings of every entry it names,
including the `COREPACK_` spelling of a `JUP_`-only variable, so a name is
checked exactly as the file spelled it and renaming a key is not a way past the
list. Both spellings are refused even where jup would ignore the second: the
deny-list governs what a cloned repository may *inject* into the environment,
which every child process inherits, not merely what jup itself reads back.

Conversely, a real `COREPACK_<NAME>` MUST NOT shadow an env file's
`JUP_<NAME>` outside the compatibility set — the file's value would give way to
a variable that has no effect.

**Presence decides, not truthiness**: `JUP_NPM_PASSWORD=` shadows a set
`COREPACK_NPM_PASSWORD`, because the empty string is meaningful for several of
these. A diagnostic that names the variable which supplied a value names **the
spelling the user actually set** — this is the one place `COREPACK_` may appear
in output. A message that merely *suggests* a variable names the `JUP_` spelling.

Resolve each setting once at startup so downstream code cannot observe different
values for one setting.

## 11.7 The compatibility spelling

These, and only these, also answer to `COREPACK_<NAME>`. They are the settings
corepack defined, so a CI or a project written against corepack keeps working
when jup replaces it (§01) — which is the whole of what the set is for. Adding to
it would be inventing a compatibility burden rather than honouring one.

| | |
|---|---|
| Behaviour (§11.1) | `ENABLE_PROJECT_SPEC`, `ENABLE_STRICT`, `ENABLE_AUTO_PIN`, `DEFAULT_TO_LATEST`, `ENABLE_NETWORK`, `ENABLE_UNSAFE_CUSTOM_URLS`, `ENABLE_DOWNLOAD_PROMPT`, `ENV_FILE`, `HOME` |
| Registry and auth (§11.2) | `NPM_REGISTRY`, `NPM_TOKEN`, `NPM_USERNAME`, `NPM_PASSWORD`, `INTEGRITY_KEYS` |
| Written, not read (§11.4) | `ROOT`, `MIGRATE_FROM` |

## 11.8 The configuration boundary

These variables, the constrained `.npmrc` (§05.3), the project manifest, version
files, and `jup.lock` are the complete configuration surface. There is no config
file format of jup's own, and no plugin system. Adding one would be a scope
change (§01.7).
