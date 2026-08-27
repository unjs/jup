# 16 — Implementation Notes: Fast, Small, Zero-Dependency

Non-normative guidance for building this. The normative contract is §01–§13; this
file is about *how* to hit the four goals without violating it.

## 16.1 Budget

Targets for a native single-binary implementation:

| Metric | Target | Why it's achievable |
|---|---|---|
| Binary size | < 2 MB stripped | The only heavy pieces are gzip, ECDSA-P256, and TLS |
| Warm proxy invocation | < 5 ms to `exec` | One manifest read, one `stat`, one `execve` |
| Cold install | network-bound | Hashing and extraction stream concurrently |
| Runtime dependencies | zero | Everything below is a few hundred lines each |
| Allocations on the warm path | < 50 | See §16.3 |

The warm path is the one that matters: it runs on every `yarn`, `npm`, and `pnpm`
invocation on the machine, forever.

## 16.2 What you actually have to write

| Component | Rough size | Notes |
|---|---|---|
| Semver subset (§04.2) | ~400 lines | Parse, compare, range grammar, two satisfaction modes |
| JSON parser | ~500 lines, or use the stdlib | Needs to preserve key order for the manifest rewrite, and report indentation |
| HTTP/1.1 client | ~800 lines | GET only, chunked, redirects, `CONNECT` proxy |
| TLS | link the platform's | schannel / Secure Transport / OpenSSL — do **not** vendor a stack |
| gzip inflate | ~600 lines, or link zlib | Decompress only |
| tar reader | ~400 lines | ustar + PAX long names, with §07.4's safety rules |
| SHA-1/224/256/384/512 | ~600 lines, or link the platform | |
| ECDSA-P256 verify + DER/SPKI parse | ~700 lines, or link the platform | Verify only — no keygen, no signing |
| dotenv parser | ~80 lines | `KEY=value`, quotes, comments |
| Everything else | ~2000 lines | The actual logic in §01–§10 |

Prefer linking the platform's crypto and TLS over vendoring: it is smaller, it gets
security updates for free, and it picks up the system trust store, which is what
corporate environments need (§15).

## 16.3 The warm path, syscall by syscall

An exactly-pinned project with the version already in the store should look like:

```
readlink/proc-self-exe            (locate self, only if enable/disable)
getenv × N                        (one pass over environ, in-process; the
                                   JUP_/COREPACK_ pair resolves in that pass)
openat  ./package.json            → read → close
  ...plus one openat per ancestor directory until found
openat  ./.jup.env                → ENOENT (cheap; only until a manifest is found)
openat  ./.corepack.env           → ENOENT (legacy name, §03.2; only when .jup.env is absent)
stat    <store>/<pm>/<ver>/.jup
openat  <store>/<pm>/<ver>/.jup   → read → close
execve  <node> <binPath> <args...>
```

That is the whole thing. Notice what is absent: no `lastKnownGood.json` read, no
`opendir` of the store, no network, no temp files, no lockfile.

Things that will silently wreck this budget:

* Parsing the embedded registry table from JSON at startup → make it static data
  (§14.20).
* Calling `findInstalledVersion` for exact versions → §14.1.
* Reading `lastKnownGood.json` unconditionally → it is only needed when the project
  has no spec, and the fallback locator is **lazy** for exactly this reason (§02.1).
* Resolving the full manifest into a general-purpose JSON DOM → for the warm path
  you only need two string fields; a streaming scan that bails after
  `packageManager` and `devEngines` is dramatically cheaper. Keep a full parser for
  the rewrite path in `use`/`up`, which is not hot.
* Walking to the filesystem root when the project is one directory up. The walk
  stops at the first manifest *with* a `packageManager` field, so the common case is
  one or two directories.

## 16.4 Manifest rewriting without a full DOM

`use` / `up` / auto-pin must edit `package.json` while preserving indentation, line
endings, key order, and (per §14.7) the BOM. Serialising a parsed DOM loses all of
this unless the parser is order- and format-preserving.

The simpler approach: treat it as a **surgical text edit**.

* If a `"packageManager"` key already exists at the top level, locate its value span
  and replace just the string literal. Everything else in the file is untouched by
  construction.
* If it does not exist, insert `"packageManager": "<value>",` after the opening brace
  at the file's detected indentation, or before the closing brace if the object is
  empty.

This needs a JSON *scanner* (to find top-level keys and string spans correctly,
respecting escapes and nesting) but not a *builder*. It is smaller, faster, and
strictly more faithful than parse-and-reserialise. Validate by re-scanning the result.

## 16.5 Streaming the download

Do not buffer the tarball. One pass:

```
socket → [TLS] → tee ─→ digest(algo)
                  └───→ inflate → tar → filesystem
```

With §14.10's fix you need the digest of the compressed stream regardless of whether
you extract everything or one file, so the tee is unconditional and free.

Cap total inflated bytes and entry count as you go (§07.4 rule 7) rather than
checking afterwards — by then the disk is full.

## 16.6 Concurrency

There is exactly one concurrency primitive in this design: **`rename` is atomic within
a filesystem**, and losing that race is a success, not a failure (§07.5). Everything
else follows:

* Temp directories go *inside* the store so the rename never crosses a filesystem.
* Two processes downloading the same version do duplicated work and one discards it.
  That is fine; it is rare and bounded.
* Two processes downloading *different* versions never interact.
* The only shared mutable file is `lastKnownGood.json`, and §14.3 makes that write
  atomic too.

Resist adding a lockfile. Every lockfile design has a stale-lock story, and this one
does not need it.

## 16.7 Error handling posture

The tool sits in front of every package manager invocation on the machine. Its
failure modes must be biased toward *degrading* rather than *blocking*:

| Class | Posture |
|---|---|
| Store is unreadable/unwritable but the needed version is present | succeed silently |
| `lastKnownGood.json` corrupt | treat as empty |
| Cannot write `lastKnownGood.json` | continue, no message |
| Network unavailable but the version is cached | succeed |
| Integrity failure | **hard fail**, cache nothing |
| Project spec conflicts with the invoked binary | **hard fail** (unless transparent/strict-off) |
| Manifest is malformed JSON | **hard fail** |

The line is: anything about *what to run* fails loudly; anything about *bookkeeping*
degrades quietly.

## 16.8 Testing strategy

The reference implementation's suite is the right model and worth copying wholesale:

* A **local mock registry** implementing packuments, dist-tags, per-version metadata,
  tarballs, `401` on bad auth, ECDSA signing over `<name>@<version>:<integrity>`, and
  deliberately-broken modes (`invalid_signature`, `invalid_integrity`). Being able to
  serve a *validly signed but wrong* artifact is what makes the integrity tests real.
* A **record/replay HTTP cache** so the suite runs offline against real registry
  responses, keyed by `sha256(url + headers)`.
* **Fake package managers**: a directory in the store with a hand-written `.jup`
  and a trivial entry script. This is how §13.12's exit-code, signal, and stdio tests
  get written without downloading anything.
* A **live staleness test** comparing the embedded trust store against
  `GET https://registry.npmjs.org/-/npm/v1/keys` (§13.7 #81), and a scheduled job that
  refreshes the embedded default versions.

For a native implementation, add:

* A **fuzzer over the tar extractor** with path traversal, symlink escapes, absolute
  paths, long PAX names, and expansion bombs (§13.7 #84–85).
* A **fuzzer over the semver parser**, differentially compared against a reference
  semver implementation across a large corpus of real version strings and ranges.
  This is the subsystem most likely to diverge subtly, and divergence means resolving
  to the wrong version.
* **Byte-exact golden files** for every string in §12.

## 16.9 Maintaining the embedded table

The table (§02.5) goes stale: package managers publish new versions, npm rotates its
signing keys, and bin paths move between majors (pnpm has moved twice).

Run a scheduled job that:

1. Fetches the latest stable version and its shasum/integrity for each package
   manager and rewrites `default` as `<version>+sha1.<shasum>` (or
   `<version>+sha224.<digest>` for Yarn Berry, matching upstream's own convention).
2. Fetches `GET https://registry.npmjs.org/-/npm/v1/keys` and rewrites the trust
   store, dropping expired keys (§14.4).
3. Opens a PR. Do not auto-merge — a bad `default` bricks every machine that has no
   `lastKnownGood.json` entry.

A bin-path change requires a new `ranges` entry and human review; it cannot be
automated safely.

## 16.10 Suggested module layout

```
main            argv classification, dispatch (§01.2)
config          the static embedded table (§02.5), trust store (§02.6)
semver          parse, compare, ranges, both satisfaction modes (§04.2)
manifest        discovery walk, spec parsing, devEngines, surgical rewrite (§03, §16.4)
envfile         dotenv parse, prefix filter, eligibility filter (§03.2, §14.5)
resolve         descriptor → locator (§04)
registry        npm + url registry protocols (§05.2, §05.3)
http            client, proxy, auth, redirects (§05.1, §14.6, §14.8)
integrity       hashes, SRI, ECDSA verification, trust store (§06)
store           layout, temp dirs, atomic promotion, tar extraction (§07)
exec            handover: exec / spawn, signals, exit codes (§08)
cli             the management commands (§09)
shims           enable / disable, platform integration (§10)
```

Dependency direction is strictly downward. `resolve` never touches the filesystem
except through `store`; `store` never speaks HTTP except through `http`. That
separation is what makes §13's tests writable without a network.
