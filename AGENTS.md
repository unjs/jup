# jup maintainer guide

jup discovers, verifies, caches, and runs the tools in its built-in table. This
directory is the current behavior contract. It uses plain implementation-neutral
language; code and executable tests remain the final check.

## Rules that apply everywhere

- **MUST**, **MUST NOT**, **SHOULD**, and **MAY** use RFC 2119 meanings.
- Preserve text marked exact or verbatim byte for byte. This includes punctuation,
  spacing, stream, and newline behavior.
- User-facing names use `jup` and `JUP_`. Compatibility inputs also accept
  `COREPACK_`; `.corepack.env` remains a supported fallback name.
- Keep the compiled-in tool table closed. Do not add plugins, telemetry, a general
  configuration language, or runtime dependencies.
- A warm exact pinned run uses no network, does not read global defaults, and makes
  only bounded filesystem probes.
- Never `import` a `node:` builtin. Reach builtins through `process.getBuiltinModule`
  where they are used ([maintenance](./.agents/16-implementation-notes.md)).

## Security invariants

- Scope credentials to their configured origin/path and remove them on cross-origin
  redirects ([network](./.agents/05-registry.md)).
- Project env files cannot set credentials, trust overrides, TLS weakening, cache
  home, prompts, shim paths, or host runtimes ([environment](./.agents/11-environment.md)).
- Verify raw downloaded bytes before promotion. Treat archive paths, links, special
  files, size, count, and executable modes as hostile ([integrity](./.agents/06-integrity.md),
  [store](./.agents/07-store.md)).
- Never commit a host-specific digest as a portable project pin.

## Find the contract

| Task | Read |
| --- | --- |
| Entry modes, request flow, performance boundary | [01 overview](./.agents/01-overview.md) |
| Types, host model, built-in table, trust data | [02 data model](./.agents/02-data-model.md) |
| Project/env discovery, parsing, pin writes | [03 project spec](./.agents/03-project-spec.md) |
| Semver, tags, cache, lock/memo, global defaults | [04 resolution](./.agents/04-version-resolution.md) |
| HTTP, npm registries, auth, TLS, proxies, `.npmrc` | [05 network](./.agents/05-registry.md) |
| Hashes, signatures, keys, verification tiers | [06 integrity](./.agents/06-integrity.md) |
| Store layout, safe extraction, atomic promotion | [07 store](./.agents/07-store.md) |
| Bin lookup, environment, process handover | [08 execution](./.agents/08-execution.md) |
| Public commands and output streams | [09 CLI](./.agents/09-cli.md) |
| POSIX and Windows shims | [10 shims](./.agents/10-shims.md) |
| Supported settings and precedence | [11 environment](./.agents/11-environment.md) |
| Exact messages and exit codes | [12 errors](./.agents/12-errors.md) |
| Test strategy and commands | [13 testing](./.agents/13-conformance.md) |
| Recurring maintenance work | [16 maintenance](./.agents/16-implementation-notes.md) |

The product stays focused: manage and run table entries, write only documented
project pins/locks/memos and managed state, and expose only the commands in §09.
