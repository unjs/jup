# 11 — Environment Variables (Normative)

Every `COREPACK_` setting below also accepts the canonical `JUP_` spelling with
the same values, defaults, and env-file eligibility. `JUP_` wins by presence when
both exist (§11.6). Suggested remedies name `JUP_`; source diagnostics name the
spelling the user set. Standard ambient variables such as `PATH` and `CI` have no
prefixed aliases.

Legend for **Env file** column: whether the variable may be supplied by
`.jup.env` (§03.2), under either spelling. A real environment variable
always wins over the file.

## 11.1 Behaviour

| Variable | Accepted values | Effect | Env file |
|---|---|---|---|
| `COREPACK_ENABLE_PROJECT_SPEC` | `0` | Ignore the project's `packageManager` / `devEngines`, and its version file, entirely; always use the fallback (last-known-good or built-in default) version. | yes |
| `COREPACK_ENABLE_STRICT` | `0` | Don't error when the invoked package manager differs from the project's. Behaves as if every command were transparent (§01.4): the project's own package manager still honours the pin; a different one falls back to its global default. | yes |
| `COREPACK_ENABLE_AUTO_PIN` | `1` | When the project has a `package.json` but no spec, resolve and write a `packageManager` pin before running. | yes |
| `COREPACK_DEFAULT_TO_LATEST` | `0` | Never query the registry for "latest", and never auto-bump last-known-good on install. Use the compiled-in default version. | yes |
| `COREPACK_ENABLE_NETWORK` | `0` | Refuse every network request: `Network access disabled by the environment; can't reach <url>`. | yes |
| `COREPACK_ENABLE_UNSAFE_CUSTOM_URLS` | `1` | Allow a URL reference for a *known* package manager name. Without it, `yarn@https://…` is refused. Unknown names may always use URLs. | **no** |
| `COREPACK_ENABLE_DOWNLOAD_PROMPT` | `0` / `1` | `1` prints `! jup is about to download <url>` before each artifact download and, on a TTY outside CI, asks for confirmation. Default is `0` when invoked as the tool itself, `1` when invoked through a package-manager shim. | **no** |
| `COREPACK_ENV_FILE` | `0` or a path | `0` disables env-file loading. Otherwise names the file to look for instead of `.jup.env` (§03.2 also reads `.corepack.env` when this is unset). | **no** |
| `COREPACK_HOME` | path | Root of the store and `lastKnownGood.json`. Default `$XDG_CACHE_HOME/jup`, else `%LOCALAPPDATA%\jup` on Windows, else `~/.cache/jup` (`~/AppData/Local/jup` on Windows). | **no** |

## 11.2 Registry and auth

| Variable | Accepted values | Effect | Env file |
|---|---|---|---|
| `COREPACK_NPM_REGISTRY` | URL | Base registry URL for the whole table. Trailing slashes are stripped. Default `https://registry.npmjs.org`. | yes |
| `COREPACK_NPM_TOKEN` | string | Origin-scoped `Authorization: Bearer <token>`; presence counts. | **no** |
| `COREPACK_NPM_USERNAME` | string | With a present password, origin-scoped Basic auth. Username alone sends nothing. | **no** |
| `COREPACK_NPM_PASSWORD` | string | See above. Set it explicitly to the empty string to send an empty password. | **no** |
| `COREPACK_INTEGRITY_KEYS` | `""` / `0` / JSON | `""` or `0` disables signature verification. Any other value replaces the built-in trust store. | **no** |
| `COREPACK_REGISTRY_<NAME>` | URL | Per-tool registry/download origin. | yes |
| `COREPACK_CAFILE` | path | PEM bundle added to TLS trust. | **no** |
| `COREPACK_STRICT_SSL` | `0` | Disable TLS verification with a warning. | **no** |
| `COREPACK_NETWORK_TIMEOUT` | ms | Connect and idle timeout; default `30000`. | yes |
| `COREPACK_NETWORK_RETRIES` | integer | GET retry attempts; default `3`, `0` disables. | yes |
| `COREPACK_REQUIRE_SIGNATURES` | `1` | Missing signatures are fatal. | yes |
| `COREPACK_ALLOW_UNVERIFIED` | `1` | Ambient-only per-run opt-out from §06.1's fail-closed verification tier; warn for each permitted artifact. | **no** |

## 11.3 Set *by* the tool, read by others

| Variable | Value |
|---|---|
| `COREPACK_ROOT` | Directory containing the tool's own installation root. Exported into the package manager's environment so it can detect it is running under a version manager. Has no effect on the tool itself. |
| `COREPACK_MIGRATE_FROM` | Set only during `use` / `up`, before running the package manager's `use` command. Contains the previous `packageManager` value, or the `devEngines` spec, or the literal string `unknown`. |

## 11.4 Consumed from the ambient environment

| Variable | Effect |
|---|---|
| `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` (and lowercase forms) | Direct proxy configuration using §05.1 semantics. |
| `CI` | When set, the download prompt prints its notice but does not wait for confirmation. |
| `XDG_CACHE_HOME`, `LOCALAPPDATA`, `HOME`/`USERPROFILE` | Store location fallback chain (§07.1). |
| `PATH` | Shim install-directory lookup (§10.4); locating a JavaScript runtime in a native implementation (§08.3). |
| `ProgramData` | Windows only: `--system`'s shim directory, `%ProgramData%\jup\bin`. |
| `DEBUG` | Containing `jup` — or `corepack`, which the reference implementation documents — enables verbose diagnostic logging to stderr. |
| `NO_COLOR` | Set to any value: our own output is never coloured (§09.11). Contract text is unaffected either way. |
| `FORCE_COLOR` | Colour our own output even when the stream is not a terminal. Takes precedence over `NO_COLOR` and over agent detection; `0` disables. |
| `AI_AGENT`, `CLAUDECODE`, `CLAUDE_CODE`, `REPL_ID`, `GEMINI_CLI`, `CODEX_SANDBOX`, `CODEX_THREAD_ID`, `OPENCODE`, `AUGMENT_AGENT`, `GOOSE_PROVIDER`, `JUNIE_DATA`, `JUNIE_SHIM_PATH`, `CURSOR_AGENT` | Set by an AI coding agent: our own output is not coloured (§09.11). Presence alone is the signal. The list is `unjs/std-env`'s agent table. |
| `PATH` containing `.pi/agent`, `EDITOR` matching `devin`, `TERM_PROGRAM` matching `kiro` | The same table's three agents that announce themselves by value rather than by a variable of their own. |

## 11.5 Additional settings

| Variable | Accepted values | Effect | Env file |
|---|---|---|---|
| `COREPACK_NODE_EXECPATH` | path | Path to the JavaScript runtime used to execute package managers. Only meaningful for a native implementation (§08.3.1). Falls back to a sibling runtime, then `PATH`. | **no** |
| `COREPACK_QUIET_ADVISORIES` | `1` | Silence added advisory `!` lines. It never silences errors, download/prompt, auto-pin, validation, or Yarn Switch notices. | **no** |
| `COREPACK_HOST_RUNTIME` | path | Validated absolute runtime outside `<home>`, passed through native child chains and used by `enable`. | **no** |
| `COREPACK_SHIM_DIRECTORY` | path | Default shim directory. | **no** |
| `COREPACK_FROZEN_LOCKFILE` | `1` | Refuse lock creation, refresh, or deletion. | yes |
| `COREPACK_ENABLE_PRERELEASES` | `1` | Allow prereleases in implicit resolution. | yes |
| `COREPACK_SPEC_FILE` | path | External file supplying project package-manager fields. | **no** |
| `COREPACK_MINIMUM_RELEASE_AGE` | hours | Filter younger releases from implicit resolution; exact pins are exempt. | yes |

## 11.6 Precedence

Each prefixed pair is one setting. Canonicalize the name before checking env-file
eligibility, so the compatibility spelling cannot bypass the deny list. Settings in
§11.3 are written under both names.

For any variable:

```
1. real process environment, JUP_<NAME>            (highest)
2. real process environment, COREPACK_<NAME>
3. .jup.env, either spelling, if the variable is env-file-eligible
4. the tool's built-in default                     (lowest)
```

Presence decides, not truthiness: `JUP_NPM_PASSWORD=` shadows a
`COREPACK_NPM_PASSWORD` that is set, because §11.2 makes the empty string a
meaningful value. A diagnostic that names the variable that supplied a value MUST name the spelling the
user actually set. This is the one place `COREPACK_` may appear in output; a
message that merely *suggests* a variable names the `JUP_` spelling.

Only the **closest** env file to `cwd` is consulted, and only directories at or below
the project root are searched (the walk stops once a manifest with a `packageManager`
field is found). Directories inside `node_modules` are skipped entirely.

## 11.7 Configuration boundary

These settings, constrained `.npmrc` (§05.3), project manifests, version files, and
the explicit lock/memo formats are the complete configuration surface. Do not add a
plugin or general configuration system. Resolve each `JUP_`/`COREPACK_` pair once at
startup so downstream code cannot observe different values.
