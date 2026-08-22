/**
 * §16.9 — keep the embedded table (§02.5) and trust store (§02.6) from rotting.
 *
 * The table goes stale in three ways, and only two of them can be automated:
 * package managers publish new versions, npm rotates its signing keys, and bin
 * paths move between majors. This script does the first two and prints a notice
 * for the third, because a new `ranges` entry needs human review.
 *
 * §15.33 is why this exists rather than being someone's calendar reminder: a
 * compiled-in `default` pointing at a release unsupported for six years —
 * corepack shipped Yarn Classic 1.22.22 as yarn's default until #812 — is "a
 * maintenance failure, not a compatibility guarantee".
 *
 * **Every `default` this writes is hash-pinned, and the digest is taken from the
 * artifact this script actually downloaded.** §02.5 requires the pin and §15.11
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
import { compareDigest, parseSri, verifySignature } from "../src/integrity.ts";

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
 * An npm-published package manager: the `latest` dist-tag, pinned to the sha1 of
 * bytes this script **verified**, not to a digest it was told.
 *
 * The chain is §06's, run in the same order and with the same code the tool
 * uses at install time:
 *
 * 1. npm's ECDSA signature over `<pkg>@<version>:<integrity>`, checked against
 *    the embedded trust store (§06.3). A registry that cannot produce one has
 *    nothing to say about what it published.
 * 2. the downloaded tarball against that signed `dist.integrity` (§06.1 row 2).
 * 3. only then, the sha1 of those same bytes, which is the form §02.5's
 *    `default` takes.
 *
 * Writing a `default` any other way would put an unverified digest in the one
 * place §15.11 has no second opinion about: a machine with no
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

  return `${version}+sha1.${digest(tarball, "sha1")}`;
}

/**
 * Yarn Berry, which is not an npm artifact: `repo.yarnpkg.com/tags` publishes
 * the `stable` alias, and the artifact is a single `.js` file. sha224 matches
 * upstream's own convention for this one (§16.9), and §02.5 already ships it.
 *
 * **This one cannot be verified the way the npm path is.** `repo.yarnpkg.com`
 * publishes no signatures and no digests at all — that is §06.6's recorded hole
 * and the whole of what §15.11 refuses to install unpinned — so the digest here
 * rests on TLS alone. That is precisely why §16.9 says not to auto-merge: a
 * human comparing the proposed version against Yarn's own release notes is the
 * only check this line gets.
 */
async function yarnDefault() {
  const tags = await getJson("https://repo.yarnpkg.com/tags");
  const version = tags.aliases.stable;
  const file = await getBytes(
    `https://repo.yarnpkg.com/${version}/packages/yarnpkg-cli/bin/yarn.js`,
  );
  return `${version}+sha224.${digest(file, "sha224")}`;
}

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
  const literal = new RegExp(`(\\n${indent}default: ")([^"]*)(")`);
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
 * §14.4 — npm's published signing keys, expired ones dropped.
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
const [npm, pnpm, yarn] = await Promise.all([npmDefault("npm"), npmDefault("pnpm"), yarnDefault()]);

table = rewriteDefault(table, "npm", "default", npm);
table = rewriteDefault(table, "pnpm", "default", pnpm);
// §15.33 bullet 2: both of yarn's defaults track the supported major. They are
// separate fields because bullet 1 floors the transparent one against the user's
// recorded default, not because they may name different releases.
table = rewriteDefault(table, "yarn", "default", yarn);
table = rewriteDefault(table, "yarn", "transparent.default", yarn);

const keys = await refreshKeys(readFileSync(KEYS, "utf8"));

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
  "\nRewritten. A bin-path change still needs a new `ranges` entry and human review (§16.9).",
);
