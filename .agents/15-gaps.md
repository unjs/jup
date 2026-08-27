# 15 — Gaps Closed (from corepack's Open Issue Tracker)

Requirements derived from the ~120 open issues and ~27 open PRs on
`nodejs/corepack`. These are **normative**, on the same footing as §14. Where a
requirement here refines one in §14, §15 wins.

Each entry cites the driving issue(s) so the motivation stays traceable. Signal
counts (👍 / comments) are given where they justify prioritisation. Claims about
corepack's behaviour have been verified against the source at `b856c516`.

**Status legend:** ⬛ maintainers say *by design / won't fix* — this spec chooses
differently, deliberately.

---

# Part A — Registry, mirrors, and corporate networks

This is the single largest cluster in the tracker, and every issue in it traces to
the same root: registry configuration is a **single env var that only rewrites one
hardcoded origin**, and nothing else in the ecosystem is consulted.

## 15.1 Read a constrained `.npmrc` subset — [required]

> Driven by **#540** (25👍, 11 comments, open since 2024-07) — *"`COREPACK_NPM_REGISTRY`
> should default to `npm config get registry`"*. Reframed in-thread as a supply-chain
> concern, not a convenience: a locked-down organisation configures one registry and
> expects every tool to honour it. Corepack silently doesn't, so it reaches the public
> registry from machines whose policy forbids exactly that.

§05.4 records that corepack reads no `.npmrc` at any level. A conforming
implementation **MUST** read one, restricted to the following keys.

**Files, lowest to highest precedence:**

```
1. <prefix>/etc/npmrc          (builtin/global)
2. $HOME/.npmrc                (user)  — or %USERPROFILE%\.npmrc
3. ./.npmrc, walking up to the project root, closest wins   (project)
```

The project walk MUST use the same rules as §03.1: stop at the project root, skip
directories inside `node_modules`.

**Keys honoured — and no others:**

| Key | Effect |
|---|---|
| `registry` | Default registry base URL |
| `@scope:registry` | Registry for that scope. Relevant because Yarn Berry is fetched as `@yarnpkg/cli-dist` (§02.5) |
| `//host/path/:_authToken` | Bearer token for that registry prefix |
| `//host/path/:_auth` | Pre-encoded Basic credentials for that prefix |
| `//host/path/:username` + `:_password` | Basic credentials (`_password` is base64) |
| `cafile` | Path to a PEM bundle — see §15.4 |
| `ca` / `strict-ssl` | See §15.4 |

Everything else in the file **MUST be ignored**, including `${VAR}` expansion in
unlisted keys.

**Precedence over the whole configuration space:**

```
1. COREPACK_NPM_REGISTRY / COREPACK_NPM_TOKEN / COREPACK_NPM_USERNAME|PASSWORD   (highest)
2. .jup.env, for the env-file-eligible subset only (§11, §14.5)
3. .npmrc, in the file order above
4. the built-in default registry                                                 (lowest)
```

**Security constraints — these are what make reading `.npmrc` safe:**

* Auth entries are **prefix-scoped by construction** (`//host/path/:_authToken`).
  A credential MUST only be attached to a request whose origin *and* path prefix
  match. This is stricter than corepack's own Bearer handling and is the reason
  `.npmrc` can be read at all without reintroducing §14.6's leak.
* A **project-level** `.npmrc` is attacker-controlled in a cloned repository. It MAY
  set `registry` and `@scope:registry`; it **MUST NOT** be honoured for `_authToken`,
  `_auth`, `_password`, `ca`, `cafile`, or `strict-ssl`. Those come from the user and
  global files only. (npm itself does honour project-level auth; this spec does not,
  because unlike npm this tool runs *before* the user has decided to trust the repo.)
* `strict-ssl=false` MUST be honoured only from the user/global files, and MUST print
  a warning naming the file it came from.

> **Note on scope discipline.** This is ~150 lines: an INI-ish line parser, a prefix
> matcher, and a precedence chain. It does not pull in npm's config system, and it
> does not make the tool configurable in any new way — it reads configuration the user
> already wrote for a different tool. That is the whole justification for crossing the
> "no config file" line in §01.7.

## 15.2 One mirror mechanism for every source — [required]

> Driven by **#753** (15👍, no maintainer response) — *"Corepack ignores
> `COREPACK_NPM_REGISTRY` for the Yarn registry"* — and **#872**, where a Renovate
> deployment gets its IP banned for fetching Yarn across hundreds of repositories and
> cannot point at a self-hosted mirror.

Corepack's override rewrites exactly one hardcoded prefix,
`https://registry.npmjs.org` (§07.3). Consequences, verified against the table in
§02.5:

* Yarn **Berry** has no mirror path of its own. Setting `COREPACK_NPM_REGISTRY`
  switches it to the `@yarnpkg/cli-dist` npm package — which works, but *only* by
  also redirecting npm and pnpm. There is no way to mirror Yarn alone.
* With the override **unset**, Berry always fetches from `repo.yarnpkg.com`, and its
  version/tag list always comes from `https://repo.yarnpkg.com/tags`. Neither is
  configurable, and neither is signature-verifiable (§06.6).

**Required:** a per-source base-URL override, resolved before any request:

```
COREPACK_REGISTRY_<NAME>       overrides the download/registry base for package manager <NAME>
COREPACK_NPM_REGISTRY          overrides the npm-protocol registry base (unchanged meaning)
```

`<NAME>` is the upper-cased package manager name (`COREPACK_REGISTRY_YARN`,
`COREPACK_REGISTRY_PNPM`, `COREPACK_REGISTRY_NPM`). When set, **every** URL derived
from that package manager's table entry — download URL, tag document, version list —
has its origin replaced. Rewriting MUST be origin replacement, not substring
replacement (see §15.3).

Precedence: `COREPACK_REGISTRY_<NAME>` > `COREPACK_NPM_REGISTRY` > `.npmrc` >
built-in.

## 15.3 Rewrite origins, not substrings — [required, security]

> Driven by **#792** (*tarball URLs not rewritten to the custom registry*) and by
> corepack's own history: *"incorrect registry origin check"*, fixed in 0.34.1.

Corepack rewrites URLs with `url.replace("https://registry.npmjs.org", override)` —
a prefix string replacement. This is fragile in both directions: it misses URLs that
differ only in trailing slash or case, and it would happily rewrite the middle of a
URL that merely *contains* the literal.

**Required:** parse both URLs, compare **origins** (scheme + host + port,
case-insensitive host), and if they match, rebuild the target URL with the override's
scheme/host/port and the override's path prefix prepended. Never operate on the URL
as a string.

This composes with §14.9: after rewriting, the resulting host MUST equal the
configured registry's host, or the download is refused.

## 15.4 TLS: custom CAs and actionable diagnostics — [required]

> Driven by **#332** (7👍) — *"Error when performing the request"* turns out to mean
> `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, i.e. a corporate TLS-interception proxy whose
> CA is not in the trust store. Corepack's message says none of that. Also **#447**
> (proxy not honoured on a specific runtime image) and **#458** (6👍, 9 comments —
> unexplained `fetch()` failures in CI, root cause never found).

Corepack has no TLS configuration surface at all; users must know to set a
runtime-level environment variable that corepack never mentions.

**Required:**

* Honour a PEM bundle from, in precedence order: `COREPACK_CAFILE`, `.npmrc`'s
  `cafile`/`ca` (user/global only, §15.1), then the platform trust store.
* `COREPACK_STRICT_SSL=0` (or `.npmrc` `strict-ssl=false` from user/global) disables
  verification, and MUST print:
  `! TLS certificate verification is disabled (set by <source>)`
* **Classify TLS failures and say what to do.** A conforming implementation MUST NOT
  surface a bare transport error for these cases:

```
Untrusted certificate authority
    → `TLS certificate verification failed for <host>: the certificate was issued by an
       unknown authority. If your network uses a TLS-inspecting proxy, point
       JUP_CAFILE at its CA bundle.`
Expired / not-yet-valid certificate
    → `TLS certificate for <host> is expired or not yet valid (check the system clock).`
Hostname mismatch
    → `TLS certificate for <host> does not match that hostname.`
```

* **Confirm the bundle was actually installed.** Installing a CA is a
  security-relevant configuration step whose API answers nothing: Node's
  `tls.setDefaultCACertificates` returns `undefined`, so an unchecked call is a
  wish. An implementation MUST verify that the configured certificates are
  reflected in the runtime's default trust store afterwards — reading them back
  where the runtime offers a way (`tls.getCACertificates("default")`) — and MUST
  fail with a message **naming the setting that was ignored** rather than letting
  the request fail later with the bare certificate error this section exists to
  abolish. A runtime that provides no way to install the bundle at all MUST fail
  the same way, not with a raw `TypeError`.

  The check costs one call and only on a run that configures a CA, so §15.4's
  "nothing here costs anything unless it is configured" is preserved. It is
  skipped when the request will not travel over the runtime's own `fetch`
  (§14.8's `node:https` dispatcher passes `ca` explicitly, so the process default
  is not what carries it).

  Its limit is worth stating: this detects a **no-op setter**. It cannot detect a
  runtime whose HTTP stack simply does not consult the process trust store —
  measured with a one-certificate bundle, `getCACertificates("default")` went
  120 → 1 on node 24.19, 121 → 1 on bun 1.4.0 and 151 → 1 on deno 2.8.3, and only
  node's `fetch` honoured it. All three report the change; two ignore it. That is
  a runtime bug rather than something detectable from here.

## 15.5 Network resilience: timeouts and retries — [required]

> Driven by **#458** (6👍, 9 comments): intermittent CI failures with no diagnosis. The
> reference implementation has **no timeout, no retry, and no backoff** — a single
> transport hiccup is fatal — which is exactly the shape of an undiagnosable flake.

**Required** (refining §05.1's table from SHOULD to MUST):

* A connect timeout and an idle timeout, both defaulting to 30 s, both overridable via
  `COREPACK_NETWORK_TIMEOUT` (milliseconds).
* Automatic retry for **idempotent GETs only**, on transport errors and on
  408/425/429/5xx: 3 attempts, exponential backoff with jitter, honouring
  `Retry-After` when present. Never retry other 4xx.
* `COREPACK_NETWORK_RETRIES=0` disables retrying.
* The final error MUST include the underlying cause — the errno or TLS reason — not
  just the wrapper message.

## 15.6 Implement proxying directly — [required]

> Driven by **#516** (maintainer thread on dropping the HTTP-client dependency) and
> **#447**. Corepack carried a whole HTTP client dependency *solely* for proxy support
> (§05.1), then dropped it in 0.35.0 in favour of a host feature that requires a
> second opt-in flag most users never set.

This restates §14.8 and raises it to a first-class goal-driven requirement: for a
zero-dependency implementation the HTTP client is being written anyway, and
`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` cost a `CONNECT` handshake and a
suffix matcher. Corepack's dependency churn in this area — add a client for proxies,
patch its dispatcher prototype (0.27.0), then remove it again (0.35.0) — is the
argument for owning it.

`NO_PROXY` matching MUST support: `*` (disable entirely), bare hostnames, leading-dot
suffixes, and an optional `:port` qualifier.

---

# Part B — Integrity and trust

The most actively debated area of the tracker, driven by real incidents.

## 15.7 Never crash on absent registry metadata — [required, bug]

> Driven by **#570** (9👍), **#725**, and **#808** — a `TypeError: Cannot read
> properties of undefined` when a private registry's metadata omits `dist` or
> `dist.signatures`. Widespread during the February 2025 npm key-rotation incident.
> Artifactory, Nexus, and similar proxies routinely strip `signatures`.

Verified in source: `fetchLatestStableVersion` destructures
`const {version, dist: {integrity, signatures, shasum}} = metadata` and
`fetchTarballURLAndSignature` destructures `versionMetadata.dist` — both throw a raw
`TypeError` when `dist` is absent. `verifySignature` *does* guard its `signatures`
argument, so the crash happens strictly upstream of the good error message.

The only documented workaround is `COREPACK_INTEGRITY_KEYS=0`, which disables
verification **globally and permanently** — an all-or-nothing footgun that turns a
metadata-shape problem into a security downgrade.

**Required:** three distinct outcomes, never a crash.

| Registry response | Outcome |
|---|---|
| `dist` absent entirely | Error: `<pkg>@<version> metadata from <registry> has no "dist" section; this registry may not be npm-compatible` |
| `dist` present, `signatures` absent or empty | **Soft-fail**: proceed if a hash is pinned or `integrity` is present and matches; otherwise refuse. Warn once: `! <registry> does not publish signatures for <pkg>@<version>; falling back to integrity-only verification` |
| `signatures` present but invalid | **Hard fail** — `Signature does not match` (§06.3), unchanged |

`COREPACK_REQUIRE_SIGNATURES=1` turns the soft-fail into a hard failure, for
organisations that want to mandate signed sources.

## 15.8 Fall back to package-root metadata for signatures — [required, bug]

> Driven by **#808** and its unmerged PR **#870**: JFrog Artifactory returns
> `dist.signatures` on the package-root endpoint (`GET /<pkg>`) but strips it from the
> version endpoint (`GET /<pkg>/<version>`).

**Required:** when the version endpoint yields no `signatures`, retry once against the
package-root endpoint and read `versions[<version>].dist.signatures` from there before
concluding the registry is unsigned. Only then apply §15.7's soft-fail.

## 15.9 Decouple trust-key freshness from release cadence — [required]

> Driven by closed incidents **#612/#616** — npm rotated its signing keys in February
> 2025 and **every released corepack broke worldwide** until users manually upgraded —
> and by stalled PR **#647** (18 comments, open since Feb 2025, no merge decision),
> which would fetch keys via TUF but grows the bundle from 936 KB to 2.4 MB.

Corepack bakes keys into `config.json` at release time (§02.6), so key rotation is a
global outage with a manual-upgrade remedy. The bundled table today still ships a key
that expired on 2025-01-29 (§14.4).

**Required:**

* Keys are cached at `<home>/keys.json` with a fetch timestamp.
* On a signature failure where **no trusted key matched the signature's keyid** — and
  only then — refresh once from `<registry>/-/npm/v1/keys`, cache the result, and
  retry verification. A successful verification path never makes this request, so the
  fast path (§01.3) is unaffected.
* The refreshed set is **merged with**, not substituted for, the embedded set; embedded
  keys remain trusted until they expire.
* `COREPACK_INTEGRITY_KEYS`, when set, disables refresh entirely — an explicitly
  pinned trust store is final.
* Refresh MUST be skipped when `COREPACK_ENABLE_NETWORK=0`.

> **On the circularity objection.** A maintainer's objection to key-fetching
> (on **#884**) is that fetching keys over the same TLS channel as the artifact adds
> little. That is right for *bootstrapping* trust and wrong for *rotating* it: merging
> a fetched key into an embedded set, only on keyid-miss, only for the npm registry,
> converts "every old client is bricked" into "old clients keep working". It does not
> weaken the embedded keys, because they are never removed by this path.

## 15.10 Custom-registry trust, without circular trust — [required]

> Driven by **#884** and open PR **#885**: signature verification always uses npm's
> keys even when a different registry served the package, so every re-signing private
> registry (Cloudsmith and similar) fails. Compounded by **#741**: `.corepack.env` was
> not loaded for `install`/`prepare`, so the per-project workaround did not work
> either.

**Required:**

* The trust store is keyed by **registry origin**, not by the literal string `npm`:
  ```json
  {"https://registry.npmjs.org": [<key>…],
   "https://npm.internal.example": [<key>…]}
  ```
  The embedded set populates the npm origin. `COREPACK_INTEGRITY_KEYS` accepts both
  this shape and corepack's legacy `{"npm": [...]}` shape, the latter meaning the
  default registry's origin.
* Keys for a non-default origin come **only** from the environment or the user/global
  configuration — never from a project file (§14.5), and never auto-fetched from that
  registry itself. §15.9's refresh applies to the npm origin only.
* A registry origin with no configured keys and no signatures falls to §15.7's
  soft-fail.

## 15.11 One verification tier for every source — [required, security] ⬛

> Driven by open PR **#548** (*"refuse to download unverified downloads"*, a breaking
> change, unmerged), **#855** (request for a `--strict` integrity flag), **#495**
> (22 comments; a Node.js TSC member arguing the current model is a supply-chain
> risk), and **#10** (7👍, open since 2020).

Corepack's trust model is two-tiered, and §06.6 records the holes: npm-hosted packages
get a signature chain; Yarn Berry from `repo.yarnpkg.com` gets **TLS only**; Yarn Berry
via a custom npm registry gets **nothing at all** (§14.10). Yarn's maintainer has
confirmed Yarn will not move to npm-only distribution, so the asymmetry is structural,
and the PR that would close it has sat unmerged.

**Required:**

* Every artifact MUST clear one of: a **user-pinned hash**, a **verified registry
  signature**, or a **verified detached signature** from the distribution channel.
  TLS alone is not a verification tier.
* Because the built-in table pins a hash on both `default` and
  `transparent.default` (§02.5), the tool ships in a fully-verified state — the
  unverified path only opens for versions resolved dynamically from an unsigned
  channel.
* When no tier is available, refuse:
  `Refusing to install <name>@<version>: <source> provides no signature and no hash was pinned. Pin a hash in the packageManager field, or set JUP_ALLOW_UNVERIFIED=1.`
* `COREPACK_ALLOW_UNVERIFIED=1` opts out, per-run, with a warning. It MUST NOT be
  settable from an env file (§14.5).

This also closes §14.10 (single-file extractions) and §06.6's `repo.yarnpkg.com` row.

## 15.12 Store the pin's hash outside the version string — [recommended] ⬛

> Driven by **#316**, where maintainers explicitly defend appending the hash to the
> version as a deliberate security tradeoff, despite it breaking external tooling that
> expects `packageManager` to hold clean semver. Also **#726** and **#620**, both
> asking for the notation to be clarified or documented.

The `<version>+<algo>.<hex>` form (§02.1) is technically valid semver build metadata,
but it means the field no longer round-trips through tools that treat it as a version.

**Recommended:** keep writing the suffixed form by default — it is the interoperable
format and §13 asserts it — but support reading an explicit sidecar:

```json
{"packageManager": "yarn@4.14.1",
 "devEngines": {"packageManager": {"name": "yarn", "version": "4.14.1",
                                   "integrity": "sha512-…"}}}
```

When `devEngines.packageManager.integrity` is present it is an SRI string and is
treated exactly like a build-suffix hash (§06.1). `--pin-style=sidecar` makes
`use`/`up` write that form instead. Both forms MUST be accepted on read.

---

# Part C — Shims, PATH, and platform integration

## 15.13 Never require elevation; default to a per-user directory — [required]

> Driven by **#71** — **34👍, 20 comments, open since 2021, the highest-signal issue
> in the tracker.** `corepack enable` writes shims next to its own binary, which on
> Windows is `C:\Program Files\nodejs` and requires administrator rights. Also **#265**
> (Arch Linux, corepack installed to `/usr` by the system package manager), **#416**
> (NixOS, `EROFS`), and **#673** (`LOCALAPPDATA` honoured on Linux/WSL, landing the
> store on a mounted Windows drive with alien permissions).
>
> Maintainers' standing response across all four is *"PRs welcome"*. Unfixed for four
> years. npm solved this long ago by defaulting global installs to `%APPDATA%\npm`.

Verified in source: `enable` resolves its target as `dirname(which("corepack"))`
(§10.4), with no writability check and no fallback.

**Required:**

1. Resolve the install directory as: `--install-directory`, else
   `COREPACK_SHIM_DIRECTORY`, else the **per-user default**:
   * Linux/BSD: `$XDG_BIN_HOME`, else `~/.local/bin`
   * macOS: `~/.local/bin`
   * Windows: `%LOCALAPPDATA%\jup\bin` (no `node\` segment — §07.1)
2. **Probe writability before writing anything.** On `EROFS`/`EACCES`/`EPERM`, fall
   back to the per-user default and say so:
   `! <dir> is not writable; installing shims to <fallback> instead`
3. If the chosen directory is not on `PATH`, print exactly what to add, for the
   detected shell, and exit 0 — do not silently install somewhere inert.
4. `--install-directory=<the directory containing the tool>` remains available for
   anyone who wants the old behaviour.
5. **`LOCALAPPDATA` MUST only be consulted on Windows** (closes #673). This narrows
   §07.1's documented chain; it is the one place this spec breaks store-location
   compatibility with corepack, and it is correct — a Linux process inheriting
   `LOCALAPPDATA` from WSL interop should not put its cache on `/mnt/c`.

## 15.14 Native shims — [required]

> Driven by **#213** (5👍 — Yarn's `.ps1` shim blocked by Windows' default execution
> policy; a maintainer dismissed code-signing as impractical for dynamically generated
> scripts), **#486** (the `#!/usr/bin/env node` shebang picks the wrong `node`, or
> none; maintainer: *"not something that can be fixed from Corepack's end"*), and
> **#751** (4👍, 15 comments — after Node 25 stopped bundling corepack, stale shims
> point at a `dist/yarn.js` that no longer exists).

Three separate "unfixable" issues, one root cause: the shim is an interpreted script
that hardcodes a path and needs a JavaScript runtime on `PATH` to start.

**Required:** §14.15's self-dispatching model, which dissolves all three —

* A real executable is not subject to PowerShell execution policy (**#213**).
* A native binary needs no `node` on `PATH` to *start*; it locates a runtime only when
  it is time to execute a package manager, with a clear error if none is found
  (§08.3.1) (**#486**).
* A symlink or hardlink to the tool itself carries no baked-in path to relocatable
  build output (**#751**).

Additionally, to close **#751** fully: `enable` MUST detect and replace a shim that
points at a nonexistent target, and `disable` MUST remove such a dangling shim rather
than skipping it.

## 15.15 Make `disable` non-destructive — [required] ⬛

> Driven by **#112** (10👍). `corepack disable` deletes whatever occupies the shim
> name, including a pre-existing real package-manager install that `enable` clobbered
> (§10.2). A maintainer's position: *"not a huge deal if enable/disable are destructive
> operations"*, on the grounds that tracking the original is hard with nvm/asdf/etc.

Combined with §14.16 (refuse to clobber foreign binaries), this becomes tractable:

* `enable` refuses to replace an entry it did not create unless `--force`.
* With `--force`, it records the displaced entry — path, type, and for a symlink its
  target — in `<home>/shims.json` before replacing it.
* `disable` removes only entries it created, then restores anything recorded, then
  clears the record.
* If a recorded entry can no longer be restored, `disable` says so and continues.

## 15.16 Shim npm by default — [required] ⬛

> Driven by **#138**, where excluding npm is confirmed *deliberate*: corepack defers to
> the npm team on whether npm should be corepack-managed, and npm has not opted in.
> Four years later, the consequence stands — a project pinned to `yarn` correctly
> blocks `pnpm`, while `npm install` silently works anyway and produces the very
> inconsistent lockfile state the tool exists to prevent.

The exclusion is inter-team policy, not a technical constraint. A separate
implementation is not party to it.

**Required:** `enable` with no arguments targets **all** supported package managers,
npm included. `--exclude npm` restores the old default for anyone who needs it. §10.5
and §13 test #117 change accordingly, and this MUST be called out prominently in the
tool's own documentation, since it is the one behavioural difference a user migrating
from corepack will notice immediately.

## 15.17 Resolve bin paths from signed metadata — [required]

> Driven by **#775**: corepack hardcodes each package manager's entry-point path and
> breaks every time one restructures — pnpm has forced a new range band twice already
> (`.js` → `.cjs` → `.mjs`, §02.5), and a v12 alpha broke it again. A maintainer frames
> the tradeoff honestly: reading `bin` from the downloaded package is more correct but
> trusts attacker-controlled metadata.

Both horns are avoidable, because verification already happens. A hardcoded path is
worth nothing once it is wrong, and the version that will break it is by definition
one no release could have anticipated — so the table MUST NOT be the thing that
decides where an entry point is.

**Required:**

1. For a tarball install, `bin` MUST come from the extracted `package.json` — read
   only **after** the artifact has cleared §15.11's verification tier, and subject to
   §14.13's containment check. This holds whether or not a declared range band covers
   the version: a band that disagrees with the package is a stale band, not a
   correction.
2. The embedded table's `bin` is the fallback. It is authoritative for a **single-file**
   download, which has no manifest to read, and it is used for a tarball only when the
   package declares no usable `bin` — and then only where a *declared* band covers the
   version, so §02.3's fall-forward guess never reaches the marker.
3. Debug-level notes carry the maintenance signal to whoever owns the table (§16.9),
   since neither case changes the outcome of the run:
   * the resolved version matches no declared range band; and
   * a declared band's `bin` disagrees with what the package declares — the band has
     rotted, and only this note will say so.

This makes a new package-manager major work on day one instead of requiring a release,
without ever trusting an unverified path. The range bands keep their other jobs
(§02.3's `url`, `registry`, `commands`) and remain worth maintaining; they simply stop
being able to break an install by being out of date.

---

# Part D — Cache, offline, and CI

## 15.18 `cache clean` removes everything it claims to — [required, bug]

> Driven by **#675**: the documentation says `cache clear` *"clears the local
> COREPACK_HOME cache directory"*, but `lastKnownGood.json` survives (verified: the
> command removes `<home>/v1`, and the file lives at `<home>/`, §07.9).

§14.21 records the survival as intentional — a recorded default is a preference, not a
cache entry — and that reasoning holds. The defect is that the behaviour and the
documentation disagree.

**Required:** keep the default behaviour; document it precisely; add
`cache clean --all` to remove the recorded defaults as well, printing what it removed.

## 15.19 Offline and airgapped installs as a first-class path — [required]

> Driven by **#448** and **#414**, two separate open issues reporting the same thing:
> the documented `pack -o` → `install -g --cache-only` flow does not reliably work, and
> the extra steps that make it work (permission fixes, specific flag combinations) were
> found by trial and error in the issue threads rather than in the documentation.

This is a core value proposition — build a container image once, run it with no
network — and §13.8 already covers the happy path. The gap is diagnostics.

**Required:**

* When resolution fails and `COREPACK_ENABLE_NETWORK=0`, the error MUST name what was
  missing and how to seed it:
  `<name>@<range> is not in the cache and network access is disabled. Seed it with 'jup install -g --cache-only <name>@<version>', or run 'jup pack <name>@<version>' on a networked machine.`
* `install -g --cache-only <file>.tgz` MUST report every locator it extracted, so a
  Dockerfile layer's log shows what the image actually contains.
* A `jup cache list` command printing installed `<name>@<version>` pairs and the
  recorded defaults, machine-readable under `--json`. This is the missing tool for
  "did my image get seeded correctly?", and it is a directory listing.

## 15.20 Predictable download-prompt behaviour — [required]

> Driven by **#550**: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` does not always suppress the
> prompt, and behaviour differs between explicit (`corepack install`) and implicit
> (shim) invocation in a way users find surprising and under-documented.

Verified: the default is set by the *entry point* (§10.1), the variable cannot be set
from an env file (§03.2), and the interactive branch additionally requires a TTY and
an unset `CI` (§05.5). Three interacting conditions, none of them documented together.

**Required:**

* `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` MUST suppress both the notice and the
  confirmation, unconditionally, from every entry point. No exceptions.
* The interactive confirmation MUST require *all* of: value `1`, stdin is a TTY, `CI`
  unset. When the notice prints but confirmation is skipped, that is not an error.
* §11's table MUST state the entry-point-dependent default explicitly, and the tool's
  own `--help` MUST mention it.

---

# Part E — Scope and distribution

## 15.21 Package managers beyond npm/pnpm/yarn — [bounded]

> **Widened by §15.39.** Everything below holds for *tools*, not only package
> managers: the closed compiled-in table, the data-only rule for adding an entry, the
> ban on hardcoding names outside it, and the consent requirement all apply
> unchanged to a `kind: "runtime"` entry.

> Bun, Deno, and others recur in the tracker. The table (§02.5) is closed, and adding
> an entry requires a release.

The goals in the README (minimal; no plugin system) argue against a user-extensible
registry, and §01.7 forbids one. But "closed table" and "closed set" are different
things.

**Required:**

* The table remains **compiled in** and **not user-extensible** at runtime. No plugin
  API, no user-supplied `config.json`, no discovery protocol.
* Adding a package manager MUST be a data-only change: one entry in §02.5, no code.
  The tool's own structure MUST NOT hardcode the names `npm`, `pnpm`, `yarn` anywhere
  outside that table. (Corepack mostly achieves this; the exceptions are the
  npm-exclusion in `enable` — removed by §15.16 — and the `binName.includes("yarn")`
  Yarn Switch check in §10.2, which SHOULD become a per-entry flag.)
* An unknown name in `packageManager` remains an error, not a URL-fetch fallback
  (§03.4).

### bun, deno, aube and nub are entries

All four ship in §02.5. They are the entries that use §15.28's per-host model, and
adding them was a data-only change in the sense above — the machinery they use is
§15.28's, declared per band, not per name.

What that model has to accommodate, and what §02.4 and §15.28 now spell out, is that
**one version is many artifacts**:

* the version line and the dist-tags come from the launcher package (`registry`),
  the bytes and npm's signature from the per-host one (`artifactRegistry`);
* there is therefore no portable digest, so `packageManager` records a bare version
  and §15.23 records a digest per host;
* the compiled-in `default` is likewise bare (§02.3), and clears §15.11's tier
  through the registry signature rather than through a literal.

`bun` and `deno` set `shimByDefault: false` (§02.3, §10.5). They name runtimes
people install deliberately and run outside any project, so a bare `jup enable` —
which existing users run on upgrade, having asked for nothing — must not claim those
names on `PATH`. `jup enable bun` is the opt-in.

**aube** (`@endevco/aube`) is the third, added under the same model, and it is where
that flag's meaning gets tested. aube is a package manager and nothing else: `aube`,
`aubr` and `aubx` name no runtime and mean nothing outside a project. So it does
**not** opt out, and a bare `jup enable` claims its three names exactly as it claims
`pnpm` and `pnpx`. The line §10.5 draws is runtime-versus-package-manager; an entry
that opted out merely for being recent would freeze the default set at corepack's
three names forever.

Two further things aube contributes to the model:

* Its published names are `<host>` verbatim, so its `targets` map is an identity —
  and still load-bearing, because aube publishes **no `darwin-x64` build at all**.
  A `targets` map is a declaration of the host set, not a spelling table, and this is
  the entry that shows the difference.
* It ships distinct musl artifacts, which is what added the libc half of §15.28's
  host name. That fixed bun on Alpine as a side effect (bun publishes musl builds too
  and was being handed the glibc one) and made deno's absence of a musl build an
  error naming the host instead of a loader failure at exec time.

**nub** (`@nubjs/nub`) is the fourth, and it is what settles what `shimByDefault`
actually asks. nub is a package manager — `nub install`, `add`, `remove` are
pnpm-compatible on the CLI and on the lockfile — and it opts **out** anyway, because
it is also a runtime: `nub server.ts` executes a TypeScript file on the installed
Node, `nubx` is an npx, and `nub node` manages Node versions. So the flag is not
about category any more than it is about recency. The question is whether the name
means anything outside a project, and `nub` means plenty; §10.5 now states it that
way, with `aube` and `nub` as the two sides.

Two smaller things nub contributes:

* Its `targets` map is an identity over the **whole** host vocabulary — no rename,
  no hole — because nub's own launcher builds `${process.platform}-${process.arch}`
  and appends `-musl`, which is §15.28's host rule in someone else's repository. It
  is written out regardless: a band with no `targets` claims every host forever, and
  the map is the only place a host leaving the set could be said.
* `nub` and `nubx` are one file, as `bun` and `bunx` are, but for a stated reason —
  the per-host packages shipped a byte-identical second copy until 0.7.0 and dropped
  it because it doubled a ~50 MB artifact per host. §15.28's `argv[0]` rule is what
  keeps two names over one file working for a native artifact.
* Its binary is published at mode **0644**, which is what forced §07.4 rule 6 to
  grow a second half. npm sets 0755 on extract only for a file the package's `bin`
  names, and these packages declare none; nub's `postinstall` chmods it back, and
  jup runs no lifecycle scripts. A native band's declared entry points are now made
  executable on the way into the store — bounded to those paths, to files that
  begin like a program (`#!`/ELF/Mach-O), to `+x`, and best-effort. The
  program-image bound is what keeps test 193's diagnosis intact: a stale `bin`
  path naming a data file must stay unexecutable, or `execvp`'s `/bin/sh`
  fallback turns a clear `cannotExecute` into exit 127 and a shell message. bun,
  deno and aube all publish 0755 and are unaffected.

> **On consent.** The requirement below is unchanged and is not satisfied by this
> section. Bun's maintainers reportedly asked corepack not to add them (#295), and
> pnpm's maintainer asked to be removed (§15.36). Shipping an entry is a maintainer
> decision about someone else's project, and it is the one part of adding a package
> manager that no amount of implementation work settles.

## 15.22 Publish through channels resistant to typosquatting — [advisory]

> Driven by **#803**: a lookalike domain outranked the real repository in search
> results, served LLM-generated documentation, and began offering downloads that
> carried an infostealer.

Not a code requirement, but it constrains distribution:

* Ship through package registries and signed release artifacts with published
  checksums. Do not ship an install script fetched from a bare domain.
* Sign release binaries and publish the verification procedure in the same repository
  as the source.
* Hardcode the canonical download origins used by the tool itself; there is no reason
  for a version manager to fetch from a host it does not already know about.

---

# Part F — Core semantics and UX

## 15.23 Accept semver ranges in the project spec — [required] ⬛

> Driven by **#95** — **121👍, 28 comments, open since 2022-03-02**, the second
> highest-signal issue in the tracker, with a companion PR (**#300**) unmerged since
> 2023. Also **#402** (19👍, *"the `packageManager` field is too limited"*) and
> **#729**, where the exact-version-only rule breaks Dependabot, Renovate, and Netlify
> builds.
>
> Corepack's author has held the line for four years: ranges *"prevent using hashes"*
> and *"give users a false sense of confidence"*, and on #729, *"the packageManager
> field not supporting ranges is a feature, not a bug."* Other maintainers disagree in
> the same threads. The cost is now concrete: **pnpm removed corepack from its own
> documentation** over this, and pnpm 11.21 generates `devEngines.packageManager`
> ranges that corepack rejects.

Verified: `parseSpec` with `enforceExactVersion: true` rejects anything that is not an
exact version (§03.4), and that flag is set for every proxy-mode read of a manifest
without a CLI version override.

The objection is real but is an argument against *unrecorded* ranges, not against
ranges. Both halves are obtainable:

**Required:**

* `packageManager` and `devEngines.packageManager.version` MUST accept a semver range
  or a dist-tag as well as an exact version.
* When the spec is not an exact version, the resolved concrete version **and its hash**
  are recorded in a resolution file at the project root, `.jup.lock`:
  ```json
  {"version": 1,
   "resolutions": {"pnpm@^11.0.0": {"resolved": "11.1.2", "integrity": "sha512-…"}}}
  ```
* §15.28 — for a package manager whose artifact is per-host there is no single hash,
  so `integrity` is instead an object keyed by the normalised `<platform>-<arch>`:
  ```json
  {"version": 1,
   "resolutions": {"bun@^1.4.0": {"resolved": "1.4.0",
                                  "integrity": {"linux-x64": "sha512-…",
                                                "darwin-arm64": "sha512-…"}}}}
  ```
  The **version** is one shared decision and is recorded once; the digest is not, and
  each host reads and writes only its own key. Rules:
  * A host with no key yet still resolves the recorded version with **no network
    request**, and verifies its download through §06.3's signature — the tier a
    native artifact always has. It then records its own key.
  * Adding a host's key is not a *re*-resolution and is not gated behind `up`: the
    version is unchanged and nothing was requested for it. It is gated by
    `COREPACK_FROZEN_LOCKFILE`, because it is still a write.
  * Other hosts' keys are carried forward while the recorded version stands, and
    dropped when it moves — a digest for 1.3.0 says nothing about 1.4.0 anywhere.
  * Keys are serialised sorted, so a new host is a one-line diff.
  * A build that does not know this shape reads `typeof integrity === "string"`, finds
    it false, and treats the entry as version-only. That is the correct degradation,
    and is why the file's `version` did not have to change.
* On every subsequent run, a recorded resolution that still satisfies the range is used
  **without any network access** — the fast path (§01.3) is preserved for ranges too.
* The resolution is refreshed only by an explicit `jup up`, or when the recorded
  version no longer satisfies the range.
* When the file is absent and the spec is a range, resolution hits the registry and
  writes the file. `COREPACK_FROZEN_LOCKFILE=1` (and CI defaults, matching package
  manager convention) makes that a hard error instead:
  `<name>@<range> is not resolved in .jup.lock and lockfile updates are disabled.`
* An exact-version spec continues to work with no lockfile involvement whatsoever.
  Projects that want corepack's current guarantees change nothing.

The file is jup's own, and is named for the tool that writes it. Corepack has no
resolution file — no lockfile of any kind, and no `COREPACK_FROZEN_LOCKFILE`; it rejects
ranges outright (§03.4), so it has nothing to record. There is therefore no
Corepack-era spelling to stay compatible with, and an implementation MUST NOT read a
`.corepack.lock`: no released tool has ever written a file by that name, so accepting it
would be compatibility with nothing.

This is the reconciliation the #300 discussion circled for three years without
landing: ranges for humans, a recorded hash for reproducibility and integrity.

## 15.24 Never resolve an unspecified version to a prerelease — [required, bug]

> Driven by **#473** (10👍) and its duplicate **#774**, both open, **with no maintainer
> response in roughly two years**. Recurs on every package manager prerelease cycle:
> `corepack use pnpm` installs `9.1.0-0` or `11.0.0-dev.1005` instead of the current
> stable release.

Verified in source — this is a two-line interaction:

```js
versions.filter(v => semverUtils.satisfiesWithPrereleases(v, finalDescriptor.range))
[...new Set(versions.flat())].sort(semverRcompare)
```

`satisfiesWithPrereleases` **strips the prerelease tag before testing** (§04.2), so
`11.0.0-dev.1005` satisfies `*`. `rcompare` then sorts it above `10.x`, and it wins.
The lenient satisfaction that correctly lets an *explicitly pinned* prerelease match a
range band (§02.3) leaks into *implicit* resolution, where it is wrong.

**Required:** in the range-query path (§04.1 step 6), discard candidates carrying a
prerelease tag **unless** the range itself names a prerelease, or
`COREPACK_ENABLE_PRERELEASES=1` is set. Range-band selection (§02.3) and cache probing
(§14.2) keep the lenient rule — those classify a version the user already chose.

Additionally, a bare name or `*` SHOULD resolve via the registry's `latest` dist-tag
rather than by taking the semver maximum. The dist-tag is the publisher's own
statement about what is current, and it costs the same single request.

## 15.25 Symmetric manifest-walk stop conditions — [required, bug]

> Driven by **#779** (fix PR **#811** open, unmerged). Introduced when devEngines
> support landed (PR #643) without updating the walk.

Verified in source — the loop condition is:

```js
while (nextCwd !== currCwd && (!selection || !selection.data.packageManager))
```

Only `packageManager` stops the walk. A nested manifest declaring **only**
`devEngines.packageManager` does not, so the walk continues past it and a parent's
spec — or the global default — silently wins. The nested project's declared package
manager is ignored.

**Required:** the walk stops when the manifest declares `packageManager` **or**
`devEngines.packageManager`. §03.1 is amended accordingly. An explicitly empty or null
`packageManager` counts as "declared but invalid" — it stops the walk and produces a
parse error, rather than being treated as absent.

## 15.26 One logical pin, updated atomically — [required, bug]

> Driven by **#874** (fix PR **#880** open) — `corepack use pnpm@latest` on a
> devEngines-only project fails, because `use` writes a top-level `packageManager` that
> then conflicts with the existing `devEngines.packageManager`; a hash-presence
> difference alone is enough to trigger it. Related: **#729**, **#835**.

§03.3 gives `packageManager` precedence when both exist, and §03.7 writes only
`packageManager` — so a mutating command can *create* the very mismatch §03.3 then
rejects.

**Required:**

* A command that writes a pin MUST update **every field that encodes it**. If
  `devEngines.packageManager` exists, its `version` (and `integrity`, per §15.12) is
  updated alongside `packageManager`.
* If only `devEngines.packageManager` exists, the pin is written **there**, and no
  top-level `packageManager` is created. Creating one is what breaks #874.
* The post-write validation in §03.7 MUST run against the state being written, not the
  state on disk, so a command can never leave a project it just edited in a state it
  would refuse to read.

> **On field precedence (#835).** Corepack's author states `packageManager` is *"the
> recommended universal field"* and that Yarn *"has no plan"* to support devEngines,
> while npm and pnpm treat `packageManager` as legacy. That is a live ecosystem split,
> and a re-implementation cannot resolve it by fiat. This spec therefore keeps §03.3's
> read precedence (`packageManager` wins when both are present and agree) but requires
> both to be maintained on write, so a project stays valid under either reader.

## 15.27 Predictable target for project-mutating commands — [required]

> Driven by **#607**, where `corepack use` in a nested directory of a non-workspace
> monorepo updates the **root** `package.json`. Corepack's author confirmed the
> behaviour is intentional, agreed it is surprising outside Yarn-style workspaces, and
> floated a `--here` flag without committing to it.

§03.1 already documents the mechanism and its monorepo consequence.

**Required:**

* The walk for a *mutating* command MUST stop at a **workspace boundary** — a manifest
  declaring `workspaces`, or a directory containing `pnpm-workspace.yaml` — even when
  that manifest has no package-manager field.
* `--here` forces the mutation into `cwd`'s own manifest, creating it if absent.
* Every mutating command MUST print the path it modified:
  `Updated <path> to use <name>@<reference>`.
  This is the one-line fix for the whole class of "corepack edited a file I didn't
  expect" reports, and it also covers the auto-pin case in §03.6.

## 15.28 Do not assume package managers are portable JavaScript — [required]

> Driven by **#295** — **146👍, 32 comments, open since 2023-08-24, the single
> most-upvoted issue in the tracker.** Corepack cannot support Bun because, per a
> maintainer, *"Corepack was written with assumption that package managers would be
> implemented in JS"*, while Bun ships per-OS/per-arch native binaries. Yarn's planned
> v6 is also going native but intends to stay compatible.

This assumption is load-bearing across corepack: one URL template per version
(§02.4), a `bin` map of paths to `.js` files (§07.7), and in-process module loading
(§08.2). A re-implementation that inherits it inherits the ceiling.

**Required:** the table's fetch and execution model MUST accommodate native artifacts.

* `url` MAY contain `{platform}` and `{arch}` placeholders alongside `{}`, resolved
  against a normalised platform/arch pair (`linux`/`darwin`/`win32` ×
  `x64`/`arm64`).
* The **host name** — what `targets` is keyed by and what §15.23 records a digest
  under — is that pair, and on a musl Linux the pair suffixed `-musl`. Linux is the
  one platform where `<platform>-<arch>` does not name a binary interface: a glibc
  build does not start on Alpine, and a publisher shipping both says so in the
  artifact name (`@oven/bun-linux-x64-musl`, `@endevco/aube-linux-x64-musl`). glibc
  MUST stay unsuffixed, so every existing `targets` map and every recorded
  `.jup.lock` key keeps its meaning and only a musl host sees a new one. How the
  libc is detected is unspecified — it MUST describe the host rather than the build
  machine; the reference implementation stats the two loader paths and reads musl
  only when glibc's is absent, so that a glibc distribution with `musl` merely
  installed as a package is not misread.
* `url` and `artifactRegistry.package` MAY contain `{target}`, resolved through the
  band's own `targets` map from that same normalised pair. A pair the band does not
  declare MUST fail **before any request**, naming the host and what the band does
  ship for — see §12's `unsupportedTarget`. Published artifact names are not the
  product of two independent axes (bun spells Windows on arm64 `windows-aarch64`;
  deno suffixes only its Linux builds `-glibc`), and a per-band table is also the
  only way to say that a *version* has no build for an otherwise ordinary host.
* `bin` **paths** MAY contain `{exe}` — `.exe` on Windows, empty elsewhere. Bin
  *names* never do. This is needed because a per-host artifact package typically
  declares no `bin` of its own, so §07.7 has nothing to read and the table is the
  authority for a tarball.
* A range entry MAY declare `"exec": "native"`, meaning its `bin` targets are executed
  **directly** rather than through a JavaScript runtime. §08.3.1's runtime lookup is
  skipped entirely for these — which also makes them faster than the JS path, not
  slower.
* On the native path, `argv[0]` MUST be the **binary name the user invoked**, not the
  path to the artifact. A direct invocation through `PATH` gives the shell's word, and
  a package manager may dispatch on it: `bunx` and `bun` are one executable, and the
  first behaves as the second's `x` subcommand for no other reason. §02.4 already
  spells "two names, one file" as two `bin` entries with one path; this is what makes
  that spelling mean the same thing for a native artifact as for a JavaScript one.
  (§08.2's `[execPath, binPath, …]` rewrite exists only because the JS path runs an
  interpreter.)
* The extractor MUST preserve the executable bit for native `bin` targets (§07.4
  rule 6 already permits exactly this).
* A band MAY declare `artifactRegistry`, an npm registry spec naming the package the
  **artifact** comes from when that differs from the one `registry` answers version
  questions about (§02.4). §06 and §07 follow `artifactRegistry`; §04 follows
  `registry`.

### One version, many artifacts

A per-host band breaks an assumption the rest of the spec was written under: that a
`(name, version)` pair names one sequence of bytes. It does not, and a conforming
implementation MUST NOT let a digest taken on one host escape onto another:

* The digest MUST NOT be folded into the locator's reference (§07.6 step 3), because
  that reference is what `use`/`up` write into `packageManager`. A committed
  `bun@1.4.0+sha512.…` is a pin no other platform's artifact can satisfy, and it fails
  as a hash mismatch — the one outcome a pin exists to prevent.
* §15.23's `.jup.lock` records the digest **per host** (see there).
* The compiled-in `default` is a bare version (§02.3).
* §04.5's default-version lookup MUST return a bare version too, and MUST NOT read
  the launcher's `dist` at all. This is the same mistake in its least visible place:
  it is reached only when a project has *no* spec, so a build that gets it wrong
  passes every pinned test and fails every bare `bun` / `deno`.
* The recorded last-known-good (§04.5 step 1) MUST likewise hold a bare version for
  such an entry, and a reference read back from it that carries a digest MUST be
  **repaired on read** — the suffix dropped, the version kept, the file rewritten
  best-effort. That file is derived state which outlives a release: step 1 returns it
  with no network, ahead of every check downstream, so a bad entry written by an
  earlier build is permanent unless the read heals it. This follows §04.4's rule that
  a damaged `lastKnownGood.json` degrades rather than fails, with a more specific
  idea of damaged — the version is still a good default; only the digest is untrue.

> **One predicate, one choke point.** The four rules above are all the same fact —
> a per-host digest is host-local and references travel — and an implementation
> SHOULD enforce them where a reference *gains* a digest rather than at each writer.
> Both places such a reference is stored, `packageManager` and `lastKnownGood.json`,
> are copied between machines: the first is committed, the second is baked into
> container images and warmed caches. §06.1 row 1 reads a reference-borne digest as
> an explicit pin, so a digest that travels turns the *correct* artifact into a hash
> mismatch on arrival.
* What replaces the missing literal is not nothing: the per-host packages are ordinary
  signed npm tarballs, so §06.3's signature over `dist.integrity` covers exactly the
  bytes this host is about to run, and §15.11's tier is cleared on every install
  rather than by a compiled-in claim. This is *stronger* than a stale pin, not weaker.
* The store marker still records the hash it saw. The store is host-local, so there it
  is exactly the right fact, and §07.2's fast path keeps working unchanged.

> **On consent.** Bun's maintainers reportedly asked not to be added to corepack, and
> the issue remains unresolved partly for that reason. Technical capability is not
> permission: a package manager MUST NOT be added to the built-in table without its
> maintainers' agreement (§15.21). This requirement is about not *foreclosing* native
> support in the architecture, which is a separate question from who gets added.

## 15.29 Verify that `enable` actually took effect — [required, bug]

> Driven by **#507** (12👍): `corepack enable` exits 0 with no output, and `yarn` still
> resolves to the previous global install. Causes include shell command hashing, the
> shim directory not being on `PATH`, and other version managers (Volta and similar)
> shadowing it. None are surfaced.

**Required:** after writing shims, `enable` MUST verify its own post-condition:

1. Resolve each installed binary name through `PATH`.
2. If the resolved path is not the shim just written, warn — naming what won:
   `! <name> on PATH resolves to <path>, not the shim just installed at <shim>. Another version manager may be shadowing it.`
3. If the shim directory is absent from `PATH`, print the exact line to add for the
   detected shell (§15.13 point 3).
4. Note that a currently-open shell may need `hash -r` before the change is visible.

Exit code stays 0 — these are warnings, not failures — but silence must no longer be
the output of an enable that did nothing.

## 15.30 Introspection: `jup info` — [required]

> Driven by **#180** (3👍, a maintainer proposed a concrete output format and asked for
> a PR — never implemented), **#566**, **#686** (*"there's no reliable/explicit way to
> determine if corepack is enabled or not"*, from a Node.js member), **#440**, and
> **#679**.

The tracker's recurring shape is *"the tool resolved something surprising and I cannot
see why."* Issues #673, #412, #507, #607, and #686 would each have been diagnosed in
one command.

**Required:** `jup info [--json]`, printing:

* the resolved package manager, version, and hash;
* **which file and which field** it came from, as an absolute path;
* the env file in effect, if any, and which variables it contributed;
* the effective registry for each package manager, and the source of that setting
  (env var, `.npmrc` path, or built-in);
* the store path, whether it is writable, and the cached versions present;
* the recorded global defaults;
* for each supported binary name: whether a shim is installed, and what that name
  currently resolves to on `PATH`.

`info` MUST NOT perform any network request and MUST NOT fail when the project spec is
invalid — reporting *why* it is invalid is the point. `--json` output is stable and
documented; this is the tool's supportability surface.

`jup cache list` (§15.19) is a subset of this and MAY be an alias.

## 15.31 Global invocations bypass the project pin — [required, bug]

> Driven by **#690**: `npm install -g corepack@latest` fails inside a yarn- or
> pnpm-pinned project with *"This project is configured to use yarn"* — blocking the
> tool's own documented upgrade path. A maintainer agreed the fix should apply to both
> `-g` and `--global`.

The project-enforcement check (§03.5) fires on package manager identity without
considering that the command is explicitly global — operating outside the project by
definition.

**Required:** when the invocation carries a global flag (`-g`, `--global`, or a
package-manager-specific equivalent such as `--location=global`) as a **leading**
argument, treat it as a transparent command (§01.4): no name-mismatch error, and the
global default version is used. The flag must be recognised positionally, before any
subcommand argument that could contain a user-controlled `-g`.

## 15.32 Put the resolved package manager on `PATH` — [required]

> Driven by **#412**, filed as a documentation issue but containing a real defect:
> `corepack pnpm exec …` does not place the corepack-resolved pnpm on `PATH` for nested
> processes, so a script that shells out to `pnpm` gets a different one — or nothing.
> The behaviour differs from Yarn only because Yarn adds itself to `PATH` independently.
> A maintainer's response was *"that's something you should bring up to pnpm"*.

Correctness here must not depend on each package manager volunteering to fix it.

**Required:** before handing over (§08.7), prepend a directory containing the resolved
package manager's binaries to `PATH` in the child environment. §14.15's self-dispatching
shims make this cheap: the directory is the shim directory, and any nested invocation
re-enters the tool and resolves identically. Native package managers (§15.28) get the
directory holding their extracted binary.

The prepended entry MUST be the only modification to `PATH`, and MUST NOT leak into the
tool's own process.

## 15.33 No stale or shadowed defaults — [required, bug]

> Driven by **#812** (`yarn create` freshly after install downloads Yarn Classic
> 1.22.22, unsupported since 2020; corepack's author: *"Yep I agree, time to bump the
> default to Modern"* — not yet shipped) and **#202** (a confirmed operator-precedence
> defect in the transparent-command fallback, acknowledged by two maintainers, no fix
> landed).

Verified in source, `Engine.executePackageManagerRequest`:

```js
const fallbackReference = isTransparentCommand
  ? definition.transparent.default ?? defaultVersion
  : defaultVersion;
```

`transparent.default` is a **compile-time constant** that unconditionally outranks
`defaultVersion` — which is the user's own last-known-good (§04.5). So a user who ran
`corepack install -g yarn@4.9.0` still gets the table's pinned `4.14.1` for
`yarn dlx`, and there is no way to override it.

**Required:**

* `transparent.default` is a **floor, not an override**. Use the last-known-good
  version when one exists and is at least as new; fall back to `transparent.default`
  only when there is no recorded default, or the recorded one is older.
  This preserves the behaviour §02.5 documents (a bare directory gets a modern Yarn for
  `yarn dlx`) while respecting an explicit user choice.
* Embedded `default` values MUST track the current supported major of each package
  manager, refreshed by the job in §16.9. A default pointing at a release unsupported
  for six years is a maintenance failure, not a compatibility guarantee.

## 15.34 Hold the scope line — [required] ⬛

> Corepack's maintainers have repeatedly and, in this spec's judgement, **correctly**
> declined to expand scope. These rulings are adopted deliberately, not inherited by
> omission.

| Request | Ruling | This spec |
|---|---|---|
| **#57** `corepack run <script>` (26 comments, 9👍) | Out of scope — *"each package manager has different implementations of run… which Corepack couldn't replicate without becoming a package manager"* | **Adopted.** The semantic divergence is real (Yarn resolves scripts workspace-wide, npm does not). `node --run` and `$npm_execpath` are the right mechanisms. |
| **#352** `corepack manager <verb>` passthrough (14 comments) | Out of scope — *"its only purpose is to change how they are installed"* | **Adopted.** Userland wrappers are the right home. |
| **#465** pin duplicated into the package manager's lockfile | Belongs in the package manager | **Adopted**, and §15.23's `.jup.lock` serves the underlying Docker-layer-caching need without touching another tool's file format. |
| **#683** extend pinning to monorepo task runners | Same boundary | **Adopted.** |

One narrower request is accepted:

> **#505** *"`corepack project install`"* (9👍) — a single command meaning "install
> dependencies with whichever package manager this project declares." A maintainer was
> sympathetic, noting `corepack up` already runs `<pm> install` as a side effect
> (§09.5), so the mechanism exists. PR **#551** is open and unmerged.

**Required:** `jup install --project` (aliased `jup project install`) resolves
the project's package manager and runs its `commands.use` argv. It adds no new
mechanism — §09.5 already does exactly this — and unlike `add` or `remove`, `install`
has no meaningfully divergent semantics across the three package managers. Nothing
beyond `install` is in scope.

## 15.35 Sundry required behaviours

Smaller items, each traceable to an open issue.

| # | Issue | Requirement |
|---|---|---|
| a | **#298** (accepted by a maintainer, never shipped) | A bare name is valid wherever a spec is accepted: `jup use yarn` means `yarn@latest`. §03.4 already yields range `*` for a bare name; §15.24 makes `*` resolve via the `latest` dist-tag. |
| b | **#833** (5👍, PR #851 open) | Binary names come **only** from the table (§02.4). Adding pnpm 11's `pn`/`pnx` aliases MUST be a data-only change, and §15.21 forbids hardcoding names elsewhere. |
| c | **#624** (5👍; a contributor's fix PR went unreviewed) | Deprecated commands MUST print a migration line naming the replacement and still work: `'jup prepare' is deprecated; use 'jup pack' instead.` Never silently hide a command. |
| d | **#682**, **#402** | `COREPACK_SPEC_FILE` names a file supplying `packageManager`/`devEngines.packageManager` for a project whose manifest cannot be edited (vendored trees). It overrides the manifest; it is **not** env-file-eligible. |
| e | **#850** | `COREPACK_MINIMUM_RELEASE_AGE` (hours) filters candidates younger than the given age out of *implicit* resolution, matching the `minimumReleaseAge` gate npm and pnpm now ship. An explicitly pinned exact version is never filtered. |
| f | **#629** (9👍, zero maintainer response) | The tool MUST report its own version in `info` (§15.30) and support a self-version constraint. Its own version drift is otherwise an unmanaged instance of the problem it exists to solve. |
| g | **#316** | `use`/`up` MUST be idempotent on an already-pinned value. Corepack's current code strips an existing build suffix before re-appending, and §13 test #109 covers malformed input, but the historically-reported double-append (`+sha256…+sha256…`) MUST have a dedicated regression test. |
| h | **#166**, **#686** | Enablement state MUST NOT depend on how the tool was installed, and MUST be reportable via `info`. |
| i | **#496** | The project-mismatch error MUST NOT mask an unrelated failure in the invoked command. Check identity **before** executing, never by interpreting the package manager's own exit status. |
| j | **#204** | A **nonexistent exact version** MUST be reported as such. §04.1 step 5 returns an exact version unverified, so the first sign of trouble is a bare `Server answered with HTTP 404` naming a tarball URL. Implementations MUST map a 404 on an artifact download to: `<name>@<version> does not exist in <registry>. Run 'jup info' to see the resolved spec and where it came from.` |
| k | **#424** | A `packageManager` field in `$HOME/package.json` (or any ancestor of it) silently governs *every* directory — a repeated, hard-to-diagnose confusion in the thread. When the governing manifest resolves to the home directory or above, the tool MUST append to §12.5's error: `(this manifest is outside any project — a stray "packageManager" field there affects every directory)`. |
| l | **#679** | Commands that mutate state MUST report what they did. `cache clean` currently prints nothing (§09.7); it MUST print `Removed <n> cached version(s) from <path>` (or `Nothing to remove`). `DEBUG=jup` (and `DEBUG=corepack`, §14.24) is a debugging aid, not a substitute for command output. |

## 15.36 A note on corepack's trajectory

Not a requirement — context that affects how much of corepack's behaviour is worth
treating as a fixed contract.

* Node.js stopped bundling corepack in **Node 25** (TSC vote, 2025-03-19). Node 24
  keeps it until 2028.
* On **#687** (*"Release corepack@1.0.0"*, 8👍), corepack's author wrote: *"I don't
  personally see a benefit to bringing it to 1.0… I just don't have bandwidth to spend
  on tasks that don't directly matter to Yarn."*
* In the same thread, **pnpm's maintainer** wrote: *"IMO corepack has lost relevance to
  both Yarn and pnpm. At this point it causes more problems for us than it solves. Feel
  free to remove pnpm support from corepack."*
* **#401** (*"Need goals/use cases"*) remains open with no goals document; `DESIGN.md`
  is stale.

Two consequences for a re-implementation:

1. **The behavioural contract in §01–§13 is worth matching** — a large installed base
   depends on it, and §13's matrix is derived from a real, thorough test suite.
2. **Corepack's open-issue backlog should not be read as a roadmap.** Much of it is
   unresolved for reasons of bandwidth and governance rather than difficulty: #95
   (121👍), #295 (146👍), and #71 (34👍) are each years old with maintainers explicitly
   declining ownership. That is precisely why §15 exists, and why several of its
   requirements are marked ⬛.

Per §15.21 and §15.28, secure explicit agreement from each package manager's
maintainers before shipping support for it. pnpm's disavowal above and Bun's reported
refusal are both consent problems, not technical ones, and neither is solved by a
better implementation.

---

## 15.37 New environment variables

Introduced by this section. All follow §11.6's precedence.

| Variable | Values | Effect | Env file |
|---|---|---|---|
| `COREPACK_REGISTRY_<NAME>` | URL | Per-package-manager registry/download origin (§15.2) | yes |
| `COREPACK_CAFILE` | path | PEM bundle for TLS verification (§15.4) | **no** |
| `COREPACK_STRICT_SSL` | `0` | Disable TLS verification, with a warning (§15.4) | **no** |
| `COREPACK_NETWORK_TIMEOUT` | ms | Connect and idle timeout, default 30000 (§15.5) | yes |
| `COREPACK_NETWORK_RETRIES` | integer | Retry attempts, default 3, `0` disables (§15.5) | yes |
| `COREPACK_REQUIRE_SIGNATURES` | `1` | Turn §15.7's soft-fail into a hard failure | yes |
| `COREPACK_ALLOW_UNVERIFIED` | `1` | Permit an artifact with no verification tier (§15.11) | **no** |
| `COREPACK_SHIM_DIRECTORY` | path | Default shim install directory (§15.13) | yes |
| `COREPACK_FROZEN_LOCKFILE` | `1` | Refuse to write/refresh `.jup.lock` (§15.23) | yes |
| `COREPACK_ENABLE_PRERELEASES` | `1` | Allow implicit resolution to select a prerelease (§15.24) | yes |
| `COREPACK_SPEC_FILE` | path | External file supplying the project spec (§15.35d) | **no** |
| `COREPACK_MINIMUM_RELEASE_AGE` | hours | Minimum publish age for implicit resolution (§15.35e) | yes |

## 15.38 Additional conformance tests

Appended to §13. All are ⊕ (they would fail against corepack today).

| # | Setup | Expected |
|---|---|---|
| 148 | User `.npmrc` sets `registry=` | that registry is used; `COREPACK_NPM_REGISTRY` still overrides it (§15.1) |
| 149 | Project `.npmrc` sets `//host/:_authToken` | **ignored**; user-level `.npmrc` auth is honoured (§15.1) |
| 150 | `.npmrc` sets `@yarnpkg:registry` | Yarn Berry's `@yarnpkg/cli-dist` fetch uses it (§15.1) |
| 151 | `COREPACK_REGISTRY_YARN` set, `COREPACK_NPM_REGISTRY` unset | Yarn mirrors; npm and pnpm still use the default (§15.2) |
| 152 | Override registry differing only by trailing slash or host case | rewritten correctly; no doubled path (§15.3) |
| 153 | Registry presents a certificate from an unknown CA | the CA-specific message, naming `JUP_CAFILE` (§15.4) |
| 154 | Registry returns 503 twice then 200 | succeeds after retries; `COREPACK_NETWORK_RETRIES=0` fails immediately (§15.5) |
| 155 | Registry stalls past `COREPACK_NETWORK_TIMEOUT` | times out with a timeout-specific message (§15.5) |
| 156 | `HTTPS_PROXY` set, no other opt-in flag | request is proxied (§15.6, §14.8) |
| 157 | `NO_PROXY=.internal` with a matching host | bypasses the proxy (§15.6) |
| 158 | Metadata with no `dist` key | the no-`dist` message, **not** a crash (§15.7) |
| 159 | Metadata with `dist` but no `signatures`, hash pinned | succeeds with one warning (§15.7) |
| 160 | Same, no hash pinned, `COREPACK_REQUIRE_SIGNATURES=1` | refused (§15.7) |
| 161 | `signatures` absent on the version endpoint, present at package root | verifies via the fallback (§15.8) |
| 162 | Signature whose keyid matches no embedded key | keys refreshed once, verification retried, then succeeds (§15.9) |
| 163 | Same with `COREPACK_ENABLE_NETWORK=0` or pinned `COREPACK_INTEGRITY_KEYS` | no refresh attempted (§15.9) |
| 164 | Warm cache hit | **no** key-refresh request (§15.9, §01.3) |
| 165 | Trust store keyed by a non-default registry origin | that origin's keys are used (§15.10) |
| 166 | Project `.jup.env` supplying keys for a custom origin | ignored (§15.10, §14.5) |
| 167 | Yarn Berry from `repo.yarnpkg.com`, no hash pinned | refused unless `COREPACK_ALLOW_UNVERIFIED=1` (§15.11) |
| 168 | Yarn Berry via a custom npm registry, no hash | tarball-stream digest verified against signed `integrity` (§15.11, §14.10) |
| 169 | `devEngines.packageManager.integrity` present, `packageManager` clean semver | integrity enforced (§15.12) |
| 170 | `enable` where the tool's directory is read-only | falls back to the per-user directory and says so (§15.13) |
| 171 | `LOCALAPPDATA` set on Linux | **ignored** for store resolution (§15.13) |
| 172 | Shim directory not on `PATH` | prints the exact line to add; exit 0 (§15.13) |
| 173 | Shim pointing at a nonexistent target | `enable` replaces it; `disable` removes it (§15.14) |
| 174 | `enable --force` over a real binary, then `disable` | the original is restored (§15.15) |
| 175 | `enable` with no arguments | npm shims are created; `--exclude npm` omits them (§15.16) |
| 176 | A tarball install, banded or not | `bin` read from the verified package, containment-checked; the table is the fallback (§15.17, §14.13) |
| 177 | `cache clean` then `cache clean --all` | defaults survive the first, are removed by the second (§15.18) |
| 178 | Uncached version with `COREPACK_ENABLE_NETWORK=0` | the error names the seeding command (§15.19) |
| 179 | `cache list --json` | installed pairs and recorded defaults (§15.19) |
| 180 | `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` via a shim entry point | fully silent (§15.20) |
| 181 | `packageManager: "pnpm@^11.0.0"` | resolves; `.jup.lock` records version + integrity (§15.23) |
| 182 | Second run with that lockfile present | **no** network request (§15.23, §01.3) |
| 183 | Range with no lockfile and `COREPACK_FROZEN_LOCKFILE=1` | refused (§15.23) |
| 184 | Registry publishes `11.0.0-dev.1005` above stable `10.x`; `jup use pnpm` | resolves to the **stable** release (§15.24) |
| 185 | Same with `COREPACK_ENABLE_PRERELEASES=1` | resolves to the prerelease (§15.24) |
| 186 | Explicitly pinned prerelease | still resolves and matches its range band (§15.24, §14.2) |
| 187 | Nested manifest with only `devEngines.packageManager`, parent pins a different one | the **nested** spec wins (§15.25) |
| 188 | Manifest with `packageManager: null` | walk stops; parse error, not "absent" (§15.25) |
| 189 | `use` on a devEngines-only project | `devEngines` is updated; no `packageManager` is created (§15.26) |
| 190 | `use` where both fields exist | both updated; result re-reads cleanly (§15.26) |
| 191 | `use` in a nested dir under a `workspaces` root | the workspace root is updated, and its path is printed (§15.27) |
| 192 | Same with `--here` | the nested manifest is updated (§15.27) |
| 193 | Table entry with `{platform}`/`{arch}` and `"exec": "native"` | correct artifact fetched; executed directly, no JS runtime consulted (§15.28) |
| 194 | Native artifact extraction | executable bit preserved (§15.28, §07.4) |
| 195 | `enable` where another manager shadows the shim on `PATH` | warns naming the winner; exit 0 (§15.29) |
| 196 | `jup info --json` with an invalid project spec | succeeds, reports why it is invalid, makes no network request (§15.30) |
| 197 | `npm install -g <pkg>` inside a yarn-pinned project | permitted (§15.31) |
| 198 | A nested script invoking `pnpm` under `jup pnpm exec` | resolves to the same pnpm (§15.32) |
| 199 | `install -g yarn@4.9.0`, then `yarn dlx` in a bare directory | uses `4.9.0`, not the table's `transparent.default` (§15.33) |
| 200 | No recorded default, `yarn dlx` in a bare directory | uses `transparent.default` (§15.33) |
| 201 | `jup prepare` | works, and prints the migration line (§15.35c) |
| 202 | `use` run twice on an already-pinned value | idempotent; no doubled build suffix (§15.35g) |
| 203 | `COREPACK_MINIMUM_RELEASE_AGE` set, newest release younger than it | an older release is chosen; an exact pin is unaffected (§15.35e) |
| 204 | `packageManager` pins an exact version that was never published | error names the version as nonexistent, not a bare HTTP 404 (§15.35j) |
| 205 | `packageManager` present in `$HOME/package.json`, run from an unrelated directory | the mismatch error flags the manifest as outside any project (§15.35k) |
| 206 | `cache clean` with, then without, cached versions | reports the count removed, then `Nothing to remove` (§15.35l) |
| 207 | `#440`: a store directory symlinked to a local checkout | resolves and runs, so a package manager can be debugged in place |
| 208 | Only matching key expired **and** its signature does not verify | exit 1, `The package was signed with an expired key (<keyid>, expired <expires>)` — leniency is not a bypass (§06.5, §14.4) |
| 209 | A CA bundle is configured and the runtime's default trust store does not reflect it afterwards | fails naming the setting that was ignored, not a bare certificate error (§15.4) |
| 210 | `--version` and `info` in a built package | the packed version, with no manifest read; never a plausible-looking placeholder (§09.9, §15.30f) |
| 211 | A shim run under `node --preserve-symlinks-main`, or on a runtime that resolves from the link | runs; the stub resolves its entry against its own realpath (§14.25) |
| 212 | `packageManager: "bun@<v>"` | the host's `@oven/bun-<target>` tarball is fetched and executed directly; the launcher package is never downloaded (§15.21, §15.28) |
| 213 | The same, verified under `COREPACK_REQUIRE_SIGNATURES=1` | passes — the signature checked is the *artifact* package's, not the launcher's (§15.28) |
| 214 | `bunx <args>` | reaches the same cached file as `bun`, under `argv[0]` = `bunx` (§15.28) |
| 215 | `packageManager: "deno@<v>"` | runs; the marker's `bin` names the package-root executable, from the table, because the artifact package declares none (§07.7, §15.28) |
| 216 | `jup use bun@<v>` | `packageManager` holds a **bare** version; no digest is written to a committed file (§15.28) |
| 217 | `packageManager: "bun@^1.4.0"` with a `.jup.lock` recorded on another host | resolves offline; this host's digest is added and the other host's is left intact (§15.23, §15.28) |
| 218 | `enable` with no names, then `enable bun`, then `disable` with no names | no bun/deno shim first; both after naming bun; none after the bare disable (§10.5, §15.21) |
| 219 | A version whose band declares no artifact for this host (e.g. `bun@1.2.0` on Windows arm64) | fails before any request, naming the host and what that version ships for (§12, §15.28) |
| 220 | `deno` in a directory with no project spec, `JUP_DEFAULT_TO_LATEST=1` | runs; no digest is pinned from the launcher package, and the recorded default is a bare version (§04.5, §15.28) |
| 221 | A `lastKnownGood.json` whose per-host entry carries a digest, as an earlier build wrote | the suffix is dropped on read and the file rewritten; the run makes no network request, and a non-per-host entry's digest is untouched (§04.5, §15.28) |
| 222 | `packageManager: "aube@<v>"` | the host's `@endevco/aube-<host>` tarball is fetched and executed directly; the launcher is never downloaded, and the marker's `bin` comes from the artifact package's own declaration (§07.7, §15.21) |
| 223 | `aubr <script>` and `aubx <args>` | both reach the same cached install, each under its own `argv[0]` (§15.21, §15.28) |
| 224 | `enable` with no names | `aube`, `aubr` and `aubx` are installed while `bun` and `deno` are not — the default set is decided by `shimByDefault`, not by how recent the entry is (§10.5, §15.21) |
| 225 | A Linux host whose glibc loader is absent and whose musl loader is present | the host names itself `<platform>-<arch>-musl`; the musl artifact is requested, and an entry that publishes no musl build (deno) fails before any request naming that host (§15.28) |
| 226 | `aube` on `darwin-x64`, a host it has never published for | fails before any request, naming the host and the complete published set — the case a `targets` map that is otherwise an identity exists for (§12, §15.21) |
| 227 | `packageManager: "nub@<v>"`, then `nubx <args>` | the host's `@nubjs/nub-<host>` tarball is fetched and run; the launcher is never downloaded, and both names resolve to the single executable the artifact ships, from the table, because that package declares no `bin` (§07.7, §15.21) |
| 228 | `enable` with no names, then `enable nub`, then `disable` with no names | no `nub`/`nubx` shim first, both after naming nub, none after the bare disable — a package manager stays out of the default set because its name also means something outside a project (§10.5, §15.21) |
| 229 | A native artifact whose tarball ships its entry point at mode 0644 (as `@nubjs/nub-<host>` does) | the cached entry point is executable and the run succeeds; nothing else in the archive gains the bit, and a `bin` path naming a non-program keeps its mode and still reports `cannotExecute` (§07.4 rule 6, §15.28) |
| 230 | `jup node@22 --version` in a directory with no project | the host's `node-<target>` tarball is fetched and executed directly; the `node` launcher package is never downloaded (§15.39, §15.28) |
| 231 | `jup node --version` in a project pinning `packageManager: "pnpm@…"` | runs node; the project's package-manager pin is neither consulted nor an error, and `jup pnpm --version` in the same directory is unaffected (§03.5, §15.39) |
| 232 | `devEngines.runtime: {name: "node", version: "22.x"}` and `packageManager: "pnpm@…"` in one manifest | `node` resolves within `22.x`, `pnpm` resolves from the pin; neither field constrains the other (§03.3, §15.39) |
| 233 | `packageManager: "node@22.23.2"`, then a package-manager request in that project | refused with §12.12's runtime-in-`packageManager` message, naming `devEngines.runtime`; no network request. A *runtime* request there reads `devEngines.runtime`, finds nothing and falls back — the stray field never becomes the runtime's pin (§03.4, §15.39) |
| 234 | `jup use node@22`, on a manifest with no `devEngines`, with one that has only `packageManager`, and with a `runtime` member naming another tool under `onFail: "warn"` | `devEngines.runtime` is written — created at the surrounding nesting where absent, name corrected where it disagreed — and its path printed; no top-level `packageManager` is created, an existing `devEngines.packageManager` is untouched, and no install command runs (§03.7, §09.5, §15.39) |
| 235 | `jup enable` with no names, then `jup enable node` | no `node` shim first, one after — a runtime is never in the default set (§10.5, §15.39) |
| 236 | `jup node@22` on a musl Linux host, and on `linux-armv7l` | `unsupportedTarget` naming `linux-x64-musl` in the first, `unsupportedArch` in the second; both before any request (§02.5, §15.28) |
| 237 | `.nvmrc` reading `v22.23.2` beside a manifest pinning `packageManager: "pnpm@…"` and no `devEngines.runtime` | `node` resolves within it and installs per-host as usual; `pnpm` in the same directory is unaffected; neither file is written (§15.40) |
| 238 | `.nvmrc` in a parent and another in `packages/app` reading `22.x`, with comments, blank lines and a `key=value` line | the nearer file speaks, read through the comments and the setting; its `.jup.lock` is written beside it, not at the root (§15.40, §15.23) |
| 239 | `.nvmrc` and `devEngines.runtime` naming different versions | `devEngines.runtime` wins, with no warning and no comparison between them (§15.40) |
| 240 | `.nvmrc` reading `lts/*`, `lts/<codename>`, `system`, `iojs` or `default`; then one reading `node` or `stable` | the first five are refused, naming the word and `devEngines.runtime`, before any request; the last two resolve to the `latest` dist-tag (§15.40) |
| 241 | `.nvmrc` carrying two versions, only comments, or nothing | `Invalid <path>`; no request, and no fall back to the compiled-in default (§15.40) |
| 242 | `.nvmrc` in a directory with no `package.json` anywhere above it | it still speaks; no manifest is created and auto-pin does not fire (§15.40) |
| 243 | `.nvmrc` present with `JUP_ENABLE_PROJECT_SPEC=0`, then `jup use node@22` in that same directory | not read in either case; `use` writes `devEngines.runtime` and leaves the file untouched (§15.40, §11.1, §15.27) |

## 15.39 Tools, not only package managers — [required]

> Driven by the same thread as §15.28 and §15.21. Every request for bun, deno or a
> runtime arrives as "can it manage X too?", and the answers so far have been decided
> one entry at a time. §15.28 built the machinery that makes a non-JavaScript,
> per-host tool an ordinary entry; once that exists, "package manager" stops being a
> property of the *pipeline* and is only a property of the *manifest field* an entry
> is declared in.

**Required:**

* §02.3 gains `kind: "package-manager" | "runtime"`, absent meaning
  `"package-manager"`. It is the **only** discriminator, and it decides exactly four
  things, all of them in §03 and §10:
  1. which manifest field is the project spec — `packageManager` /
     `devEngines.packageManager`, or `devEngines.runtime` (§03.3);
  2. whether the name is legal in `packageManager` (§03.4) — it is not, for a
     runtime, and the message is in §12.12;
  3. which spec §03.5 reconciles against, and therefore that its name mismatch
     cannot arise *across* kinds: a project's package-manager pin is never a
     reason to refuse a runtime. Within a kind the rule is unchanged;
  4. that a runtime MUST set `shimByDefault: false` (§10.5).
* Nothing else may branch on `kind`. §04 resolution, §05 registry access, §06
  integrity, §07 the store, and §08 execution are one path over both kinds. A
  requirement that reads "the package manager" in those files reads "the tool".
* `node` ships as the first `kind: "runtime"` entry (§02.5). Adding it is a data-only
  change in §15.21's sense: it uses §15.28's launcher/artifact split, `{target}` map,
  `{exe}` placeholder and `exec: "native"` unchanged.
* §01.7's *"MUST NOT manage Node.js versions"* is **superseded**. The line that ruling
  protected — a closed, compiled-in table changed only by a release, with no plugin
  API and no runtime extensibility — is unchanged and restated there.

### What this does not open

`kind` is a two-value enum on purpose, and the pressure will be to grow it.

* It is **not** a general version manager. `jup node@22` runs the `node` table entry;
  there is no mechanism to manage a tool the table does not ship, and §15.21's
  data-only rule is what keeps adding one a release rather than a config file.
* `devEngines` also standardises `os`, `cpu` and `libc`. jup reads none of them.
  Reading `libc` in particular would *look* like a fit — §15.28 already computes the
  host's libc — but that computation answers "which artifact do I fetch", not "may
  this project be built here", and the second question belongs to the package manager
  running the install.
* A runtime does not become a place to hang §15.34's declined requests. `jup run`
  is still out of scope, and `node --run` is still the mechanism.
* The tool still installs no project dependencies and executes no lifecycle scripts.
  A runtime entry is one more artifact in the store, not a bootstrap environment.

### On consent, again

§15.21's requirement is unchanged and this section does not satisfy it. `node` is the
case where it reads oddly, because the launcher package `node` on npm is a community
package rather than a Node.js project artifact — so the maintainer to ask is that
package's, and what they would be agreeing to is jup fetching the same per-host
packages their own `preinstall` fetches, without running it. That is a smaller ask
than bun's and a real one all the same.

## 15.40 Read the version file the ecosystem already writes — [required]

> The other half of §15.39. A runtime got a field of its own, `devEngines.runtime`,
> and the number of repositories that have written one is close to zero. The number
> that carry an `.nvmrc` is very large, it says exactly the same thing, and it is
> already obeyed by a program most of those repositories have installed. A tool that
> can run node and refuses to read the file the project wrote to say which node has
> chosen purity over being useful.

`.nvmrc` is nvm's, and the interoperation is deliberately one-directional and small:
jup **reads** it, never writes it, and does not otherwise touch a machine's version
manager (§10.5).

**Required:**

* §02.3 gains an optional per-entry `versionFile: {path, format}`. `node` declares
  `{path: ".nvmrc", format: "nvm"}` and no other entry declares anything. It is
  **not** a property of `kind`: a runtime whose ecosystem has no such convention
  declares none, and a package manager whose ecosystem grows one may declare it.
* Adding a second one MUST be a data-only change in §15.21's sense. The file name
  lives in the table and nowhere else; §03's walk MUST NOT know what it is looking
  for.
* §03.1 reads it in the directories it walks anyway, keeps the **nearest**, and does
  not let it stop the walk. It MUST NOT be looked for on a mutating walk (§15.27),
  nor wherever the manifest itself would not be read (§11.1).
* It is consulted **only** on `NoSpec` and `NoProject` for the requested tool, so the
  precedence is: the `devEngines` member, then the version file, then §03.5's
  fallback. A `Found` is never displaced.
* When it speaks, the result is a `Found` targeting the version file, carrying no
  `devEngines` declaration and no pin — so §03.6's auto-pin does not fire, and
  §15.23's `up` treats it as it treats a synthesised spec. A range declared in it resolves through
  `.jup.lock` as any range does, written beside the version file.
* Parsing is lazy, and both failure modes — a file carrying no single version, and
  one carrying a word that is not a version — are errors (§12.12). Neither may fall
  back to the compiled-in default.
* The `"nvm"` grammar and the range it yields are specified in §03.1. Two facts are
  requirements rather than incidental: the numeric forms pass through **unchanged**
  (§04.2's partial-version grammar already accepts them, `v` prefix included), and
  `node` / `stable` become the `latest` dist-tag.
* Nothing past §03 may learn that a range came from a version file. §04–§08 see a
  descriptor, as they do for a manifest range.

### Why the LTS aliases are refused

They are the ones people will miss, and they are refused on the data rather than on
principle. The `node` launcher package publishes the dist-tags `latest` and
`v4-lts` … `v20-lts`; the LTS series tags **stop there**, with no `v22-lts` and no
`v24-lts`. So:

* `lts/*` — "the newest LTS" — has nothing on the npm side to resolve against at all;
* `lts/<codename>` would need a compiled-in codename-to-major table (`iron` → 20,
  `jod` → 22, …) that grows by an entry every LTS line and is wrong until the next
  release ships. That is precisely the shape §15.21 exists to refuse, and a table jup
  cannot keep correct is worse than an error that says so.

Half-supporting them — answering `lts/argon` and erroring on `lts/*` — would be the
worst of both, so all the LTS forms take the same message, which names the word and
points at `devEngines.runtime`. That field can express what the alias meant.

### What this does not open

* **jup does not adopt another manager's installs.** `$NVM_DIR/versions/node/<v>/bin/node`
  stays untouched. Everything jup executes arrives through §06's digest and registry
  signature and §07's atomic install; an nvm version directory came from nodejs.org
  by nvm's own path, or from a source compile, and running those bytes would silently
  bypass the one thing §06 exists to do. They are not even interchangeable — nvm
  installs the nodejs.org tarball, and the `node` entry installs the per-host npm
  package (§02.5) — and §07's single-`stat` fast path would have to grow a second
  lookup root to find them.
* **It is not a version-manager compatibility layer.** No `nvm use`, no shell hook, no
  profile edit, no `$NVM_DIR/alias` resolution, no `.nvmrc` **writing**. The one
  behaviour required here is reading a file.
* **It is not a general "read every version file" mechanism.** `versionFile` is one
  optional table field with one declared instance. A second one — `.node-version`,
  `.tool-versions` — is a release, and is a judgement about that file's grammar, not
  a config option.
* **It does not give the version file a say over the manifest.** A project that
  disagrees with its own `.nvmrc` is answered by `devEngines.runtime`, which is the
  field jup writes and the only one it writes.
