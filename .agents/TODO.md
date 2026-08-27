## Cleanups — small, each independently landable

1. **`src/version/resolve.ts:56-64`** — `registryFor`/`hasRegistryOverride` is a redundant,
   incomplete copy of §05.2 rewrite 1 (it reads only `COREPACK_NPM_REGISTRY`, missing the
   `.npmrc` half). Both call sites (`:117`, `:177`) feed fetchers that apply
   `resolveRegistrySpec` themselves and it is idempotent, so this is deletable.
2. **`src/project/manifest.ts:565`** — `hashFromIntegrity` duplicated from
   `src/project/lockfile.ts:263`. The copy was made when `lockfile.ts` was cold; §15.23 put
   it on the warm path, so it now buys nothing. Keep manifest's stricter base64 check when
   merging.
3. **`src/errors.ts:352`** — `cafileUnreadable` hardcodes `(set by COREPACK_CAFILE)`, wrong
   when the bundle came from an `.npmrc` `cafile`/`ca`. §12 wants the source parameterised.
   `src/net/tls.ts:163` flags it in place.
4. **`.agents/14-divergences.md`** — §14.5's rationale never gained its line about
   `COREPACK_REGISTRY_<NAME>` being env-file eligible (§15.37): spec-conformant and
   consistent with `COREPACK_NPM_REGISTRY`, but a weaker form of what §14.5 guards against.

## Open work

5. **§15.4's expired / not-yet-valid certificate branch** is unit-tested by error code only
   (`test/unit/tls.test.ts:256`). The committed fixture is valid until 2126; an end-to-end
   row needs a second, expired one.
6. **§14.15 on POSIX** — `process.argv[1]` is *not* realpathed (verified), so
   `basename(argv[1])` dispatch works from a JS distribution today: one `dist/shim.mjs` and
   one symlink per binary, no generated stubs, closing #751 at the root. It changes the shim
   contract, not enablement, and does nothing for Windows, where the `.cmd`/`.ps1` wrappers
   lose the invocation name.
7. **`src/errors.ts` on the warm path** — 31.7 kB of message table, all of it parsed to
   print one line. The largest remaining warm-path win, and the reason the byte ceiling
   keeps moving.

## Decided, not open

* **§15.24's SHOULD** (a bare name or `*` via the registry's `latest` dist-tag) stays
  unhonoured: it would resolve against the last band's registry only, dropping the Yarn
  Classic candidates §04.1 step 6 unions in. Asserted by row 184, so changing it is a
  deliberate act.
* **§15.26 / row 190** reads as pin-versus-constraint — the only reading under which §09.4
  and rows 112–113 also hold.
* **§15.34's four declined requests** are adopted, not deferred.
* **§14.14's "to pack" wording** stays verbatim, because naming prioritises byte
  compatibility.
* **`ACCEPT_EXPIRED_KEY_WITH_WARNING`** (`src/verify/integrity.ts:57`) stays `false`: §13 row
  82 wants the strict answer. §14.4's lenient branch and that row are a live spec conflict,
  and it is what makes bare `yarn` fail online under `COREPACK_DEFAULT_TO_LATEST=1` when npm
  signs a packument with a key npm itself marks expired. §15.9's refresh does not help — the
  key is expired at the source.

## Standing hazards

* **The warm byte ceiling is a tripwire, not a budget** (`test/unit/main.test.ts`,
  now 238,000). Raising it is allowed; raising it silently is not. §15.28's bun and
  deno entries took it from 208,000 to 226,000 and cost a measured **+6,005 bytes
  (+7.5%)** in `dist/_warm.mjs` — by far the largest raise so far, and the first where
  the cost was code rather than prose. §15.21's `aube` then took it to 234,000 for
  **+1,964 bytes (+2.3%)**, which is what "the machinery is now paid for" turned out
  to be worth: a third of the cost for a comparable entry, and most of the source
  delta is the prose explaining the libc probe. `nub` then took it to 238,000 for
  **+919 bytes (+1.04%)** — pure table data, no new machinery, and it confirms the
  prediction the aube raise made. The accounting is in the test's own docstring.
  A further native entry needing no new host dimension should cost about the same.
* **A per-host digest is host-local, and references travel** (§15.28). Both places a
  reference is stored are copied between machines — `packageManager` is committed,
  `lastKnownGood.json` is baked into images and warmed caches — and §06.1 row 1 reads
  a reference-borne digest as an explicit pin, so a digest that travels turns the
  *correct* artifact into a hash mismatch on arrival.

  Two of the four sites now share a choke point: `store.referenceWithHash` is where a
  reference gains a digest, and it declines for a per-host name, which covers `use`,
  the auto-pin, and every `setLastKnownGood` caller at once. The other two are
  §07.6 step 3 (`install.ts`) and §04.5's default-version lookup (`registry.ts`), plus
  a repair-on-read in `getDefaultVersion` for files earlier builds poisoned. Rows 216,
  217, 220 and 221 guard them.

  Both §15.28 bugs that shipped were the *same* mistake in a place nothing pinned
  reaches — a bare `deno` with no project spec — so the whole conformance suite passed
  while the actual first-run experience failed. Prefer widening the choke point over
  adding a fifth site: anything that answers "does this reference get a digest?" a
  second way is the next bug.
* **The sandbox has live network and the conformance harness does not disable it.** A row
  relying on a fallback version can pass over the wire. Seed the store and set
  `COREPACK_ENABLE_NETWORK=0` wherever the answer must come from the fixture.
* **`.jup.lock` has no legacy spelling and must not grow one.** Corepack rejects ranges
  outright and has never written a lockfile of any name, so a `.corepack.lock` read path
  would be compatibility with a file that never existed — and a second `stat` on the range
  fast path.
* **`.corepack.env` is the opposite case and must not lose its fallback.** §14.24 renamed
  every other layout path outright, because nothing on disk could still be reached through
  them. This one can: it is a file real repositories have committed. The second `openat` per
  walked directory (`src/project/env.ts:363`) is the price, it is paid on the cold walk
  rather than the exact-pin fast path, and the upstream suite's ten-odd `.corepack.env` rows
  are what would go red if someone reclaimed it. Removing it is a deliberate act with a
  deprecation cycle, not a cleanup.
* **A plan organised by value will miss requirements.** Phase 2 shipped twelve items and
  left eight §15 sections unassigned. Walk the spec first, then rank.

## Not an engineering decision

**Bun's, Deno's, aube's, nub's and `node`'s maintainers have not been asked.** §15.21
and §15.28 both require a tool's maintainers to agree before an entry ships, and four
of the five are in the table now (§15.39's `node` is specified but not yet
implemented — see the item below). Bun's reportedly declined the same request from
corepack (#295). This is not a technical loose end and no further implementation work
resolves it; it is a conversation someone has to have before a release carries these
entries. Until then it is one more reason the item below stands.

aube is the one where the ask is least likely to be refused and most likely to be
*wanted*, since it is a package manager rather than a runtime and it is the only entry
whose names a bare `jup enable` claims — which makes asking more important, not less.

nub sits between the two groups and should be asked on its own terms: it is a package
manager, so the entry is squarely in scope, but its own installer owns `~/.nub/bin`
and its npm launcher rewrites the on-PATH entry that dispatched it into a native
trampoline. jup never installs that launcher, so the two do not collide today — but
that is a fact about nub's current implementation, not an agreement, and it is exactly
the kind of thing the maintainers should get to say something about.


`node` (§15.39) is the entry the spec now requires and the code does not have. What is
outstanding is the §02.5 row, `kind` on the definition, the four places §15.39 says
`kind` may be read (§03.3's `devEngines.runtime`, §03.4's refusal, §03.5's skipped
mismatch, §10.5's forced opt-out), §03.7's runtime write path, §12.12's message, and
rows 230–236. It needs no new host machinery: §15.28's launcher/artifact split,
`{target}`, `{exe}` and `exec: "native"` all carry over unchanged, so on the aube→nub
trend the warm-byte cost should be table data plus the `kind` branches, not a new
subsystem. `node`'s per-host packages are also the one launcher family published by
someone other than the project whose name it carries, which is the consent item above.

`package.json` is still `0.0.0` and nothing has been published. Shipping is not neutral: the
package installs a `corepack` bin alias, §15.33 moved yarn's compiled-in default from
Classic 1.x to Berry 4.x so a bare `yarn` in an unpinned project behaves differently from
corepack's, and the table now ships four entries whose maintainers have not been consulted.
All of it is deliberate and documented; all of it wants a human to agree before a release
carries them.
