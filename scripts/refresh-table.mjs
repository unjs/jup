/**
 * §16, Built-in table and trust keys — keep the embedded table (§02.5) and
 * trust store (§02.6) from rotting.
 *
 * The table goes stale in four ways, and only two of them can be automated:
 * package managers publish new versions, npm rotates its signing keys, bin paths
 * move between majors, and Node moves LTS to a new major. This script does the
 * first two — for every entry, node included — and prints a notice for the last
 * two, because a new `ranges` entry and a new LTS line both need human review.
 *
 * It also writes every sanctioned copy of a table value that lives outside
 * `src/config/`: the two bootstrap installers ({@link stampInstallers}) and the
 * unit suite's `default` literals ({@link stampReviewGates}). A refresh is one
 * command and one PR, never a command followed by a hunt for what it left
 * behind.
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
 * Usage (`pnpm refresh` runs the same thing, and is what CI runs):
 *   pnpm refresh              # rewrite in place
 *   pnpm refresh --commit     # rewrite, then commit exactly what was rewritten
 *   pnpm refresh --check      # write nothing; exit 1 if anything is stale
 *
 * The workflow that runs it opens a PR and does **not** auto-merge: a bad
 * `default` bricks every machine that has no recorded default of its own.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareDigest, parseSri, verifySignature } from "../src/verify/integrity.ts";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "src", "config");
const TABLE = join(SRC, "table.ts");
const KEYS = join(SRC, "keys.ts");

// The unit suite's review gates. Stamped, not authored: see
// {@link stampReviewGates}.
const CONFIG_TEST = join(ROOT, "test", "unit", "config.test.ts");

// The two bootstrap installers. They are stamped, not authored: see
// {@link stampInstallers}.
const PUBLIC = join(ROOT, "docs", "public");
const INSTALL_SH = join(PUBLIC, "install.sh");
const INSTALL_PS1 = join(PUBLIC, "install.ps1");

const NPM_REGISTRY = "https://registry.npmjs.org";
const check = process.argv.includes("--check");
const commit = process.argv.includes("--commit");

if (check && commit) {
  console.error(
    "--check and --commit are opposites: one refuses to write, the other writes twice.",
  );
  process.exit(2);
}

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
 * The newest stable `<line>.x.y` a packument holds.
 *
 * Two entries pick a `default` from a **line** rather than from `latest`, for
 * unrelated reasons — pnpm because upstream's tag lags the line jup ships
 * ({@link PNPM_LINE}), node because npm's tags cannot name an LTS at all
 * ({@link NODE_LTS_LINE}) — and both want the same answer from the same data:
 * the highest release on that major, prereleases excluded.
 */
function newestOnLine(packument, line, name) {
  const stable = new RegExp(`^${line}\\.(\\d+)\\.(\\d+)$`);
  const found = Object.keys(packument.versions ?? {})
    .map((version) => [version, stable.exec(version)])
    .filter(([, match]) => match !== null)
    .map(([version, match]) => [version, Number(match[1]), Number(match[2])])
    .sort((a, b) => a[1] - b[1] || a[2] - b[2]);

  if (found.length === 0) throw new Error(`${name} publishes no stable ${line}.x release`);
  return found[found.length - 1][0];
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
  const version = newestOnLine(packument, PNPM_LINE, "pnpm");

  // The band decides the pin, not the caller. Reading it from the table would
  // make the check circular (see {@link NATIVE_TARGETS}), so the boundary is
  // named here and asserted against the table by `pnpm test`.
  return PNPM_LINE >= 12
    ? await nativeDefault("pnpm", NATIVE_TARGETS.pnpm, version)
    : await npmDefault("pnpm");
}

/**
 * §02.3 — the LTS line jup ships as node's compiled-in `default` and answers
 * `node@lts` with.
 *
 * This is the one number in this file a release cannot compute, and the reason
 * is npm's, not ours: the `node` package's dist-tags stop at `v20-lts` (20.11.1)
 * while the same package publishes 22.x and 24.x, so every reading of them names
 * a line two majors stale. `nodejs.org/dist/index.json` knows the answer and is
 * exactly the second source §02.2 refuses.
 *
 * So the *line* is the review gate and the *patch* is not: a human moves this
 * number when Node's release schedule moves LTS, and the script keeps the table
 * on that line's newest release in between. {@link reviewNodeLine} prints the
 * question on every run.
 */
const NODE_LTS_LINE = 24;

/**
 * §02.3 — node's `default`, and the `lts` tag that names the same release.
 *
 * Bare, like bun's and deno's and for the same reason (§07.6): node's artifact
 * is per-host, so there is no portable digest to pin, and the check that
 * replaces one is {@link nativeDefault}'s — does every host the table promises
 * actually have a signed build of this release?
 *
 * `tags.lts` moves with `default` because they answer the same question. §02.3
 * makes `default` "the current LTS line", so a `default` the `lts` tag did not
 * name would mean `jup use node` and `jup use node@lts` installing two Nodes.
 */
async function nodeDefault() {
  const packument = await getJson(`${NPM_REGISTRY}/node`);
  const version = newestOnLine(packument, NODE_LTS_LINE, "node");
  return await nativeDefault("node", NATIVE_TARGETS.node, version);
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
  // §02.3 — three of node's six are renames: the packages are
  // `node-<platform>-<arch>` with `win32` spelled `win`, and on Apple Silicon the
  // prefix is `node-bin-` because `node-darwin-arm64` belongs to an unrelated
  // publisher.
  node: {
    "darwin-arm64": "node-bin-darwin-arm64",
    "darwin-x64": "node-darwin-x64",
    "linux-arm64": "node-linux-arm64",
    "linux-x64": "node-linux-x64",
    "win32-arm64": "node-win-arm64",
    "win32-x64": "node-win-x64",
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
 * Replace one `tags: { <tag>: "…" }` literal inside a named entry's block.
 *
 * Separate from {@link rewriteDefault} because the shapes differ, not because
 * the values do: `tags` is an inline object, so the key being rewritten is not
 * at a predictable indent and the `default` matcher would not see it.
 */
function rewriteTag(source, name, tag, reference) {
  const block = new RegExp(`(\\n  ${name}: \\{)([\\s\\S]*?)(\\n  \\},\\n)`);
  const found = block.exec(source);
  if (found === null) throw new Error(`No ${name} block in ${TABLE}`);

  const body = found[2];
  const literal = new RegExp(`(tags: \\{ ${tag}: ")([^"]*)(")`);
  const current = literal.exec(body);
  if (current === null) throw new Error(`No ${name}.tags.${tag} in ${TABLE}`);
  if (current[2] === reference) return source;

  changes.push(`${name}.tags.${tag}: ${current[2]} -> ${reference}`);
  const rewritten = body.replace(
    literal,
    (_all, before, _old, after) => before + reference + after,
  );
  return source.replace(block, (_all, open, _body, close) => open + rewritten + close);
}

/** One `default:` literal read back out, for the installers to be stamped with. */
function readDefault(source, name) {
  const block = new RegExp(`\\n  ${name}: \\{([\\s\\S]*?)\\n  \\},\\n`).exec(source);
  if (block === null) throw new Error(`No ${name} block in ${TABLE}`);
  const value = /\n    default:(?: |\n      )"([^"]*)"/.exec(block[1]);
  if (value === null) throw new Error(`No ${name}.default in ${TABLE}`);
  return value[1];
}

/** The default registry's keys, in the order {@link refreshKeys} left them. */
function readTrustKeys(source) {
  const block = /\n  \[DEFAULT_REGISTRY\]: \[\n([\s\S]*?)\n  \],\n/.exec(source);
  if (block === null) throw new Error(`No trust-store block in ${KEYS}`);
  const found = [...block[1].matchAll(/\n      key: "([^"]*)",/g)].map((match) => match[1]);
  if (found.length === 0) throw new Error(`No keys in ${KEYS}`);
  return found;
}

/**
 * Rewrite the one capture group `pattern` finds in `source`, and record it.
 *
 * The single-capture shape is the contract every stamped copy of a table value
 * shares: a pattern that matches more than one place, or none, is a stamper that
 * has quietly stopped stamping, so both are errors rather than no-ops.
 */
function stamp(path, source, label, pattern, value) {
  const found = pattern.exec(source);
  if (found === null) throw new Error(`No ${label} in ${path}`);
  if (found[1] === value) return source;
  changes.push(`${label}: ${found[1]} -> ${value}`);
  return source.replace(pattern, (all) => all.replace(found[1], value));
}

/**
 * §16 — the two installers carry copies of table values, and this is what keeps
 * them from becoming a second source of them.
 *
 * `docs/public/install.{sh,ps1}` bootstrap a machine that has no Node at all, so
 * they run before there is a jup to ask what version it wants; the version has
 * to be a literal in the script. Which makes it exactly the thing §16 says table
 * data must not become — a hand-maintained copy — unless something stamps it.
 *
 * Both values matter for a reason, and neither is cosmetic:
 *
 * * `NODE_VERSION` naming anything but `node.default` is a duplicate download.
 *   The installer's copy would satisfy nothing jup later resolves, so the first
 *   real command fetches ~200 MB of a *second* Node beside the first.
 * * `NPM_TRUST_KEYS` is §02.6's store, which `install.sh` verifies the download's
 *   npm signature against before promoting it into the store (§06.1). A key left
 *   behind by a rotation stops that check succeeding, and the installer quietly
 *   falls back to a placement jup has to re-download.
 *
 * `install.ps1` takes the version only: it does not write a store entry, because
 * it cannot run the signature check (see its own header).
 */
function stampInstallers(table, keys) {
  const version = readDefault(table, "node");
  const trusted = readTrustKeys(keys).join(" ");

  let sh = readFileSync(INSTALL_SH, "utf8");
  sh = stamp(INSTALL_SH, sh, "install.sh NODE_VERSION", /^NODE_VERSION=(.*)$/m, version);
  sh = stamp(INSTALL_SH, sh, "install.sh NPM_TRUST_KEYS", /^NPM_TRUST_KEYS="([^"]*)"$/m, trusted);

  let ps1 = readFileSync(INSTALL_PS1, "utf8");
  ps1 = stamp(INSTALL_PS1, ps1, "install.ps1 nodeVersion", /^\$nodeVersion = '([^']*)'$/m, version);

  return { sh, ps1 };
}

/**
 * §13 — the three assertions in `test/unit/config.test.ts` that name a `default`
 * outright, kept honest the same way the installers are.
 *
 * They are literals on purpose and must stay literals: `expect(yarn.default)
 * .toBe(yarn.transparent.default)` is a tautology that passes just as well
 * against a table that has drifted back to Yarn Classic, and the aube and nub
 * rows are what makes a `default` change something a human has to look at rather
 * than something that lands in a diff nobody reads. What the literal must not be
 * is *hand-maintained*: a refresh that leaves them behind fails the suite it was
 * supposed to be checked by, and the fix is then a second manual edit made under
 * a red build. So the script writes them and the PR shows them.
 */
function stampReviewGates(table) {
  let source = readFileSync(CONFIG_TEST, "utf8");

  // Yarn's is the wrapped `const supported = "…"` both of its fields compare
  // against; §02.5 keeps `default` and `transparent.default` on one release.
  source = stamp(
    CONFIG_TEST,
    source,
    "config.test.ts yarn default",
    /const supported =\n\s+"([^"]*)";/,
    readDefault(table, "yarn"),
  );

  for (const name of ["aube", "nub"]) {
    source = stamp(
      CONFIG_TEST,
      source,
      `config.test.ts ${name} default`,
      new RegExp(`expect\\(DEFINITIONS\\.${name}!\\.default\\)\\.toBe\\("([^"]*)"\\)`),
      readDefault(table, name),
    );
  }

  return source;
}

/**
 * `git` in the repository this script lives in, output captured **verbatim**.
 *
 * Untrimmed on purpose: `status --porcelain` puts the two status columns in the
 * first two bytes, and an unstaged modification's first byte is a space, so a
 * convenience trim here silently eats the first character of the first path.
 */
function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

/**
 * §16 — the two refusals `--commit` owes the "human review of generated
 * changes" rule, both about not signing someone else's work.
 *
 * A file this run is about to write that was *already* modified cannot produce a
 * commit which is only this run's doing, and the hand edit it would swallow is
 * precisely the kind §16 wants looked at — `NODE_LTS_LINE` moving to a new major
 * is the common one. A `--commit` outside a work tree is a flag that would
 * otherwise do nothing quietly.
 *
 * Both stop the run *before* anything is written, so a refusal leaves the tree
 * exactly as it was found.
 */
function assertCommittable(paths) {
  const refuse = (reason) => {
    console.error(`\n${reason}`);
    process.exit(1);
  };

  try {
    git("rev-parse", "--is-inside-work-tree");
  } catch {
    refuse(`--commit needs a git work tree; ${ROOT} is not inside one.`);
  }

  const dirty = git("status", "--porcelain", "--", ...paths)
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.slice(3));

  if (dirty.length > 0) {
    refuse(
      `--commit would swallow uncommitted changes to:\n  ${dirty.join("\n  ")}\n` +
        "Commit or revert those first, then refresh (nothing has been written).",
    );
  }
}

/**
 * §16 — `--commit`, so a refresh is one command and the commit says what the
 * run said.
 *
 * The message body is {@link changes} verbatim: every line the run printed is a
 * value that moved, which is exactly what a reviewer of a table refresh needs in
 * `git log` and what the PR quotes back. Nothing is invented for it.
 *
 * The commit is pathspec-limited to the files this script wrote, so an unrelated
 * staged change stays staged and unrelated work in the tree stays in the tree.
 */
function commitRefresh(paths) {
  execFileSync("git", ["commit", "--quiet", "--file", "-", "--", ...paths], {
    cwd: ROOT,
    input: `chore: refresh the built-in table\n\n${changes.join("\n")}\n`,
  });
  return git("rev-parse", "--short", "HEAD").trim();
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
const [npm, pnpm, yarn, bun, deno, aube, nub, node] = await Promise.all([
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
  nodeDefault(),
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
// §02.3 — the LTS line is {@link NODE_LTS_LINE}'s to say and the patch is this
// script's; `default` and `tags.lts` name the same release for the reason
// {@link nodeDefault} gives.
table = rewriteDefault(table, "node", "default", node);
table = rewriteTag(table, "node", "lts", node);

const keys = await refreshKeys(readFileSync(KEYS, "utf8"));

// After every rewrite, so a rotated key and a new `node.default` are stamped in
// the same run that produced them.
const installers = stampInstallers(table, keys);
const configTest = stampReviewGates(table);

/**
 * §02.3 — which major is in LTS is the one table value this script cannot
 * compute, so it is asked rather than answered.
 *
 * {@link NODE_LTS_LINE} explains why npm's tags cannot say. The patch within the
 * line is refreshed like any other `default`; only the line itself waits on a
 * human, exactly as §16 says a `ranges` change does.
 */
console.log(
  `review: node tracks the ${NODE_LTS_LINE} line (now ${node}) — confirm against Node's LTS schedule (§02.3).`,
);

if (changes.length === 0) {
  console.log("The embedded table and trust store are current.");
  process.exit(0);
}

for (const change of changes) console.log(change);

if (check) {
  console.error(`\n${changes.length} item(s) are stale; run 'node scripts/refresh-table.mjs'.`);
  process.exit(1);
}

/**
 * Everything this run writes, and therefore everything `--commit` commits.
 *
 * One list for both, so the commit cannot fall behind the rewrite: a stamped
 * file added here is committed by the same edit that starts writing it.
 */
const written = {
  [TABLE]: table,
  [KEYS]: keys,
  [INSTALL_SH]: installers.sh,
  [INSTALL_PS1]: installers.ps1,
  [CONFIG_TEST]: configTest,
};

// Before the first write, so a refusal leaves the tree as it was found.
if (commit) assertCommittable(Object.keys(written));

for (const [path, content] of Object.entries(written)) writeFileSync(path, content);

console.log("\nRewritten: table, trust store, installers and the unit suite's `default` literals.");
if (commit) console.log(`Committed ${commitRefresh(Object.keys(written))}.`);
console.log(
  "A bin-path change still needs a new `ranges` entry, and a new LTS line still needs\n" +
    "`NODE_LTS_LINE` moved by hand — both are human review (§16, Built-in table and trust keys).",
);
