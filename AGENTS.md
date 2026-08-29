# jup maintainer guide

jup discovers, verifies, caches and runs the tools in its built-in table.
`.agents/` describes what the code does and why. It is a map, not a standard:
where the two disagree, `src/` and the test suites win, and the docs get fixed.

## Rules that apply everywhere

- **MUST**, **MUST NOT**, **SHOULD** and **MAY** use RFC 2119 meanings. They mark
  real invariants — mostly security and output contracts — not house style.
- Preserve text marked exact or verbatim byte for byte, punctuation, spacing,
  stream and newline behaviour included. §12 lists it.
- User-facing names use `jup` and `JUP_`. Compatibility inputs also accept
  `COREPACK_`, and `.corepack.env` is a supported fallback filename.
- Keep the compiled-in tool table closed. No plugins, no telemetry, no general
  configuration language, no runtime dependencies.
- A warm exact pinned run uses no network, does not read global defaults, and
  makes only bounded filesystem probes.
- Never `import` a `node:` builtin. Reach builtins through
  `process.getBuiltinModule` where they are used ([16](./.agents/16-implementation-notes.md)).
- Table values — versions, digests, host maps, trust keys — live in `src/config/`
  and are refreshed by script. Do not copy them into the docs.

## Security invariants

- Scope credentials to their configured origin and path, and drop them on
  cross-origin redirects ([05](./.agents/05-registry.md)).
- Project env files cannot set credentials, trust overrides, TLS weakening, the
  cache home, prompts, shim paths, or host runtimes
  ([11](./.agents/11-environment.md)).
- Verify raw downloaded bytes before promotion. Treat archive paths, links,
  special files, sizes, counts and executable modes as hostile
  ([06](./.agents/06-integrity.md), [07](./.agents/07-store.md)).
- Never commit a host-specific digest as a portable project pin.

## Find the contract

| Task | Read |
| --- | --- |
| Entry modes, request flow, performance boundary | [01 overview](./.agents/01-overview.md) |
| Types, host model, built-in table, trust data | [02 data model](./.agents/02-data-model.md) |
| Project/env discovery, parsing, pin writes | [03 project](./.agents/03-project-spec.md) |
| Semver, tags, store probe, `jup.lock`, global defaults | [04 resolution](./.agents/04-version-resolution.md) |
| HTTP, npm registries, auth, TLS, proxies, `.npmrc` | [05 network](./.agents/05-registry.md) |
| Hashes, signatures, keys, verification tiers | [06 integrity](./.agents/06-integrity.md) |
| Store layout, safe extraction, atomic promotion | [07 store](./.agents/07-store.md) |
| Bin lookup, environment, process handover | [08 execution](./.agents/08-execution.md) |
| Public commands and output streams | [09 CLI](./.agents/09-cli.md) |
| POSIX and Windows shims, `PATH` integration | [10 shims](./.agents/10-shims.md) |
| Supported settings and precedence | [11 environment](./.agents/11-environment.md) |
| Exact messages and exit codes | [12 errors](./.agents/12-errors.md) |
| Test strategy and commands | [13 testing](./.agents/13-conformance.md) |
| Build shape, table refresh, recurring work, known debts | [16 maintenance](./.agents/16-implementation-notes.md) |

There are no §14 or §15 pages. Those numbers labelled two working documents —
differences from Corepack, and requirements derived from its issue tracker —
whose content now lives in the pages above. Citations to them survive in some
code comments and test names and are being retired; do not add new ones. Cite the
topical page that owns the behaviour.

The product stays focused: manage and run table entries, write only the
documented project pins, lockfiles and managed state, and expose only the
commands in §09.
