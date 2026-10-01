/**
 * Minimal, self-contained repro of the scriptc divergence that makes a compiled
 * jup answer *wrong* rather than fail. Nothing here imports jup.
 *
 *   node --experimental-strip-types scripts/scriptc/regex-repro.ts
 *   npx scriptc build scripts/scriptc/regex-repro.ts -o /tmp/repro && /tmp/repro
 *
 * A capture group that did not participate reads `""`, where ECMA-262
 * (RegExp.prototype.exec, step 28) specifies `undefined`:
 *
 *   node     PARTIAL 4 => ["4","4",null,null]
 *   scriptc  PARTIAL 4 => ["4","4","",""]
 *
 * `src/version/semver.ts` reads an absent component as "wildcard"
 * (`isWildcard(match[2])`, and `match[1] ?? "="` on the operator path). `""` is
 * not absent and not a wildcard, so it falls through to `toNumber("")` and every
 * partial range — `^4`, `9.x`, `*`, `>=18 <21` — becomes a parse failure. The
 * binary links, runs, exits 0, and reports those ranges invalid.
 */

const NUM = String.raw`0|[1-9]\d*`;
const NUM_OR_X = String.raw`(?:${NUM}|x|X|\*)`;
const PARTIAL_RE = new RegExp(
  String.raw`^[v=]*(${NUM_OR_X})(?:\.(${NUM_OR_X}))?(?:\.(${NUM_OR_X}))?$`,
);

for (const input of ["10.0.0", "4", "9.x", "*", "18"]) {
  const match = PARTIAL_RE.exec(input);
  console.log(`PARTIAL ${input.padEnd(7)} =>`, JSON.stringify(match && [...match]));
}
