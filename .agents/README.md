# Package Manager Version Manager — Implementation Specification

A normative, implementation-agnostic specification for a **package manager version
manager** (PMVM): the class of tool that reads a project's declared package manager,
fetches the exact version, verifies it, caches it, and executes it.

The reference implementation studied to produce this spec is
[`nodejs/corepack`](https://github.com/nodejs/corepack) at commit `b856c516`
(v0.35.0, 2026-08-15). This spec captures corepack's observable contract so that a
**re-implementation in any language (JS, Rust, Zig, Go, C)** can be a drop-in
replacement, while being explicit about which corepack behaviours are *contract* and
which are *incidental to its Node.js host*.

## Design goals for the re-implementation

These goals are normative. Where corepack's design conflicts with them, this spec
says so explicitly and prescribes the alternative.

| Goal | Meaning | Consequence in this spec |
|---|---|---|
| **Fast** | Cold start under ~5 ms; a cache-hit run must do zero network I/O and a bounded number of syscalls. | No dynamic config discovery beyond what is required; single `stat` fast path (§07); no subprocess for the common case where the host allows in-process execution. |
| **Small** | Single self-contained binary or single-file script. | Embedded registry table (§02); no vendored semver library — implement the required subset (§04). |
| **Zero dependency** | No third-party runtime dependencies. | Every algorithm here is specified concretely enough to implement from scratch: semver subset, tar extraction, HTTP, ECDSA verification. |
| **Minimal** | Do one job. No plugin system, no config DSL, no telemetry. | The CLI surface in §09 is the complete surface. Anything not listed is out of scope. |

## Reading order

| File | Contents |
|---|---|
| [`01-overview.md`](./01-overview.md) | Architecture, the two entry modes, the end-to-end request pipeline |
| [`02-data-model.md`](./02-data-model.md) | Descriptors, locators, specs; the embedded package-manager registry table |
| [`03-project-spec.md`](./03-project-spec.md) | Manifest discovery, `packageManager` / `devEngines.packageManager` parsing, env files |
| [`04-version-resolution.md`](./04-version-resolution.md) | Tags, ranges, the semver subset, cache lookup, last-known-good |
| [`05-registry.md`](./05-registry.md) | HTTP layer, npm registry protocol, auth, proxies |
| [`06-integrity.md`](./06-integrity.md) | Hash suffixes, npm registry signatures, trust store |
| [`07-store.md`](./07-store.md) | On-disk layout, atomic install, tarball extraction, concurrency |
| [`08-execution.md`](./08-execution.md) | Handing control to the package manager; argv, env, exit codes, signals |
| [`09-cli.md`](./09-cli.md) | The complete command surface |
| [`10-shims.md`](./10-shims.md) | `enable` / `disable`, POSIX and Windows shim mechanics |
| [`11-environment.md`](./11-environment.md) | Normative table of every environment variable |
| [`12-errors.md`](./12-errors.md) | Normative error messages and exit codes |
| [`13-conformance.md`](./13-conformance.md) | Test matrix a conforming implementation must pass |
| [`14-divergences.md`](./14-divergences.md) | Where this spec deliberately departs from corepack, and why |
| [`15-gaps.md`](./15-gaps.md) | **Normative.** Gaps from corepack's open issue tracker: registry/TLS, trust, shims, cache, core semantics |
| [`16-implementation-notes.md`](./16-implementation-notes.md) | Non-normative build guidance: budgets, what to write, layout, testing |

## Conformance language

**MUST** / **MUST NOT** / **SHOULD** / **MAY** are used per RFC 2119. A **conforming
implementation** satisfies every MUST in files 01–12 **and §15**, and passes every test
in §13 (tests 1–147) and §15.38 (tests 148–203).

§14 and §15 both prescribe departures from corepack: §14 from reading its source,
§15 from its issue tracker. Both are normative; where they overlap, §15 refines §14.

Text in `fixed width` that appears inside a "verbatim" callout is part of the
observable contract — user-facing strings are matched by real-world scripts and CI,
so they MUST be reproduced byte-for-byte.
