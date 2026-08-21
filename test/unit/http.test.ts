import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageError, messages } from "../../src/errors.ts";
import {
  assertSafeArtifactUrl,
  credentialsFor,
  httpGet,
  httpGetJson,
  USER_AGENT,
} from "../../src/http.ts";

/* ------------------------------------------------------------------ *
 * A real local server per test: the *client* is what must be fetch-based,
 * and the only way to know what went on the wire is to receive it.
 * ------------------------------------------------------------------ */

interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

interface TestServer {
  origin: string;
  requests: Recorded[];
  last: () => Recorded;
  close: () => Promise<void>;
}

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

const servers: TestServer[] = [];

async function startServer(handler: Handler): Promise<TestServer> {
  const requests: Recorded[] = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? "",
      url: request.url ?? "",
      headers: { ...request.headers },
    });
    handler(request, response);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  const instance: TestServer = {
    origin: `http://127.0.0.1:${port}`,
    requests,
    last: () => {
      const request = requests.at(-1);
      if (request === undefined) {
        throw new Error("no request was received");
      }
      return request;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };

  servers.push(instance);
  return instance;
}

/** A server that answers every request with `{"ok":true}`. */
function ok(): Promise<TestServer> {
  return startServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(`{"ok":true}`);
  });
}

/** A port nothing is listening on: bind one, learn the number, give it back. */
async function deadOrigin(): Promise<string> {
  const server = await ok();
  const origin = server.origin;
  await server.close();
  servers.splice(servers.indexOf(server), 1);
  return origin;
}

const ENV_KEYS = [
  "COREPACK_NPM_TOKEN",
  "COREPACK_NPM_USERNAME",
  "COREPACK_NPM_PASSWORD",
  "COREPACK_ENABLE_NETWORK",
  "COREPACK_ENABLE_UNSAFE_CUSTOM_URLS",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
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
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

const base64 = (value: string) => Buffer.from(value).toString("base64");

/* ------------------------------------------------------------------ *
 * §14.6 — the one credential rule
 * ------------------------------------------------------------------ */

describe("credentials (§14.6)", () => {
  it("sends Bearer for COREPACK_NPM_TOKEN (test 65)", async () => {
    const server = await ok();
    process.env.COREPACK_NPM_TOKEN = "foo";

    await httpGet(`${server.origin}/pkg`, { registryOrigin: server.origin });

    expect(server.last().headers.authorization).toBe("Bearer foo");
  });

  it("prefers Bearer over username/password (test 66)", async () => {
    const server = await ok();
    process.env.COREPACK_NPM_TOKEN = "foo";
    process.env.COREPACK_NPM_USERNAME = "user";
    process.env.COREPACK_NPM_PASSWORD = "hunter2";

    await httpGet(`${server.origin}/pkg`, { registryOrigin: server.origin });

    const { authorization } = server.last().headers;
    expect(authorization).toBe("Bearer foo");
    expect(authorization).not.toContain("Basic");
  });

  it("sends Basic for username + password (test 67)", async () => {
    const server = await ok();
    process.env.COREPACK_NPM_USERNAME = "user";
    process.env.COREPACK_NPM_PASSWORD = "hunter2";

    await httpGet(`${server.origin}/pkg`, { registryOrigin: server.origin });

    expect(server.last().headers.authorization).toBe(`Basic ${base64("user:hunter2")}`);
  });

  it("sends nothing for a username with no password (test 68)", async () => {
    const server = await ok();
    process.env.COREPACK_NPM_USERNAME = "user";

    await httpGet(`${server.origin}/pkg`, { registryOrigin: server.origin });

    expect(server.last().headers.authorization).toBeUndefined();
  });

  it("sends nothing for a password with no username", async () => {
    const server = await ok();
    process.env.COREPACK_NPM_PASSWORD = "hunter2";

    await httpGet(`${server.origin}/pkg`, { registryOrigin: server.origin });

    expect(server.last().headers.authorization).toBeUndefined();
  });

  it("treats an empty token as present, not as absent", () => {
    process.env.COREPACK_NPM_TOKEN = "";
    process.env.COREPACK_NPM_USERNAME = "user";
    process.env.COREPACK_NPM_PASSWORD = "hunter2";

    const { authorization } = credentialsFor(
      new URL("https://registry.npmjs.org/pkg"),
      "https://registry.npmjs.org",
    );

    expect(authorization).toBe("Bearer ");
  });

  it("sends Basic from userinfo and strips it from the URL (test 69)", async () => {
    const server = await ok();
    const url = new URL(`${server.origin}/pkg`);
    url.username = "user";
    url.password = "hunter2";

    // The URL that goes on the wire carries no userinfo…
    const stripped = credentialsFor(new URL(url.href), server.origin);
    expect(stripped.url.href).toBe(`${server.origin}/pkg`);
    expect(stripped.url.username).toBe("");
    expect(stripped.url.password).toBe("");
    expect(stripped.authorization).toBe(`Basic ${base64("user:hunter2")}`);

    await httpGet(url.href, { registryOrigin: server.origin });

    // …and neither does anything the server actually received.
    const request = server.last();
    expect(request.headers.authorization).toBe(`Basic ${base64("user:hunter2")}`);
    expect(`${request.method} ${request.url}`).toBe("GET /pkg");
    expect(request.url).not.toContain("@");
    expect(request.headers.host).not.toContain("@");
    for (const [name, value] of Object.entries(request.headers)) {
      if (name === "authorization") continue;
      expect(JSON.stringify(value)).not.toContain("hunter2");
    }
  });

  it("userinfo wins over an env token", () => {
    process.env.COREPACK_NPM_TOKEN = "foo";

    const { authorization } = credentialsFor(
      new URL("https://user:hunter2@registry.npmjs.org/pkg"),
      "https://registry.npmjs.org",
    );

    expect(authorization).toBe(`Basic ${base64("user:hunter2")}`);
  });

  it("sends NO credentials to an origin that is not the registry (test 70)", async () => {
    const registry = await ok();
    const cdn = await ok();
    process.env.COREPACK_NPM_TOKEN = "foo";
    process.env.COREPACK_NPM_USERNAME = "user";
    process.env.COREPACK_NPM_PASSWORD = "hunter2";

    await httpGet(`${cdn.origin}/tarball.tgz`, { registryOrigin: registry.origin });

    expect(cdn.last().headers.authorization).toBeUndefined();
    expect(registry.requests).toHaveLength(0);
  });

  it("sends no credentials when no registry origin is configured", async () => {
    const server = await ok();
    process.env.COREPACK_NPM_TOKEN = "foo";

    await httpGet(`${server.origin}/pkg`);

    expect(server.last().headers.authorization).toBeUndefined();
  });

  it("does not let a caller smuggle an authorization header past the origin check", async () => {
    const server = await ok();

    await httpGet(`${server.origin}/pkg`, { headers: { authorization: "Bearer smuggled" } });

    expect(server.last().headers.authorization).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Redirects
 * ------------------------------------------------------------------ */

describe("redirects", () => {
  it("drops Authorization on a cross-origin hop", async () => {
    const cdn = await ok();
    const registry = await startServer((request, response) => {
      if (request.url === "/pkg") {
        response.writeHead(302, { location: `${cdn.origin}/tarball.tgz` });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`{"ok":true}`);
    });
    process.env.COREPACK_NPM_TOKEN = "foo";

    const response = await httpGet(`${registry.origin}/pkg`, { registryOrigin: registry.origin });
    expect(response.status).toBe(200);

    // The first hop is authenticated…
    expect(registry.last().headers.authorization).toBe("Bearer foo");
    // …the cross-origin hop is not.
    expect(cdn.last().headers.authorization).toBeUndefined();
  });

  it("keeps Authorization on a same-origin hop", async () => {
    const registry = await startServer((request, response) => {
      if (request.url === "/pkg") {
        response.writeHead(302, { location: "/pkg/latest" });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`{"ok":true}`);
    });
    process.env.COREPACK_NPM_TOKEN = "foo";

    await httpGet(`${registry.origin}/pkg`, { registryOrigin: registry.origin });

    expect(registry.requests).toHaveLength(2);
    expect(registry.requests[1]?.url).toBe("/pkg/latest");
    expect(registry.requests[1]?.headers.authorization).toBe("Bearer foo");
  });
});

/* ------------------------------------------------------------------ *
 * §12.6 error messages
 * ------------------------------------------------------------------ */

describe("errors (§12.6)", () => {
  it("throws the exact badStatus message on a non-2xx", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("nope");
    });
    const url = `${server.origin}/missing`;

    await expect(httpGet(url)).rejects.toThrow(messages.badStatus(404, url));
    await expect(httpGet(url)).rejects.toSatisfy(
      (error: Error) =>
        error.message ===
        `Server answered with HTTP 404 when performing the request to ${url}; for troubleshooting help, see https://github.com/nodejs/corepack#troubleshooting`,
    );
  });

  it("drains the body before throwing, keeping the connection reusable", async () => {
    const server = await startServer((request, response) => {
      if (request.url === "/missing") {
        response.writeHead(404, { "content-type": "text/plain" });
        response.end("x".repeat(4096));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`{"ok":true}`);
    });

    await expect(httpGet(`${server.origin}/missing`)).rejects.toThrow(/HTTP 404/);
    // A torn-down connection would still work here, but a *reused* one proves
    // the body was consumed rather than abandoned.
    await expect(httpGetJson(`${server.origin}/pkg`)).resolves.toEqual({ ok: true });
  });

  it("throws the exact requestFailed message when the host is unreachable", async () => {
    const origin = await deadOrigin();
    const url = `${origin}/pkg`;

    await expect(httpGet(url)).rejects.toThrow(messages.requestFailed(url));
  });

  it("attaches the transport error as cause", async () => {
    const origin = await deadOrigin();

    const error = await httpGet(`${origin}/pkg`).catch((error_: Error) => error_);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it("surfaces a timeout as the transport-failure message", async () => {
    const server = await startServer(() => {
      // Never answers.
    });
    const url = `${server.origin}/slow`;

    await expect(httpGet(url, { timeout: 50 })).rejects.toThrow(messages.requestFailed(url));
  });

  it("never leaks userinfo into an error message", async () => {
    const origin = await deadOrigin();
    const withUserinfo = origin.replace("http://", "http://user:hunter2@");

    const error = await httpGet(`${withUserinfo}/pkg`).catch((error_: Error) => error_);

    expect((error as Error).message).not.toContain("hunter2");
    expect((error as Error).message).not.toContain("user:");
    expect((error as Error).message).toBe(messages.requestFailed(`${origin}/pkg`));
  });

  it("reports an unparseable URL as a request failure", async () => {
    await expect(httpGet("not a url")).rejects.toThrow(messages.requestFailed("not a url"));
  });
});

/* ------------------------------------------------------------------ *
 * COREPACK_ENABLE_NETWORK
 * ------------------------------------------------------------------ */

describe("COREPACK_ENABLE_NETWORK=0", () => {
  it("throws a UsageError before opening a socket", async () => {
    const server = await ok();
    process.env.COREPACK_ENABLE_NETWORK = "0";
    const url = `${server.origin}/pkg`;

    const error = await httpGet(url).catch((error_: Error) => error_);

    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toBe(messages.networkDisabledUrl(url));
    expect((error as Error).message).toBe(
      `Network access disabled by the environment; can't reach ${url}`,
    );
    expect(server.requests).toHaveLength(0);
  });

  it("names the stripped URL, not the one with userinfo", async () => {
    const server = await ok();
    process.env.COREPACK_ENABLE_NETWORK = "0";
    const withUserinfo = server.origin.replace("http://", "http://user:hunter2@");

    const error = await httpGet(`${withUserinfo}/pkg`).catch((error_: Error) => error_);

    expect((error as Error).message).toBe(messages.networkDisabledUrl(`${server.origin}/pkg`));
    expect(server.requests).toHaveLength(0);
  });

  it('only reacts to the exact string "0"', async () => {
    const server = await ok();
    process.env.COREPACK_ENABLE_NETWORK = "1";

    await expect(httpGetJson(`${server.origin}/pkg`)).resolves.toEqual({ ok: true });
  });
});

/* ------------------------------------------------------------------ *
 * Request shape
 * ------------------------------------------------------------------ */

describe("request shape", () => {
  it("sends a User-Agent naming the tool and nothing about the machine", async () => {
    const server = await ok();

    await httpGet(`${server.origin}/pkg`);

    const agent = server.last().headers["user-agent"];
    expect(agent).toBe(USER_AGENT);
    expect(agent).toMatch(/^pipack\/\d+\.\d+\.\d+/);
    for (const secret of [process.env.USER, process.env.HOME, process.platform]) {
      if (secret) expect(agent).not.toContain(secret);
    }
  });

  it("passes caller headers through and lets them override the User-Agent", async () => {
    const server = await ok();

    await httpGet(`${server.origin}/pkg`, {
      headers: {
        accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8",
        "user-agent": "custom/1",
      },
    });

    const { headers } = server.last();
    expect(headers.accept).toBe(
      "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8",
    );
    expect(headers["user-agent"]).toBe("custom/1");
  });

  it("issues a GET", async () => {
    const server = await ok();

    await httpGet(`${server.origin}/pkg`);

    expect(server.last().method).toBe("GET");
  });

  it("httpGetJson parses the body", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`{"versions":{"1.0.0":{}}}`);
    });

    const body = await httpGetJson<{ versions: Record<string, unknown> }>(`${server.origin}/pkg`);

    expect(Object.keys(body.versions)).toEqual(["1.0.0"]);
  });

  it("httpGetJson reports a malformed body as a request failure", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{not json");
    });
    const url = `${server.origin}/pkg`;

    await expect(httpGetJson(url)).rejects.toThrow(messages.requestFailed(url));
  });
});

/* ------------------------------------------------------------------ *
 * §14.9 — artifact URL validation (test 83)
 * ------------------------------------------------------------------ */

describe("assertSafeArtifactUrl (§14.9)", () => {
  const registry = "https://registry.npmjs.org";

  it("accepts an https URL on the registry's host", () => {
    const url = assertSafeArtifactUrl(
      "https://registry.npmjs.org/yarn/-/yarn-1.22.22.tgz",
      registry,
    );
    expect(url.href).toBe("https://registry.npmjs.org/yarn/-/yarn-1.22.22.tgz");
  });

  it("accepts a registry URL that carries a path and a trailing slash", () => {
    expect(() =>
      assertSafeArtifactUrl("https://registry.npmjs.org/yarn/-/yarn-1.22.22.tgz", `${registry}/`),
    ).not.toThrow();
  });

  it('rejects httpfoo:// — corepack\'s startsWith("http") bug', () => {
    // Same host, so a host-only check would wave this straight through.
    expect(() => assertSafeArtifactUrl("httpfoo://registry.npmjs.org/x.tgz", registry)).toThrow(
      /^Refusing to download from httpfoo:\/\/registry\.npmjs\.org: /,
    );
  });

  it("rejects a different host (test 83)", () => {
    expect(() => assertSafeArtifactUrl("https://evil.example.com/x.tgz", registry)).toThrow(
      messages.refusingToDownload("evil.example.com", registry),
    );
    expect(() => assertSafeArtifactUrl("https://evil.example.com/x.tgz", registry)).toThrow(
      `Refusing to download from evil.example.com: it does not match the configured registry ${registry}`,
    );
  });

  it("treats a different port as a different host", () => {
    expect(() => assertSafeArtifactUrl("https://registry.npmjs.org:8443/x.tgz", registry)).toThrow(
      /^Refusing to download from registry\.npmjs\.org:8443: /,
    );
  });

  it("rejects an unparseable value", () => {
    expect(() => assertSafeArtifactUrl("not a url", registry)).toThrow(
      messages.refusingToDownload("not a url", registry),
    );
    expect(() => assertSafeArtifactUrl("", registry)).toThrow(/^Refusing to download from : /);
  });

  it("rejects other schemes outright", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://registry.npmjs.org/x.tgz",
      "javascript:alert(1)",
      "data:text/plain,x",
    ]) {
      expect(() => assertSafeArtifactUrl(url, registry)).toThrow(/^Refusing to download from /);
    }
  });

  it("does not silently downgrade an https registry to http", () => {
    expect(() => assertSafeArtifactUrl("http://registry.npmjs.org/x.tgz", registry)).toThrow(
      /^Refusing to download from http:\/\/registry\.npmjs\.org: /,
    );
  });

  it("allows http when the configured registry is itself http", () => {
    const mirror = "http://mirror.internal:4873";
    expect(assertSafeArtifactUrl("http://mirror.internal:4873/x.tgz", mirror).protocol).toBe(
      "http:",
    );
    // …and still allows https on the same host.
    expect(() => assertSafeArtifactUrl("https://mirror.internal:4873/x.tgz", mirror)).not.toThrow();
  });

  it("relaxes only the host check under COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=1", () => {
    process.env.COREPACK_ENABLE_UNSAFE_CUSTOM_URLS = "1";

    expect(() => assertSafeArtifactUrl("https://evil.example.com/x.tgz", registry)).not.toThrow();
    // The scheme check is not negotiable.
    expect(() => assertSafeArtifactUrl("httpfoo://evil.example.com/x.tgz", registry)).toThrow(
      /^Refusing to download from /,
    );
  });

  it("never leaks the registry's userinfo into the error", () => {
    const error = (() => {
      try {
        assertSafeArtifactUrl("https://evil.example.com/x.tgz", "https://user:hunter2@npm.corp");
      } catch (error_) {
        return error_ as Error;
      }
      throw new Error("expected a throw");
    })();

    expect(error.message).not.toContain("hunter2");
    expect(error.message).toContain("https://npm.corp");
  });
});
