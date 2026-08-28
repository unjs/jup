# jup implementation specification

jup (pronounced “yup”) discovers, downloads, verifies, caches, and runs developer tools — package managers, and the runtimes they run on. This directory defines its implementation specification. The specification is independent of any programming language or runtime so that the same behavior can be implemented in JavaScript, Rust, Zig, Go, C, or another suitable language.

"Tool" is the general term and "package manager" is one **kind** of tool (§02.3). The distinction reaches exactly four places, all of them in §03 and §10; everything from resolution through execution is one pipeline over both kinds. §15.39 states the model and what it deliberately does not open.

The behavior is based on [`nodejs/corepack`](https://github.com/nodejs/corepack) at commit `b856c516` (v0.35.0, 2026-08-15). The specification separates Corepack behavior that users and scripts depend on from details that exist only because Corepack runs on Node.js.

## Design goals

These goals are requirements, not general preferences. When Corepack behaves differently, the relevant section explains the difference and defines the behavior jup must follow.

| Goal | Requirement | Effect on the implementation |
| --- | --- | --- |
| **Fast** | Start in under roughly 5 ms when cold. A cached run must not use the network and must make only a bounded number of system calls. | Avoid unnecessary configuration discovery. Use the single-`stat` cache fast path described in §07. Run the package manager in-process when the host supports it. |
| **Small** | Ship as one self-contained binary or one standalone script. | Embed the tool registry described in §02. Implement the required semver operations instead of including a general-purpose semver library. |
| **No runtime dependencies** | Do not require third-party libraries at runtime. | Implement the required semver, archive extraction, HTTP, and ECDSA behavior directly from the algorithms in this specification. |
| **Focused** | Manage and run versions of the tools in the built-in table, and nothing more. | Do not add plugins, a configuration language, or telemetry. The table is not user-extensible (§15.21). The commands in §09 are the complete public CLI. |

## How to read the specification

Start with the overview, then follow the files in numeric order when implementing the complete system. For work on one subsystem, use this table to find the relevant contract.

| File | Covers |
| --- | --- |
| [`01-overview.md`](./01-overview.md) | Architecture, invocation modes, and the complete request flow |
| [`02-data-model.md`](./02-data-model.md) | Descriptors, locators, specs, tool kinds, and the built-in tool registry |
| [`03-project-spec.md`](./03-project-spec.md) | Manifest discovery, `packageManager`, `devEngines.packageManager`, `devEngines.runtime`, version files (`.nvmrc`), and env files |
| [`04-version-resolution.md`](./04-version-resolution.md) | Tags, ranges, the supported semver operations, cache lookup, and last-known-good versions |
| [`05-registry.md`](./05-registry.md) | HTTP behavior, the npm registry protocol, authentication, and proxies |
| [`06-integrity.md`](./06-integrity.md) | Digest suffixes, npm registry signatures, and trusted keys |
| [`07-store.md`](./07-store.md) | Cache layout, atomic installation, archive extraction, and concurrent installs |
| [`08-execution.md`](./08-execution.md) | Arguments, environment variables, process execution, exit codes, and signals |
| [`09-cli.md`](./09-cli.md) | The complete command-line interface |
| [`10-shims.md`](./10-shims.md) | `enable`, `disable`, and shim behavior on POSIX and Windows |
| [`11-environment.md`](./11-environment.md) | Every supported environment variable |
| [`12-errors.md`](./12-errors.md) | Required error messages and exit codes |
| [`13-conformance.md`](./13-conformance.md) | The test suite every conforming implementation must pass |
| [`14-divergences.md`](./14-divergences.md) | Intentional differences from Corepack and the reasons for them |
| [`15-gaps.md`](./15-gaps.md) | Required behavior derived from unresolved Corepack issues, including registry, TLS, trust, shim, cache, resolution, and tool-kind behavior |
| [`16-implementation-notes.md`](./16-implementation-notes.md) | Non-normative guidance on structure, performance budgets, implementation order, and testing |

## Requirements language

The words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** have the meanings defined by RFC 2119.

An implementation conforms to this specification when it:

- satisfies every **MUST** in files 01 through 12;
- satisfies the additional requirements in §15;
- passes tests 1–147 in §13; and
- passes tests 148–249 in §15.38.

Both §14 and §15 define intentional differences from Corepack. Section 14 records differences found while studying Corepack's source. Section 15 adds requirements derived from its issue tracker. If the two sections cover the same behavior, §15 takes precedence.

Some user-facing text is part of the compatibility contract. Content marked as verbatim and shown in `fixed width` must be reproduced exactly, including capitalization, spacing, and punctuation. Existing scripts and CI jobs may compare these messages byte for byte.

Those strings name **jup**, not Corepack, wherever Corepack's own text names itself — in the program name, in the usage lines, and in the `JUP_` variable a remedy points at. So do the paths: the store is `<cache>/jup`, its marker `.jup`, `pack`'s default output `jup.tgz`, and the env file `.jup.env` — which is the one name that keeps reading its Corepack spelling, because it is the only one that exists in repositories today. §14.24 states the rule and what it leaves alone; §12 carries the resulting text.
