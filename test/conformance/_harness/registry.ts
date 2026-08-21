/**
 * The mock registry required by §13.1.
 *
 * Serves `GET /<pkg>`, `GET /<pkg>/<version>`, `GET /<pkg>/-/<pkg>-<version>.tgz`,
 * scoped names and dist-tags, signs every version with a real ECDSA P-256 key
 * over `<name>@<version>:<integrity>`, answers `401` on bad auth, and can be put
 * into deliberately-broken modes.
 *
 * The important one is `invalid_integrity`: the metadata is *validly signed* but
 * describes bytes other than the ones served, which is the only way to tell a
 * signature check from a digest check apart (rows 75–79).
 */

import { Buffer } from "node:buffer";
import { createHash, generateKeyPairSync, type KeyObject, sign as cryptoSign } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { sriOf } from "./tarball.ts";

export type RegistryMode =
  | "ok"
  | "invalid_signature"
  | "invalid_integrity"
  | "no_signatures"
  | "untrusted_key";

export interface RecordedRequest {
  /** The path the mock actually served. */
  path: string;
  /** The URL the tool asked for, before the harness rewrote its host onto the mock. */
  original: string;
  authorization?: string;
  accept?: string;
  userAgent?: string;
}

interface PublishedVersion {
  tarball: Uint8Array;
  /** What `dist.integrity` claims — normally the tarball's own digest. */
  integrity: string;
}

interface PublishedPackage {
  versions: Map<string, PublishedVersion>;
  distTags: Record<string, string>;
}

function keypair(): { privateKey: KeyObject; spki: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return { privateKey, spki: publicKey.export({ type: "spki", format: "der" }).toString("base64") };
}

/** `"SHA256:" + base64(SHA256(<DER SPKI>))` — a selector, never a security check (§06.3). */
function keyidFor(spki: string): string {
  return `SHA256:${createHash("sha256").update(Buffer.from(spki, "base64")).digest("base64").replace(/=+$/, "")}`;
}

export class MockRegistry {
  readonly #server: Server;
  readonly #packages = new Map<string, PublishedPackage>();
  readonly #files = new Map<string, { body: Uint8Array; type: string }>();

  readonly #trusted = keypair();
  readonly #rogue = keypair();

  #origin = "";

  /** Every request the mock answered, in order. */
  requests: RecordedRequest[] = [];
  mode: RegistryMode = "ok";
  /** When set, a request whose `authorization` differs gets a 401. */
  requiredAuthorization?: string;
  /** When set, `dist.tarball` is advertised on this origin instead (row 83). */
  tarballOrigin?: string;

  constructor() {
    this.#server = createServer((request, response) => {
      this.#handle(request, response);
    });
  }

  get origin(): string {
    return this.#origin;
  }

  /** The keyid the mock signs under, and the one its trust store publishes. */
  get keyid(): string {
    return keyidFor(this.#trusted.spki);
  }

  /**
   * A `COREPACK_INTEGRITY_KEYS` value trusting this mock, in corepack's legacy
   * `{"npm": [...]}` shape so it applies whatever registry origin is in force.
   */
  trustStore(options?: { expires?: string | null; keyid?: string }): string {
    return JSON.stringify({
      npm: [
        {
          expires: options?.expires ?? null,
          keyid: options?.keyid ?? this.keyid,
          keytype: "ecdsa-sha2-nistp256",
          scheme: "ecdsa-sha2-nistp256",
          key: this.#trusted.spki,
        },
      ],
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(0, "127.0.0.1", resolve));
    this.#origin = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  /** Forget the request log, the mode and the auth requirement; keep what is published. */
  reset(): void {
    this.requests = [];
    this.mode = "ok";
    this.requiredAuthorization = undefined;
    this.tarballOrigin = undefined;
  }

  publish(
    name: string,
    version: string,
    tarball: Uint8Array,
    options?: { distTags?: Record<string, string> },
  ): void {
    let entry = this.#packages.get(name);
    if (entry === undefined) {
      entry = { versions: new Map(), distTags: {} };
      this.#packages.set(name, entry);
    }
    entry.versions.set(version, { tarball, integrity: sriOf(tarball) });
    Object.assign(entry.distTags, options?.distTags);
  }

  /** A raw artifact at a fixed path — Yarn Berry's single `.js` file, the `/tags` document. */
  publishFile(path: string, body: string | Uint8Array, type = "application/octet-stream"): void {
    this.#files.set(path, {
      body: typeof body === "string" ? Buffer.from(body, "utf8") : body,
      type,
    });
  }

  tarballOf(name: string, version: string): Uint8Array {
    const found = this.#packages.get(name)?.versions.get(version);
    if (found === undefined) throw new Error(`Mock registry has no ${name}@${version}`);
    return found.tarball;
  }

  /* ------------------------------------------------------------------ */

  #handle(request: IncomingMessage, response: ServerResponse): void {
    const path = request.url ?? "/";
    const original =
      (request.headers["x-original-url"] as string | undefined) ?? `${this.#origin}${path}`;

    this.requests.push({
      path,
      original,
      authorization: request.headers.authorization,
      accept: request.headers.accept,
      userAgent: request.headers["user-agent"],
    });

    if (
      this.requiredAuthorization !== undefined &&
      request.headers.authorization !== this.requiredAuthorization
    ) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(`{"error":"Unauthorized"}`);
      return;
    }

    const file = this.#files.get(path);
    if (file !== undefined) {
      response.writeHead(200, { "content-type": file.type });
      response.end(Buffer.from(file.body));
      return;
    }

    // The base every advertised URL is written against: whatever host the tool
    // believes it is talking to, so `dist.tarball` passes §14.9's host check in
    // both the default-registry and the COREPACK_NPM_REGISTRY mode.
    const base = new URL(original).origin;

    const { name, rest } = splitPath(path);
    const entry = name === undefined ? undefined : this.#packages.get(name);
    if (entry === undefined || name === undefined) {
      this.#notFound(response);
      return;
    }

    if (rest[0] === "-") {
      const version = tarballVersion(name, rest[1] ?? "");
      const published = version === undefined ? undefined : entry.versions.get(version);
      if (published === undefined) {
        this.#notFound(response);
        return;
      }
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.end(Buffer.from(published.tarball));
      return;
    }

    if (rest.length === 0) {
      const versions: Record<string, unknown> = {};
      for (const version of entry.versions.keys()) {
        versions[version] = this.#versionDoc(name, version, base);
      }
      this.#json(response, { name, "dist-tags": entry.distTags, versions });
      return;
    }

    const selector = rest[0]!;
    const version = entry.versions.has(selector) ? selector : entry.distTags[selector];
    if (version === undefined || !entry.versions.has(version)) {
      this.#notFound(response);
      return;
    }
    this.#json(response, this.#versionDoc(name, version, base));
  }

  #versionDoc(name: string, version: string, base: string): unknown {
    const published = this.#packages.get(name)!.versions.get(version)!;
    const basename = name.split("/").pop()!;

    // A validly signed statement about bytes we are not serving.
    const integrity =
      this.mode === "invalid_integrity"
        ? sriOf(Buffer.from(`not the artifact you are downloading: ${name}@${version}`))
        : published.integrity;

    const dist: Record<string, unknown> = {
      tarball: `${this.tarballOrigin ?? base}/${name}/-/${basename}-${version}.tgz`,
      integrity,
      shasum: createHash("sha1").update(published.tarball).digest("hex"),
    };

    if (this.mode !== "no_signatures") {
      const payload = `${name}@${version}:${integrity}`;
      const useRogueKey = this.mode === "invalid_signature";
      dist.signatures = [
        {
          keyid: this.mode === "untrusted_key" ? "SHA256:nobody-trusts-this-key" : this.keyid,
          sig: cryptoSign(
            "sha256",
            Buffer.from(payload, "utf8"),
            useRogueKey ? this.#rogue.privateKey : this.#trusted.privateKey,
          ).toString("base64"),
        },
      ];
    }

    return { name, version, dist };
  }

  #json(response: ServerResponse, body: unknown): void {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  }

  #notFound(response: ServerResponse): void {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(`{"error":"Not found"}`);
  }
}

/** `/@scope/name/rest…` and `/name/rest…`, with the query string dropped. */
function splitPath(path: string): { name?: string; rest: string[] } {
  const segments = path
    .split("?")[0]!
    .slice(1)
    .split("/")
    .filter((segment) => segment !== "");
  if (segments.length === 0) return { rest: [] };
  if (segments[0]!.startsWith("@")) {
    if (segments.length < 2) return { rest: [] };
    return { name: `${segments[0]}/${segments[1]}`, rest: segments.slice(2) };
  }
  return { name: segments[0], rest: segments.slice(1) };
}

/** `cli-dist-3.0.0-rc.2.tgz` under `@yarnpkg/cli-dist` -> `3.0.0-rc.2`. */
function tarballVersion(name: string, file: string): string | undefined {
  const prefix = `${name.split("/").pop()}-`;
  if (!file.startsWith(prefix) || !file.endsWith(".tgz")) return undefined;
  return file.slice(prefix.length, -".tgz".length);
}
