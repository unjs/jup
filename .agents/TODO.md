## Open work

1. **§15.4's expired / not-yet-valid certificate branch** is tested by error code only
   (`test/unit/tls.test.ts:256` maps `CERT_HAS_EXPIRED` and `CERT_NOT_YET_VALID` onto the
   sentence). The committed fixture is valid until 2126, so nothing presents an expired
   certificate over a real socket; an end-to-end row needs a second, expired one.
2. **Row 221 has no conformance test.** §15.38 specifies it — a `lastKnownGood.json` whose
   per-host entry carries a digest an earlier build wrote heals on read, the file is
   rewritten, and the run makes no network request. The behaviour is implemented
   (`src/version/resolve.ts:202`) and unit-tested (`test/unit/resolve.test.ts:715`, `:734`),
   but `test/conformance/15-21-native-entries.test.ts` jumps 220 -> 222. Rows 216, 217 and
   220 cover the other §15.28 digest sites; this is the one hole in that set, and §15.28's
   two shipped bugs were both in a place the suite did not reach.
3. **`src/errors.ts` on the warm path** — 36.8 kB of message table, all of it parsed to
   print one line. The largest remaining warm-path win, and the reason the byte ceiling
   keeps moving.

## Before a release

**Bun's, Deno's, aube's, nub's and `node`'s maintainers have not been asked.** §15.21 and
§15.28 both require a tool's maintainers to agree before an entry ships, and all five are in
the table now. Bun's reportedly declined the same request from corepack (#295). No further
implementation work resolves this; it is a conversation someone has to have.

aube is the one where the ask is least likely to be refused and most likely to be *wanted*,
since it is a package manager rather than a runtime and it is the only entry whose names a
bare `jup enable` claims — which makes asking more important, not less.

nub sits between the two groups and should be asked on its own terms: it is a package
manager, so the entry is squarely in scope, but its own installer owns `~/.nub/bin` and its
npm launcher rewrites the on-PATH entry that dispatched it into a native trampoline. jup
never installs that launcher, so the two do not collide today — but that is a fact about
nub's current implementation, not an agreement, and it is exactly the kind of thing the
maintainers should get to say something about.

`node`'s per-host packages are also the one launcher family published by someone other than
the project whose name it carries — `node` on npm is a community package, and
`node-bin-setup` is what the `{target}` map's three renames come from. So the ask has a
different addressee here than for the other four, and it is a smaller one: jup fetches the
same per-host packages that installer fetches, without running it.

`package.json` is still `0.0.0` and nothing has been published. Shipping is not neutral: the
package installs a `corepack` bin alias, §15.33 moved yarn's compiled-in default from
Classic 1.x to Berry 4.x so a bare `yarn` in an unpinned project behaves differently from
corepack's, and the table ships five entries whose maintainers have not been consulted. All
of it is deliberate and documented; all of it wants a human to agree before a release
carries them.
