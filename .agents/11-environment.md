# 11 — Environment Variables (Normative)

**Every variable in this file has two spellings.** The tool is `jup`; the tables
below are written in corepack's `COREPACK_` spelling because that is what
existing projects, CI configuration and §13's rows already set. For each
`COREPACK_<NAME>` an implementation MUST also honour `JUP_<NAME>`, naming the
same setting: same accepted values, same default, same env-file eligibility,
same §14.5 deny-list entry. `JUP_` wins when both are set (§11.6). The full rule,
including what this means for the env file and for diagnostics, is §11.6; the
rationale is §14.22.

Legend for **Env file** column: whether the variable may be supplied by
`.corepack.env` (§03.2), under either spelling. A real environment variable
always wins over the file.

## 11.1 Behaviour

| Variable | Accepted values | Effect | Env file |
|---|---|---|---|
| `COREPACK_ENABLE_PROJECT_SPEC` | `0` | Ignore the project's `packageManager` / `devEngines` entirely; always use the fallback (last-known-good or built-in default) version. | yes |
| `COREPACK_ENABLE_STRICT` | `0` | Don't error when the invoked package manager differs from the project's. Behaves as if every command were transparent (§01.4): the project's own package manager still honours the pin; a different one falls back to its global default. | yes |
| `COREPACK_ENABLE_AUTO_PIN` | `1` | When the project has a `package.json` but no spec, resolve and write a `packageManager` pin before running. | yes |
| `COREPACK_DEFAULT_TO_LATEST` | `0` | Never query the registry for "latest", and never auto-bump last-known-good on install. Use the compiled-in default version. | yes |
| `COREPACK_ENABLE_NETWORK` | `0` | Refuse every network request: `Network access disabled by the environment; can't reach <url>`. | yes |
| `COREPACK_ENABLE_UNSAFE_CUSTOM_URLS` | `1` | Allow a URL reference for a *known* package manager name. Without it, `yarn@https://…` is refused. Unknown names may always use URLs. | **no** (§14.5) |
| `COREPACK_ENABLE_DOWNLOAD_PROMPT` | `0` / `1` | `1` prints `! Corepack is about to download <url>` before each artifact download and, on a TTY outside CI, asks for confirmation. Default is `0` when invoked as the tool itself, `1` when invoked through a package-manager shim. | **no** |
| `COREPACK_ENV_FILE` | `0` or a path | `0` disables env-file loading. Otherwise names the file to look for instead of `.corepack.env`. | **no** |
| `COREPACK_HOME` | path | Root of the store and `lastKnownGood.json`. Default `$XDG_CACHE_HOME/node/corepack`, else `%LOCALAPPDATA%\node\corepack`, else `~/.cache/node/corepack` (`~/AppData/Local/node/corepack` on Windows). | yes |

## 11.2 Registry and auth

| Variable | Accepted values | Effect | Env file |
|---|---|---|---|
| `COREPACK_NPM_REGISTRY` | URL | Base registry URL. Trailing slashes are stripped. May embed `user:pass@`. Default `https://registry.npmjs.org`. Setting it also switches Yarn Berry from `repo.yarnpkg.com` to the `@yarnpkg/cli-dist` npm package. | yes |
| `COREPACK_NPM_TOKEN` | string | `Authorization: Bearer <token>`. Origin-scoped on downloads; unscoped on metadata requests in the reference implementation (§14.6 requires scoping both). Presence alone counts — an empty value still suppresses Basic auth on the metadata path. | **no** (§14.5) |
| `COREPACK_NPM_USERNAME` | string | With `COREPACK_NPM_PASSWORD`, `Authorization: Basic base64(user:pass)`. Username alone sends nothing on the metadata path. | **no** (§14.5) |
| `COREPACK_NPM_PASSWORD` | string | See above. Set it explicitly to the empty string to send an empty password. | **no** (§14.5) |
| `COREPACK_INTEGRITY_KEYS` | `""` / `0` / JSON | `""` or `0` disables signature verification. Any other value is parsed as `{"npm": [<key>…]}` and **replaces** the built-in trust store. | **no** (§14.5) |

## 11.3 Set *by* the tool, read by others

| Variable | Value |
|---|---|
| `COREPACK_ROOT` | Directory containing the tool's own installation root. Exported into the package manager's environment so it can detect it is running under a version manager. Has no effect on the tool itself. |
| `COREPACK_MIGRATE_FROM` | Set only during `use` / `up`, before running the package manager's `use` command. Contains the previous `packageManager` value, or the `devEngines` spec, or the literal string `unknown`. |

## 11.4 Consumed from the ambient environment

| Variable | Effect |
|---|---|
| `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` (and lowercase forms) | Proxy configuration. **In the reference implementation these are inert unless `NODE_USE_ENV_PROXY=1` is also set.** This spec requires honouring them directly (§05.1, §14.8). |
| `CI` | When set, the download prompt prints its notice but does not wait for confirmation. |
| `XDG_CACHE_HOME`, `LOCALAPPDATA`, `HOME`/`USERPROFILE` | Store location fallback chain (§07.1). |
| `PATH` | Shim install-directory lookup (§10.4); locating a JavaScript runtime in a native implementation (§08.3). |
| `DEBUG` | Containing `corepack` enables verbose diagnostic logging to stderr. |

## 11.5 New in this spec

| Variable | Accepted values | Effect | Env file |
|---|---|---|---|
| `COREPACK_NODE_EXECPATH` | path | Path to the JavaScript runtime used to execute package managers. Only meaningful for a native implementation (§08.3.1). Falls back to a sibling runtime, then `PATH`. | yes |

## 11.6 Precedence

Every variable in this file has **two spellings**. The tables are written in
corepack's, because that is what existing projects, CI configuration and §13's
rows already set; the implementation is `jup`, and answers to `JUP_<NAME>` for
each `COREPACK_<NAME>` above. The pair is one variable: the same default, the
same env-file eligibility, the same deny-list entry (§14.5's list is keyed by the
`COREPACK_` spelling and canonicalised before it is checked, so renaming a key is
not a way past it). The two variables §11.3 *sets* are written under both names.

For any variable:

```
1. real process environment, JUP_<NAME>            (highest)
2. real process environment, COREPACK_<NAME>
3. .corepack.env, either spelling, if the variable is env-file-eligible
4. the tool's built-in default                     (lowest)
```

Presence decides, not truthiness: `JUP_NPM_PASSWORD=` shadows a
`COREPACK_NPM_PASSWORD` that is set, because §11.2 makes the empty string a
meaningful value. A diagnostic that names the variable that supplied a value
(§15.4's `set by COREPACK_CAFILE`, `info`'s `frozenSource`) MUST name the
spelling the user actually set.

Only the **closest** env file to `cwd` is consulted, and only directories at or below
the project root are searched (the walk stops once a manifest with a `packageManager`
field is found). Directories inside `node_modules` are skipped entirely.

## 11.7 Design note for a minimal implementation

Reading these is the *only* configuration input the tool has. There is no config
file, no `.npmrc`, no user profile, no registry of registries. A conforming
implementation MUST NOT add one; every knob above is a lookup in the environment
block that is already in memory at startup, which is what keeps the cold path free of
I/O.

Practical guidance: read the whole environment block once into a small struct at
startup rather than doing repeated lookups. A single pass with a perfect-hash or a
sorted-prefix scan over the two prefixes is measurably cheaper than a `getenv` per
variable in the hot path, and it makes the env-file merge trivial. Resolve the
`JUP_`/`COREPACK_` pair into one slot during that pass, `JUP_` winning, so that
nothing downstream can read one spelling and miss the other — a bare lookup on a
single spelling is the defect §14.22 exists to prevent, and it fails silently,
because a variable that is not set and a variable whose name is wrong are the
same observation.
