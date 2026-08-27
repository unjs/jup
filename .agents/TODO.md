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

* **The warm byte ceiling is a tripwire, not a budget** (`test/unit/main.test.ts:1017`,
  204,000). Raising it is allowed; raising it silently is not.
* **The sandbox has live network and the conformance harness does not disable it.** A row
  relying on a fallback version can pass over the wire. Seed the store and set
  `COREPACK_ENABLE_NETWORK=0` wherever the answer must come from the fixture.
* **`.jup.lock` has no legacy spelling and must not grow one.** Corepack rejects ranges
  outright and has never written a lockfile of any name, so a `.corepack.lock` read path
  would be compatibility with a file that never existed — and a second `stat` on the range
  fast path.
* **A plan organised by value will miss requirements.** Phase 2 shipped twelve items and
  left eight §15 sections unassigned. Walk the spec first, then rank.

## Not an engineering decision

`package.json` is still `0.0.0` and nothing has been published. Shipping is not neutral: the
package installs a `corepack` bin alias, and §15.33 moved yarn's compiled-in default from
Classic 1.x to Berry 4.x, so a bare `yarn` in an unpinned project behaves differently from
corepack's. Both are deliberate and documented; both want a human to agree before a release
carries them.
