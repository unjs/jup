/**
 * Mirror the assets of the newest GitHub release into `public/r/`, so the built
 * site serves them from `https://jup.unjs.io/r/<asset>`.
 *
 * The release page is where `pnpm compile`'s binaries land (see
 * `.github/workflows/release.yml`), and it is a fine place for a human to click.
 * It is a poor place for an `sh` installer to point at: the download host is not
 * the docs host, so a one-liner has to name two domains, and a draft release —
 * the shape every release has before someone presses publish — is not reachable
 * without a token at all. Copying the assets under the docs origin gives both a
 * single stable base URL and a way to see a draft's binaries on a preview
 * deploy before the release exists publicly.
 *
 * "Newest" means the first entry of `/releases`, which GitHub sorts by creation
 * date and which includes drafts. That is deliberate: a draft is the release
 * being prepared right now, and the whole point of a preview deploy is to
 * exercise it before anyone presses publish.
 *
 * Assets are read through the API asset endpoint with
 * `Accept: application/octet-stream` rather than `browser_download_url`,
 * because the latter 404s for a draft's assets no matter what token is sent.
 *
 * Downloads are skipped when `public/r/<name>` already matches the size the API
 * reports for it, which keeps a rebuild from moving ~190 MB again. Pass
 * `--force` to ignore that.
 *
 * A token is required, because `unjs/jup` is a private repository — an
 * anonymous request cannot tell that from a repository that does not exist and
 * answers 404 either way. It comes from `GITHUB_TOKEN` or `GH_TOKEN`, with a
 * gitignored `docs/.env` as a fallback so a local token need not live in shell
 * history; a real environment variable wins over that file. Read access to the
 * repository's contents is all it needs. Nothing here writes the token
 * anywhere, and nothing it downloads carries it.
 *
 * Usage: `pnpm --filter jup-docs assets`, or automatically as part of
 * `pnpm build` in this directory.
 */

import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "unjs/jup";

/** The directory holding `package.json`, i.e. `docs/`. */
const DOCS_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Where the mirrored assets go. */
const OUT_DIR = join(DOCS_ROOT, "public", "r");

const force = process.argv.includes("--force");

/**
 * `.env` beside `package.json`, if the maintainer put a token there. Node
 * throws when the file is absent, which is the common case and not an error.
 */
try {
  process.loadEnvFile(join(DOCS_ROOT, ".env"));
} catch {
  // No local .env; env vars or an anonymous request carry the run instead.
}

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

/** @param {Record<string, string>} [extra] */
const headers = (extra) => ({
  "user-agent": "jup-docs",
  "x-github-api-version": "2022-11-28",
  ...(token ? { authorization: `Bearer ${token}` } : {}),
  ...extra,
});

/** @param {number} bytes */
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;

async function main() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=1`, {
    headers: headers({ accept: "application/vnd.github+json" }),
  });
  if (!res.ok) {
    // 404 is what a private repository returns to a request that may not see
    // it, so an unhelpfully literal "not found" is usually a missing token.
    const hint =
      (res.status === 404 || res.status === 401) && !token
        ? " — set GITHUB_TOKEN (or put it in docs/.env)"
        : "";
    throw new Error(`GitHub releases request failed: ${res.status} ${res.statusText}${hint}`);
  }

  const [release] = await res.json();
  if (!release) throw new Error(`${REPO} has no releases`);

  const assets = release.assets ?? [];
  console.log(
    `[assets] ${release.tag_name}${release.draft ? " (draft)" : ""} — ${assets.length} asset(s)`,
  );
  if (assets.length === 0) {
    throw new Error(`release ${release.tag_name} has no assets to mirror`);
  }

  mkdirSync(OUT_DIR, { recursive: true });

  // Four at a time: enough to keep the link busy, few enough that a failure
  // does not leave eight partial files behind.
  const queue = [...assets];
  const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let asset = queue.shift(); asset; asset = queue.shift()) {
      await mirror(asset);
    }
  });
  await Promise.all(workers);

  // An asset renamed or dropped between releases would otherwise sit in
  // `public/r/` forever and keep being served as if it were current.
  const keep = new Set([...assets.map((a) => a.name), "index.json"]);
  for (const name of readdirSync(OUT_DIR)) {
    if (keep.has(name)) continue;
    console.log(`[assets] stale ${name}`);
    await rm(join(OUT_DIR, name), { force: true });
  }

  // What a `latest` resolver needs and cannot get from a directory listing:
  // which tag these files came from. Digests are GitHub's, so an installer can
  // check what it downloaded without a second request to the API.
  writeFileSync(
    join(OUT_DIR, "index.json"),
    `${JSON.stringify(
      {
        tag: release.tag_name,
        draft: release.draft,
        prerelease: release.prerelease,
        assets: assets.map((a) => ({ name: a.name, size: a.size, digest: a.digest })),
      },
      undefined,
      2,
    )}\n`,
  );
}

/** Download one asset into `public/r/`, unless the file already matches. */
async function mirror(asset) {
  const dest = join(OUT_DIR, asset.name);
  if (!force && existsSync(dest) && statSync(dest).size === asset.size) {
    console.log(`[assets] cached ${asset.name} (${mb(asset.size)})`);
    return;
  }

  const res = await fetch(asset.url, { headers: headers({ accept: "application/octet-stream" }) });
  if (!res.ok) {
    throw new Error(`download of ${asset.name} failed: ${res.status} ${res.statusText}`);
  }

  // Written to a scratch name and renamed, so an interrupted run cannot leave a
  // short file that the size check above would then accept on the next build.
  const partial = `${dest}.part`;
  await writeFile(partial, res.body);
  const written = statSync(partial).size;
  if (asset.size && written !== asset.size) {
    await rm(partial, { force: true });
    throw new Error(`${asset.name}: expected ${asset.size} bytes, got ${written}`);
  }
  await rename(partial, dest);
  console.log(`[assets] fetched ${asset.name} (${mb(written)})`);
}

await main().catch((error) => {
  console.error(`[assets] ${error.message}`);
  process.exitCode = 1;
});
