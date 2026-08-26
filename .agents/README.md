# jup implementation specification

This directory defines how jup discovers, downloads, verifies, caches, and runs the tools a project pins — today its package manager, and by the model in [`17-domains.md`](./17-domains.md) its language runtime. The specification is independent of any programming language or runtime so that the same behavior can be implemented in JavaScript, Rust, Zig, Go, C, or another suitable language.

The behavior is based on [`nodejs/corepack`](https://github.com/nodejs/corepack) at commit `b856c516` (v0.35.0, 2026-08-15). The specification separates Corepack behavior that users and scripts depend on from details that exist only because Corepack runs on Node.js.

## Design goals

These goals are requirements, not general preferences. When Corepack behaves differently, the relevant section explains the difference and defines the behavior jup must follow.

| Goal | Requirement | Effect on the implementation |
| --- | --- | --- |
| **Fast** | Start in under roughly 5 ms when cold. A cached run must not use the network and must make only a bounded number of system calls. | Avoid unnecessary configuration discovery. Use the single-`stat` cache fast path described in §07. Run the package manager in-process when the host supports it. |
| **Small** | Ship as one self-contained binary or one standalone script. | Embed the package manager registry described in §02. Implement the required semver operations instead of including a general-purpose semver library. |
| **No runtime dependencies** | Do not require third-party libraries at runtime. | Implement the required semver, archive extraction, HTTP, and ECDSA behavior directly from the algorithms in this specification. |
| **Focused** | Manage and run the tool that installs a project's dependencies and the tool that runs its code, and nothing more (§17.8). | Do not add plugins, a configuration language, or telemetry. The commands in §09 are the complete public CLI. |

## How to read the specification

Start with the overview, then follow the files in numeric order when implementing the complete system. For work on one subsystem, use this table to find the relevant contract.

| File | Covers |
| --- | --- |
| [`01-overview.md`](./01-overview.md) | Architecture, invocation modes, and the complete request flow |
| [`02-data-model.md`](./02-data-model.md) | Descriptors, locators, specs, and the built-in package manager registry |
| [`03-project-spec.md`](./03-project-spec.md) | Manifest discovery, `packageManager`, `devEngines.packageManager`, and env files |
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
| [`15-gaps.md`](./15-gaps.md) | Required behavior derived from unresolved Corepack issues, including registry, TLS, trust, shim, cache, and resolution behavior |
| [`16-implementation-notes.md`](./16-implementation-notes.md) | Non-normative guidance on structure, performance budgets, implementation order, and testing |
| [`17-domains.md`](./17-domains.md) | Tools and roles, the command router and its scope words, and the breaking changes that keep runtime management open |

## Requirements language

The words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** have the meanings defined by RFC 2119.

An implementation conforms to this specification when it:

- satisfies every **MUST** in files 01 through 12;
- satisfies the additional requirements in §15 and §17;
- passes tests 1–147 in §13;
- passes tests 148–207 in §15.38; and
- passes tests 208–233 in §17.9.

Sections 14, 15, and 17 define intentional differences from Corepack. Section 14 records differences found while studying Corepack's source. Section 15 adds requirements derived from its issue tracker. Section 17 widens the subject from *package manager* to *tool* and fixes the parts of the design that cannot change after 1.0. Where two sections cover the same behavior, the later one takes precedence.

Some user-facing text is part of the compatibility contract. Content marked as verbatim and shown in `fixed width` must be reproduced exactly, including capitalization, spacing, and punctuation. Existing scripts and CI jobs may compare these messages byte for byte.
