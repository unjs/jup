/**
 * §16, Built-in table and trust keys — keep the embedded table (§02.5) and
 * trust store (§02.6) from rotting.
 *
 * The table goes stale in three ways, and only two of them can be automated:
 * package managers publish new versions, npm rotates its signing keys, and bin
 * paths move between majors. This script does the first two and prints a notice
 * for the third, because a new `ranges` entry needs human review.
 *
 * This is why it exists rather than being someone's calendar reminder: a
 * compiled-in `default` pointing at a release unsupported for six years —
 * corepack shipped Yarn Classic 1.22.22 as yarn's default until #812 — is "a
 * maintenance failure, not a compatibility guarantee".
 *
 * **Every `default` this writes is hash-pinned, and the digest is taken from the
 * artifact this script actually downloaded.** §02.5 requires the pin and §06.1
 * enforces it at install time, so a `default` written from a version number
 * alone would be refused on every machine with no `lastKnownGood.json` — that
 * is, every fresh install. Nothing here trusts a digest it was merely told.
 *
 * Usage:
 *   node scripts/refresh-table.mjs           # rewrite in place
 *   node scripts/refresh-table.mjs --check   # exit 1 if anything is stale
 *
 * The workflow that runs it opens a PR and does **not** auto-merge: a bad
 * `default` bricks every machine that has no recorded default of its own.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareDigest, parseSri, verifySignature } from "../src/verify/integrity.ts";

const SRC = join(import.meta.dirname, "..", "src", "config");
const TABLE = join(SRC, "table.ts");
const KEYS = join(SRC, "keys.ts");

const NPM_REGISTRY = "https://registry.npmjs.org";
const check = process.argv.includes("--check");

/** Every rewrite this run wants to make, for the summary and for `--check`. */
const changes = [];

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  return response.json();
}

async function getBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function digest(bytes, algo) {
  return createHash(algo).update(bytes).digest("hex");
}

/**
 * An npm-published package manager: the `latest` dist-tag, pinned to the sha512
 * of bytes this script **verified**, not to a digest it was told.
 *
 * The chain is §06's, run in the same order and with the same code the tool
 * uses at install time:
 *
 * 1. npm's ECDSA signature over `<pkg>@<version>:<integrity>`, checked against
 *    the embedded trust store (§06.3). A registry that cannot produce one has
 *    nothing to say about what it published.
 * 2. the downloaded tarball against that signed `dist.integrity` (§06.1 row 2).
 * 3. only then, the sha512 of those same bytes, which is the form §02.5's
 *    `default` takes.
 *
 * sha512 rather than sha1 for two reasons. §06.2 warns about weak *user* pins,
 * and a default that would trip that warning is the tool scolding the user
 * about an algorithm it picked for them. More practically it is the digest
 * `use` writes, taken from the registry's own `dist.integrity`, so matching it
 * keeps a bare `yarn` and a pinned project on **one** store directory instead
 * of colliding into §07.2's pin-qualified one on the common path.
 *
 * Writing a `default` any other way would put an unverified digest in the one
 * place §06.1 has no second opinion about: a machine with no
 * `lastKnownGood.json` has nothing but this literal to check its first download
 * against.
 */
async function npmDefault(packageName) {
  const metadata = await getJson(`${NPM_REGISTRY}/${packageName}/latest`);
  const { version, dist } = metadata;
  if (dist?.integrity === undefined) {
    throw new Error(`${packageName}@${version} publishes no dist.integrity`);
  }

  verifySignature({
    signatures: dist.signatures,
    integrity: dist.integrity,
    packageName,
    version,
    registryOrigin: NPM_REGISTRY,
  });

  const tarball = await getBytes(dist.tarball);
  const expected = parseSri(dist.integrity);
  if (!compareDigest(expected.hex, digest(tarball, expected.algo))) {
    throw new Error(`${packageName}@${version} does not match its signed dist.integrity`);
  }

  return `${version}+sha512.${digest(tarball, "sha512")}`;
}

/**
 * §02.3 — a per-host package manager, whose `default` is a **bare version**.
 *
 * There is no one digest to pin: `bun@1.4.0` is six different artifacts, and a
 * literal here would be whichever machine ran this script. So the chain above
 * does not apply, and what replaces it is a different question — not "are these
 * bytes the ones npm signed?" but "does this version actually have a build for
 * every host the table claims?" A `default` naming a version some host cannot
 * install is the same maintenance failure, arriving one platform at a time.
 *
 * Metadata only, deliberately: the artifacts are 60–100 MB each and nothing is
 * compiled in from them, so downloading six of them would buy a digest this
 * table does not carry. The signature over each host's `dist.integrity` is
 * checked because it is free — it comes in the packument — and because it is
 * what the tool will check at install time (§06.3).
 */
async function nativeDefault(launcher, artifactFor, pinnedVersion) {
  const version = pinnedVersion ?? (await getJson(`${NPM_REGISTRY}/${launcher}/latest`)).version;

  await Promise.all(
    Object.values(artifactFor).map(async (packageName) => {
      const metadata = await getJson(`${NPM_REGISTRY}/${packageName}/${version}`);
      const dist = metadata?.dist;
      if (dist?.integrity === undefined) {
        throw new Error(`${packageName}@${version} publishes no dist.integrity`);
      }
      verifySignature({
        signatures: dist.signatures,
        integrity: dist.integrity,
        packageName,
        version,
        registryOrigin: NPM_REGISTRY,
      });
    }),
  );

  return version;
}

/**
 * §02.5 — the major line jup ships as pnpm's compiled-in `default`.
 *
 * pnpm is the only entry whose `default` is not simply the `latest` dist-tag.
 * Upstream still points `latest` at the 11 line while publishing 12 under
 * `next-12`, and jup ships the 12 line deliberately, so the version is resolved
 * from the published set rather than from a tag that would drag it back. Move
 * this number to adopt a later line; delete the special case and fall back to
 * `npmDefault("pnpm")` once `latest` catches up and the line is JS again —
 * which it will not be, since 12 is where pnpm went native.
 */
const PNPM_LINE = 12;

/**
 * §02.5 — pnpm's `default`, pinned the way its **band** requires.
 *
 * This is the one tool that crosses §02.4's JS/native line at a major boundary,
 * and the pin style has to cross with it. Below 12 the bytes are the `pnpm` npm
 * tarball and the default is hash-pinned like npm's and yarn's; from 12 the
 * bytes are `@pnpm/exe.<host>` and there is no single digest to write, so the
 * default is a bare version like bun's and deno's.
 *
 * Getting this wrong is not a cosmetic error. A hash-pinned `12.x` default would
 * carry the digest of a tarball that is never downloaded on that band, and §06.1
 * row 1 reads a digest-bearing reference as an explicit pin — so the correct
 * per-host artifact would be **refused**, on every machine with no
 * `lastKnownGood.json` of its own. That is precisely why `referenceWithHash`
 * refuses to attach a per-host digest at runtime (§07.6); this is the same rule
 * applied to the compiled-in literal.
 */
async function pnpmDefault() {
  const packument = await getJson(`${NPM_REGISTRY}/pnpm`);
  const stable = new RegExp(`^${PNPM_LINE}\\.(\\d+)\\.(\\d+)$`);
  const line = Object.keys(packument.versions ?? {})
    .map((version) => [version, stable.exec(version)])
    .filter(([, match]) => match !== null)
    .map(([version, match]) => [version, Number(match[1]), Number(match[2])])
    .sort((a, b) => a[1] - b[1] || a[2] - b[2]);

  if (line.length === 0) throw new Error(`pnpm publishes no stable ${PNPM_LINE}.x release`);
  const version = line[line.length - 1][0];

  // The band decides the pin, not the caller. Reading it from the table would
  // make the check circular (see {@link NATIVE_TARGETS}), so the boundary is
  // named here and asserted against the table by `pnpm test`.
  return PNPM_LINE >= 12
    ? await nativeDefault("pnpm", NATIVE_TARGETS.pnpm, version)
    : await npmDefault("pnpm");
}

/**
 * The host sets §02.5's newest per-host bands declare.
 *
 * Duplicated from the table rather than imported: `nativeDefault` is checking
 * that the *newest* release covers what the newest band promises, and reading
 * the promise from the same file it is about would make the check circular for
 * the one edit — a target quietly dropped — it exists to catch.
 */
const NATIVE_TARGETS = {
  bun: {
    "darwin-arm64": "@oven/bun-darwin-aarch64",
    "darwin-x64": "@oven/bun-darwin-x64",
    "linux-arm64": "@oven/bun-linux-aarch64",
    "linux-arm64-musl": "@oven/bun-linux-aarch64-musl",
    "linux-x64": "@oven/bun-linux-x64",
    "linux-x64-musl": "@oven/bun-linux-x64-musl",
    "win32-arm64": "@oven/bun-windows-aarch64",
    "win32-x64": "@oven/bun-windows-x64",
  },
  deno: {
    "darwin-arm64": "@deno/darwin-arm64",
    "darwin-x64": "@deno/darwin-x64",
    "linux-arm64": "@deno/linux-arm64-glibc",
    "linux-x64": "@deno/linux-x64-glibc",
    "win32-arm64": "@deno/win32-arm64",
    "win32-x64": "@deno/win32-x64",
  },
  // aube publishes no `darwin-x64`, so the absence is declared here too — the
  // check is "does the newest release cover what the newest band promises?", and
  // listing a host the band does not is how this script would start failing on a
  // package that has never existed.
  // §02.5 — pnpm is the one entry that *crosses* into a per-host band at a major
  // boundary rather than having been born on one side of it, so its targets are
  // consulted only when the tracked line is native. `@pnpm/exe.<host>` names the
  // host directly, so this map is the table's identity map with the scope added.
  pnpm: {
    "darwin-arm64": "@pnpm/exe.darwin-arm64",
    "darwin-x64": "@pnpm/exe.darwin-x64",
    "linux-arm64": "@pnpm/exe.linux-arm64",
    "linux-arm64-musl": "@pnpm/exe.linux-arm64-musl",
    "linux-x64": "@pnpm/exe.linux-x64",
    "linux-x64-musl": "@pnpm/exe.linux-x64-musl",
    "win32-arm64": "@pnpm/exe.win32-arm64",
    "win32-x64": "@pnpm/exe.win32-x64",
  },
  aube: {
    "darwin-arm64": "@endevco/aube-darwin-arm64",
    "linux-arm64": "@endevco/aube-linux-arm64",
    "linux-arm64-musl": "@endevco/aube-linux-arm64-musl",
    "linux-x64": "@endevco/aube-linux-x64",
    "linux-x64-musl": "@endevco/aube-linux-x64-musl",
    "win32-arm64": "@endevco/aube-win32-arm64",
    "win32-x64": "@endevco/aube-win32-x64",
  },
  nub: {
    "darwin-arm64": "@nubjs/nub-darwin-arm64",
    "darwin-x64": "@nubjs/nub-darwin-x64",
    "linux-arm64": "@nubjs/nub-linux-arm64",
    "linux-arm64-musl": "@nubjs/nub-linux-arm64-musl",
    "linux-x64": "@nubjs/nub-linux-x64",
    "linux-x64-musl": "@nubjs/nub-linux-x64-musl",
    "win32-arm64": "@nubjs/nub-win32-arm64",
    "win32-x64": "@nubjs/nub-win32-x64",
  },
};

/** Replace one `default:` literal inside a named package manager's block. */
function rewriteDefault(source, name, field, reference) {
  // The block runs from `<name>: {` to the next top-level entry, which is enough
  // context to keep `transparent.default` and `default` apart without parsing.
  // The opening newline stays in the body, so a `default` on the block's very
  // first line is still preceded by one.
  const block = new RegExp(`(\\n  ${name}: \\{)([\\s\\S]*?)(\\n  \\},\\n)`);
  const found = block.exec(source);
  if (found === null) throw new Error(`No ${name} block in ${TABLE}`);

  const body = found[2];
  // `transparent.default` is indented four spaces further than `default`.
  const indent = field === "transparent.default" ? "      " : "    ";
  // A sha512 reference does not fit beside its key at this indent, so the
  // formatter wraps it onto the next line. Both shapes have to be found, or the
  // rewrite silently stops matching the moment a value crosses the print width
  // — which is exactly what moving the table off sha1 did.
  const literal = new RegExp(`(\\n${indent}default:(?: |\\n${indent}  )")([^"]*)(")`);
  const current = literal.exec(body);
  if (current === null) throw new Error(`No ${name}.${field} in ${TABLE}`);
  if (current[2] === reference) return source;

  changes.push(`${name}.${field}: ${current[2]} -> ${reference}`);
  const rewritten = body.replace(
    literal,
    (_all, before, _old, after) => before + reference + after,
  );
  return source.replace(block, (_all, open, _body, close) => open + rewritten + close);
}

/**
 * §02.6 — npm's published signing keys, expired ones dropped.
 *
 * Shipping a key that has expired is dead weight at best: §06.5 refuses it at
 * verification time anyway, so the only thing it can do is make a rotation look
 * like it already happened.
 */
async function refreshKeys(source) {
  const { keys } = await getJson(`${NPM_REGISTRY}/-/npm/v1/keys`);
  const live = keys
    .filter((key) => key.expires === null || Date.parse(key.expires) > Date.now())
    .map((key) => ({
      expires: key.expires ?? null,
      keyid: key.keyid,
      keytype: key.keytype,
      scheme: key.scheme,
      key: key.key,
    }));

  if (live.length === 0) throw new Error(`${NPM_REGISTRY} published no unexpired keys`);

  const rendered = live
    .map(
      (key) =>
        `    {\n` +
        `      expires: ${key.expires === null ? "null" : JSON.stringify(key.expires)},\n` +
        `      keyid: ${JSON.stringify(key.keyid)},\n` +
        `      keytype: ${JSON.stringify(key.keytype)},\n` +
        `      scheme: ${JSON.stringify(key.scheme)},\n` +
        `      key: ${JSON.stringify(key.key)},\n` +
        `    },`,
    )
    .join("\n");

  const block = /(\n  \[DEFAULT_REGISTRY\]: \[\n)([\s\S]*?)(\n  \],\n)/;
  const found = block.exec(source);
  if (found === null) throw new Error(`No trust-store block in ${KEYS}`);
  if (found[2] === rendered) return source;

  changes.push(`trust store: ${live.map((key) => key.keyid).join(", ")}`);
  return source.replace(block, (_all, open, _body, close) => open + rendered + close);
}

let table = readFileSync(TABLE, "utf8");
const [npm, pnpm, yarn, bun, deno, aube, nub] = await Promise.all([
  npmDefault("npm"),
  pnpmDefault(),
  // §02.5 — Berry is an npm package now, so it takes the same verified path as
  // npm and pnpm. It used to need a branch of its own: `repo.yarnpkg.com` published
  // no signature and no digest, so the pin written here rested on TLS alone, and
  // §16, Built-in table and trust keys' "do not auto-merge" existed largely
  // for that one line.
  npmDefault("@yarnpkg/cli-dist"),
  nativeDefault("bun", NATIVE_TARGETS.bun),
  nativeDefault("deno", NATIVE_TARGETS.deno),
  nativeDefault("@endevco/aube", NATIVE_TARGETS.aube),
  nativeDefault("@nubjs/nub", NATIVE_TARGETS.nub),
]);

table = rewriteDefault(table, "npm", "default", npm);
table = rewriteDefault(table, "pnpm", "default", pnpm);
// §04.6: both of yarn's defaults track the supported major. They are
// separate fields because the transparent one is floored against the user's
// recorded default, not because they may name different releases.
table = rewriteDefault(table, "yarn", "default", yarn);
table = rewriteDefault(table, "yarn", "transparent.default", yarn);
table = rewriteDefault(table, "bun", "default", bun);
table = rewriteDefault(table, "deno", "default", deno);
table = rewriteDefault(table, "aube", "default", aube);
table = rewriteDefault(table, "nub", "default", nub);

const keys = await refreshKeys(readFileSync(KEYS, "utf8"));

/**
 * §02.3 — `node`'s `lts` is the one table value this script cannot compute.
 *
 * npm's `node` dist-tags stop at `v20-lts` (20.11.1) while the same package
 * publishes 22.x and 24.x, so no query over them yields the line actually in
 * maintenance, and §02.2 rules out reaching for `nodejs.org/dist/index.json` to
 * get it. So it is flagged, never rewritten: a human checks it against Node's
 * release schedule, exactly as §16 says a human checks a `ranges` change.
 */
function reviewNodeLts(source) {
  const current = /tags:\s*\{\s*lts:\s*"([^"]+)"/.exec(source)?.[1];
  if (current === undefined) {
    console.warn("! node has no `tags.lts`; §02.3 requires one.");
    return;
  }
  console.log(`review: node tags.lts is ${current} — confirm against Node's LTS schedule (§02.3).`);
}

reviewNodeLts(table);

if (changes.length === 0) {
  console.log("The embedded table and trust store are current.");
  process.exit(0);
}

for (const change of changes) console.log(change);

if (check) {
  console.error(`\n${changes.length} item(s) are stale; run 'node scripts/refresh-table.mjs'.`);
  process.exit(1);
}

writeFileSync(TABLE, table);
writeFileSync(KEYS, keys);
console.log(
  "\nRewritten. A bin-path change still needs a new `ranges` entry and human review (§16, Built-in table and trust keys).",
);
