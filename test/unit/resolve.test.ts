import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFINITIONS } from "../../src/config/table.ts";
import { messages } from "../../src/errors-cold.ts";
import {
  getDefaultVersion,
  getFallbackLocator,
  resolveDescriptor,
} from "../../src/version/resolve.ts";

/* ------------------------------------------------------------------ *
 * A real local server per test, as in registry.test.ts: the wire is the
 * contract, and `requests` is what makes "zero network requests" an
 * assertion rather than a hope.
 * ------------------------------------------------------------------ */

interface TestServer {
  origin: string;
  requests: string[];
  close: () => Promise<void>;
}

type Route = unknown | ((response: ServerResponse) => void);

const servers: TestServer[] = [];

async function startServer(routes: Record<string, Route>): Promise<TestServer> {
  const requests: string[] = [];

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    const url = request.url ?? "";
    requests.push(url);

    const route = Object.hasOwn(routes, url) ? routes[url] : undefined;
    if (route === undefined) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(`{"error":"not found"}`);
      return;
    }
    if (typeof route === "function") {
      (route as (response: ServerResponse) => void)(response);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(route));
  };

  const server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const instance: TestServer = {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };

  servers.push(instance);
  return instance;
}

/** The rejection itself, so `message` can be compared against `messages.*`. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the promise to reject");
}

/* ------------------------------------------------------------------ *
 * Environment and store fixtures
 * ------------------------------------------------------------------ */

const ENV_KEYS = [
  "COREPACK_HOME",
  "COREPACK_NPM_REGISTRY",
  "COREPACK_ENABLE_NETWORK",
  "COREPACK_ENABLE_UNSAFE_CUSTOM_URLS",
  "COREPACK_DEFAULT_TO_LATEST",
  "COREPACK_INTEGRITY_KEYS",
  // §04.1's opt-in. Leaking it between rows would let one test silently decide
  // what the next one resolves to — precisely the hazard §04.1 is about.
  "JUP_ENABLE_PRERELEASES",
  "XDG_CACHE_HOME",
  "LOCALAPPDATA",
] as const;

/**
 * §02.2 — Berry resolves through `@yarnpkg/cli-dist` on the npm registry like
 * every other band, so the `berry` server below is never reached. It stays as
 * the negative control: the rows asserting `berry.requests` is empty are what
 * would catch a band being moved back onto a vendor host.
 */

let saved: Record<string, string | undefined>;
let home: string;

/** The npm packument the mock serves for `yarn` — Yarn Classic only. */
const YARN_PACKUMENT = {
  versions: { "1.22.4": {}, "1.22.9": {} },
  "dist-tags": { latest: "1.22.9" },
};

/** Yarn's tag document: `aliases` are the tags, `tags` are the versions (§05.3). */
const BERRY_TAGS = {
  aliases: { latest: "4.9.0", stable: "4.9.0", canary: "4.10.0-rc.1" },
  tags: ["2.0.0", "4.0.0", "4.9.0"],
};

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }

  home = mkdtempSync(join(tmpdir(), "jup-resolve-"));
  process.env.COREPACK_HOME = home;
  // Nothing here exercises signature verification; the registry mock serves a
  // legacy `shasum`-only `dist`, which is the quietest shape.
  process.env.COREPACK_INTEGRITY_KEYS = "0";
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  rmSync(home, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

/** Both bands of the `yarn` definition, mocked. */
/**
 * The Berry band as an npm package.
 *
 * §05.2 rewrite 1: with `JUP_NPM_REGISTRY` set, the override applies to tag and
 * version lookups too, not just to the download — so Berry is asked for as
 * `@yarnpkg/cli-dist` on the mirror. The mirror therefore has to serve it.
 */
const CLI_DIST_PACKUMENT = {
  // Mirrors BERRY_TAGS.tags exactly, so swapping the source does not also swap
  // which versions exist — the prerelease stays a dist-tag target only.
  versions: { "2.0.0": {}, "4.0.0": {}, "4.9.0": {} },
  "dist-tags": { latest: "4.9.0", stable: "4.9.0", canary: "4.10.0-rc.1" },
};

async function startYarnServers(): Promise<{ npm: TestServer; berry: TestServer }> {
  const npm = await startServer({
    "/yarn": YARN_PACKUMENT,
    "/yarn/latest": { version: "1.22.9", dist: { shasum: "deadbeef" } },
    "/pnpm": { versions: { "10.0.0": {} }, "dist-tags": { latest: "10.0.0" } },
    "/@yarnpkg/cli-dist": CLI_DIST_PACKUMENT,
  });
  const berry = await startServer({ "/tags": BERRY_TAGS });

  process.env.COREPACK_NPM_REGISTRY = npm.origin;

  return { npm, berry };
}

/** The same two servers with no mirror configured, so Berry keeps its own registry. */
async function startYarnServersWithoutMirror(): Promise<{ npm: TestServer; berry: TestServer }> {
  const servers = await startYarnServers();
  delete process.env.COREPACK_NPM_REGISTRY;
  return servers;
}

/**
 * A cached install: the directory, plus the `.jup` marker §07.2 stats.
 *
 * §06.1 — `hash` matters now: the probe checks a hash-bearing reference against
 * the marker before answering, so an install standing for a *pinned* reference
 * has to record that pin's digest or it is a miss.
 */
function seedInstalled(name: string, version: string, hash?: string): void {
  const dir = join(home, "v1", name, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".jup"),
    JSON.stringify({
      locator: { name, reference: version },
      ...(hash === undefined ? {} : { hash }),
    }),
  );
}

function seedLastKnownGood(entries: Record<string, string>): void {
  writeFileSync(join(home, "lastKnownGood.json"), `${JSON.stringify(entries, null, 2)}\n`);
}

function readLastKnownGoodFile(): Record<string, string> | null {
  const path = join(home, "lastKnownGood.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
}

/* ------------------------------------------------------------------ *
 * §04.1 step 1 — URL references (tests 17, 18, 19)
 * ------------------------------------------------------------------ */

describe("resolveDescriptor step 1 — URL references", () => {
  const url = "https://example.com/yarn-1.22.21.tgz";

  it("refuses a URL for a known package manager (test 17)", async () => {
    const { npm, berry } = await startYarnServers();

    const error = await rejection(resolveDescriptor({ name: "yarn", range: url }));
    expect(error.message).toBe(messages.illegalUrl(`yarn@${url}`));
    expect(error.message).toContain("JUP_ENABLE_UNSAFE_CUSTOM_URLS=1");
    expect([...npm.requests, ...berry.requests]).toEqual([]);
  });

  it("passes it through with the opt-in (test 18)", async () => {
    const { npm, berry } = await startYarnServers();
    process.env.COREPACK_ENABLE_UNSAFE_CUSTOM_URLS = "1";

    // Untouched: no version parsing, no registry lookup, no cache probe.
    await expect(resolveDescriptor({ name: "yarn", range: url })).resolves.toEqual({
      name: "yarn",
      reference: url,
    });
    expect([...npm.requests, ...berry.requests]).toEqual([]);
  });

  it("passes a URL for an unknown name through, before the name check (test 19)", async () => {
    process.env.COREPACK_ENABLE_UNSAFE_CUSTOM_URLS = "1";

    // Step 1 precedes step 2, so this never reaches `unsupportedByBuild`.
    await expect(resolveDescriptor({ name: "cutlery", range: url })).resolves.toEqual({
      name: "cutlery",
      reference: url,
    });
  });

  it("does not need the opt-in for an unknown name", async () => {
    await expect(resolveDescriptor({ name: "cutlery", range: url })).resolves.toEqual({
      name: "cutlery",
      reference: url,
    });
  });

  it("keeps a URL fragment, which carries the hash (§02.1)", async () => {
    process.env.COREPACK_ENABLE_UNSAFE_CUSTOM_URLS = "1";
    const withHash = `${url}#sha1.abcdef`;

    await expect(resolveDescriptor({ name: "yarn", range: withHash })).resolves.toEqual({
      name: "yarn",
      reference: withHash,
    });
  });
});

/* ------------------------------------------------------------------ *
 * §04.1 step 2 — unknown package manager
 * ------------------------------------------------------------------ */

describe("resolveDescriptor step 2 — unknown package manager", () => {
  it("rejects a name the build does not know", async () => {
    const error = await rejection(resolveDescriptor({ name: "cutlery", range: "1.0.0" }));
    expect(error.message).toBe(messages.unsupportedByBuild("cutlery"));
  });
});

/* ------------------------------------------------------------------ *
 * §04.1 step 3 — tags (§02.3, test 145)
 * ------------------------------------------------------------------ */

describe("resolveDescriptor step 3 — tags", () => {
  it("refuses a tag when tags are not allowed, without any network", async () => {
    const { npm, berry } = await startYarnServers();

    const error = await rejection(resolveDescriptor({ name: "yarn", range: "latest" }));
    expect(error.message).toBe(messages.tagsNotAllowed());
    expect([...npm.requests, ...berry.requests]).toEqual([]);
  });

  it("resolves against the LAST range entry's registry, not the first (§02.3)", async () => {
    const { npm, berry } = await startYarnServers();

    // `yarn@latest` must be Berry's 4.9.0, from `@yarnpkg/cli-dist`'s dist-tags
    // — not the `yarn` package's, which is Classic's 1.22.9. Both bands are npm
    // registries since §02.5, so this is now a question of *which package* the
    // tag is read from rather than which protocol.
    await expect(
      resolveDescriptor({ name: "yarn", range: "latest" }, { allowTags: true }),
    ).resolves.toEqual({ name: "yarn", reference: "4.9.0" });

    expect(npm.requests).toEqual(["/@yarnpkg/cli-dist"]);
    expect(npm.requests).not.toContain("/yarn");
    // And no vendor host was involved at any point.
    expect(berry.requests).toEqual([]);
  });

  it("asks the mirror for @yarnpkg/cli-dist instead, once one is configured (§05.2)", async () => {
    // §05.2 rewrite 1. repo.yarnpkg.com is not an npm registry and cannot be
    // mirrored, so a configured mirror switches Berry to its npm package — for
    // the *tag lookup*, not only for the download. Without this, `yarn@latest`
    // behind a corporate mirror still reaches the public internet: it fails
    // outright behind a firewall, and leaks traffic everywhere else.
    const { npm, berry } = await startYarnServers();

    await expect(
      resolveDescriptor({ name: "yarn", range: "latest" }, { allowTags: true }),
    ).resolves.toEqual({ name: "yarn", reference: "4.9.0" });

    expect(npm.requests).toEqual(["/@yarnpkg/cli-dist"]);
    expect(berry.requests).toEqual([]);
  });

  it("names the last band's registry URL even when the network is off", async () => {
    // The table's real registry, so the assertion is about the *table*, not the
    // mock. Two things changed with §02.5: the tag lookup is now the
    // `@yarnpkg/cli-dist` packument rather than `https://repo.yarnpkg.com/tags`,
    // and because it goes through the npm layer the refusal names the
    // *repository* rather than the document — `networkDisabledRegistry`, which
    // is the message every other package manager already produced here.
    await startYarnServersWithoutMirror();
    process.env.COREPACK_ENABLE_NETWORK = "0";

    const error = await rejection(
      resolveDescriptor({ name: "yarn", range: "latest" }, { allowTags: true }),
    );
    expect(error.message).toBe(messages.networkDisabledRegistry("https://registry.npmjs.org"));
  });

  it("uses the npm dist-tags for an npm-typed last band", async () => {
    const { npm } = await startYarnServers();

    await expect(
      resolveDescriptor({ name: "pnpm", range: "latest" }, { allowTags: true }),
    ).resolves.toEqual({ name: "pnpm", reference: "10.0.0" });
    expect(npm.requests).toEqual(["/pnpm"]);
  });

  it("reports an unknown tag (test 145)", async () => {
    await startYarnServers();

    const error = await rejection(
      resolveDescriptor({ name: "yarn", range: "nightly" }, { allowTags: true }),
    );
    expect(error.message).toBe(messages.tagNotFound("nightly"));
  });

  it("probes the cache with the resolved version, not the tag", async () => {
    const { npm, berry } = await startYarnServers();
    seedInstalled("yarn", "4.9.0");

    await expect(
      resolveDescriptor({ name: "yarn", range: "latest" }, { allowTags: true }),
    ).resolves.toEqual({ name: "yarn", reference: "4.9.0" });

    // The tag lookup is unavoidable; the *version* lookup is not. With a mirror
    // configured, §05.2 sends the tag lookup to @yarnpkg/cli-dist.
    expect(npm.requests).toEqual(["/@yarnpkg/cli-dist"]);
    expect(berry.requests).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * §04.1 step 4 — the cache probe, and the §01.3 budget
 * ------------------------------------------------------------------ */

describe("resolveDescriptor step 4 — cache probe", () => {
  it("answers a range from the cache with ZERO network requests (§01.3)", async () => {
    const { npm, berry } = await startYarnServers();
    seedInstalled("yarn", "1.22.4");

    await expect(resolveDescriptor({ name: "yarn", range: "^1.22.0" })).resolves.toEqual({
      name: "yarn",
      reference: "1.22.4",
    });

    // The budget assertion: a warm run does no I/O over the wire at all.
    expect(npm.requests).toEqual([]);
    expect(berry.requests).toEqual([]);
  });

  it("answers an exact pin from the cache with ZERO network requests (§04.3)", async () => {
    const { npm, berry } = await startYarnServers();
    seedInstalled("yarn", "1.22.4");

    await expect(resolveDescriptor({ name: "yarn", range: "1.22.4" })).resolves.toEqual({
      name: "yarn",
      reference: "1.22.4",
    });
    expect([...npm.requests, ...berry.requests]).toEqual([]);
  });

  it("picks the highest cached version satisfying the range", async () => {
    await startYarnServers();
    seedInstalled("yarn", "1.22.4");
    seedInstalled("yarn", "1.22.9");
    seedInstalled("yarn", "4.9.0");

    await expect(resolveDescriptor({ name: "yarn", range: "^1.0.0" })).resolves.toEqual({
      name: "yarn",
      reference: "1.22.9",
    });
  });

  it("runs BEFORE the exact-version passthrough (step 4 precedes step 5)", async () => {
    await startYarnServers();
    // §06.1 redirected this row's fixture: the marker has to prove the pin the
    // reference carries, or the probe answers "miss" and step 5 supplies the
    // hash-bearing reference — which is what this row exists to rule out.
    seedInstalled("yarn", "1.22.4", "sha224.0123456789ab");

    // The store never records a build suffix in its *directory* name (§07.2), so
    // a cache hit answers with the bare version. Were step 5 to run first, the
    // hash-bearing reference would come back verbatim.
    await expect(
      resolveDescriptor({ name: "yarn", range: "1.22.4+sha224.0123456789ab" }),
    ).resolves.toEqual({ name: "yarn", reference: "1.22.4" });
  });

  it("skips the cache when useCache is false, so `use`/`up` see the registry", async () => {
    const { npm } = await startYarnServers();
    seedInstalled("yarn", "1.22.4");

    await expect(
      resolveDescriptor({ name: "yarn", range: "^1.22.0" }, { useCache: false }),
    ).resolves.toEqual({ name: "yarn", reference: "1.22.9" });
    expect(npm.requests).toContain("/yarn");
  });
});

/* ------------------------------------------------------------------ *
 * §04.1 step 5 — exact versions
 * ------------------------------------------------------------------ */

describe("resolveDescriptor step 5 — exact versions", () => {
  it("resolves an exact version with no network at all (test 14)", async () => {
    const { npm, berry } = await startYarnServers();

    for (const [name, version] of [
      ["yarn", "1.22.4"],
      ["pnpm", "4.11.6"],
      ["npm", "6.14.2"],
    ] as const) {
      await expect(resolveDescriptor({ name, range: version })).resolves.toEqual({
        name,
        reference: version,
      });
    }
    expect([...npm.requests, ...berry.requests]).toEqual([]);
  });

  it("returns a version that does not exist, unverified (§04.1, phase 2)", async () => {
    const { npm, berry } = await startYarnServers();

    // 1.99.99 is not in the packument; the 404 surfaces at download time.
    await expect(resolveDescriptor({ name: "yarn", range: "1.99.99" })).resolves.toEqual({
      name: "yarn",
      reference: "1.99.99",
    });
    expect([...npm.requests, ...berry.requests]).toEqual([]);
  });

  it("passes a pinned prerelease through (test 15)", async () => {
    await startYarnServers();

    await expect(resolveDescriptor({ name: "yarn", range: "2.0.0-rc.30" })).resolves.toEqual({
      name: "yarn",
      reference: "2.0.0-rc.30",
    });
  });

  it("keeps the build suffix on an uncached exact pin (test 16)", async () => {
    await startYarnServers();
    const reference = "1.22.22+sha1.ac34549e6aa8e7ead463a7407e1c7390f61a6610";

    await expect(resolveDescriptor({ name: "yarn", range: reference })).resolves.toEqual({
      name: "yarn",
      reference,
    });
  });
});

/* ------------------------------------------------------------------ *
 * §04.1 step 6 — the range query
 * ------------------------------------------------------------------ */

describe("resolveDescriptor step 6 — range query", () => {
  it("unions every band, so a range spanning Classic and Berry sees both", async () => {
    const { npm, berry } = await startYarnServers();

    await expect(resolveDescriptor({ name: "yarn", range: ">=1" })).resolves.toEqual({
      name: "yarn",
      reference: "4.9.0",
    });
    // Both bands are queried; with a mirror configured both live on it (§05.2).
    expect([...npm.requests].sort()).toEqual(["/@yarnpkg/cli-dist", "/yarn"]);
    expect(berry.requests).toEqual([]);
  });

  it("takes the highest match across the union, not the last band's highest", async () => {
    const { npm, berry } = await startYarnServers();

    // Only the npm band can satisfy this, but both bands are still queried.
    await expect(resolveDescriptor({ name: "yarn", range: ">=1 <2" })).resolves.toEqual({
      name: "yarn",
      reference: "1.22.9",
    });
    expect([...npm.requests].sort()).toEqual(["/@yarnpkg/cli-dist", "/yarn"]);
    expect(berry.requests).toEqual([]);
  });

  it("queries the bands in parallel", async () => {
    const arrivals: number[] = [];
    const delayed = (body: unknown) => (response: ServerResponse) => {
      arrivals.push(Date.now());
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      }, 100);
    };

    const npm = await startServer({
      "/yarn": delayed(YARN_PACKUMENT),
      "/@yarnpkg/cli-dist": delayed(CLI_DIST_PACKUMENT),
    });
    process.env.COREPACK_NPM_REGISTRY = npm.origin;

    await resolveDescriptor({ name: "yarn", range: ">=1" });

    expect(arrivals).toHaveLength(2);
    // Serial fan-out would put the second arrival a full response delay after
    // the first; parallel fan-out puts them within a millisecond or two.
    expect(Math.abs(arrivals[1]! - arrivals[0]!)).toBeLessThan(50);
  });

  it("dedupes versions offered by more than one band", async () => {
    const npm = await startServer({
      "/yarn": { versions: { "4.9.0": {}, "1.22.9": {} }, "dist-tags": {} },
      "/@yarnpkg/cli-dist": CLI_DIST_PACKUMENT,
    });
    process.env.COREPACK_NPM_REGISTRY = npm.origin;

    await expect(resolveDescriptor({ name: "yarn", range: ">=4" })).resolves.toEqual({
      name: "yarn",
      reference: "4.9.0",
    });
  });

  it("returns null when nothing matches, so the caller can report §12.4 (test 144)", async () => {
    const { npm, berry } = await startYarnServers();

    await expect(resolveDescriptor({ name: "yarn", range: "^99.0.0" })).resolves.toBeNull();
    expect([...npm.requests].sort()).toEqual(["/@yarnpkg/cli-dist", "/yarn"]);
    expect(berry.requests).toEqual([]);

    // The message the caller then formats.
    expect(messages.failedToResolve("^99.0.0", "yarn")).toBe(
      `Failed to successfully resolve '^99.0.0' to a valid yarn release`,
    );
  });

  // §04.1 redirected this row. It used to assert that `>=4` resolves to
  // `4.10.0-rc.1` — corepack's behaviour, and the defect behind #473/#774. The
  // *lenient satisfaction* it was really testing is still exercised, by the last
  // case below: a range naming a prerelease still matches one.
  describe("§04.1 — prereleases are excluded from implicit resolution", () => {
    async function serveYarn(): Promise<void> {
      const npm = await startServer({
        "/yarn": { versions: {}, "dist-tags": {} },
        "/@yarnpkg/cli-dist": {
          versions: { "4.10.0-rc.1": {}, "4.9.0": {} },
          "dist-tags": {},
        },
      });
      process.env.COREPACK_NPM_REGISTRY = npm.origin;
    }

    it("takes the highest STABLE release for a plain range", async () => {
      await serveYarn();

      await expect(resolveDescriptor({ name: "yarn", range: ">=4" })).resolves.toEqual({
        name: "yarn",
        reference: "4.9.0",
      });
    });

    it("takes the prerelease with JUP_ENABLE_PRERELEASES=1", async () => {
      await serveYarn();
      process.env.JUP_ENABLE_PRERELEASES = "1";

      await expect(resolveDescriptor({ name: "yarn", range: ">=4" })).resolves.toEqual({
        name: "yarn",
        reference: "4.10.0-rc.1",
      });
    });

    it("takes the prerelease when the range itself names one (§04.2 leniency)", async () => {
      await serveYarn();

      // The band lookup and the cache probe keep the lenient rule; what narrowed
      // is the *candidate set*, and a range that names a prerelease re-admits it.
      await expect(resolveDescriptor({ name: "yarn", range: ">=4.0.0-0" })).resolves.toEqual({
        name: "yarn",
        reference: "4.10.0-rc.1",
      });
    });

    it("resolves to nothing rather than silently downgrading to a prerelease", async () => {
      const npm = await startServer({
        "/yarn": { versions: {}, "dist-tags": {} },
        "/@yarnpkg/cli-dist": { versions: { "5.0.0-rc.1": {} }, "dist-tags": {} },
      });
      process.env.COREPACK_NPM_REGISTRY = npm.origin;

      // §04.1 says "discard", with no fallback: `Failed to successfully resolve`
      // names a real problem, where installing a dev build silently does not.
      await expect(resolveDescriptor({ name: "yarn", range: ">=5" })).resolves.toBeNull();
    });
  });
});

/* ------------------------------------------------------------------ *
 * §04.6 — getDefaultVersion (tests 97–103)
 * ------------------------------------------------------------------ */

describe("getDefaultVersion (§04.6)", () => {
  it("returns the last-known-good entry with NO network (test 101)", async () => {
    const { npm, berry } = await startYarnServers();
    seedLastKnownGood({ yarn: "1.0.0" });

    await expect(getDefaultVersion("yarn")).resolves.toBe("1.0.0");
    expect([...npm.requests, ...berry.requests]).toEqual([]);
  });

  it("returns the compiled-in default with NO network when DEFAULT_TO_LATEST=0", async () => {
    const { npm, berry } = await startYarnServers();
    process.env.COREPACK_DEFAULT_TO_LATEST = "0";

    await expect(getDefaultVersion("yarn")).resolves.toBe(DEFINITIONS.yarn!.default);
    expect([...npm.requests, ...berry.requests]).toEqual([]);
    // Nothing is recorded on this path.
    expect(readLastKnownGoodFile()).toBeNull();
  });

  it("fetches the latest stable version and records it (test 103)", async () => {
    const { npm } = await startYarnServers();

    await expect(getDefaultVersion("yarn")).resolves.toBe("1.22.9+sha1.deadbeef");
    expect(npm.requests).toEqual(["/yarn/latest"]);
    expect(readLastKnownGoodFile()).toEqual({ yarn: "1.22.9+sha1.deadbeef" });
  });

  it("keeps the other entries when recording", async () => {
    await startYarnServers();
    seedLastKnownGood({ pnpm: "10.0.0" });

    await getDefaultVersion("yarn");
    expect(readLastKnownGoodFile()).toEqual({ pnpm: "10.0.0", yarn: "1.22.9+sha1.deadbeef" });
  });

  it("survives an unwritable home rather than failing the run", async () => {
    const { npm } = await startYarnServers();
    // A file where the home folder should be: `mkdir -p` fails with ENOTDIR.
    const blocked = join(home, "blocked");
    writeFileSync(blocked, "");
    process.env.COREPACK_HOME = blocked;

    await expect(getDefaultVersion("yarn")).resolves.toBe("1.22.9+sha1.deadbeef");
    expect(npm.requests).toEqual(["/yarn/latest"]);
  });

  it("rejects an unknown package manager", async () => {
    const error = await rejection(getDefaultVersion("cutlery"));
    expect(error.message).toBe(messages.unsupportedByBuild("cutlery"));
  });

  /**
   * §02.4 — a recorded per-host reference must not carry a digest, and step 1
   * is the one place a bad one can arrive from outside the current build.
   *
   * `lastKnownGood.json` is derived state that outlives a release. A version of
   * the tool that pinned the *launcher* package's digest here left an entry that
   * step 1 returns with no network, ahead of every guard downstream — so the
   * repair has to happen on read or the machine stays broken forever. §04.5
   * already says a damaged file degrades rather than fails; this is the same
   * rule with a more specific idea of damaged. The version is still a good
   * recorded default, so the suffix goes and the entry stays.
   */
  it("heals a per-host entry that carries a digest, and rewrites the file (§02.4)", async () => {
    const { npm, berry } = await startYarnServers();
    seedLastKnownGood({
      deno: "2.9.5+sha512.26dfc0709884aed516f64ac6c25c140ec9b572836d99fb61890e09b52085f8936",
      // Untouched: pnpm's artifact is one tarball for every host, so its digest
      // is true everywhere and the repair must not be a blanket suffix strip.
      pnpm: "10.0.0+sha512.abcd",
    });

    await expect(getDefaultVersion("deno")).resolves.toBe("2.9.5");
    // Still no network — healing must not turn the offline path into an online
    // one, which is the whole point of step 1.
    expect([...npm.requests, ...berry.requests]).toEqual([]);
    expect(readLastKnownGoodFile()).toEqual({
      deno: "2.9.5",
      pnpm: "10.0.0+sha512.abcd",
    });
  });

  // Windows cannot reach the state this row is about: `chmod` there toggles the
  // read-only *file* attribute and does nothing at all to a directory, so the
  // repair's write lands and the last-known-good file heals. §07.8's claim —
  // the run must not depend on the rewrite — is the same code path either way;
  // what is missing is a way to make the rewrite fail.
  it.skipIf(process.platform === "win32")(
    "heals in memory even when the file cannot be rewritten",
    async () => {
      const { npm, berry } = await startYarnServers();
      seedLastKnownGood({ deno: "2.9.5+sha512.wrong" });

      // §07.8 — an unwritable store must still be able to *run*. A read-only
      // home lets the entry be read and makes the repair's write fail, which is
      // the ordering that matters: the run must not depend on the rewrite.
      chmodSync(home, 0o555);
      try {
        await expect(getDefaultVersion("deno")).resolves.toBe("2.9.5");
        expect([...npm.requests, ...berry.requests]).toEqual([]);
      } finally {
        chmodSync(home, 0o755);
      }

      // The file kept the bad value, and the next run will heal it again — one
      // wasted repair per run is the correct price for a read-only checkout.
      expect(readLastKnownGoodFile()).toEqual({ deno: "2.9.5+sha512.wrong" });
    },
  );
});

/* ------------------------------------------------------------------ *
 * §02.1, §04.6 — the fallback locator's laziness
 * ------------------------------------------------------------------ */

describe("getFallbackLocator (§02.1)", () => {
  it("is a thunk, and building it touches neither disk nor network", async () => {
    const { npm, berry } = await startYarnServers();

    const locator = getFallbackLocator("yarn", { transparent: false });
    expect(typeof locator.reference).toBe("function");
    expect(locator.name).toBe("yarn");
    expect([...npm.requests, ...berry.requests]).toEqual([]);
  });

  it("is NOT invoked when the project has a usable spec", async () => {
    // Any request to this server means the fallback was materialised eagerly.
    const npm = await startServer({});
    const berry = await startServer({ "/tags": BERRY_TAGS });
    process.env.COREPACK_NPM_REGISTRY = npm.origin;
    seedLastKnownGood({ yarn: "1.0.0" });

    // §01.3's step 2: the fallback is built *before* the project is inspected.
    let invoked = false;
    const built = getFallbackLocator("yarn", { transparent: false });
    const locator = {
      name: built.name,
      reference: () => {
        invoked = true;
        return built.reference();
      },
    };

    // Step 3/4 find a spec, so step 5 resolves that instead.
    const resolved = await resolveDescriptor({ name: "yarn", range: "1.22.4" });

    expect(resolved).toEqual({ name: "yarn", reference: "1.22.4" });
    expect(invoked).toBe(false);
    expect(typeof locator.reference).toBe("function");
    expect([...npm.requests, ...berry.requests]).toEqual([]);
  });

  it("resolves to getDefaultVersion when it is finally called", async () => {
    const { npm } = await startYarnServers();

    const locator = getFallbackLocator("yarn", { transparent: false });
    await expect(locator.reference()).resolves.toBe("1.22.9+sha1.deadbeef");
    expect(npm.requests).toEqual(["/yarn/latest"]);
  });

  // §04.6 redirected this row: `transparent.default` used to be an
  // unconditional override, and the row asserted that the recorded default was
  // not even read. It is a **floor** now, so it is read — but still never over
  // the network, which is the half of the original assertion that still holds.
  it("uses transparent.default when nothing is recorded, with no network", async () => {
    const { npm, berry } = await startYarnServers();

    const locator = getFallbackLocator("yarn", { transparent: true });
    await expect(locator.reference()).resolves.toBe(DEFINITIONS.yarn!.transparent.default);
    expect([...npm.requests, ...berry.requests]).toEqual([]);
  });

  it("prefers a recorded default from the same major line or newer (§04.6)", async () => {
    const { npm, berry } = await startYarnServers();
    // Row 199: `corepack install -g yarn@4.9.0` then `yarn dlx`. 4.9.0 is
    // *older* than the table's 4.14.1, and the user still gets 4.9.0 — a
    // literal version-wise floor would answer 4.14.1 and fail the row.
    seedLastKnownGood({ yarn: "4.9.0" });

    const locator = getFallbackLocator("yarn", { transparent: true });
    await expect(locator.reference()).resolves.toBe("4.9.0");
    expect([...npm.requests, ...berry.requests]).toEqual([]);
  });

  it("keeps the floor when the recorded default is from an older major (§04.6)", async () => {
    await startYarnServers();
    // #812 exactly: `yarn create` reaching for Yarn Classic, unsupported since
    // 2020, because `install -g yarn@1.22.22` recorded it as the default.
    seedLastKnownGood({ yarn: "1.22.22" });

    const locator = getFallbackLocator("yarn", { transparent: true });
    await expect(locator.reference()).resolves.toBe(DEFINITIONS.yarn!.transparent.default);
  });

  it("keeps the floor when the recorded default cannot be parsed (§04.6)", async () => {
    await startYarnServers();
    seedLastKnownGood({ yarn: "https://example.test/yarn.js" });

    const locator = getFallbackLocator("yarn", { transparent: true });
    await expect(locator.reference()).resolves.toBe(DEFINITIONS.yarn!.transparent.default);
  });

  it("falls back to getDefaultVersion when the definition declares no transparent.default", async () => {
    await startYarnServers();
    seedLastKnownGood({ pnpm: "10.1.0" });

    expect(DEFINITIONS.pnpm!.transparent.default).toBeUndefined();
    const locator = getFallbackLocator("pnpm", { transparent: true });
    await expect(locator.reference()).resolves.toBe("10.1.0");
  });

  it("defers the unknown-name error to the thunk", async () => {
    const locator = getFallbackLocator("cutlery", { transparent: true });
    const error = await rejection(locator.reference());
    expect(error.message).toBe(messages.unsupportedByBuild("cutlery"));
  });
});
