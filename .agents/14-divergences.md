# 14 — Deliberate Divergences from Corepack

Each entry: what corepack does, why this spec departs, and what a conforming
implementation must do instead. Numbered to match the `§14.n` references throughout.

Categories: **[perf]** serves the fast/small goals · **[sec]** closes a security hole ·
**[correct]** fixes a defect · **[native]** required because the implementation is not
a Node module.

These divergences come from **reading corepack's code**. A second set, derived from
its **open issue tracker**, is specified in [§15](./15-gaps.md) and is equally
normative. Where the two overlap, §15 refines §14.

---

## 14.1 Exact-version fast path — [perf]

**Corepack:** `resolveDescriptor` always calls `findInstalledVersion`, which `opendir`s
`<store>/<name>/` and parses every entry name as semver, even when the descriptor is
already an exact version and the answer is trivially itself.

**Required:** when the descriptor's range is a valid exact semver version, skip the
directory scan and go straight to `stat(<store>/<name>/<version>/.corepack)`. This is
the single hottest path in the tool — the overwhelming majority of real invocations
are an exactly-pinned `packageManager` field — and it turns an O(installed versions)
directory walk plus N semver parses into one `stat`.

Keep the directory scan for genuine ranges.

## 14.2 Prerelease consistency in the cache probe — [correct]

**Corepack:** `findInstalledVersion` uses strict `range.test(name)`, while every other
range comparison in the codebase uses `satisfiesWithPrereleases`. A directory named
`4.0.0-rc.1` therefore does not satisfy a `>=2.0.0` probe.

**Consequence:** a project pinned to a prerelease that is resolved through a range
re-queries the registry on every single invocation, and works offline only by
accident (the exact-version path in step 5 saves it).

**Required:** use `satisfiesWithPrereleases` in the cache probe, matching the rest of
the resolution pipeline.

## 14.3 Atomic last-known-good writes — [correct]

**Corepack:** `lastKnownGood.json` is written with a plain non-atomic write. Two
concurrent processes can interleave and leave a truncated file. Because reads
tolerate corruption by returning `{}`, the failure is silent — the global default is
simply lost.

**Required:** write to a temp file in the same directory and rename over the target.
Keep the forgiving read semantics; they are correct and they make the recovery
invisible.

## 14.4 Honour key expiry — [sec]

**Corepack:** the trust store carries an `expires` field on every key and **never reads
it**. The bundled table currently ships a key that expired on 2025-01-29.

**Required:** exclude expired keys from selection; if the only matching key is
expired, fail with a message naming the key and its expiry (§12.12). Because a
skewed system clock could then reject valid keys, an implementation SHOULD accept an
otherwise-valid signature from an expired key with a loud warning rather than hard
failing — but MUST NOT do so silently. Ship only unexpired keys.

## 14.5 Restrict what `.corepack.env` may set — [sec]

**Corepack:** any `COREPACK_`-prefixed variable can be set from a project-local
`.corepack.env`, except `COREPACK_ENV_FILE` and `COREPACK_ENABLE_DOWNLOAD_PROMPT`.
That includes `COREPACK_INTEGRITY_KEYS`.

**Consequence:** `cd` into a cloned repository and run `yarn`, and a committed
`.corepack.env` containing `COREPACK_INTEGRITY_KEYS=0` has already disabled signature
verification before anything is downloaded. `COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=1`
lets that same file point `packageManager` at an arbitrary host. `COREPACK_NPM_TOKEN`
lets it exfiltrate a token by pairing with a hostile `COREPACK_NPM_REGISTRY`.

**Required:** the env file may set only the *behavioural* variables — the eligible
set is exactly the ones marked "yes" in §11. Security-relevant variables
(`COREPACK_INTEGRITY_KEYS`, `COREPACK_ENABLE_UNSAFE_CUSTOM_URLS`, `COREPACK_NPM_TOKEN`,
`COREPACK_NPM_USERNAME`, `COREPACK_NPM_PASSWORD`) are honoured **only** from the real
process environment. When an env file attempts to set one, ignore it and warn once:

```
! Ignoring <NAME> from <path>: this variable can only be set in the environment
```

## 14.6 One credential rule — [sec]

**Corepack:** two independent auth paths that disagree. Metadata requests use a
presence test and are **not** origin-scoped, so `COREPACK_NPM_USERNAME`/`PASSWORD` are
sent to whatever host the request targets. Download requests use a truthiness test
where either half alone produces a header, and a Bearer token silently overwrites
credentials that came from the URL's own userinfo.

**Required:** one function, used by both paths (§05.4):

```
credentialsFor(url):
    if url has userinfo            → Basic from userinfo, strip it from the URL
    else if url.origin != registryOrigin → none
    else if COREPACK_NPM_TOKEN is present → Bearer
    else if USERNAME and PASSWORD are both present → Basic
    else                                  → none
```

Credentials never leave the configured registry's origin, and the `authorization`
header is dropped on any cross-origin redirect.

## 14.7 Preserve the BOM — [correct]

**Corepack:** `readPackageJson` strips a UTF-8 BOM for parsing and never re-emits it,
so `corepack use` silently removes the BOM from a manifest that had one.

**Required:** record whether the original had a BOM and re-emit it. Indentation and
line endings are already preserved; the BOM is the one remaining formatting loss.

## 14.8 Proxies without a second opt-in — [correct]

**Corepack:** contains no proxy code at all and depends on the host runtime's
env-proxy support, which currently requires `NODE_USE_ENV_PROXY=1`. Setting
`HTTPS_PROXY` alone does nothing, which is the opposite of every user's expectation
and a recurring source of "corepack doesn't work behind our proxy" reports.

**Required:** implement `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` directly
with standard `proxy-from-env` semantics, honoured without any additional flag
(§05.1). A zero-dependency implementation has to write the HTTP client anyway, so
this costs a `CONNECT` handshake and a suffix-match function.

## 14.9 Validate the tarball URL — [sec]

**Corepack:** accepts any `dist.tarball` value that `startsWith("http")` — which also
matches `httpfoo://`, and imposes no relationship between the tarball's host and the
configured registry. Corepack has already shipped one bug in this area ("incorrect
registry origin check", 0.34.1).

**Required:** the URL must parse; its scheme must be `https:` (or `http:` when the
configured registry itself is `http:`); and its host must match the configured
registry's host unless the user opts in. A hostile or compromised mirror must not be
able to redirect the download to an arbitrary server.

## 14.10 Verify single-file extractions — [sec]

**Corepack:** when `registry.bin` is set — the `@yarnpkg/cli-dist` path taken whenever
`COREPACK_NPM_REGISTRY` is configured — the guard is
`if (registry.type === "npm" && !registry.bin && !shouldSkipIntegrityCheck())`. The
`!registry.bin` clause means **no signature check and no hash check** happen at all
unless the user pinned a hash. The reason is mechanical: the tool hashes the extracted
single file, which cannot be compared against the whole-tarball `dist.integrity`.

**Consequence:** anyone running Yarn Berry through a corporate npm mirror is getting
an unverified binary.

**Required:** hash the **tarball stream** as it arrives, in parallel with the filtered
extraction — the download is already streaming and the extra digest is free. Compare
that against the signed `dist.integrity` exactly as the full-extraction path does.
Continue to hash the extracted file separately when the user pinned a hash, since
that is the artifact their pin refers to.

## 14.11 Constant-time digest comparison and algorithm validation — [sec]

**Corepack:** compares hex digests with `!==`, and passes the algorithm name straight
to the host's `createHash`, which throws an opaque error on an unknown name.

**Required:** constant-time comparison; an explicit supported-algorithm list
(minimum `sha1`, `sha224`, `sha256`, `sha384`, `sha512`); a clear error for anything
else (§12.12); and a warning when a pin uses `sha1` or `md5`.

## 14.12 Parse SRI properly — [correct/sec]

**Corepack:** derives the expected hash with `integrity.slice("sha512-".length)`,
hard-assuming the SRI algorithm is `sha512`. A registry returning `sha256-…` yields a
silently wrong expected digest.

**Required:** parse `<algo>-<base64>`, use the named algorithm for the digest, and
reject unsupported SRI algorithms explicitly.

## 14.13 Confine `bin` paths — [sec]

**Corepack:** when `bin` comes from a downloaded `package.json` rather than the
embedded table, its values are joined onto the install location without validation.
A malicious package could declare `"bin": {"yarn": "../../../../etc/…"}`.

**Required:** resolve the joined path and verify it remains inside the install
directory; error otherwise (§12.12). The exposure is limited (the tool already
executed a downloaded tarball's code) but the check is one comparison.

## 14.14 Fix the copy-pasted "to pack" messages — [correct]

**Corepack:** `install`, `up`, and `use` all emit "please specify the package manager
**to pack**", which is meaningless outside `pack`.

**Required:** parameterise the verb per command. Note this **breaks byte-compatibility**
with two test-asserted strings; a conforming implementation that prioritises exact
compatibility may keep them, but this spec recommends the fix and marks §12.9's
wording as advisory rather than normative.

## 14.15 Self-dispatching shims — [native/perf/small]

**Corepack:** generates one JS file per binary name at build time, each hard-coding
its own name, plus three Windows script variants per name via a shim generator. It
avoids `argv[0]` sniffing because Node `realpath`s the executed module and loses the
invocation name.

**Required for a native implementation:** a shim is a symlink (POSIX) or a hardlink /
copy of the binary (Windows) pointing at the tool itself; the tool dispatches on
`basename(argv[0])`. This removes every generated file, the `PATHEXT` workaround, the
PowerShell pipeline special-casing, and the requirement that a JS runtime be locatable
at `enable` time. The explicit `<tool> <binary>` form remains available.

The download-prompt default (§05.5) then keys off the same dispatch: `1` when invoked
under a package-manager name, `0` when invoked under the tool's own name.

## 14.16 Don't clobber foreign binaries — [correct]

**Corepack:** `enable` unlinks and replaces whatever occupies a target name, with one
hard-coded exception for Yarn Switch.

**Required:** refuse to replace a regular file that is not one of the tool's own
shims, print the message in §12.12, and provide `--force`. The Yarn Switch case then
falls out of the general rule instead of being special-cased.

## 14.17 Find the tool's own path properly — [correct/native]

**Corepack:** locates the install directory via a `PATH` lookup for a binary named
`corepack`, because Node has already lost the invocation path. This picks the wrong
directory when the tool was run by absolute path while a different copy sits earlier
on `PATH`, and propagates a raw rejection when nothing matching is on `PATH` at all.

**Required:** use the platform's self-path primitive (`/proc/self/exe`,
`_NSGetExecutablePath`, `GetModuleFileNameW`), fall back to the `PATH` lookup, and
emit a clear error if both fail (§12.12).

## 14.18 Actionable read-only-filesystem handling — [correct]

**Corepack:** `enable` fails with a raw errno when the directory containing the tool
is read-only — the common case in container images and OS-packaged installs.

**Required:** detect `EROFS`/`EACCES` and name the two real options
(`--install-directory <writable dir on PATH>`, or shell aliases). An implementation
MAY add `--print-shell-init` emitting shell functions, sidestepping the filesystem.

## 14.19 Subprocess execution model — [native]

**Corepack:** loads the package manager into its own process, rewriting `process.argv`,
`process.execArgv`, and `process.mainModule` to impersonate a direct invocation.

**Required for a native implementation:** `exec()` on POSIX (preferred — no extra
process, exact signal and exit-code semantics for free), or spawn-and-wait with the
signal forwarding, stdio inheritance, and exit-code mapping rules in §08.3–§08.6.
Every observable property listed in §08.4 must hold.

## 14.20 Embedded table as static data — [perf/small]

**Corepack:** ships `config.json` and parses it as JSON on every startup.

**Required:** compile the table in as a static structure. Preserve the *ordered*
nature of the `ranges` map explicitly (§02.3) — a language with unordered maps must
use a list of pairs, since "last declared range wins" is load-bearing.

---

## 14.21 What is deliberately NOT changed

For the record, these corepack behaviours look like bugs and are not:

* **A user-supplied hash bypasses signature verification** (§06.1). An explicit pin is
  a stronger, user-chosen assertion than the registry's claim about itself.
* **Yarn's `default` is 1.x while `transparent.default` is 4.x** (§02.5). Deliberate:
  bare `yarn` behaves like the classic global yarn; `yarn dlx`, which classic yarn
  lacks, gets a modern release.
* **`cache clean` does not remove `lastKnownGood.json`** (§07.9). The recorded default
  is a preference, not a cache entry.
* **No lockfile around installs** (§07.5). The rename is the lock; adding one would
  introduce stale-lock failures to solve a solved problem.
* **Forgiving `lastKnownGood.json` reads** (§04.4). Corruption degrades to "no
  recorded default" rather than breaking the tool.
* **Tags resolve against the newest range band only** (§04.1). Tags describe the
  current channel; resolving them per-band would make `yarn@latest` ambiguous.

---

## 14.22 Every variable answers to `JUP_` as well — [correct]

**Corepack:** the variables are named after the tool, `COREPACK_*`, and there is
exactly one spelling of each.

**Consequence:** a re-implementation under a different name has two bad options.
Keep `COREPACK_*` only, and every variable in its own documentation is named
after a different program. Rename them, and every project, CI file and shell
profile that already sets one silently stops configuring anything — the failure
mode of a misspelt environment variable is that it reads as unset, which is also
its default, so nothing fails loudly.

**Required:** each variable in §11 has both spellings, `JUP_<NAME>` and
`COREPACK_<NAME>`, naming one setting. `JUP_` wins when both are set, as the more
specific statement about *this* tool. The pair shares its default, its env-file
eligibility and its §14.5 deny-list entry — the deny-lists are keyed by the
`COREPACK_` spelling and a name is canonicalised before it is checked, so
`JUP_INTEGRITY_KEYS` in a `.corepack.env` is refused exactly as
`COREPACK_INTEGRITY_KEYS` is. §03.2's prefix sandbox admits both prefixes and
nothing else. §11.3's two exported variables are written under both names, so a
package manager looking for `COREPACK_ROOT` still finds it.

An implementation MUST NOT read a variable with a bare environment lookup, which
sees one spelling; §11.6's precedence is the contract, including the rule that a
diagnostic names the spelling the user actually set.

## 14.23 A mute scoped to the lines this spec adds — [correct]

**Corepack:** prints six advisories, and has no way to turn any of them off:
the download notice and its prompt (§11.1), the auto-pin notice (§03.6), the
three `devEngines` warnings (§03.3), and `enable`/`disable`'s Yarn Switch skip.

**Consequence:** this spec adds a good deal more — §06.2's weak-hash notice,
§15.4's disabled-TLS line, §15.11's "publishes no signatures" and its unverified
opt-out, §15.13's and §15.29's shim diagnostics, §14.5's refused env-file
variable, §14.16's declined shim, §15.15's failed restore, §15.1's refused
`.npmrc` key. They are good defaults, and they are also stderr an existing CI job
did not have. A blunt mute is not the answer: the `devEngines` text is matched
byte for byte by §13's rows, so silencing everything breaks the contract §12
establishes.

**Required:** `COREPACK_QUIET_ADVISORIES=1` (§11.5) silences exactly the lines
this spec adds. Corepack's six are unaffected, and so is every error — the
variable changes what is *reported*, never what is done. It is env-file
ineligible under §14.5: several of the lines it covers are the notice that a
verification step was skipped, and a cloned repository must not be able to
silence them, least of all §14.5's own "Ignoring `<NAME>`" warning.
