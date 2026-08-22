# §15 conformance audit — pipack @ `fed9e24`

**Scope.** Every `## 15.x` section of `.agents/15-gaps.md` (38 sections), checked against
`src/` and `test/`. A section is **Done** only where something *tests* it; code with no
test is recorded as untested.

**Suite state at audit time.** `vitest run` → 55 files, **1473 passed, 3 skipped**, green.

**Two things happened during the audit and you should know about both.**

1. **The repo was being edited while I read it, and still is.** At the moment I
   started, `git status` was clean at `fed9e24`. By the time I finished, the working
   tree held modifications to `src/config/keys.ts`, `src/integrity.ts`,
   `src/registry.ts` and two conformance harness files, plus **three new untracked
   files**: `src/trust.ts` (328 lines), `test/conformance/15-09-key-refresh.test.ts`
   (236 lines, titling rows 162–164) and
   `test/conformance/15-10-custom-registry-trust.test.ts` (180 lines, titling rows
   165–166). Someone is implementing **§15.9 and §15.10** right now.
   **This audit describes `HEAD`** — the last committed, green, fully-measured state —
   because an in-flight tree is not a thing you can audit. §15.9 and §15.10 below are
   therefore marked against `HEAD` with the in-flight work noted; **re-check those two
   rows once that work lands.** Everything else in this report was unaffected: no
   other file under `src/` or `test/` changed during the audit. I made no edits.

2. **`README.md` overstates completion.** It claims phase 2 is complete "apart from
   two items" (§15.9, §15.35e). It acknowledges §15.14/§15.19/§15.35 as partial. Beyond all of that, this audit
   finds **seven further sections** not done or only partly done — §15.10, §15.17,
   §15.26, §15.31, §15.32, §15.33, §15.34 — plus **three unrecorded §15.35 items**
   (c, d, f), plus **13** unasserted §15.38 rows (five of which the in-flight work above
   is about to close).

---

## The table

Tags are the ones `15-gaps.md` itself carries. ⬛ = maintainers say won't-fix upstream.

| § | Tag | Status | Evidence | What's missing |
|---|---|---|---|---|
| **15.1** `.npmrc` subset | required | **Done** | `src/npmrc.ts:146-216` (3 tiers incl. `<prefix>/etc/npmrc`), `:344-351` (allow-list applied *before* `${VAR}` expansion), `:538-569` (prefix-scoped auth), `:131-133`+`:398-405` (project file may not set auth/ca/cafile/strict-ssl), `src/tls.ts:85-101` (strict-ssl warning names the file). Tests `15-01-npmrc.test.ts:90/126/170/192/218`, `unit/npmrc.test.ts:129-140,215-230,333-394`. Row 149 asserts the token **on the wire** (`mirror.requests[].authorization`), so it is a real discriminator. | One literal deviation: `npmrcAuthorizationFor` (`src/npmrc.ts:552-557`) compares host+port+path but **not scheme**, while §15.1 says "origin *and* path prefix". Deliberate (npm-compatible) and documented, untested either way. Also `PREFIX` (bare) is accepted as the npm prefix (`:147`) — a common env var in build images; untested. |
| **15.2** per-source registries | required | **Done** | `src/npmrc.ts:592-594,633-646` (precedence `<NAME>` > `NPM_REGISTRY` > `.npmrc` > built-in); download `src/install.ts:351`, tarball `src/registry.ts:292`, **tag doc + version list** `src/registry.ts:476-480,439-463`. Test `15-02-registries.test.ts:124` asserts the yarn mirror received *both* `/tags` and `/yarn` while `fallback.requests === []`. Real discriminator (three live servers per row). | `applyRegistryOverride` only rebases URLs whose origin is `registry.npmjs.org` (`src/registry.ts:117`), so a mirror echoing an upstream `dist.tarball` on `registry.yarnpkg.com` is not rebased and then trips §14.9. Not a stated MUST, but a plausible Artifactory shape and untested. |
| **15.3** origins not substrings | required, security | **Done** | One `rebase` helper, parses both URLs and compares `.origin`: `src/registry.ts:134-153`; composed with §14.9 at `:292-293`. Tests `15-02-registries.test.ts:250` (host case + trailing slash), `:277`/`:299` (path prefix once), `:314` (a URL *containing* the default registry is left alone — corepack's exact `String.replace` bug, asserted on two request logs). | — |
| **15.4** TLS CAs + diagnostics | required | **Done** | Bundle precedence `src/tls.ts:62-96`; `COREPACK_STRICT_SSL` `:82`+`:213-221`; the **three verbatim sentences** `src/errors.ts:289-300` via `classifyTlsFailure` `src/tls.ts:334-341`, substituted for the transport message at `src/http.ts:439-443` and never retried (`:97`). Tests `unit/tls.test.ts:271-281` pin the literals; `15-04-tls.test.ts:115` runs a real TLS server with an untrusted CA and asserts `not.toContain("Error when performing the request")`, with a `COREPACK_CAFILE` control at `:142`. | The **expired / not-yet-valid** branch is unit-tested by code path only (`unit/tls.test.ts:257-263`); the committed fixture is valid until 2126, so there is no end-to-end case. Already recorded as a carried follow-up in `PLAN.md`. |
| **15.5** timeouts + retries | required | **Done** | `src/http.ts:39,379-380` (30 s default, `COREPACK_NETWORK_TIMEOUT`), `:411-415` connect+headers and `:490-531` idle watchdog; `:65-67` retryable set `408/425/429/5xx` and nothing else (`:464`); `Retry-After` both RFC 9110 forms `:135-150`; `RETRIES=0` `:381-384`; cause chained into the final error `:449,478-481`. Tests `unit/http.test.ts:656-672,707-733,735-748,750-787`, conformance `15-05-resilience.test.ts:142/169/190/212/243`. Discriminators assert **request counts and delay arrays**, not just outcomes. | Three deliberate deviations from the literal text, all documented in-source: `MAX_RETRY_AFTER = 30_000` (`:59`) means a `Retry-After` longer than 30 s is **not** honoured and the client retries *sooner* than the server asked; `MAX_ATTEMPTS = 10` caps `COREPACK_NETWORK_RETRIES` (`:52`); the status give-up path (`:468`) attaches no `cause`/`retriesExhausted` note, unlike the transport path — asymmetric and unasserted. |
| **15.6** proxying | required | **Done** | `src/proxy.ts:73-79,139-164` (`HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`, no second opt-in flag); **all four `NO_PROXY` forms** in `:93-126` (`*`, `:port` incl. implicit 443/80, leading-dot suffix, bare hostname at label boundaries); CONNECT vs absolute-form at `:306-311`, re-evaluated per redirect hop `:230,270`. Tests `unit/proxy.test.ts:492-583`, `15-06-proxy.test.ts:44` (row 156 targets `https://example.com`, unreachable without the tunnel — success *is* the proof) and `:77` (row 157, `proxy.connects === []` with a paired control). | — |
| **15.7** never crash on absent metadata | required, bug | **Done** | Three outcomes in one place: `src/registry.ts:354-401`, tier 1 hoisted to `requireDist` `:497-508` and used by **both** former crash sites (`:216`, `:281`). Tests `15-07-registry-metadata.test.ts:56` (asserts the exact sentence *and* `not.toContain("Cannot read properties")`), `:71` (`occurrences(stderr, warning) === 1`), `:84` (`REQUIRE_SIGNATURES` paired permitted/refused). | **`COREPACK_REQUIRE_SIGNATURES` is not consulted on §06.1 row 1's pinned-hash path** — `src/install.ts:395-399` returns before `verifyRegistryTrust`, so `pnpm@6.6.2+sha512.…` installs from an unsigned registry with the flag at `1`. Deliberate and documented, but **untested in either direction**. Also: the soft-fail widens the spec's "`integrity` present and matches" to include a bare `dist.shasum` (`src/registry.ts:229,302`); and `COREPACK_REQUIRE_SIGNATURES` is the one §15 security flag absent from `ENV_FILE_INELIGIBLE` (`src/env.ts:33-74`) — harmless today because `envFlag` honours only `"1"` (a project file can only tighten). |
| **15.8** package-root fallback | required, bug | **Done** | `src/registry.ts:411-426`, called exactly once from `:374-376` and only when `signatures === undefined`; best-effort, skipped when the network is off (`:416`). Test `15-07-registry-metadata.test.ts:105` asserts **ordering** (`indexOf("/pnpm") > indexOf("/pnpm/6.6.2")`) **and count** (`toHaveLength(1)`) under `REQUIRE_SIGNATURES=1` so the soft-fail cannot be what carried it; `:127` asserts the happy path pays nothing (`toStrictEqual([...])`). | Narrowed: the fallback is skipped when `integrity` is `undefined` (`:376`), where §15.8 states the retry unconditionally. And "once" is per `verifyRegistryTrust` call, not per run — a `pnpm@latest` install calls it from both `fetchLatestStableVersion` (`:223`) and `resolveExpectedIntegrity` (`src/install.ts:416`), so an Artifactory-shaped registry can see **two** package-root requests. Every test pins an exact version, so this is unexercised. |
| **15.9** trust-key freshness | required | **Not done** | Nothing at `HEAD`: no `<home>/keys.json`, no `GET <registry>/-/npm/v1/keys` refresh, no merge-on-keyid-miss. The only hit for `keys.json` in the whole repo is the spec text itself. Rows **162, 163, 164** unasserted. | Everything. *In flight*: an uncommitted `UntrustedKeyidError` subclass landed in `src/integrity.ts` at 11:02 UTC referencing a `src/trust.ts` that does not exist. Note `PLAN.md`'s finding that this also blocks bare `yarn` + `COREPACK_DEFAULT_TO_LATEST=1` online, because npm signs the `yarn` packument's `latest` with a key npm itself marks expired 2025-01-29 — and §14.4's lenient branch (`ACCEPT_EXPIRED_KEY_WITH_WARNING`, `src/integrity.ts:56`) is hard-`false` because §13 test 82 wants the strict answer. So §15.9 alone does not fix that; the §14.4/§13-82 conflict has to be resolved with it. |
| **15.10** custom-registry trust | required | **Partial** (at `HEAD`) | At `HEAD`, `COREPACK_INTEGRITY_KEYS` **accepts both shapes** — legacy `{"npm":[…]}` and origin-keyed — at `src/integrity.ts:169-191`; keys are environment-only, never from a project file (`src/env.ts:35,56`, tested `unit/env.test.ts`); an unknown origin with no signatures falls to §15.7's soft-fail. **But selection ignores the origin**: `src/config/keys.ts` `getTrustedKeys` did `Object.values(store).flat()`, with a comment stating outright that "§15.10 makes trust per-origin *and* adds a soft-fail for unknown origins; the two arrive together or not at all". `unit/config.test.ts:197-213` **asserts the flattened behaviour** — so the existing test would have to be rewritten, not merely extended. Rows **165, 166** unasserted. | The MUST "a registry origin's keys are used for that origin" is unmet at `HEAD`: a store configured with keys for a Cloudsmith mirror silently widened them to `registry.npmjs.org` too. *In flight*: the uncommitted `src/config/keys.ts` now selects by parsed origin then falls back to the npm origin — which looks right — but it is untested (its own doc-comment claims `unit/config.test.ts` "uses a two-origin store", and it does not), uncommitted, and unaccompanied by rows 165/166. |
| **15.11** one verification tier | required, security ⬛ | **Done** | `assertVerificationTier` `src/install.ts:466-487`, called at `:152` **before** the stream opens; refusal string byte-identical to the spec at `src/errors.ts:507-508`; opt-out env-file-ineligible **and loudly refused** (`src/env.ts:42` *and* `:74`). Tests `15-11-verification.test.ts:79` (exact version), `:124` (dynamically resolved Berry range), `:139` (env file cannot open the hole), each with a positive control on the same fixture (`:94`, `:107`) — so they cannot pass by refusing unconditionally. Bonus: `:199` proves a pin the cache cannot vouch for is not adopted from another pin's directory. | Two opt-outs exist where §15.11 names one: `COREPACK_INTEGRITY_KEYS` in `{"","0"}` (`src/install.ts:474`) and §15.7's shasum soft-fail counting as a tier (`:430`). Both documented; the second is sanctioned by §15.10's closing line. Not a defect, but worth knowing. |
| **15.12** sidecar integrity | **recommended** ⬛ | **Done** | Read as SRI and folded into a build suffix: `src/manifest.ts:364-366,410-416,444-479`; `--pin-style=sidecar` writer `src/pin.ts:252-290`, `src/cli.ts:511-695`. Tests `15-12-sidecar.test.ts:72` (asserts **only the tarball** was requested, proving it took §06.1 row 1 rather than the signature path), `:86` (wrong sidecar → `Mismatch hashes.`), `:98` (the no-sidecar control that makes the row mean something), `:145` (round-trip from a **cold store**), `:123` (suffix + disagreeing sidecar refused). | — (`--pin-style` is now in `src/usage.ts`; that `PLAN.md` follow-up is closed.) |
| **15.13** never require elevation | required | **Done** | `src/shims.ts:333-349` (`--install-directory` → `COREPACK_SHIM_DIRECTORY` → per-user), `:295-312` (XDG / `~/.local/bin` / `%LOCALAPPDATA%\node\corepack\bin`), `:352-391` (**writability probe**: `mkdir -p` + real probe file + `rm`, run before any `generate` at `:1079`), `:129-135`+`:985-1017` (PATH line per detected shell, exit 0). Point 5 covers the **store** too: `src/store.ts:78` `(isWindows ? process.env.LOCALAPPDATA : undefined)`. Tests `unit/shims.test.ts:157,169-180,398,420,443,460,508`; conformance `15-13-shims.test.ts:77` (row 170, real `chmod 0o555`), `:99` (row 171, drives `info --json` with `LOCALAPPDATA` on a fake `/mnt/c/…` and asserts **both** `store.home` and `shims.directory` ignore it), `:154`/`:170` (bash vs fish, the latter asserting `not.toContain("export PATH")`). | Windows `perUserShimDirectory` branch (`:296-303`) has no direct test. The two row-170 cases skip under root (`IS_ROOT`), so a root CI silently loses them. |
| **15.14** native shims | required | **Partial** (as recorded) | Behavioural half done: `enable` uses `lstat` not `stat` (`src/shims.ts:742-745`, with a comment naming corepack's 0.34.4 `EEXIST` bug) and `isOurEntry` treats a dangling link naming `<binName>.js` as ours (`:513-534`); `disable` mirrors it at `:797-810`. Tests `unit/shims.test.ts:283`/`:589`, conformance `15-13-shims.test.ts:185`/`:203` (row 173, asserting `lstatSync(...) === undefined` after `disable`). The unit test's precondition (`existsSync === false` while `isSymbolicLink() === true`) makes it fail against a `stat`-based build. | Native-binary half deliberately not attempted (#213 PowerShell execution policy, #486 shebang) — `src/shims.ts:6-11` says so, `PLAN.md` assesses it. **Verified and worth acting on:** `PLAN.md` records that `process.argv[1]` is *not* realpathed, so §14.15's `basename(argv[1])` dispatch is available on POSIX **today** from a JS distribution — one `dist/shim.mjs` and six symlinks, closing #751 at the root. That is a real, cheap, unclaimed win. Narrower nit: a dangling symlink whose target basename is *not* `<binName>.js` is not "ours", so `disable` leaves it — defensible, narrower than the literal MUST. |
| **15.15** non-destructive `disable` | required ⬛ | **Done** | `src/shims.ts:756-766` (refuse without `--force`), `:550-653` (`<home>/shims.json` records path, type, symlink target, mode), `:662-711` (restore after removal, EXDEV fallback), `:140-142` (`restoreFailed` warns and continues). Tests `unit/shims.test.ts:301,317,613,635,653,673,695`; conformance `15-13-shims.test.ts:218` (row 174: byte content **and** mode `0o755` **and** `shims.json` gone **and** second `disable` a no-op), `:254` (leaves a foreign binary it never displaced alone). | Deliberate widening: a foreign **symlink** is displaced without `--force` (`:761-774`), because §10.2 requires `enable` to correct a symlink pointing elsewhere. Recorded and restorable, so the harm §15.15 targets does not occur, but the literal "refuses" is not met for symlinks. Stated in-source at `:626-628`. |
| **15.16** shim npm by default | required ⬛ | **Done** | `src/shims.ts:217-232` (`Object.keys(DEFINITIONS)`, no npm exclusion), `:183-188` (`--exclude`, repeatable and comma-separated). Tests `unit/shims.test.ts:116` (exact array `["npm","npx","pnpm","pnpx","yarn","yarnpkg"]`), `:190`, `:134` (unknown `--exclude` name rejected, incl. `constructor`); conformance `15-13-shims.test.ts:271` (row 175). Called out in `README.md:277-282`. | — |
| **15.17** bin paths from signed metadata | required | **Not done** | Point 1 holds trivially (`src/store.ts:611`), and the §14.13 containment check is unconditional (`src/exec.ts:85-90`), so the *safety* half is fine. But **point 2 does not exist**: `getSpecFor` (`src/config/table.ts:144-154`) **throws** `messages.noRangeBand` when no band matches, and `resolveBin` calls it unguarded at `src/store.ts:609-611`, so a version outside every band dies rather than reading `bin` from the verified package. The only `package.json` fallback (`:621-628`) fires when the band declares an *array* `bin` — that is §07.7's Yarn-Berry-as-tarball case, not §15.17's. | Point 2 (fallback on no-band-match) and point 3 (a **debug-level note naming the version** — there is no debug channel in `src/` at all). Row **176** unasserted; `noRangeBand` has **zero** test references anywhere. Practical impact today is low because every table band is open-ended at one end, but the whole point of §15.17 is the day a package manager restructures. |
| **15.18** `cache clean --all` | required, bug | **Done** | `src/cli.ts:817-838`; count taken before removal; `--json` rejected on `clean` rather than ignored (`:797-799`). Documented in `README.md:360`. Test `15-30-info.test.ts:489` (row 177: defaults survive a plain clean, are removed by `--all`), `:511`. | — |
| **15.19** offline/airgapped | required | **Done** | (a) `messages.notInCacheOffline` `src/errors.ts:244-245`, attached at both the download (`src/main.ts:281`) and the **resolution** (`:321`, `src/cli.ts:78,572`) call sites. (b) `installFromArchive` prints one line per extracted locator, `src/cli.ts:485-494`. (c) `corepack cache list [--json]` `src/cli.ts:784-790` → `src/info.ts:1249`, sharing one report builder with `info`, and `listInstalled` counts only marker-bearing directories (`src/store.ts:641-660`). Tests: rows **178** (`15-35-sundries.test.ts:55` full-`stderr` equality, `:71` range, `:87` `up`'s *second* resolve, `:101` seeded-store control) and **179** (`15-30-info.test.ts:444,473`); archive reporting `unit/cli.test.ts:454-455`. | Cosmetic: the message interpolates the **range** into `install -g --cache-only <name>@<range>` where §15.19's template says `<version>`. Identical for an exact pin; for a range there is no concrete version to name offline, so this is arguably the only possible rendering. |
| **15.20** download-prompt behaviour | required | **Done, one row unasserted** | `confirmDownload` `src/install.ts:252-256`: `envFlag` returns true only for exactly `"1"`, and the single early return suppresses **both** notice and confirmation from every entry point. Interactive branch requires all three (`:259`: value 1, `isTTY === true`, `!isCI()`). Entry-point defaults are `??=` so an explicit `0` always wins: `src/bin.ts:11` (`"0"`) and the generated stub `src/shims.ts:417` (`"1"`). §11's table states the entry-point-dependent default (`.agents/11-environment.md:16`) and `HELP_TEXT` mentions it (`src/usage.ts:71-74`). Tests `unit/install.test.ts:897,914`, `13-05-environment.test.ts:230`, `13-11-shims.test.ts:335`. | Row **180** — "`=0` via a **shim** entry point → fully silent" — is not asserted end-to-end. The two halves are each tested separately; nothing joins them. Low risk, cheap to close. |
| **15.21** beyond npm/pnpm/yarn | **bounded** | **Partial** | Table stays compiled-in and non-extensible (`src/config/table.ts`), an unknown name is an error not a URL fetch (`src/manifest.ts:298`, `src/resolve.ts:92`), and the **data-only** requirement is genuinely proven: `15-28-native.test.ts:149` injects a whole new definition — URL template, `exec: "native"`, a `bin` map — with **no accompanying code**, and it runs. Binary names come only from the table (`unit/config.test.ts:134-148`). | The MUST "the tool's own structure MUST NOT hardcode the names `npm`, `pnpm`, `yarn` anywhere outside that table" is **violated once**: `isYarnSwitch` at `src/shims.ts:494` (`if (!binName.includes("yarn")) return false`) plus `YARN_SWITCH_RE`. §15.21 itself names this and says it *SHOULD* become a per-entry flag, so it is the softest of the outstanding items — paperwork, not user impact. |
| **15.22** typosquat-resistant distribution | **advisory** | **Not done** (nothing to break yet) | The one code-adjacent clause is met: canonical download origins are hardcoded in the table, and off-registry hosts need `COREPACK_ENABLE_UNSAFE_CUSTOM_URLS` (`src/http.ts:337`). No install-script-from-a-bare-domain exists. | No release pipeline at all — `.github/workflows/` holds only `autofix.yml` and `checks.yml`, `package.json`'s `release` script is a bare `npm publish` with no provenance/attestation flag, and there is no signing or published verification procedure. `README.md:809` says "Published release: Not yet", so this is a pre-release to-do, not a regression. |
| **15.23** ranges in the spec | required ⬛ | **Done** | `src/manifest.ts:301-317` (exact-version rejection gone), `src/resolve.ts:105-122` (tags), `src/lockfile.ts:29-105,196-206` (schema, sorted keys, byte-exact serialisation), `src/main.ts:158-166` (lockfile read precedes any resolver import), `src/env.ts:388-411` (`COREPACK_FROZEN_LOCKFILE` wins both ways; CI is the default; `up` exempt via `{refresh:true}`), `src/lockfile.ts:55-59` (exact pin ⇒ no lockfile at all). Tests `15-23-ranges.test.ts:61,88,109,129,155,173,187,206,225,286,301,368`. Row 182 asserts `registry.requests === []` on the second run; row 206's control plants a lockfile entry that would give a *different* answer and asserts it is neither read nor written. Strong throughout. | One letter-of-spec gap: a **dist-tag** in `devEngines.packageManager.version` is rejected — `src/manifest.ts:372-377` accepts `isValidRange` only, and `unit/manifest.test.ts:514,522` *pin* that rejection because §03.3 / base test 21 require it. A genuine spec-vs-spec collision (§15.23 says "a semver range **or a dist-tag**"), not an oversight. |
| **15.24** no implicit prerelease | required, bug | **Done** (MUST); SHOULD not done | `src/resolve.ts:159-169` filters only in step 6; lenient rule preserved for band selection (`src/config/table.ts:144-147`) and cache probing (`src/store.ts:473-476`). Every fixture row publishes a **higher** prerelease alongside stable (`15-24-prereleases.test.ts:38-45`), so each row genuinely discriminates: `:57,66,75,88,102,118,129`. | The trailing **SHOULD** — a bare name or `*` resolving via the registry's `latest` dist-tag rather than the semver maximum — is not done (`src/resolve.ts:161-175` always takes the maximum). `PLAN.md` records this as blocked with a real reason (it would resolve `yarn@*` against the last band's registry only, dropping the Yarn Classic candidates §04.1 step 6 unions in). **Row 184 cannot detect it** because the fixture's `latest` and the stable maximum are the same version. |
| **15.25** symmetric walk stop | required, bug | **Done** | `src/manifest.ts:69-81` — `Object.hasOwn(data,"packageManager")` (presence, not truthiness) **or** a non-null `devEngines.packageManager`; used at `:142-145`. Tests `15-25-walk-stop.test.ts:28,47` put a *different* manager in the ancestor so "kept climbing" and "stopped" give different answers; `:64` covers `packageManager: null`; `:81` is the necessary negative control; `:96` proves the widening did not leak past the `node_modules` guard. | `packageManager: ""` — the "explicitly empty" half of the MUST — has **no test**. By reading it is handled (presence stops the walk, then `parseSpec` raises `noVersionSpecified`). Cosmetic: `src/info.ts:456-497` still mirrors the *old* truthy stop condition on its error path. |
| **15.26** atomic pin | required, bug | **Partial** | Bullet 2 (devEngines-only ⇒ write there, create no `packageManager`) done: `src/pin.ts:214-249,161-181`, proven by `15-26-atomic-pin.test.ts:53`, which **re-runs the tool afterwards** — the actual requirement. Bullet 3 (validate against the state being *written*) done: `src/pin.ts:98,126-135,235-248`, discriminated by `:99`, `:152`, `:188`. | **Bullet 1 is only partly met.** When `packageManager` exists and `devEngines.packageManager.version` is a **range**, `devEngines` is deliberately left untouched (`src/pin.ts:194-213,244-248`) on the reasoning that a range is a constraint, not a pin — and `15-26:128` asserts that as *intended*. §15's own **row 190** says "both updated". So the proving test proves consistency with the implementation, not conformance with the row. **Residual hole, untested and not reasoned about in source:** that same branch also skips `devEngines.packageManager.integrity`, so a hand-written `{version: "<range>", integrity: "sha512-OLD"}` + top-level `packageManager` gets the pin rewritten while `integrity` goes stale; the next read then raises `devEnginesIntegrityMismatch` under the default `onFail: "error"` — i.e. the command leaves a project it just edited in a state it refuses to read, exactly what bullet 3 prohibits. Reachable only from a hand-written combination (`--pin-style=sidecar` always writes an exact version alongside), so severity is low. |
| **15.27** predictable write target | required | **Done** | `src/manifest.ts:96-99` (boundary), scanned only in mutating mode (`:47,133,231-233`); `--here` at `:149-155`, wired at `src/cli.ts:517,606` and `src/pin.ts:66`; one formatter for `Updated <path> to use …` at `src/errors.ts:402-403`, emitted by `use`/`up` (`src/cli.ts:680`), by `up`'s lockfile-refresh form (`:551`), and by the **§03.6 auto-pin** case (`src/main.ts:443`, stderr). Tests `15-27-write-target.test.ts:57,79,101,123,141,157,178`; the auto-pin line is proven by `13-05-environment.test.ts:180`, which asserts the *entire* stderr byte-for-byte. | Edge case: the boundary check sits inside the block that successfully read a `package.json` (`src/manifest.ts:187-233`), so a directory holding `pnpm-workspace.yaml` but **no** `package.json` hits the `continue` at `:193-196` and the walk climbs past it. The MUST names the directory unconditionally. Untested. |
| **15.28** native package managers | required | **Done** | `src/config/table.ts:179-258` (`{platform}`/`{arch}`, normalised allow-lists incl. `amd64`/`aarch64`, explicit error rather than a leaked placeholder); `src/exec.ts:152-156` returns **before** `process.argv`/`nextTick`/`import()` and before any §08.3.1 runtime lookup; `src/native.ts:64-120`; executable bit at `src/tar.ts:514-519,622`. Tests are the strongest in the suite: the fixture artifact is deliberately **invalid JavaScript** (`15-28-native.test.ts:73-95`), `COREPACK_NODE_EXECPATH` is set to a nonexistent path as a trap (`:242`), `$0` is asserted to be the artifact itself (`:267`), the URL is asserted to contain no surviving `{` (`:262`), row 194 has a non-executable negative control plus setuid assertions, and `:485` re-reads the tar headers with an independent parser. | — (POSIX-only via `describe.skipIf`, stated and justified.) |
| **15.29** verify `enable` took effect | required, bug | **Done** | `src/shims.ts:1043-1052` (`verifyOnPath`), `:262-276` (`whichFile`, PATHEXT-aware), `:121-123` (exact `shimShadowed` message), `:125-138` (`hash -r` advice), `:1096` (exit 0 unconditionally). Test `15-13-shims.test.ts:296` builds a **real shadowing binary** earlier on `PATH` and asserts the full sentence — fails if the check is removed *or* if the wording drifts. `:321` is the all-clear control (`stderr === ""`). | Two readings-of-convenience, both defensible: `hash -r` prints only when there is a problem (§15.29 point 4 reads unconditional), and `verifyOnPath` returns early when the directory is off PATH, so point 1's per-name resolution is skipped in that case. |
| **15.30** `corepack info` | required | **Done** | All seven items present and asserted — `src/info.ts:541+` (resolution, 7 statuses), `:318-378,399-434` (file **and field**, absolute, derived from the manifest rather than `hasPin`), `:681+` (env file contributions), `:729+` (`registrySource` per package manager), `:289-297` (store, writability, cached versions, recorded defaults), `:884+` (per-binary shim and PATH winner). Tests `15-30-info.test.ts:121,148,199,211,229,257,272,287,317,339,361,413`. "No network request" is structurally true (`info.ts` imports neither `registry.ts` nor `http.ts`) **and** asserted on every invocation by the helper at `:100-113`; "must not fail on an invalid spec" is exercised over **nine** distinct invalid shapes at `:148`. | — |
| **15.31** global invocations bypass the pin | required, bug | **Not done** | Nothing. `runProxy` (`src/main.ts:99-160`) classifies transparency solely through `isTransparentCommand` (`:81-96`), which matches only the table's `transparent.commands` prefixes. There is no positional scan for `-g` / `--global` / `--location=global` anywhere in `src/` — the only `-g` handling is `src/cli.ts:351`/`:969`, which is *our own* `install -g`, a different code path. Row **197** unasserted. | Everything. **And it is worse here than in corepack**, because §15.16 now shims npm by default: npm's `transparent.commands` are only `["npm","init"]` and `["npx"]` (`src/config/table.ts:29-31`), so `npm install -g <anything>` inside a yarn- or pnpm-pinned project hits §12.5's mismatch error — corepack never hit this for npm because npm was unshimmed. This blocks the tool's own documented upgrade path (#690). |
| **15.32** resolved manager on `PATH` | required | **Not done** | Nothing, and it is flagged in-source as future work: `src/exec.ts:145-148` — *"`PATH` is deliberately left alone in phase 1; §15.32 will prepend `dirname(binPath)` to it here."* `PLAN.md:353` says the same. `src/native.ts` does not touch `PATH` either. Row **198** unasserted. | Everything. §15.32 notes this is *cheap* given the self-dispatching shims: prepend the shim directory to the child's `PATH` in `execPackageManager`, as the only modification, and not leaking into our own process. |
| **15.33** no stale/shadowed defaults | required, bug | **Partial** | Bullet 1 (**floor, not override**) done and well proven: `src/resolve.ts:228-279` prefers the recorded last-known-good when its major line is ≥ the floor's, else the floor, with no network on either branch. Tests `15-33-defaults.test.ts:40` (**both** versions seeded, so it cannot pass via a resolution failure), `:55,70,80,95,108`. | **Bullet 2 is not done for yarn.** `src/config/table.ts:85` still ships `default: "1.22.22+sha1.…"` — Yarn Classic, the exact value §15.33 calls "a maintenance failure, not a compatibility guarantee". npm (11.14.1) and pnpm (11.1.2) are current; only yarn is stale. The in-source comment defends it by citing §02.5/§14.21 — and `.agents/02-data-model.md:193` does specify that literal — so §15.33's amendment was simply never applied to the table, and README/AGENTS.md record no deviation. Nothing locks the value in: every test reads `DEFINITIONS.yarn.default` symbolically, so bumping it would not break the suite. Also missing: the **§16.9 refresh job** §15.33 delegates to — `.github/workflows/` holds only `autofix.yml` and `checks.yml`. |
| **15.34** hold the scope line | required ⬛ | **Partial** | The four **adopted rulings** are N/A-and-honoured: there is no `corepack run`, no package-manager passthrough, no writing into another tool's lockfile, no monorepo task-runner pinning (`src/cli.ts:940-991` is the complete dispatch). | The **one narrower request §15.34 accepts** is not implemented: `corepack install --project` (aliased `corepack project install`), which resolves the project's package manager and runs its `commands.use` argv. `src/cli.ts:940-991` has no `--project` and no `project` case; `cmdInstall` (`:308-341`) caches the manager, it does not run `install`. The mechanism already exists — `commands.use` is in the table and `up` already invokes it (`src/cli.ts:634`) — so this is wiring, not design. No row in §15.38 covers it. |
| **15.35a** bare name is a valid spec | required | **Done** | `requireVersion: false` on every spec-accepting path (`src/cli.ts:261,299,326,368,530,601`, `src/main.ts:152`); §03.4 yields range `*`, and §15.24's filter then picks the stable maximum. Tested end-to-end by `15-24-prereleases.test.ts:57` (`use pnpm`, no version). | — |
| **15.35b** binary names only from the table | required | **Done** | `getBinariesFor` / `getPackageManagerFor` in `src/config/table.ts`; tested `unit/config.test.ts:134-148` with exact arrays. The §15.28 suite proves the data-only property end to end by injecting a whole definition with no code (`15-28-native.test.ts:149`). | pnpm 11's `pn`/`pnx` aliases are not in the table — but §15.35b requires only that adding them be data-only, which it is. |
| **15.35c** deprecated commands print a migration line | required | **Not done** | `cmdHydrate` / `cmdPrepare` (`src/cli.ts:846-870+`) still work, but print no migration line. `grep -rn "is deprecated" src/ test/` → **zero hits**. The required string `'corepack prepare' is deprecated; use 'corepack pack' instead.` exists nowhere. `README.md` does not mention `prepare` at all. Row **201** unasserted. | The whole requirement. One-line change plus one row. |
| **15.35d** `COREPACK_SPEC_FILE` | required | **Not done** | Zero references outside the spec. | The whole requirement — **and a trap for whoever implements it**: env-file eligibility is a *deny-list* (`src/env.ts:32-43`), so `COREPACK_SPEC_FILE` is currently env-file **eligible** by default, while §15.37 marks it ineligible. It must be added to `ENV_FILE_INELIGIBLE` in the same change, or a cloned repo can redirect the project spec from `.corepack.env`. Not in README's "not done" list either, so this gap was entirely unrecorded. |
| **15.35e** `COREPACK_MINIMUM_RELEASE_AGE` | required | **Not done (blocked — verified)** | Zero implementation. `PLAN.md:830-835`'s reason checks out: `fetchAvailableVersions` returns `string[]`, and the abbreviated packument the client requests (`application/vnd.npm.install-v1+json`) carries no `time` map, so this needs a `fetchVersionTimes` in `src/registry.ts` plus a `time` map in the mock registry. Row **203** unasserted. | The whole requirement. Genuinely blocked on new registry plumbing, not on design. Also needs no `ENV_FILE_INELIGIBLE` entry (§15.37 marks it eligible). |
| **15.35f** report own version; self-version constraint | required | **Partial** | Half done: `getOwnVersion` (`src/self.ts:63-79`, walking up so it stays correct in a built package) is reported by `info` at `src/info.ts:284`, asserted by `15-30-info.test.ts:128` and `unit/info.test.ts:643`. | The **self-version constraint** half does not exist — nothing lets a project declare or enforce a required version of the tool itself. No row covers it. |
| **15.35g** idempotent `use`/`up` | required | **Done** | Test `15-35-sundries.test.ts:120,137,153` (row 202) — re-pinning the already-written value, asserting no doubled build suffix, and covering `up` as well. | — |
| **15.35h** enablement state independent of install method | required | **Done** | `describeShims` (`src/info.ts:884+`) reports, per binary name, the shim path, whether it is ours, and the PATH winner — derived from the filesystem and `PATH`, never from how the tool was installed. Proven by `15-30-info.test.ts:361`, which runs a **real** `enable` against a copied tool and then a partial `disable`. | — |
| **15.35i** mismatch error must not mask a real failure | required | **Done** (by construction) | `runProxy` reconciles identity (`src/main.ts:143`) strictly before resolution, install, and handover; the package manager's exit status is never inspected to decide identity (`src/exec.ts`). The mismatch message is asserted at `13-05-environment.test.ts:81` and exit-code passthrough at `13-12-execution.test.ts`. | Nothing to fix. There is no single test that *joins* the two (an invoked command failing on its own and not being reported as a mismatch), but the architecture makes the failure mode unreachable. |
| **15.35j** nonexistent exact version | required | **Done** | `messages.versionDoesNotExist` (`src/errors.ts:232-233`), mapped from a 404 on artifact download (`src/resolve.ts:137`, `src/errors.ts:547-583`). Tests `15-35-sundries.test.ts:169,189,204` (row 204), including a positive control that an existing version is unaffected. | — |
| **15.35k** a stray `packageManager` in `$HOME` | required | **Not done** | The required suffix — `(this manifest is outside any project — a stray "packageManager" field there affects every directory)` — exists nowhere. `grep` for `outside any project` in `src/` → zero hits. `src/manifest.ts:91` mentions #424 in a comment only; nothing compares the governing manifest's directory against `homedir()` or above. Row **205** unasserted. | The whole requirement. It is a suffix on §12.5's existing message plus one path comparison. |
| **15.35l** mutating commands report | required | **Done** | `src/cli.ts:817-838` — the count is taken **before** removal; `messages.removedFromCache` / `nothingToRemove` / `removedFromCacheAll` at `src/errors.ts:405-409`. Test `15-35-sundries.test.ts:219,236` (row 206), covering both `clean` and `clear`. | — |
| **15.36** note on corepack's trajectory | — | **N/A** | Context only; explicitly "not a requirement". | — |
| **15.37** new environment variables | — | **Done except for the two unimplemented vars** | Ten of twelve exist with the stated eligibility; the deny-list and its warnings are at `src/env.ts:32-74`, tested in `unit/env.test.ts` and `15-11-verification.test.ts:139`. | `COREPACK_SPEC_FILE` (§15.35d) and `COREPACK_MINIMUM_RELEASE_AGE` (§15.35e) do not exist. See §15.35d for the deny-list trap. |
| **15.38** additional conformance tests | — | **Partial** | 47 of 60 rows asserted. | 13 rows unasserted — see the list below. |

---

## Scoreboard

| Verdict | Sections |
|---|---|
| **Done** (implemented *and* discriminatingly tested) | 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.11, 15.12, 15.13, 15.15, 15.16, 15.18, 15.19, 15.20, 15.23, 15.24 (MUST), 15.25, 15.27, 15.28, 15.29, 15.30, 15.35a, 15.35b, 15.35g, 15.35h, 15.35i, 15.35j, 15.35l |
| **Partial** | 15.10, 15.14, 15.21, 15.26, 15.33, 15.34, 15.35f, 15.37 |
| **Not done** | 15.9, 15.17, 15.22 *(advisory)*, 15.31, 15.32, 15.35c, 15.35d, 15.35e |
| **N/A** | 15.36 |

**Nine sections the plan never assigned to anyone**, confirmed by grepping `PLAN.md`
for each section number: §15.17, §15.20, §15.22, §15.31, §15.34, and §15.35a–f/h/i/k.
`PLAN.md` mentions only §15.32 (as "phase 1 leaves this; §15.32 changes it", with no
P-item owning it) and §15.34 (only to record the four *declined* requests, missing the
one it accepts). Of the nine, four turned out to be already satisfied incidentally
(§15.20, §15.35a/b/h/i) and five are real gaps.

---

## Ranked: what is worth closing

Ordered by what a user actually hits.

1. **§15.31 — a global install inside a pinned project is blocked.** *(required, bug)*
   `npm install -g <anything>` in a yarn/pnpm-pinned project fails with §12.5's
   mismatch error. This blocks the tool's own documented upgrade path (#690), and
   §15.16 made it **strictly worse than corepack**, which never shimmed npm. Fix is a
   positional leading-flag scan (`-g`, `--global`, `--location=global`) in
   `src/main.ts:99-160` routing to the transparent path. Row 197.

2. **§15.32 — the resolved package manager is not on the child's `PATH`.** *(required)*
   Any script that shells out to `pnpm`/`yarn` from inside a run gets a different one,
   or nothing. `src/exec.ts:145-148` already names the fix and the place to put it, and
   the self-dispatching shim directory makes it a one-liner. Row 198.

3. **§15.9 — signing-key rotation.** *(required)* This is the "every client bricks
   worldwide" failure mode (#612/#616), and it already bites: `PLAN.md` records that
   bare `yarn` with `COREPACK_DEFAULT_TO_LATEST=1` **fails online today** because npm
   signs that packument with a key npm itself marks expired. Note that §15.9 alone does
   **not** fix that case — the key is expired at the source, so it needs §14.4's
   lenient branch too (`ACCEPT_EXPIRED_KEY_WITH_WARNING`, `src/integrity.ts:56`,
   hard-`false` because §13 test 82 wants strict), which is a spec conflict to
   resolve, not just code. Rows 162–164. *Work on this appears to be in flight
   uncommitted.*

4. **§15.10 — custom-registry trust.** *(required)* At `HEAD` a store configured with
   keys for a private mirror silently widens them to `registry.npmjs.org`. That is a
   trust-scoping defect, not a convenience gap. The uncommitted working-tree change
   looks like the right shape but is untested — and note `unit/config.test.ts:197-213`
   **asserts the old flattened behaviour**, so it must be rewritten, and rows 165/166
   added. This is the one place where an existing test would have to *change*, which is
   exactly the shape that hides regressions.

5. **§15.33 bullet 2 — yarn's embedded `default` is Yarn Classic 1.22.22.** *(required,
   bug)* Six years unsupported; it is the literal complaint §15.33 quotes. No test locks
   it in (every test reads it symbolically), so bumping it is cheap — but it is a
   deliberate §02.5-vs-§15.33 conflict that needs a ruling, and it should come with the
   §16.9 refresh job, which does not exist.

6. **§15.7 — `COREPACK_REQUIRE_SIGNATURES` is silently ignored when a hash is pinned.**
   *(required, bug — found by verification, not previously recorded)* `src/install.ts:395-399`
   returns before `verifyRegistryTrust`. Deliberate and documented, but an organisation
   that sets the flag to mandate signed sources does not get that for pinned specs, and
   there is **no test in either direction** — so whichever behaviour is intended, it is
   currently unguarded.

7. **§15.35c — deprecated commands print no migration line.** *(required)* Trivial:
   one string, two call sites, one row (201). Pure user-facing polish, but it is a MUST
   and it is free.

8. **§15.35k — a stray `packageManager` in `$HOME`.** *(required)* One path comparison
   and a message suffix. #424 is a repeated, hard-to-diagnose confusion; this is the
   cheapest diagnostic win left. Row 205.

9. **§15.17 — `bin` from the verified package when no band matches.** *(required)*
   Currently `getSpecFor` **throws**. Low impact today (every band is open-ended at one
   end), high impact the day pnpm or yarn restructures — which is the entire motivation.
   Also needs point 3's debug note, and there is no debug channel in `src/` at all.
   Row 176. `noRangeBand` has zero test references.

10. **§15.35d — `COREPACK_SPEC_FILE`.** *(required)* Small, and unrecorded anywhere
    until now. **Implement it together with an `ENV_FILE_INELIGIBLE` entry** — the
    deny-list default would otherwise make it project-settable, contradicting §15.37.

11. **§15.34 — `corepack install --project`.** *(required)* The one request §15.34
    accepts. `commands.use` is already in the table and `up` already invokes it
    (`src/cli.ts:634`), so this is wiring.

12. **§15.26 — declared devEngines ranges are not rewritten, and `integrity` goes
    stale with them.** *(required, bug)* Needs a ruling first: the implementation's
    reading (a range is a constraint, not a pin) is defensible and tested, but row 190
    says "both updated", so the test proves consistency rather than conformance. The
    stale-`integrity` sub-case is a genuine bullet-3 violation and is untested.

13. **§15.35e — `COREPACK_MINIMUM_RELEASE_AGE`.** *(required)* Verified blocked for the
    stated reason; needs `fetchVersionTimes` plus a `time` map in the mock registry.
    Row 203.

14. **§15.35f — self-version constraint.** *(required, half done)* The reporting half
    works; nothing enforces a required tool version. No row covers it.

**Paperwork rather than user impact:** §15.21's single hardcoded `binName.includes("yarn")`
(§15.21 itself downgrades this to a SHOULD); §15.22 (advisory, and there is no release
pipeline yet to constrain); §15.5's `MAX_RETRY_AFTER` / `MAX_ATTEMPTS` caps; §15.1's
scheme-insensitive auth prefix; §15.14's foreign dangling symlink; §15.15's symlink
displacement without `--force`; §15.29's conditional `hash -r`.

**Untested-but-correct corners worth a cheap row each:** `packageManager: ""` (§15.25);
`pnpm-workspace.yaml` with no sibling `package.json` (§15.27); the Windows
`perUserShimDirectory` branch (§15.13); an end-to-end expired certificate (§15.4);
`COREPACK_REQUIRE_SIGNATURES` on a pinned hash (§15.7, either way).

---

## Unasserted §15.38 rows

The §15.38 table runs to **207**, not 203 — the prompt's range and `README.md:806`
both stop at 203, but rows 204–207 exist and three of them are asserted.

**How I matched.** Rows are named in test titles as a leading `"<n>: "`, so I matched
`["'`` `]` followed by `(1[4-9][0-9]|20[0-7]):` across all of `test/`, which catches
`it("173: …")`, `it.skipIf(X)("173: …")` and titles passed as variables alike. I
cross-checked by grepping the bare numbers and by reading each 15-xx suite's header
comment, which lists the rows it claims. Every row I report as asserted has at least
one test whose title carries its number **and** whose body exercises that row's setup.

**No test asserts these 13 rows:**

| Row | § | What it wants | Why it is missing |
|---|---|---|---|
| 162 | 15.9 | keyid-miss ⇒ keys refreshed once, verification retried, succeeds | §15.9 not implemented |
| 163 | 15.9 | same with network off / pinned keys ⇒ no refresh | §15.9 not implemented |
| 164 | 15.9 | warm cache hit ⇒ **no** key-refresh request | §15.9 not implemented |
| 165 | 15.10 | trust store keyed by a non-default origin ⇒ that origin's keys used | §15.10 partial; `unit/config.test.ts:197-213` asserts the *opposite* today |
| 166 | 15.10 | project `.corepack.env` supplying keys for a custom origin ⇒ ignored | §15.10 partial (the *ignoring* half is covered generically by §14.5 tests, but not as this row) |
| 176 | 15.17 | version outside every band ⇒ `bin` read from the verified package | §15.17 not implemented; `getSpecFor` throws instead |
| 180 | 15.20 | `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` **via a shim entry point** ⇒ fully silent | behaviour is correct; the two halves are tested separately and never joined |
| 197 | 15.31 | `npm install -g <pkg>` inside a yarn-pinned project ⇒ permitted | §15.31 not implemented |
| 198 | 15.32 | nested script invoking `pnpm` under `corepack pnpm exec` ⇒ same pnpm | §15.32 not implemented |
| 201 | 15.35c | `corepack prepare` works **and** prints the migration line | migration line not implemented |
| 203 | 15.35e | `COREPACK_MINIMUM_RELEASE_AGE` filters implicit resolution | §15.35e blocked |
| 205 | 15.35k | `$HOME/package.json` pin ⇒ error flags it as outside any project | §15.35k not implemented |
| 207 | — | store directory symlinked to a local checkout resolves and runs (#440) | never assigned; behaviour is plausibly already correct but nothing proves it |

Row 207 is the one worth singling out: it needs no new feature, only a test. If it
passes as-is, it is the cheapest row on the list.

**Asserted (47):** 148, 149, 150, 151, 152, 153, 154, 155, 156, 157, 158, 159, 160,
161, 167, 168, 169, 170, 171, 172, 173, 174, 175, 177, 178, 179, 181, 182, 183, 184,
185, 186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 199, 200, 202, 204, 206.

---

## One documentation correction

`README.md:800-838` says phase 2 is complete "apart from two items" and lists only
§15.9 and §15.35e. On this audit that should read: **§15.9, §15.10 (partial), §15.17,
§15.26 (partial), §15.31, §15.32, §15.33 bullet 2, §15.34's accepted item, and
§15.35c/d/e/f** — plus §15.22, which is a pre-release distribution to-do rather than
code. `README.md:806` should also say rows 148–**207**, not 148–203.
