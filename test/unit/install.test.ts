import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageError } from "../../src/errors.ts";
import { confirmDownload, ensureInstalled } from "../../src/install.ts";
import { create } from "../../src/tar.ts";
import type { CorepackMarker, Locator, TrustedKey } from "../../src/types.ts";

/* ------------------------------------------------------------------ *
 * A real mock registry on a real socket: routes are keyed by request
 * path, so a test asserts what was asked for as well as what came back.
 * Tarballs are built with `src/tar.ts`'s writer, so what is served is a
 * genuine gzip tar rather than a fixture nobody can regenerate.
 * ------------------------------------------------------------------ */

type Handler = (response: ServerResponse) => void;

let server: Server;
let origin: string;
let routes: Record<string, Handler>;
/** Every URL the tool asked for, in order, *before* the test rewrite. */
let requested: string[];

/** The default origins the embedded table points at, mapped onto the mock. */
const TABLE_ORIGINS = [
  "https://registry.npmjs.org",
  "https://repo.yarnpkg.com",
  "https://registry.yarnpkg.com",
];

beforeAll(async () => {
  server = createServer((request, response) => {
    const handler = routes[request.url ?? ""];
    if (handler === undefined) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(`{"error":"not found"}`);
      return;
    }
    handler(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function jsonRoute(value: unknown): Handler {
  return (response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(value));
  };
}

function bytesRoute(data: Uint8Array): Handler {
  return (response) => {
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(Buffer.from(data));
  };
}

/* ------------------------------------------------------------------ *
 * Environment: a throwaway COREPACK_HOME per test, and a fetch spy that
 * counts requests and points the table's hardcoded origins at the mock.
 * ------------------------------------------------------------------ */

const ENV_KEYS = [
  "COREPACK_HOME",
  "COREPACK_NPM_REGISTRY",
  "COREPACK_INTEGRITY_KEYS",
  "COREPACK_ENABLE_DOWNLOAD_PROMPT",
  "COREPACK_DEFAULT_TO_LATEST",
  "COREPACK_ENABLE_NETWORK",
  "CI",
] as const;

let home: string;
let scratch: string;
let saved: Record<string, string | undefined>;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }

  home = await mkdtemp(join(tmpdir(), "pipack-install-home-"));
  scratch = await mkdtemp(join(tmpdir(), "pipack-install-work-"));
  process.env.COREPACK_HOME = home;

  routes = {};
  requested = [];

  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = String(input);
    requested.push(url);
    const table = TABLE_ORIGINS.find((candidate) => url.startsWith(candidate));
    const target = table === undefined ? url : origin + url.slice(table.length);
    return realFetch(target, init);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(home, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

interface Keypair {
  keyid: string;
  spki: string;
  privateKey: KeyObject;
}

function keypair(keyid = "SHA256:test-key"): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    keyid,
    spki: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    privateKey,
  };
}

function trustedKey(pair: Keypair): TrustedKey {
  return {
    expires: null,
    keyid: pair.keyid,
    keytype: "ecdsa-sha2-nistp256",
    scheme: "ecdsa-sha2-nistp256",
    key: pair.spki,
  };
}

function hashOf(data: Uint8Array, algo = "sha512"): string {
  return createHash(algo).update(data).digest("hex");
}

function sriOf(data: Uint8Array, algo = "sha512"): string {
  return `${algo}-${createHash(algo).update(data).digest("base64")}`;
}

/** A real npm-shaped tarball: every entry under a single `package/` root. */
async function tarballOf(files: Record<string, string>): Promise<Uint8Array> {
  const root = await mkdtemp(join(scratch, "pkg-"));
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, "package", path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  const archive = join(root, "archive.tgz");
  await create(root, ["package"], archive);
  return readFile(archive);
}

/**
 * A `dist` section as npm publishes one: the integrity is signed, the
 * signature covers `<pkg>@<version>:<integrity>`, and `signWith` lets a test
 * publish a signature made by the *wrong* key while claiming a trusted keyid.
 */
function packument(options: {
  packageName: string;
  version: string;
  tarball: string;
  integrityOf?: Uint8Array;
  keyid?: string;
  signWith?: KeyObject;
}): unknown {
  const dist: Record<string, unknown> = { tarball: options.tarball };

  if (options.integrityOf !== undefined) {
    const integrity = sriOf(options.integrityOf);
    dist.integrity = integrity;
    if (options.signWith !== undefined) {
      const payload = `${options.packageName}@${options.version}:${integrity}`;
      dist.signatures = [
        {
          keyid: options.keyid,
          sig: sign("sha256", Buffer.from(payload, "utf8"), options.signWith).toString("base64"),
        },
      ];
    }
  }

  return { name: options.packageName, version: options.version, dist };
}

function marker(location: string): CorepackMarker {
  return JSON.parse(readFileSync(join(location, ".corepack"), "utf8")) as CorepackMarker;
}

/** Nothing at all under `<home>/v1` — not the version dir, not a stray temp dir. */
function storeIsEmpty(): boolean {
  const v1 = join(home, "v1");
  return !existsSync(v1) || readdirSync(v1).length === 0;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the promise to reject");
}

/* ------------------------------------------------------------------ *
 * §07.2 — the warm path
 * ------------------------------------------------------------------ */

describe("marker hit (§07.2, test 96)", () => {
  it("short-circuits with zero network requests", async () => {
    const location = join(home, "v1", "pnpm", "9.1.0");
    await mkdir(location, { recursive: true });
    await writeFile(
      join(location, ".corepack"),
      JSON.stringify({
        locator: { name: "pnpm", reference: "9.1.0+sha512.abc" },
        bin: { pnpm: "./bin/pnpm.cjs" },
        hash: "sha512.abc",
      }),
    );

    const locator: Locator = { name: "pnpm", reference: "9.1.0" };
    const spec = await ensureInstalled(locator);

    expect(spec).toEqual({
      location,
      bin: { pnpm: "./bin/pnpm.cjs" },
      hash: "sha512.abc",
    });
    // Not one metadata request, not one artifact request, and no rewrite of the
    // reference either — the marker is the whole answer.
    expect(requested).toEqual([]);
    expect(locator.reference).toBe("9.1.0");
  });

  it("finds the marker for a hash-pinned reference, whose directory carries no build suffix", async () => {
    const location = join(home, "v1", "pnpm", "9.1.0");
    await mkdir(location, { recursive: true });
    await writeFile(
      join(location, ".corepack"),
      JSON.stringify({ locator: { name: "pnpm", reference: "9.1.0" }, bin: ["pnpm"], hash: "x.y" }),
    );

    const spec = await ensureInstalled({ name: "pnpm", reference: "9.1.0+sha256.deadbeef" });

    expect(spec.location).toBe(location);
    expect(requested).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * §07.3, §07.4 — the three download shapes
 * ------------------------------------------------------------------ */

describe("download shapes (§07.3, §07.4)", () => {
  it("extracts a `.tgz` in full and verifies the signed integrity (default registry)", async () => {
    const pair = keypair();
    const tarball = await tarballOf({
      "package.json": JSON.stringify({ name: "pnpm", version: "9.1.0", bin: "./bin/pnpm.cjs" }),
      "bin/pnpm.cjs": "console.log('pnpm')\n",
    });

    routes["/pnpm/9.1.0"] = jsonRoute(
      packument({
        packageName: "pnpm",
        version: "9.1.0",
        tarball: "https://registry.npmjs.org/pnpm/-/pnpm-9.1.0.tgz",
        integrityOf: tarball,
        keyid: pair.keyid,
        signWith: pair.privateKey,
      }),
    );
    routes["/pnpm/-/pnpm-9.1.0.tgz"] = bytesRoute(tarball);
    process.env.COREPACK_INTEGRITY_KEYS = JSON.stringify({ npm: [trustedKey(pair)] });

    const locator: Locator = { name: "pnpm", reference: "9.1.0" };
    const spec = await ensureInstalled(locator);

    expect(spec.location).toBe(join(home, "v1", "pnpm", "9.1.0"));
    // `strip: 1` removed the `package/` wrapper.
    expect(await readFile(join(spec.location, "bin/pnpm.cjs"), "utf8")).toBe(
      "console.log('pnpm')\n",
    );
    // §07.7 — the table's own BinSpec wins over the package's `bin` string.
    expect(spec.bin).toEqual({ pnpm: "./bin/pnpm.cjs", pnpx: "./bin/pnpx.cjs" });
    // §06.2 — a full extraction hashes the raw tarball stream.
    expect(spec.hash).toBe(`sha512.${hashOf(tarball)}`);
    expect(marker(spec.location)).toEqual({
      locator: { name: "pnpm", reference: `9.1.0+sha512.${hashOf(tarball)}` },
      bin: spec.bin,
      hash: spec.hash,
    });
    // §07.6 step 3 — the reference now carries the digest we actually saw.
    expect(locator.reference).toBe(`9.1.0+sha512.${hashOf(tarball)}`);

    // The metadata is asked for before the artifact: the signature has to be
    // trusted before its integrity can become the expected digest.
    expect(requested).toEqual([
      "https://registry.npmjs.org/pnpm/9.1.0",
      "https://registry.npmjs.org/pnpm/-/pnpm-9.1.0.tgz",
    ]);
  });

  it("writes a `.js` artifact verbatim and takes its bin list from the table", async () => {
    const script = "#!/usr/bin/env node\nconsole.log('yarn 3')\n";
    routes["/3.0.0/packages/yarnpkg-cli/bin/yarn.js"] = bytesRoute(Buffer.from(script));

    const spec = await ensureInstalled({ name: "yarn", reference: "3.0.0" });

    expect(await readFile(join(spec.location, "yarn.js"), "utf8")).toBe(script);
    // §07.7 — a single-file download uses the table's BinList form.
    expect(spec.bin).toEqual(["yarn", "yarnpkg"]);
    expect(spec.hash).toBe(`sha512.${hashOf(Buffer.from(script))}`);
    // §06.1 row 4 — a url-type registry publishes no signatures, so nothing was
    // fetched beyond the artifact itself.
    expect(requested).toEqual(["https://repo.yarnpkg.com/3.0.0/packages/yarnpkg-cli/bin/yarn.js"]);
  });

  it("extracts only `registry.bin` from the tarball when a custom npm registry is configured", async () => {
    const pair = keypair();
    const tarball = await tarballOf({
      "package.json": JSON.stringify({ name: "@yarnpkg/cli-dist", version: "3.0.0" }),
      "bin/yarn.js": "console.log('berry')\n",
      "lib/unused.js": "throw new Error('should not be extracted')\n",
    });

    routes["/@yarnpkg/cli-dist/3.0.0"] = jsonRoute(
      packument({
        packageName: "@yarnpkg/cli-dist",
        version: "3.0.0",
        tarball: `${origin}/@yarnpkg/cli-dist/-/cli-dist-3.0.0.tgz`,
        integrityOf: tarball,
        keyid: pair.keyid,
        signWith: pair.privateKey,
      }),
    );
    routes["/@yarnpkg/cli-dist/-/cli-dist-3.0.0.tgz"] = bytesRoute(tarball);
    process.env.COREPACK_NPM_REGISTRY = origin;
    process.env.COREPACK_INTEGRITY_KEYS = JSON.stringify({ npm: [trustedKey(pair)] });

    const spec = await ensureInstalled({ name: "yarn", reference: "3.0.0" });

    // The one filtered entry, promoted to the root under its basename (§07.4).
    expect(await readFile(join(spec.location, "yarn.js"), "utf8")).toBe("console.log('berry')\n");
    // The entry was moved out of `bin/` (the now-empty directory the extractor
    // had to create is harmless), and nothing else was written at all.
    expect(existsSync(join(spec.location, "bin", "yarn.js"))).toBe(false);
    expect(existsSync(join(spec.location, "lib"))).toBe(false);
    expect(existsSync(join(spec.location, "package.json"))).toBe(false);
    expect(spec.bin).toEqual(["yarn", "yarnpkg"]);
    // §06.2 — the *extracted file* is what the recorded hash names here, not
    // the tarball, because that is the artifact a pin would refer to.
    expect(spec.hash).toBe(`sha512.${hashOf(Buffer.from("console.log('berry')\n"))}`);
  });

  it("fails loudly on an unrecognised URL extension, before any request", async () => {
    const error = await rejection(
      ensureInstalled({ name: "yarn", reference: `${origin}/artifact.zip` }),
    );

    expect(error.message).toContain("unsupported artifact extension '.zip'");
    expect(requested).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * §06.1 — the decision table
 * ------------------------------------------------------------------ */

describe("hash pins (§06.1 row 1, §06.2)", () => {
  /** pnpm 9.1.0 served from a mirror, with a signature the test controls. */
  async function servePnpm(options: { signWith?: KeyObject; keyid?: string; tarball: Uint8Array }) {
    routes["/pnpm/9.1.0"] = jsonRoute(
      packument({
        packageName: "pnpm",
        version: "9.1.0",
        tarball: `${origin}/pnpm/-/pnpm-9.1.0.tgz`,
        integrityOf: options.tarball,
        keyid: options.keyid,
        signWith: options.signWith,
      }),
    );
    routes["/pnpm/-/pnpm-9.1.0.tgz"] = bytesRoute(options.tarball);
    process.env.COREPACK_NPM_REGISTRY = origin;
  }

  const files = {
    "package.json": JSON.stringify({ name: "pnpm", version: "9.1.0" }),
    "bin/pnpm.cjs": "console.log('pnpm')\n",
  };

  it("accepts a correctly pinned reference and records the digest it saw", async () => {
    const tarball = await tarballOf(files);
    const pair = keypair();
    await servePnpm({ tarball, keyid: pair.keyid, signWith: pair.privateKey });
    process.env.COREPACK_INTEGRITY_KEYS = JSON.stringify({ npm: [trustedKey(pair)] });

    const digest = hashOf(tarball, "sha256");
    const spec = await ensureInstalled({ name: "pnpm", reference: `9.1.0+sha256.${digest}` });

    // The pin named sha256, so that is the algorithm the recorded hash uses.
    expect(spec.hash).toBe(`sha256.${digest}`);
  });

  it("reports `Mismatch hashes` and caches nothing, identically on re-run (tests 76, 79)", async () => {
    const tarball = await tarballOf(files);
    const pair = keypair();
    await servePnpm({ tarball, keyid: pair.keyid, signWith: pair.privateKey });
    process.env.COREPACK_INTEGRITY_KEYS = JSON.stringify({ npm: [trustedKey(pair)] });

    const wrong = "0".repeat(128);
    const run = async () =>
      rejection(ensureInstalled({ name: "pnpm", reference: `9.1.0+sha512.${wrong}` }));

    const first = await run();
    expect(first.message).toBe(`Mismatch hashes. Expected ${wrong}, got ${hashOf(tarball)}`);
    expect(first).not.toBeInstanceOf(UsageError);

    // Nothing was promoted, and no temp folder was left behind for a later run
    // to trip over.
    expect(existsSync(join(home, "v1", "pnpm"))).toBe(false);
    expect(storeIsEmpty()).toBe(true);

    // Test 79: the second run reproduces the failure exactly rather than
    // reusing a poisoned cache entry.
    const second = await run();
    expect(second.message).toBe(first.message);
    expect(existsSync(join(home, "v1", "pnpm"))).toBe(false);
  });

  it("lets a user hash override a bad signature — wrong hash fails as a hash (test 77)", async () => {
    const tarball = await tarballOf(files);
    const trusted = keypair();
    const rogue = keypair("SHA256:rogue");
    // Signed by the rogue key while *claiming* the trusted keyid: verification
    // would fail with `Signature does not match` if it ran at all.
    await servePnpm({ tarball, keyid: trusted.keyid, signWith: rogue.privateKey });
    process.env.COREPACK_INTEGRITY_KEYS = JSON.stringify({ npm: [trustedKey(trusted)] });

    const error = await rejection(
      ensureInstalled({ name: "pnpm", reference: "9.1.0+sha1.deadbeef" }),
    );

    expect(error.message).toBe(
      `Mismatch hashes. Expected deadbeef, got ${hashOf(tarball, "sha1")}`,
    );
    expect(error.message).not.toContain("Signature");
  });

  it("installs despite a bad signature once the correct hash is supplied (test 78)", async () => {
    const tarball = await tarballOf(files);
    const trusted = keypair();
    const rogue = keypair("SHA256:rogue");
    await servePnpm({ tarball, keyid: trusted.keyid, signWith: rogue.privateKey });
    process.env.COREPACK_INTEGRITY_KEYS = JSON.stringify({ npm: [trustedKey(trusted)] });

    const spec = await ensureInstalled({
      name: "pnpm",
      reference: `9.1.0+sha512.${hashOf(tarball)}`,
    });

    expect(spec.hash).toBe(`sha512.${hashOf(tarball)}`);
    expect(existsSync(join(spec.location, "bin/pnpm.cjs"))).toBe(true);
  });
});

describe("registry signatures (§06.1 row 2)", () => {
  it("refuses a tarball inconsistent with its signed integrity (test 76)", async () => {
    const good = await tarballOf({ "package.json": `{"name":"pnpm","version":"9.1.0"}` });
    const evil = await tarballOf({
      "package.json": `{"name":"pnpm","version":"9.1.0"}`,
      "backdoor.js": "steal()\n",
    });
    const pair = keypair();

    routes["/pnpm/9.1.0"] = jsonRoute(
      packument({
        packageName: "pnpm",
        version: "9.1.0",
        tarball: `${origin}/pnpm/-/pnpm-9.1.0.tgz`,
        integrityOf: good,
        keyid: pair.keyid,
        signWith: pair.privateKey,
      }),
    );
    routes["/pnpm/-/pnpm-9.1.0.tgz"] = bytesRoute(evil);
    process.env.COREPACK_NPM_REGISTRY = origin;
    process.env.COREPACK_INTEGRITY_KEYS = JSON.stringify({ npm: [trustedKey(pair)] });

    const error = await rejection(ensureInstalled({ name: "pnpm", reference: "9.1.0" }));

    expect(error.message).toBe(`Mismatch hashes. Expected ${hashOf(good)}, got ${hashOf(evil)}`);
    expect(existsSync(join(home, "v1", "pnpm"))).toBe(false);
  });

  it("surfaces a bad signature before the hash check has anything to say", async () => {
    const tarball = await tarballOf({ "package.json": `{"name":"pnpm","version":"9.1.0"}` });
    const trusted = keypair();
    const rogue = keypair("SHA256:rogue");

    routes["/pnpm/9.1.0"] = jsonRoute(
      packument({
        packageName: "pnpm",
        version: "9.1.0",
        tarball: `${origin}/pnpm/-/pnpm-9.1.0.tgz`,
        integrityOf: tarball,
        keyid: trusted.keyid,
        signWith: rogue.privateKey,
      }),
    );
    routes["/pnpm/-/pnpm-9.1.0.tgz"] = bytesRoute(tarball);
    process.env.COREPACK_NPM_REGISTRY = origin;
    process.env.COREPACK_INTEGRITY_KEYS = JSON.stringify({ npm: [trustedKey(trusted)] });

    const error = await rejection(ensureInstalled({ name: "pnpm", reference: "9.1.0" }));

    expect(error.message).toBe("Signature does not match");
    expect(existsSync(join(home, "v1", "pnpm"))).toBe(false);
  });

  it("skips every check when COREPACK_INTEGRITY_KEYS disables them (§06.1 row 5)", async () => {
    const good = await tarballOf({ "package.json": `{"name":"pnpm","version":"9.1.0"}` });
    const evil = await tarballOf({ "package.json": `{"name":"pnpm","version":"9.1.0"} ` });

    routes["/pnpm/9.1.0"] = jsonRoute(
      packument({
        packageName: "pnpm",
        version: "9.1.0",
        tarball: `${origin}/pnpm/-/pnpm-9.1.0.tgz`,
        integrityOf: good,
      }),
    );
    routes["/pnpm/-/pnpm-9.1.0.tgz"] = bytesRoute(evil);
    process.env.COREPACK_NPM_REGISTRY = origin;
    process.env.COREPACK_INTEGRITY_KEYS = "0";

    const spec = await ensureInstalled({ name: "pnpm", reference: "9.1.0" });
    expect(spec.hash).toBe(`sha512.${hashOf(evil)}`);
  });

  it("warns rather than failing when the registry publishes no integrity at all", async () => {
    const tarball = await tarballOf({ "package.json": `{"name":"pnpm","version":"9.1.0"}` });
    routes["/pnpm/9.1.0"] = jsonRoute(
      packument({
        packageName: "pnpm",
        version: "9.1.0",
        tarball: `${origin}/pnpm/-/pnpm-9.1.0.tgz`,
      }),
    );
    routes["/pnpm/-/pnpm-9.1.0.tgz"] = bytesRoute(tarball);
    process.env.COREPACK_NPM_REGISTRY = origin;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const spec = await ensureInstalled({ name: "pnpm", reference: "9.1.0" });

    expect(spec.hash).toBe(`sha512.${hashOf(tarball)}`);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("publishes no integrity digest"));
  });
});

/* ------------------------------------------------------------------ *
 * §14.10 — the hole this task closes
 * ------------------------------------------------------------------ */

describe("§14.10 — single-file extractions are verified too", () => {
  const berry = {
    "package.json": JSON.stringify({ name: "@yarnpkg/cli-dist", version: "3.0.0" }),
    "bin/yarn.js": "console.log('berry')\n",
  };

  async function serveBerry(options: {
    signed: Uint8Array;
    served: Uint8Array;
    pair: Keypair;
  }): Promise<void> {
    routes["/@yarnpkg/cli-dist/3.0.0"] = jsonRoute(
      packument({
        packageName: "@yarnpkg/cli-dist",
        version: "3.0.0",
        tarball: `${origin}/@yarnpkg/cli-dist/-/cli-dist-3.0.0.tgz`,
        integrityOf: options.signed,
        keyid: options.pair.keyid,
        signWith: options.pair.privateKey,
      }),
    );
    routes["/@yarnpkg/cli-dist/-/cli-dist-3.0.0.tgz"] = bytesRoute(options.served);
    process.env.COREPACK_NPM_REGISTRY = origin;
    process.env.COREPACK_INTEGRITY_KEYS = JSON.stringify({ npm: [trustedKey(options.pair)] });
  }

  it("refuses a tampered tarball on the `registry.bin` path with no pinned hash", async () => {
    const pair = keypair();
    const signed = await tarballOf(berry);
    // A tampered mirror: the file the filter extracts is still a perfectly
    // valid `bin/yarn.js`, so extraction succeeds and corepack's guard
    // (`!registry.bin`) would have installed this without a single check.
    const tampered = await tarballOf({ ...berry, "bin/yarn.js": "steal(process.env)\n" });
    expect(hashOf(tampered)).not.toBe(hashOf(signed));

    await serveBerry({ signed, served: tampered, pair });

    const error = await rejection(ensureInstalled({ name: "yarn", reference: "3.0.0" }));

    // The digest compared is the one over the *tarball stream*, exactly as on
    // the full-extraction path — the extracted file's digest could never be
    // compared against `dist.integrity` at all.
    expect(error.message).toBe(
      `Mismatch hashes. Expected ${hashOf(signed)}, got ${hashOf(tampered)}`,
    );
    expect(existsSync(join(home, "v1", "yarn"))).toBe(false);
  });

  it("still installs the untampered artifact, recording the extracted file's digest", async () => {
    const pair = keypair();
    const signed = await tarballOf(berry);
    await serveBerry({ signed, served: signed, pair });

    const spec = await ensureInstalled({ name: "yarn", reference: "3.0.0" });

    expect(await readFile(join(spec.location, "yarn.js"), "utf8")).toBe("console.log('berry')\n");
    // §06.2's third row: the recorded hash names the extracted file, while the
    // §14.10 check above covered the stream.
    expect(spec.hash).toBe(`sha512.${hashOf(Buffer.from("console.log('berry')\n"))}`);
  });

  it("rejects a bad signature on the `registry.bin` path as well", async () => {
    const trusted = keypair();
    const rogue = keypair("SHA256:rogue");
    const signed = await tarballOf(berry);
    await serveBerry({
      signed,
      served: signed,
      pair: { ...trusted, privateKey: rogue.privateKey },
    });

    const error = await rejection(ensureInstalled({ name: "yarn", reference: "3.0.0" }));
    expect(error.message).toBe("Signature does not match");
  });
});

/* ------------------------------------------------------------------ *
 * §05.5 — the download prompt
 * ------------------------------------------------------------------ */

describe("download prompt (§05.5, tests 46, 47)", () => {
  function serveScript(): string {
    const script = "console.log('yarn 3')\n";
    routes["/3.0.0/packages/yarnpkg-cli/bin/yarn.js"] = bytesRoute(Buffer.from(script));
    return script;
  }

  it("prints exactly the notice when the variable is 1, and asks nothing off a TTY", async () => {
    serveScript();
    process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT = "1";
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const resume = vi.spyOn(process.stdin, "resume");
    const listen = vi.spyOn(process.stdin, "on");

    await ensureInstalled({ name: "yarn", reference: "3.0.0" });

    expect(stderr.mock.calls.map(([chunk]) => chunk)).toEqual([
      "! Corepack is about to download https://repo.yarnpkg.com/3.0.0/packages/yarnpkg-cli/bin/yarn.js\n",
    ]);
    // §08.6 — stdin is never touched when the confirmation is skipped.
    expect(resume).not.toHaveBeenCalled();
    expect(listen).not.toHaveBeenCalled();
  });

  it("stays silent when the variable is 0 (test 47)", async () => {
    serveScript();
    process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT = "0";
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await ensureInstalled({ name: "yarn", reference: "3.0.0" });

    expect(stderr).not.toHaveBeenCalled();
  });

  it("names the mirror's tarball URL, not the table's (test 50)", async () => {
    const pair = keypair();
    const tarball = await tarballOf({
      "package.json": JSON.stringify({ name: "@yarnpkg/cli-dist", version: "3.0.0" }),
      "bin/yarn.js": "console.log('berry')\n",
    });
    routes["/@yarnpkg/cli-dist/3.0.0"] = jsonRoute(
      packument({
        packageName: "@yarnpkg/cli-dist",
        version: "3.0.0",
        tarball: `${origin}/@yarnpkg/cli-dist/-/cli-dist-3.0.0.tgz`,
        integrityOf: tarball,
        keyid: pair.keyid,
        signWith: pair.privateKey,
      }),
    );
    routes["/@yarnpkg/cli-dist/-/cli-dist-3.0.0.tgz"] = bytesRoute(tarball);
    process.env.COREPACK_NPM_REGISTRY = origin;
    process.env.COREPACK_INTEGRITY_KEYS = JSON.stringify({ npm: [trustedKey(pair)] });
    process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT = "1";
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    await ensureInstalled({ name: "yarn", reference: "3.0.0" });

    // The metadata request came first and printed nothing: the notice is for
    // artifacts only.
    expect(stderr.mock.calls.map(([chunk]) => chunk)).toEqual([
      `! Corepack is about to download ${origin}/@yarnpkg/cli-dist/-/cli-dist-3.0.0.tgz\n`,
    ]);
  });

  describe("the interactive branch", () => {
    let restore: (() => void) | undefined;

    function fakeTty(input: string): void {
      const fake = new Readable({ read() {} }) as Readable & { isTTY?: boolean };
      fake.isTTY = true;
      fake.push(input);
      const original = Object.getOwnPropertyDescriptor(process, "stdin")!;
      Object.defineProperty(process, "stdin", { value: fake, configurable: true });
      restore = () => Object.defineProperty(process, "stdin", original);
      process.env.COREPACK_ENABLE_DOWNLOAD_PROMPT = "1";
      vi.spyOn(process.stderr, "write").mockReturnValue(true);
    }

    afterEach(() => {
      restore?.();
      restore = undefined;
    });

    it("treats a bare newline as yes", async () => {
      fakeTty("\n");
      await expect(confirmDownload("https://example.com/yarn.js")).resolves.toBeUndefined();
    });

    it("aborts on `n`", async () => {
      fakeTty("n\n");
      const error = await rejection(confirmDownload("https://example.com/yarn.js"));
      expect(error).toBeInstanceOf(UsageError);
      expect(error.message).toBe("Aborted by the user");
    });

    it("does not prompt inside CI", async () => {
      fakeTty("n\n");
      process.env.CI = "true";
      // `n` would have aborted; with CI set the byte is never read.
      await expect(confirmDownload("https://example.com/yarn.js")).resolves.toBeUndefined();
    });
  });
});

/* ------------------------------------------------------------------ *
 * §04.7 — last-known-good auto-bump
 * ------------------------------------------------------------------ */

describe("last-known-good auto-bump (§04.7)", () => {
  async function servePnpm(): Promise<Uint8Array> {
    const tarball = await tarballOf({ "package.json": `{"name":"pnpm","version":"9.1.0"}` });
    routes["/pnpm/9.1.0"] = jsonRoute(
      packument({
        packageName: "pnpm",
        version: "9.1.0",
        tarball: `${origin}/pnpm/-/pnpm-9.1.0.tgz`,
      }),
    );
    routes["/pnpm/-/pnpm-9.1.0.tgz"] = bytesRoute(tarball);
    process.env.COREPACK_NPM_REGISTRY = origin;
    process.env.COREPACK_INTEGRITY_KEYS = "0";
    return tarball;
  }

  function lastKnownGood(): Record<string, string> {
    return JSON.parse(readFileSync(join(home, "lastKnownGood.json"), "utf8")) as Record<
      string,
      string
    >;
  }

  it("advances an existing entry inside the same major, to the hashed reference", async () => {
    const tarball = await servePnpm();
    await writeFile(join(home, "lastKnownGood.json"), JSON.stringify({ pnpm: "9.0.0" }));

    await ensureInstalled({ name: "pnpm", reference: "9.1.0" });

    expect(lastKnownGood()).toEqual({ pnpm: `9.1.0+sha512.${hashOf(tarball)}` });
  });

  it("never crosses a major, and never creates a missing entry", async () => {
    await servePnpm();
    await writeFile(join(home, "lastKnownGood.json"), JSON.stringify({ pnpm: "8.0.0" }));

    await ensureInstalled({ name: "pnpm", reference: "9.1.0" });
    expect(lastKnownGood()).toEqual({ pnpm: "8.0.0" });

    await rm(join(home, "lastKnownGood.json"));
    await rm(join(home, "v1", "pnpm"), { recursive: true });
    await ensureInstalled({ name: "pnpm", reference: "9.1.0" });
    expect(existsSync(join(home, "lastKnownGood.json"))).toBe(false);
  });

  it("leaves the default alone for a cache-only install", async () => {
    await servePnpm();
    await writeFile(join(home, "lastKnownGood.json"), JSON.stringify({ pnpm: "9.0.0" }));

    await ensureInstalled({ name: "pnpm", reference: "9.1.0" }, { cacheOnly: true });

    expect(lastKnownGood()).toEqual({ pnpm: "9.0.0" });
  });
});
