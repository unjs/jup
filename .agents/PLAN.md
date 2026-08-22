# Implementation Plan — Phase 1 (§01–§14)

**Non-normative.** The contract is `.agents/01-16`. This file is the work breakdown:
what to build, in what order, with what interfaces, and which conformance tests prove
each piece.

## Ground rules for this implementation

| Decision           | Value                                                                                                                                                                                                                                                                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Language / runtime | TypeScript, ESM, Node ≥ 22.18 (native type stripping, so tests can run `node src/main.ts` with no loader)                                                                                                                                                                                                                                                            |
| Dependencies       | **Zero runtime deps.** Prefer **native web APIs** (`fetch`, `Response`, `ReadableStream`, `URL`, `AbortSignal.timeout`, `crypto.subtle`, `TextDecoder`) wherever they cover the need; fall back to Node built-ins (`node:fs`, `node:path`, `node:crypto`, `node:zlib`, `node:util`, `node:os`) only where no web API exists. Dev deps stay as the template has them. |
| Naming             | **Byte-compatible `COREPACK_*`.** Env vars, `COREPACK_HOME`, store layout (`<home>/v1`, `lastKnownGood.json`, `.corepack`), `.corepack.env`, and every user-facing string in §12 are reproduced verbatim, including `corepack` in usage lines.                                                                                                                       |
| Scope              | §01–§14 + tests 1–147. §15 is phase 2; where §15 changes an interface cheaply, the seam is noted per task so phase 2 is additive rather than a rewrite.                                                                                                                                                                                                              |
| §14.14 exception   | **Not applied.** The "to pack" messages stay verbatim per §12.9, because the naming decision prioritises byte-compatibility. Every other §14 divergence is in scope.                                                                                                                                                                                                 |
| Execution model    | In-process (§08.2), the reference model — it is available to us and it is the fast one. `exec.ts` keeps a spawn path behind the same interface for §15.28 native artifacts later.                                                                                                                                                                                    |
| Shims              | Generated JS stub files (§10.1), not §14.15 symlink dispatch: Node `realpath`s the entry module, so `argv[0]` sniffing is unavailable. §14.15/§15.14 are explicitly native-only and out of reach here.                                                                                                                                                               |
| Imports            | Explicit `.ts` extensions (`import { x } from "./semver.ts"`), matching the template's `allowImportingTsExtensions`.                                                                                                                                                                                                                                                 |

### Fast-path budget in a JS host

§16.1's 5 ms is unreachable — Node's own startup dominates. The budget still binds as a
**correctness** requirement, and test 96 asserts it: a warm exact-pin run makes zero
network requests, zero `lastKnownGood.json` reads, and no `opendir` of the store. Every
task below that could violate it says so.

---

## Module layout

```
src/
  main.ts          argv classification, dispatch, top-level error presentation   §01.2, §08.4, §12.1
  types.ts         Descriptor, Locator, InstallSpec, specs, result types         §02
  errors.ts        UsageError, message builders                                  §12
  semver.ts        parse/compare/ranges/two satisfaction modes                   §04.2
  json.ts          order-preserving scanner + surgical string-span edit          §16.4
  env.ts           dotenv parse, COREPACK_ filter, eligibility filter            §03.2, §11, §14.5
  manifest.ts      discovery walk, parseSpec, devEngines, writePin               §03
  http.ts          GET client, proxy, auth, redirects, timeouts                  §05.1, §14.6, §14.8
  registry.ts      npm + url registry protocols                                  §05.2, §05.3
  integrity.ts     hashes, SRI, ECDSA verify, trust store, expiry                §06
  tar.ts           gzip+tar reader (safety rules) and writer (`pack`)            §07.4, §07.10
  store.ts         paths, marker, temp, atomic promote, LKG, bin resolution      §07
  resolve.ts       descriptor → locator, cache probe, default version            §04
  install.ts       url choice, streaming download, verify, promote               §06, §07
  exec.ts          handover, argv/env rewrite, exit codes                        §08
  cli.ts           management commands                                           §09
  shims.ts         enable / disable                                              §10
  config/
    table.ts       embedded registry table, as static data                       §02.5, §14.20
    keys.ts        embedded trust store                                          §02.6
  index.ts         library surface (keeps the template's export)
test/
  _utils/          mock registry, fixtures, fake package managers, run() helper
  unit/            per-module tests
  conformance/     §13 tests 1–147, one file per §13.n section
```

Dependency direction is strictly downward, matching §16.10: `resolve` reaches the
filesystem only through `store`; `store` speaks HTTP only through `install`/`http`.

---

## Wave 0 — contracts

Single agent, must land before anything else. Everything after it is parallel.

### T0 — Interface skeleton

**Files:** `src/types.ts`, plus a stub for every module above exporting the exact
signatures listed in the tasks below, each body `throw new Error("TODO")`.
**Also:** set `package.json` `name`/`repository`/`bin`, `build.config.ts` entries,
and a `test/_utils/run.ts` signature stub.
**Why first:** ten agents write against these signatures concurrently. Any signature
change after this point costs a merge conflict, so over-specify here.
**Acceptance:** `pnpm typecheck` passes with every stub in place.

---

## Wave 1 — leaves (8 tasks, fully parallel)

No task in this wave imports another. Each ships with its own unit tests.

### T1 — `semver.ts` §04.2

**Exports:** `parse`, `isValidVersion`, `isValidRange`, `compare`, `rcompare`, `lt`,
`major`, `satisfies` (strict), `satisfiesWithPrereleases` (lenient).
**Range grammar:** `||`, whitespace intersection, `^ ~ > >= < <= =`, exact, `*`,
`x`/`X` wildcards, hyphen ranges.
**Critical:** the two satisfaction modes MUST stay distinct (§04.2). Lenient strips the
prerelease tag from _both_ the version and every comparator, then tests — this is not
semver's `includePrerelease`. Build metadata is ignored in comparison, so
`4.1.0+sha224.abc` compares equal to `4.1.0`. Every function returns `false`/`null`
rather than throwing on malformed input.
**Tests:** unit only in phase 1. Add a differential fuzz corpus against a reference
semver (dev-only) per §16.8 — this is the subsystem most likely to diverge subtly.

### T2 — `config/table.ts`, `config/keys.ts` §02.5, §02.6, §14.20

**Exports:** `DEFINITIONS` (ordered), `getDefinition(name)`, `getSpecFor(name, version)`,
`getBinariesFor(name)`, `getPackageManagerFor(binName)`, `SUPPORTED_NAMES`, `TRUST_KEYS`.
**Critical:** `ranges` is an **ordered list of `[range, spec]` pairs**, matched in
**reverse** — last declared wins (§02.3). Tag resolution always uses the **last**
entry's registry. Static object literals, `as const`, no JSON parsing at startup.
Transcribe npm/pnpm/yarn exactly as §02.5 gives them, including yarn's `default` being
1.x while `transparent.default` is 4.x.
**Phase-2 seam:** keep `TRUST_KEYS` behind an accessor keyed by registry origin
internally, even though phase 1 only populates `https://registry.npmjs.org` (§15.10).

### T3 — `errors.ts` §12

**Exports:** `UsageError` (distinct class), and a message builder per §12 string.
**Critical:** every string byte-exact — leading `! `, no trailing periods, the trailing
space on `? Do you want to continue? [Y/n] `, `<JSON x>` meaning `JSON.stringify(x)`.
`UsageError` vs `Error` is the presentation switch in §08.4/§12.1 and must not collapse.
**Tests:** golden-file snapshot of every exported message with representative
interpolations (§16.8 "byte-exact golden files").

### T4 — `env.ts` §03.2, §11, §14.5

**Exports:** `parseEnvFile(text)`, `loadEnvFileFrom(dir): {vars, path} | null`,
`applyEnvFile(vars, path)`, `isEnvFileEligible(name)`, plus typed accessors for all 15
variables in §11.
**Critical:**

- Parse with `node:util`'s `parseEnv` semantics.
- Keep only `COREPACK_`-prefixed keys, **before** merging.
- Merge as `{...fileVars, ...process.env}` — real environment wins — then assign to
  `process.env`.
- Never honour `COREPACK_ENV_FILE` or `COREPACK_ENABLE_DOWNLOAD_PROMPT` from a file.
- **§14.5:** also refuse `COREPACK_INTEGRITY_KEYS`, `COREPACK_ENABLE_UNSAFE_CUSTOM_URLS`,
  `COREPACK_NPM_TOKEN`, `COREPACK_NPM_USERNAME`, `COREPACK_NPM_PASSWORD`, warning once:
  `! Ignoring <NAME> from <path>: this variable can only be set in the environment`
- `COREPACK_ENV_FILE=0` disables loading entirely.
  **Tests:** 52–62 (60/61/62 are the §14.5 additions).
  **Budget:** one `open` attempt per walked directory, and only until a file is found.

### T5 — `json.ts` §16.4, §14.7

**Exports:** `parseManifest(text)` (tolerant read: BOM strip, empty → `{}`),
`scanTopLevelKey(text, key)` → span, `setTopLevelString(text, key, value)`,
`detectIndent(text)`, `detectEol(text)`, `hasBom(text)`.
**Critical:** surgical text edit, not parse-and-reserialise. Preserve key order,
indentation (first `/^[ \t]+/m` match, else two spaces), line endings (CRLF iff `\r\n`
strictly outnumbers bare `\n`; platform EOL if the file had none), and — per **§14.7** —
**re-emit the BOM** if the original had one. Insert the key after the opening brace when
absent; handle the empty-object case. The scanner must respect string escapes and
nesting so a nested `"packageManager"` is never mistaken for the top-level one.
**Tests:** unit + 12, 13, 116.

### T6 — `tar.ts` §07.4, §07.10

**Exports:** `extract(stream, destDir, {strip: 1, filter?, limits})`,
`create(cwd, paths, outPath)`, `listEntries(stream)`.
**Reader:** ustar + GNU/PAX long names, gzip via `zlib.createGunzip`. Strip exactly one
leading path component; drop entries with no leading component.
**Safety rules — all nine of §07.4, non-negotiable:** reject absolute/drive/UNC paths;
reject any normalised path escaping the root (message per §12.12: `Refusing to extract
'<entry>': path escapes the extraction directory`); skip link entries; reject non
file/dir types; never follow an existing symlink when creating (`O_NOFOLLOW`); mask mode
to `mode & 0o777 & ~umask` with no setuid/setgid/sticky; cap inflated bytes (512 MiB),
entry count (200 000), and expansion ratio; validate decoded PAX long names against
rules 1–2; ignore unknown PAX headers.
**Single-file filter:** extract only the entry whose post-strip path equals `binPath`,
then rename `tmp/<binPath>` → `tmp/<basename>`, mapping `ENOENT` → `Cannot locate
'<binPath>' in downloaded tarball` and `EEXIST`/`ENOTEMPTY` → delete src and continue.
**Writer:** gzip tar rooted at a cwd, for `pack`.
**Tests:** unit + 84, 85; add the §16.8 extractor fuzzer (traversal, symlink escape,
absolute paths, long PAX names, expansion bombs).

### T7 — `http.ts` §05.1, §14.6, §14.9

**Exports:** `httpGet(url, opts): Promise<Response>`, `httpGetJson<T>(url, opts)`,
`credentialsFor(url, registryOrigin)`, `assertSafeArtifactUrl(url, registry)`.
**Built on native `fetch`.** `Response.body` is a web `ReadableStream`, which is what the
download pipeline tees (§16.5); `AbortSignal.timeout` covers the timeouts; `fetch`
already follows redirects and already strips `Authorization` on a cross-origin hop, which
is exactly §14.6's requirement.
**Proxy support (§14.8/§15.6) is deferred to phase 2** — it is the one thing `fetch`
cannot do without a dispatcher. Keep it behind a single injectable transport option so
adding it later touches one file. Test 71/72 move to phase 2 with it.
**Critical:**

- `COREPACK_ENABLE_NETWORK=0` → `Network access disabled by the environment; can't reach
<url>` (the registry layer has its own distinct message — see T10).
- **§14.6 unified credential rule:** userinfo → Basic, stripped from the URL before the
  request; else different origin than the registry → **no credentials**; else
  `COREPACK_NPM_TOKEN` present → Bearer; else both username and password present →
  Basic; else none.
- Format every error message from the **stripped** URL. Never emit `authorization` or
  userinfo in error text.
- Redirects: `redirect: "follow"` — verify by test that `Authorization` does not survive
  a cross-origin hop rather than assuming it.
- Cancel/drain the body before throwing on non-2xx so the connection stays reusable.
- `AbortSignal.timeout(30_000)`, surfaced as the transport-failure message.
- **§14.9 URL validation helper:** the URL must parse, scheme exactly `https:` (or
  `http:` only when the configured registry is itself `http:`), and host must equal the
  configured registry's host unless opted in.
  **Tests:** 63–70 (70 is the §14.6 addition), 83. Tests 71–72 defer with proxy support.
  **Phase-2 seam:** proxy dispatcher, retry/backoff, and CA/strict-ssl all hang off the
  same options object, defaulted off in phase 1 (§15.4, §15.5, §15.6).

### T8 — `integrity.ts` §06, §14.4, §14.11, §14.12

**Exports:** `hashStream(stream, algo)`, `hashFile(path, algo)`, `parseSri(s)`,
`compareDigest(a, b)`, `verifySignature({signatures, integrity, packageName, version})`,
`shouldSkipIntegrityCheck()`, `expectedHashFromIntegrity(integrity)`.
**Critical:**

- Signed payload is exactly `<packageName>@<version>:<integrity>`, UTF-8, no whitespace,
  `integrity` including its `sha512-` prefix.
- Walk trusted keys **in order**; for each, find the first signature with a matching
  `keyid`; stop at the first trusted key with a match. Errors per §06.3 verbatim.
- Key material is a bare base64 DER SPKI; wrap in PEM armour for
  `crypto.createVerify("SHA256").verify(...)`. Signature is base64 of DER `(r,s)`.
  Validate the parsed curve is P-256 and reject others.
- **§14.4:** honour `expires`. Exclude expired keys from selection; if only an expired
  key matches, error `The package was signed with an expired key (<keyid>, expired
<expires>)`. If no unexpired key matches but the signature is otherwise valid, an
  implementation MAY accept with a loud warning — never silently.
- **§14.11:** `crypto.timingSafeEqual` for digest comparison; explicit algorithm
  allowlist (`sha1`, `sha224`, `sha256`, `sha384`, `sha512`) with
  `Unsupported hash algorithm '<algo>' in the packageManager field` for anything else;
  warn on `sha1`/`md5` pins.
- **§14.12:** parse SRI as `<algo>-<base64>` — never `slice(7)` — and reject unsupported
  SRI algorithms.
- `shouldSkipIntegrityCheck()` is true for exactly `""` and `"0"`.
  **Tests:** 73–82.

### T9 — `test/_utils/` harness §13.1, §16.8

Runs in wave 1 because most later tests block on it.
**Deliverables:**

- `registry-mock.ts`: local server implementing `GET /<pkg>`, `GET /<pkg>/<version>`,
  `GET /<pkg>/-/<pkg>-<version>.tgz`, scoped names, dist-tags, on-the-fly ECDSA signing
  over `<name>@<version>:<integrity>`, `401` on bad auth, a url-type tags document, a
  `CONNECT` proxy mode, and deliberately-broken modes: `invalid_signature`,
  `invalid_integrity`, `no_dist`, `no_signatures`, `slow`, `flaky`.
- `tarball.ts`: build npm-shaped tarballs (`package/` prefix) in memory.
- `fake-pm.ts`: seed `<store>/<name>/<version>/` with a hand-written `.corepack` and a
  trivial entry script — this is how the execution tests avoid the network.
- `fixtures.ts`: fresh `COREPACK_HOME`, temp project dirs, clean env (strip every
  `COREPACK_*`, `DEBUG`, `FORCE_COLOR`; set `COREPACK_DEFAULT_TO_LATEST=0` unless the
  test is about default lookup).
- `run.ts`: spawn `node src/main.ts <args>` (native type stripping), returning
  `{exitCode, signal, stdout, stderr}`, with TTY and stdin-pipe variants for 138–140.

---

## Wave 2 — mid layer (4 tasks, parallel)

### T10 — `manifest.ts` §03 — _deps: T1, T3, T4, T5_

**Exports:** `discoverProjectSpec(cwd, {envOnly?})` →
`NoProject | NoSpec | Found`, `parseSpec(raw, source, {enforceExactVersion})`,
`reconcile(result, fallback, {transparent, binaryVersion, requestedName})`,
`writePin(cwd, info)`.
**Critical:**

- The walk: skip directories matching the `node_modules` package regex (last segment
  pair only); load the env file before the manifest, only until one is found; stop only
  on a `packageManager` key; record the _last_ manifest seen. Reproduce the monorepo
  consequence documented in §03.1.
- `getSpec` is **lazy** — `use` must not fail on a malformed existing field (test 109).
- devEngines validation in §03.3's exact order, with the two unconditional warnings and
  `warnOrThrow` defaulting to **error** while unrecognised `onFail` degrades to a warning.
- `parseSpec` step-by-step per §03.4, including `name` being the substring before the
  _first_ `@`, so `@scope/pkg@1.0.0` yields an empty name and hits the unsupported-name
  error.
- `writePin` per §03.7: re-run discovery, devEngines cross-check via `warnOrThrow`,
  `previousPackageManager` fallback chain ending in the literal `unknown`, formatting
  preservation through T5, and creating `<cwd>/package.json` in the `NoProject` case.
  **Tests:** 1–13, 22–37, 105–110, 116, 142–143.
  **Phase-2 seam:** the walk's stop condition and the write target are what §15.25/§15.26/
  §15.27 change; keep both as single named predicates.

### T11 — `registry.ts` §05.2, §05.3 — _deps: T2, T3, T7_

**Exports:** `getRegistryUrl()`, `fetchAvailableVersions(spec)`,
`fetchAvailableTags(spec)`, `fetchLatestStableVersion(spec)`,
`fetchTarballURLAndSignature(spec, version)`.
**Critical:**

- Strip **all** trailing slashes from `COREPACK_NPM_REGISTRY`; a doubled slash 404s on
  real mirrors.
- Send `Accept: application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8`
  and parse **both** response shapes.
- Insert `{package}` **without** percent-encoding, so `@yarnpkg/cli-dist` appears
  literally.
- The registry layer's own network-disabled message names the _registry_:
  `Network access disabled by the environment; can't reach npm repository <registryUrl>`
  — distinct from T7's, and both are asserted.
- url-type registries: `fields.tags` → tag map, `fields.versions` → array **or** object
  keys (accept both), latest stable reads `.stable`, **not** `.latest`.
- npm latest-stable reference: `<version>+sha512.<hex(base64decode(integrity.slice(7)))>`
  via T8's proper SRI parse, else `<version>+sha1.<dist.shasum>`. Wrap any failure in the
  §04.5 message verbatim — both env var names in it are asserted, as is the absence of
  `COREPACK_INTEGRITY_CHECK`/`COREPACK_USE_LATEST`.
- Validate `dist.tarball` through T7's §14.9 helper, not `startsWith("http")`.
  **Tests:** 63–64, 83, plus support for 49–50, 102–103.

### T12 — `store.ts` §07, §14.1, §14.3 — _deps: T3, T6_

**Exports:** `getHomeFolder()`, `getInstallFolder()`, `getVersionDir(locator)`,
`readMarker(dir)`, `writeMarker(dir, spec)`, `createTempDir()`, `promote(tmp, dest)`,
`findInstalledVersion(name, range)`, `readLastKnownGood()`, `writeLastKnownGood(lkg)`,
`resolveBin(...)`, `cacheClean()`.
**Critical:**

- Home resolution chain **in §07.1's exact order**, including `XDG_CACHE_HOME` before
  `LOCALAPPDATA` on every platform. (§15.13 narrows this later; phase 1 reproduces it.)
- Version directory = plain semver with the build suffix removed; URL references use
  `encodeURIComponent(url without fragment)`.
- `.corepack` marker is the entire warm path: read → parse → done. `ENOENT` proceeds to
  download; any other error propagates.
- **§14.1:** when the descriptor is an exact version, `stat` the marker directly — do
  **not** `opendir` the store. The directory scan is for genuine ranges only. This is
  test 96 and the single hottest path in the tool.
- **§14.2:** the range cache probe uses `satisfiesWithPrereleases`, matching the rest of
  the pipeline; skip dot-entries; ties keep the later entry.
- Temp dirs live **inside** `<installFolder>` so the promoting rename never crosses a
  filesystem. Rename is the commit point; `EEXIST`/`ENOTEMPTY` (and win32 `EPERM` onto a
  directory) mean we lost a benign race — `rm -rf` the temp and continue as a winner.
  Windows: retry 5× with `100·2^i` ms backoff. **No lockfile, ever** (§07.5, §16.6).
- **§14.3:** `lastKnownGood.json` writes go to a temp file in the same directory and
  rename over. Reads stay maximally forgiving — every failure mode yields `{}`, non-string
  entries are dropped. `EROFS` on write is swallowed silently.
- `resolveBin` per §07.7: the `isValidBinList` (single file) vs `isValidBinSpec`
  (tarball) discrimination is load-bearing for Yarn Berry via a custom registry.
- Error tolerance per §07.8, especially the `EACCES` temp-dir message verbatim.
  **Tests:** 86–96, 104.

### T13 — `exec.ts` §08, §14.13 — _deps: T2, T3_

**Exports:** `execPackageManager(binName, installSpec, args)`.
**Critical:**

- Resolve `binPath` per §08.1; **§14.13:** when `bin` came from a downloaded
  `package.json` rather than the table, resolve the joined path and verify it stays
  inside `<location>`, erroring with §12.12's message otherwise (test 141).
- In-process handover: set `process.env.COREPACK_ROOT`, `process.argv = [execPath,
binPath, ...args]`, `process.execArgv = []`, then schedule the load on `nextTick` so
  our frames leave the stack.
- Load via `import(pathToFileURL(binPath))` — this handles both CJS and ESM entry points
  (test 135) and leaves `require.main` undefined for CJS, which is what pnpm's
  self-detection expects.
- **Do not wrap the load in a catch that rewrites the exit code.** An uncaught error must
  reset a pending code to 1 (test 133) while a `beforeExit` hook's code must survive
  (test 134). This is the corepack 0.18.1 regression; guard it with all three of 132–134.
- stdio untouched; stdin passed through and never speculatively consumed (§08.6).
- `PATH` unmodified in phase 1 (§15.32 changes this).
  **Tests:** 132–141.
  **Phase-2 seam:** keep a `spawn` implementation behind the same signature for §15.28.

---

## Wave 3 — pipeline (2 tasks)

### T14 — `resolve.ts` §04 — _deps: T1, T2, T11, T12_

**Exports:** `resolveDescriptor(descriptor, {allowTags, useCache})`,
`getDefaultVersion(name)`, `getFallbackLocator(name, {transparent})`,
`bumpLastKnownGood(locator)`.
**Critical:** §04.1's six steps **in order**, including step 4 (cache probe) preceding
step 5 (exact passthrough), tags resolving against the **last** range entry's registry,
and step 6 querying every band **in parallel** and unioning.

- The fallback locator is a **lazy** thunk (§02.1). Materialising it eagerly is the
  single easiest way to break offline operation and test 96.
- `getDefaultVersion`: LKG hit returns with **no network**; `COREPACK_DEFAULT_TO_LATEST=0`
  returns the compiled-in default with no network; otherwise fetch and record, swallowing
  record failures.
- Transparent commands with a `transparent.default` skip `getDefaultVersion` entirely —
  no LKG read, no network. (§15.33 later makes this a floor rather than an override.)
- §04.7 auto-bump: same major **and** strictly greater, and only when an entry already
  exists.
  **Tests:** 14–21, 97–104, 144–145.
  **Budget:** every path that can return without I/O must actually return without I/O.

### T15 — `install.ts` §06.1, §07.3–§07.6, §14.10 — _deps: T6, T7, T8, T11, T12_

**Exports:** `ensureInstalled(locator, {cacheOnly?})` → `InstallSpec`.
**Critical:**

- Marker hit short-circuits before anything else (§07.2).
- URL choice per §07.3, including the `npmRegistry`-instead-of-`registry` switch and
  origin rewriting when `COREPACK_NPM_REGISTRY` is set. Use origin comparison, not
  substring replacement, where it costs nothing — this is free §15.3 credit.
- Download prompt (§05.5) before any **artifact** stream, never before metadata: notice
  on stderr; confirm only when the value is `1`, stdin is a TTY, and `CI` is unset; any
  input but `n`/`N` is yes. The default comes from the entry point (`0` for the tool's
  own name, `1` for a shim), applied `??=` so a real env var wins.
- **Stream once, tee to a digest** (§16.5): socket → tee → digest, and → gunzip → tar →
  disk. Cap inflated bytes and entry count as you go, not afterwards.
- **§14.10:** hash the **tarball stream** even in the `registry.bin` single-file path, and
  compare it against the signed `dist.integrity` exactly as the full-extraction path
  does. Continue to hash the extracted file separately when the user pinned a hash. This
  closes the hole where anyone running Yarn Berry through a corporate mirror gets an
  unverified binary.
- Decision table §06.1 exactly: a user-supplied hash **overrides** signature verification
  (tests 77, 78) — this is deliberate and must not be "fixed".
- On any integrity failure: discard the temp folder, cache nothing, so a re-run fails
  identically (test 79).
- Post-install §07.6: rewrite the locator's reference to carry the **actual** digest,
  then auto-bump LKG.
  **Tests:** 45–50, 73–85, 86–96.

---

## Wave 4 — surface (3 tasks, parallel)

### T16 — `main.ts` §01.2–§01.4, §03.5, §08.4, §12.1 — _deps: T10, T13, T14, T15_

**Critical:**

- Classify `arg0` with `/^([^@]*)(?:@(.*))?$/`. Known binary name → proxy; else an `@`
  present → proxy with an unknown package manager (this is how `corepack foo@1.2.3`
  reaches "Unsupported package manager specification" instead of "unknown command");
  else management mode.
- Transparent-command matching per §01.4: `prefix[0] === binaryName` and every remaining
  segment equals the corresponding arg.
- Reconciliation per §03.5, in order: `COREPACK_ENABLE_PROJECT_SPEC=0` short-circuits to
  the fallback; `COREPACK_ENABLE_STRICT=0` forces `transparent = true`; then the
  NoProject / NoSpec / Found switch; then the CLI `binaryVersion` override, which
  replaces the range but **not** the name.
- Auto-pin (§03.6) fires only on `NoSpec`, only in proxy mode, only with
  `COREPACK_ENABLE_AUTO_PIN=1`, printing both `!` lines plus a blank line to stderr.
- Top-level presentation (§08.4/§12.1): `UsageError` in proxy mode → bare message on
  **stderr**, no stack; `UsageError` in management mode → `Usage Error: <msg>` on
  **stdout**, blank line, usage line; any other error → stderr **with a stack**. Exit 1.
  The stdout/stderr split between modes is test-asserted, and so is the fact that a
  non-usage error keeps its stack.
  **Tests:** 38–51, 146–147, and it gates most of 1–13.

### T17 — `cli.ts` §09 — _deps: T10, T12, T14, T15, T6_

Commands: `install`, `install -g|--global [--cache-only]`, `pack [--json] [-o]`, `up`,
`use`, `cache clean|clear`, `--version`, `--help`, plus deprecated `hydrate`/`prepare`.
**Critical:**

- `resolvePatternsToDescriptors` (§09.1) with `lookup.range ?? lookup.getSpec()` — the
  devEngines range is preferred over the exact pin, and that is what lets `up` cross a
  major (test 112).
- `up`'s **two-step** resolve, both with `useCache: false`, second targeting
  `^<major>.0.0`.
- `install -g` sets LKG **unconditionally**; `install` does **not** touch it; `pack`
  **does**.
- `use` prints the banner, writes the pin, then a blank line, then runs `commands.use` —
  and a devEngines mismatch surfaces _after_ the banner is already on stdout (test 110).
- Archive validation for `install -g <file>.tgz` per §07.10, using T6's extractor with
  **no** relaxed safety for "our own" archives.
- Output stream discipline per §09.11 — including that the package manager's own output
  is never wrapped, prefixed, colourised, or buffered.
- Deprecated commands keep their distinct message wording (`'corepack prepare'`,
  the devEngines-free "no spec" string, `All done!`, bare-`--output` tolerance).
  **Tests:** 86–95, 101–116, 142–147.

### T18 — `shims.ts` §10, §14.16, §14.17, §14.18 — _deps: T2, T3_

**Critical:**

- POSIX: `lstat` (**not** `stat`, so a dangling symlink is seen as a symlink), relative
  link target, idempotent — an already-correct symlink is not rewritten and its mtime is
  unchanged (test 122).
- Yarn Switch guard: any binary name containing `yarn` whose realpath matches
  `/[\/\\]switch[\/\\]bin[\/\\]/` is skipped with the §12.9 message, exit **0**. POSIX
  only; Windows `disable` removes without warning.
- **§14.16:** refuse to clobber a regular file that is not one of our own shims, with
  §12.12's message, and add `--force`. Yarn Switch then becomes one instance of the rule.
- Windows: write `<B>`, `<B>.cmd`, `<B>.ps1` unconditionally, `0o755`, byte-exact per
  §10.3 including the double spaces and the `PATHEXT` line.
- **§14.17:** locate ourselves properly — `process.argv[1]`/`import.meta.url` first,
  `PATH` lookup as fallback, and §12.12's clear error if both fail. `enable` realpaths
  the directory; `disable` deliberately does not.
- **§14.18:** map `EROFS`/`EACCES` to an actionable message naming `--install-directory`
  and shell aliases, not a raw errno.
- Default target set is every supported package manager **except npm** in phase 1;
  §15.16 flips this later. Each name expands to its full binary set, so `disable yarn`
  removes `yarnpkg` too.
  **Tests:** 117–131 (121 is the §14.16 addition).

---

## Wave 5 — closeout

### T19 — Conformance suite, tests 1–147

One file per §13 section under `test/conformance/`, each row an individual `it()` named
by its number so failures map back to the spec. Assertions on `(exitCode, stdout,
stderr)` and on the resulting filesystem. Includes:

- test **81**, the live staleness check against
  `GET https://registry.npmjs.org/-/npm/v1/keys`, tagged so it can be excluded offline;
- test **96**, the fast-path budget — assert zero mock-registry hits and, via an fs spy,
  no `lastKnownGood.json` read and no store `opendir` on a warm exact-pin run;
- test **94**, three concurrent cold installs of the same version all exiting 0.

### T20 — Packaging and docs

`package.json` (`name`, `bin`, `files`, `exports`), `build.config.ts` entries for the
main entry plus the generated shim stubs, README rewrite (usage, the `COREPACK_*`
compatibility statement, and an explicit list of where phase 1 diverges from corepack
per §14), and a CI job wiring `pnpm test`.

---

## Dependency graph

```
T0 ─┬─ T1  semver ──────────────┬─ T10 manifest ─┬─ T16 main ─┬─ T19 conformance
    ├─ T2  config ──────────────┼─ T11 registry ─┼─ T17 cli ──┤
    ├─ T3  errors ──────────────┼─ T12 store ────┼─ T18 shims ┘
    ├─ T4  env ─────────────────┼─ T13 exec ─────┤
    ├─ T5  json ────────────────┤                │
    ├─ T6  tar ─────────────────┼─ T14 resolve ──┤
    ├─ T7  http ────────────────┼─ T15 install ──┘
    ├─ T8  integrity ───────────┘
    └─ T9  test harness ─────────────────────────────────────── T20 packaging
```

Wave 1 is eight independent agents. Wave 2 is four. Wave 3 is two (T15 depends on more
than T14 but neither depends on the other). Wave 4 is three.

## Highest-risk items

1. **T13's exit-code semantics.** Three tests distinguish "throws", "sets a code", and
   "sets a code in `beforeExit`", and the natural defensive `try/catch` breaks all three.
2. **T1's two satisfaction modes.** A subtle divergence resolves the wrong version
   silently. Worth the differential fuzzer even in phase 1.
3. **T6's safety rules.** Attacker-controlled input, and the one place where writing our
   own extractor is strictly more dangerous than corepack's vendored library.
4. **The fast-path budget.** Easy to violate from any of T10, T12, or T14, and only test
   96 catches it.
5. **T5's surgical edit.** Parse-and-reserialise is the tempting shortcut and it silently
   fails tests 12, 13, and 116.

## Deferred to phase 2 (§15)

`.npmrc` reading, per-package-manager registries, origin-rewriting, TLS CA/diagnostics,
retries, key refresh and origin-keyed trust, the single verification tier, per-user shim
directories, `shims.json` restore, npm shimming by default, `cache list`/`cache clean
--all`, `.corepack.lock` ranges, prerelease exclusion, symmetric walk stop conditions,
atomic multi-field pin writes, workspace-boundary write targets, native artifacts,
`corepack info`, global-flag transparency, `PATH` prepending, and §15.35's sundries.
Tests 148–207.

---

## Wave 6 — audit (T21)

Runs **after** the implementation is complete and the conformance suite is green, not
before: an audit of stubs finds nothing, and an audit of code that is about to change is
wasted. Four independent auditors, each with one lens and no knowledge of the others'
findings, then a pass applying what survives:

| Lens | Looks for |
|---|---|
| **Correctness** | Divergence from §01–§14, missed edge cases, conformance rows the suite asserts loosely, error-path behaviour, the two spec conflicts already found (§06.5 vs test 82; SHOULD vs MUST generally) |
| **Speed** | Violations of §01.3's fast-path budget and §16.3's syscall list — eager LKG reads, store `opendir` on an exact pin, JSON DOM parsing on the warm path, allocations in argv classification |
| **Security** | §07.4 extraction rules, §14.6 credential scoping, §14.5 env-file eligibility, §14.9/§14.13 URL and bin-path confinement, §06 verification ordering, TOCTOU around the store |
| **Simplicity** | Duplication across modules, abstractions that earn nothing, dead options, places where the spec's shape was copied more literally than it needed to be |

Each auditor reports findings ranked by severity with a concrete failure scenario;
findings are verified before anything is applied, since a plausible-sounding finding that
is actually correct behaviour (§14.21 lists six of those) must not be "fixed".

---

## T21 results — what the four lenses found

Run against a green suite (768 tests) after phase 1 was complete. Each lens was blind
to the others; findings were verified before anything was applied, and two dissolved on
inspection.

### The pattern worth remembering

**Three separate bugs came from counting `dirname` calls to locate ourselves**, and all
three were invisible from source and real in the shipped package, because obuild emits
chunks into `dist/_chunks/` — one level deeper than the arithmetic assumed:

| Symptom | Found by |
|---|---|
| `enable` failed: "Assertion failed: The stub folder doesn't exist" | building and running `dist/` by hand |
| `COREPACK_ROOT` pointed at `dist/` instead of the package root | the same |
| `--version` answered `0.0.0` forever | the simplicity audit |

All three now go through `src/self.ts`, which walks up. The lesson generalises: **a test
that exercises only the source tree cannot catch a layout assumption**, and conformance
row 146 passed throughout because this repo's own version is also `0.0.0`.

### Findings applied

| Lens | Finding | Severity |
|---|---|---|
| correctness | `npmRegistry` never substituted during *resolution*, so Yarn Berry resolved from the public internet despite a configured mirror | high |
| correctness | Trust store keyed by origin ⇒ signature verification hard-failed for every custom registry | high |
| security | Registry credentials printed verbatim to stderr, including on a **successful** run | medium |
| simplicity | `--version` reported `0.0.0` from the shipped package | medium |
| security | `.js` download path had no size cap while `.tgz` did | low |

### Why the suite missed the two high-severity ones

Both were invisible for structural reasons, not oversight:

* The conformance harness rewrites **every** hardcoded host to one mock, so the mirror
  and `repo.yarnpkg.com` were the same server — a test asserting "the mirror was used"
  passed whether or not the substitution happened.
* Every trust-store test either used the default registry or injected keys in the legacy
  `{"npm": [...]}` shape, which is the one branch that ignores origin.

A mock that collapses two sources into one cannot distinguish them. Worth remembering
when building the phase-2 harness for §15.2's per-package-manager registries.

### Deferred, with reasons

* **Speed:** the proxy path eagerly loads the download/verify stack (~3.3 ms, 73 extra
  native modules, ~36 KB of cold-path JS), and the manifest is parsed into a full DOM
  (~460 allocations on a large manifest, against §16.1's <50 target). Both are real; the
  normative §01.3 budget is otherwise met exactly, verified by strace.
* **§14.8 proxy support** remains unimplemented — rows 71/72 skipped, openly declared.
* Spec ambiguities left alone and documented in place: §07.4 rule 6's prose and formula
  disagree on mode masking; row 84 promises a refusal for an escaping symlink that rule 3
  says to skip silently; `isValidRange` accepts some malformed ranges node-semver rejects
  (no practical impact — every real dist-tag is still correctly classified).

---

# Phase 2 — §15

`.agents/README.md` makes §15 **normative**: a conforming implementation satisfies its
MUSTs and passes tests 148–207. Phase 1 deliberately deferred it; this is the remainder.

Ordered by value, not by section number. §15 cites the driving issue and its signal count
for most items, and that signal is the ordering input — #295 (146👍), #95 (121👍), and
#71 (34👍) are the three highest in corepack's tracker.

## Wave A — the network layer (independent of everything else)

### P1 — Proxy support §14.8, §15.6 — **done** (`176942b`)
The one phase-1 MUST left unimplemented, and the reason conformance rows 71 and 72 are
skipped. `fetch` cannot do it without a dispatcher, so this means a `CONNECT` tunnel and
an absolute-form request path behind `HttpOptions.transport`, the seam already left for
it. `NO_PROXY` must support `*`, bare hostnames, leading-dot suffixes, and `:port`.
Honour `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` with **no** second opt-in flag — that
second flag is the whole complaint behind #447 and #458.

### P2 — Registry metadata robustness §15.7, §15.8 — **done** (`42552f7`)
Driven by #570 (9👍), #725, #808 — a raw `TypeError` when a private registry omits `dist`
or `dist.signatures`, which Artifactory and Nexus do routinely. Phase 1 already avoids the
crash; what remains is the three-outcome tiering: absent `dist` errors, absent
`signatures` soft-fails with one warning, invalid `signatures` still hard-fails, plus
`COREPACK_REQUIRE_SIGNATURES=1` and §15.8's package-root fallback.

### P3 — TLS and network resilience §15.4, §15.5 — **done** (`ae9065b`)
`COREPACK_CAFILE`, `COREPACK_STRICT_SSL`, classified TLS failures (a corporate
interception proxy currently surfaces as an unexplained transport error), timeouts, and
retries with backoff on idempotent GETs only.

Confirmed against the built binary after P1: a proxy that answers `CONNECT` with
`502 Bad Gateway` surfaces as the generic `Error when performing the request to
<url>` with nothing naming the proxy or the status. That is precisely the class
§15.4 asks to classify, and it is now reachable, so it is P3's first case.

## Wave B — configuration the user already wrote

### P4 — `.npmrc` subset §15.1 — **done** (`5640fe5`)
#540 (25👍). A locked-down org configures one registry and expects every tool to honour
it; corepack silently reaches the public registry instead. Read only the keys §15.1 lists,
with its precedence chain — and its security constraints are the reason it is safe at all:
auth entries are prefix-scoped by construction, and a **project-level** `.npmrc` may set
`registry`/`@scope:registry` but never auth or TLS keys, because unlike npm we run *before*
the user has decided to trust the repo.

### P5 — Per-source registries §15.2, §15.3 — **done** (`5640fe5`)
#753 (15👍), #872. `COREPACK_REGISTRY_<NAME>` so Yarn can be mirrored without also
redirecting npm and pnpm. Phase 1 already rewrites by origin rather than substring, so
§15.3 is largely satisfied — verify rather than reimplement.

## Wave C — core semantics

### P6 — Ranges in the pin, and `.corepack.lock` §15.23 — **done** (`4392842`)
#95: **121👍, open since 2022**, second-highest in the tracker, and the reason pnpm removed
corepack from its own documentation. The reconciliation §15.23 describes — ranges for
humans, a recorded resolution for reproducibility — is the substantive design work in
phase 2. A recorded resolution that still satisfies its range must resolve with **zero**
network access, so the §01.3 budget extends to ranges.

### P7 — The §15 defect cluster
Each is a bug with a spec citation, and they are small enough to land together:
§15.24 (a prerelease wins implicit resolution — recurs every release cycle, #473/#774, no
maintainer response in two years), §15.25 (a `devEngines`-only manifest does not stop the
walk), §15.26 (a mutating command can create the very mismatch §03.3 then rejects),
§15.33 (`transparent.default` outranks the user's own recorded default), §15.35j (a
nonexistent version surfaces as a bare 404), §15.35g (idempotent `use`).

### P8 — Write targets and reporting §15.27, §15.35l, §15.19
Stop at a workspace boundary, add `--here`, and **print the path every mutating command
modified** — the one-line fix for the whole class of "corepack edited a file I did not
expect" reports. Plus `cache clean --all` and `cache list`.

## Wave D — surface

### P9 — `corepack info` §15.30 — **done** (`6a5cbc9`)
#180, #566, #686, #440, #679. The tracker's recurring shape is *"it resolved something
surprising and I cannot see why"*; §15.30 lists five issues that one command would have
diagnosed. Must make no network request and must not fail on an invalid project spec —
reporting *why* it is invalid is the point.

### P10 — Shims and enablement §15.13, §15.14, §15.15, §15.16, §15.29 — **done** (`353a726`)
#71 is the highest-signal issue in the tracker (34👍, four years). Per-user shim directory
by default, never require elevation, `LOCALAPPDATA` only on Windows, restore what `enable
--force` displaced, shim npm by default with `--exclude npm`, and verify the shims
actually won on `PATH` afterwards.

### P11 — Native package managers §15.28
#295 is the **most-upvoted issue in the tracker** (146👍). `{platform}`/`{arch}` in a URL
template and `"exec": "native"` so a band's binaries run directly. This is architectural
headroom, not a package-manager addition: §15.21 and §15.28 both require maintainer
consent before anything is added to the table, and pnpm's maintainers have publicly
disavowed corepack while Bun's have declined. Build the capability; add no entries.

### P12 — One verification tier §15.11

Add to its scope, found while tracing P6: **a cache hit never checks the marker's
hash against the pin's digest.** §07.2 makes the store directory the plain semver
version, so `pnpm@9.0.0+sha512.<A>` and `pnpm@9.0.0+sha512.<B>` share one
directory and the second silently gets whatever the first installed — traced on
the built binary, both run. That is what §07.2 prescribes (the marker's hash is
*re-attached* to the locator, not compared), and it is corepack's behaviour too,
so it is not a regression; but it is a reproducibility hole squarely inside
§15.11's "every artifact clears a tier", and the fix belongs here rather than as
a silent change to §07.

Closes §06.6's remaining rows: `repo.yarnpkg.com` currently has TLS only. Every artifact
must clear a pinned hash, a verified registry signature, or a verified detached signature,
with `COREPACK_ALLOW_UNVERIFIED=1` as the per-run opt-out. Sequenced last because it is a
**breaking** change for anyone resolving Yarn Berry dynamically, and it wants the rest of
phase 2 settled underneath it.

## Not in scope, deliberately
§15.34 records four requests corepack's maintainers declined and §15 **adopts** those
rulings: no `corepack run`, no package-manager passthrough, no writing into another tool's
lockfile, no monorepo task-runner pinning. Only `install --project` is accepted.

## Carried follow-ups

* Add `"npmrc.ts"` to `COLD_PATH_MODULES` in `test/unit/main.test.ts`. It is cold today —
  verified two ways, module graph and `strace` showing zero `.npmrc` syscalls on a cache
  hit — and the list is what keeps it that way. Deferred only because that file was
  contended.
* `src/resolve.ts` still carries its own `hasRegistryOverride()` reading only
  `COREPACK_NPM_REGISTRY`. The consequence is neutralised (§05.2 rewrite 1 now also
  applies inside `registry.ts`'s fetchers, idempotently), but the redundant, incomplete
  copy should go once the file is free.
* `messages.cafileUnreadable` hardcodes `(set by COREPACK_CAFILE)`, which is wrong for an
  `.npmrc` `cafile`. §12 wants a parameterised message.
* `COREPACK_REGISTRY_<NAME>` is `.corepack.env`-eligible per §15.37, so a cloned repo can
  redirect one package manager's downloads. Spec-conformant and consistent with
  `COREPACK_NPM_REGISTRY`, but it is a weaker form of what §14.5 guards against — worth a
  line in §14.5's rationale.

* ~~`COREPACK_SHIM_DIRECTORY` eligibility assertion~~ — done in `353a726`. Note what it
  taught: eligibility is a **deny-list**, so a new `COREPACK_*` variable is env-file
  eligible with no edit to `src/env.ts` at all. The assertion exists so a later edit to
  `ENV_FILE_INELIGIBLE` cannot withdraw it silently; adding the variable to that list
  fails the test.
* `src/info.ts` should learn to report `COREPACK_CAFILE` / `COREPACK_STRICT_SSL`, and to
  name a custom shim directory once `COREPACK_SHIM_DIRECTORY` exists.
* §15.4's expired / not-yet-valid certificate branch is unit-tested by code path, not end
  to end — the committed fixture is valid until 2126 and an expired cert needs a second
  fixture.

### §15.14's native half — assessed, not attempted (P10)

`enable` symlinks `<shimdir>/<B>` to `dist/<B>.js`, one generated stub per binary, each
importing `./shim.mjs` by a *relative* specifier. Measured against §14.15: the relative
specifier already dissolves half of #751 (the pair is relocatable), and P10 closed the
behavioural remainder (a dangling shim is replaced/removed, not skipped). #213 (Windows
execution policy on the `.ps1` wrapper) and #486 (`#!/usr/bin/env node` must find a
runtime to *start*) are untouched and genuinely need a native binary.

One correction to the premise, verified: **`process.argv[1]` is not realpathed.**
Invoking a symlink `bin/yarn` → `dist/tool.mjs` yields `argv[1] === ".../bin/yarn"` while
`import.meta.url` is the realpath. Corepack's stated reason for avoiding invocation-name
dispatch therefore applies to `import.meta.url`, not to `argv[1]` — so a JS distribution
could do §14.15's `basename(argv[1])` dispatch on POSIX today: one shipped `dist/shim.mjs`
and six symlinks to it, no generator, #751 closed at the root. It does not help on
Windows, where the `.cmd`/`.ps1` wrappers pass the stub path to `node` and the invocation
name is lost. Worth doing as its own item; it changes the shim contract, not enablement.
