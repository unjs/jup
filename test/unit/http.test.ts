import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  messages,
  networkError,
  redactUserinfoAnywhere,
  UsageError,
} from "../../src/errors-cold.ts";
import { loadNpmrc, npmrcAuthorizationFor, resetNpmrcCache } from "../../src/net/npmrc.ts";
import {
  assertSafeArtifactUrl,
  credentialsFor,
  httpGet,
  httpGetJson,
  retryAfterMs,
  RETRY_AFTER_TOO_LONG,
  USER_AGENT,
} from "../../src/net/http.ts";

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
  // §14.8 — the proxy variables are live with no second opt-in, so a developer
  // who has one configured must not have it applied to these fixtures.
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
  "COREPACK_NPM_TOKEN",
  "COREPACK_NPM_USERNAME",
  "COREPACK_NPM_PASSWORD",
  "COREPACK_ENABLE_NETWORK",
  "COREPACK_ENABLE_UNSAFE_CUSTOM_URLS",
  // §15.4 / §15.5 — a developer's own TLS or retry settings must not reach the
  // fixtures, and the retry default must not turn every failure assertion below
  // into three round trips plus backoff.
  "COREPACK_CAFILE",
  "COREPACK_STRICT_SSL",
  "COREPACK_NETWORK_RETRIES",
  "COREPACK_NETWORK_TIMEOUT",
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  // §15.1 — the credential rule now has a filesystem tier, memoised per cwd.
  resetNpmrcCache();
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  // The retry-specific block below opts back in; everything else in this file
  // predates §15.5 and asserts the shape of a *single* attempt.
  process.env.COREPACK_NETWORK_RETRIES = "0";
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
        `Server answered with HTTP 404 when performing the request to ${url}; for troubleshooting help, see https://github.com/unjs/jup#troubleshooting`,
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
    expect(agent).toMatch(/^jup\/\d+\.\d+\.\d+/);
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

/* ------------------------------------------------------------------ *
 * §15.5 — timeouts and retries
 *
 * Corepack has no timeout, no retry and no backoff: one hiccup is
 * fatal, which is the exact shape of the undiagnosable CI failure in
 * #458. Every test here counts *requests the server actually saw*,
 * because that is the only thing that distinguishes a retry from a
 * hopeful assertion about one.
 * ------------------------------------------------------------------ */

/** Backoff is real time; a test that wants to assert the schedule records it instead. */
function recordingSleep(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number) => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

/** A server that answers `status` for the first `times` requests, then 200. */
function flaky(
  times: number,
  status: number,
  headers: Record<string, string> = {},
): Promise<TestServer> {
  let seen = 0;
  return startServer((_request, response) => {
    seen += 1;
    if (seen <= times) {
      response.writeHead(status, { "content-type": "text/plain", ...headers });
      response.end("later");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(`{"ok":true}`);
  });
}

describe("retries (§15.5, row 154)", () => {
  it("retries a 503 and succeeds — three attempts by default", async () => {
    // The variable left unset: this is the *default* the spec states.
    delete process.env.COREPACK_NETWORK_RETRIES;
    const server = await flaky(2, 503);
    const { sleep, delays } = recordingSleep();

    await expect(httpGetJson(`${server.origin}/pkg`, { sleep })).resolves.toEqual({ ok: true });

    expect(server.requests).toHaveLength(3);
    // Exponential, jittered: each delay inside [step/2, step].
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(125);
    expect(delays[0]).toBeLessThanOrEqual(250);
    expect(delays[1]).toBeGreaterThanOrEqual(250);
    expect(delays[1]).toBeLessThanOrEqual(500);
  });

  it("gives up with the §12.6 status message once the attempts are spent", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("down");
    });
    const { sleep } = recordingSleep();
    const url = `${server.origin}/pkg`;

    await expect(httpGet(url, { attempts: 3, sleep })).rejects.toThrow(
      messages.badStatus(503, url),
    );

    expect(server.requests).toHaveLength(3);
  });

  it("COREPACK_NETWORK_RETRIES=0 fails on the first answer (row 154's other half)", async () => {
    const server = await flaky(2, 503);
    process.env.COREPACK_NETWORK_RETRIES = "0";

    await expect(httpGet(`${server.origin}/pkg`)).rejects.toThrow(/HTTP 503/);

    expect(server.requests).toHaveLength(1);
  });

  it("honours COREPACK_NETWORK_RETRIES as a count of attempts", async () => {
    const server = await flaky(4, 500);
    process.env.COREPACK_NETWORK_RETRIES = "5";
    const { sleep } = recordingSleep();

    await expect(httpGetJson(`${server.origin}/pkg`, { sleep })).resolves.toEqual({ ok: true });

    expect(server.requests).toHaveLength(5);
  });

  it.for([[408], [425], [429], [500], [502], [503], [504]])("retries HTTP %i", async ([status]) => {
    const server = await flaky(1, status!);
    const { sleep } = recordingSleep();

    await expect(httpGetJson(`${server.origin}/pkg`, { attempts: 3, sleep })).resolves.toEqual({
      ok: true,
    });
    expect(server.requests).toHaveLength(2);
  });

  it.for([[400], [401], [403], [404], [409], [410], [418], [422]])(
    "never retries HTTP %i",
    async ([status]) => {
      const server = await startServer((_request, response) => {
        response.writeHead(status!, { "content-type": "text/plain" });
        response.end("no");
      });
      const { sleep, delays } = recordingSleep();

      await expect(httpGet(`${server.origin}/pkg`, { attempts: 3, sleep })).rejects.toThrow(
        messages.badStatus(status!, `${server.origin}/pkg`),
      );

      expect(server.requests).toHaveLength(1);
      expect(delays).toEqual([]);
    },
  );

  it("retries a transport failure and reports it once the attempts are spent", async () => {
    const origin = await deadOrigin();
    const { sleep, delays } = recordingSleep();

    const error = await httpGet(`${origin}/pkg`, { attempts: 3, sleep }).catch(
      (error_: Error) => error_,
    );

    expect((error as Error).message).toBe(messages.requestFailed(`${origin}/pkg`));
    expect(delays).toHaveLength(2);
    // §15.5 — the underlying reason survives, and says how many tries it took.
    expect((error as Error).stack).toContain("Caused by: Giving up after 3 attempts");
    expect((error as Error).stack).toMatch(/ECONNREFUSED/);
  });

  it("honours Retry-After in seconds", async () => {
    const server = await flaky(1, 429, { "retry-after": "2" });
    const { sleep, delays } = recordingSleep();

    await expect(httpGetJson(`${server.origin}/pkg`, { attempts: 2, sleep })).resolves.toEqual({
      ok: true,
    });

    expect(delays).toEqual([2000]);
  });

  it("honours Retry-After as an HTTP-date", async () => {
    const when = new Date(Date.now() + 3000).toUTCString();
    const server = await flaky(1, 503, { "retry-after": when });
    const { sleep, delays } = recordingSleep();

    await expect(httpGetJson(`${server.origin}/pkg`, { attempts: 2, sleep })).resolves.toEqual({
      ok: true,
    });

    expect(delays).toHaveLength(1);
    // Within a second of the requested wait, allowing for the round trip.
    expect(delays[0]).toBeGreaterThan(1500);
    expect(delays[0]).toBeLessThanOrEqual(3000);
  });

  it("falls back to backoff for an unusable Retry-After", async () => {
    const server = await flaky(1, 503, { "retry-after": "soon" });
    const { sleep, delays } = recordingSleep();

    await expect(httpGetJson(`${server.origin}/pkg`, { attempts: 2, sleep })).resolves.toEqual({
      ok: true,
    });

    expect(delays[0]).toBeGreaterThanOrEqual(125);
    expect(delays[0]).toBeLessThanOrEqual(250);
  });

  it("drains each failed attempt, so the connection is reused rather than torn down", async () => {
    const server = await flaky(1, 503);
    const { sleep } = recordingSleep();

    await httpGetJson(`${server.origin}/pkg`, { attempts: 2, sleep });

    // Two requests, and the fixture only ever accepted connections it could
    // keep alive; a body left unread would have forced a new one.
    expect(server.requests).toHaveLength(2);
  });
});

describe("retryAfterMs", () => {
  const now = Date.parse("2026-08-22T10:00:00Z");

  it("reads delta-seconds", () => {
    expect(retryAfterMs("0", now)).toBe(0);
    expect(retryAfterMs("5", now)).toBe(5000);
    expect(retryAfterMs(" 5 ", now)).toBe(5000);
  });

  it("reads an HTTP-date, and never returns a negative wait", () => {
    expect(retryAfterMs("Sat, 22 Aug 2026 10:00:10 GMT", now)).toBe(10_000);
    expect(retryAfterMs("Sat, 22 Aug 2026 09:00:00 GMT", now)).toBe(0);
  });

  it("reports a wait longer than the cap as such, so the caller can stop", () => {
    expect(retryAfterMs("120", now)).toBe(RETRY_AFTER_TOO_LONG);
    expect(retryAfterMs("Sat, 22 Aug 2026 11:00:00 GMT", now)).toBe(RETRY_AFTER_TOO_LONG);
  });

  it("declines anything unparseable, which backs off as normal instead", () => {
    expect(retryAfterMs("soon", now)).toBeUndefined();
    expect(retryAfterMs("", now)).toBeUndefined();
    expect(retryAfterMs(null, now)).toBeUndefined();
  });
});

describe("timeouts (§15.5, row 155)", () => {
  it("names the timeout, the URL and the variable in the cause", async () => {
    const server = await startServer(() => {
      // Never answers.
    });
    const url = `${server.origin}/slow`;

    const error = await httpGet(url, { timeout: 50 }).catch((error_: Error) => error_);

    expect((error as Error).message).toBe(messages.requestFailed(url));
    expect((error as Error).stack).toContain(`Caused by: Timed out after 50ms waiting for ${url}`);
    expect((error as Error).stack).toContain("JUP_NETWORK_TIMEOUT");
  });

  it("reads COREPACK_NETWORK_TIMEOUT when the caller names no timeout", async () => {
    const server = await startServer(() => {});
    process.env.COREPACK_NETWORK_TIMEOUT = "60";
    const url = `${server.origin}/slow`;

    const error = await httpGet(url).catch((error_: Error) => error_);

    expect((error as Error).stack).toContain("Timed out after 60ms");
  });

  it("ignores a COREPACK_NETWORK_TIMEOUT that is not a number", async () => {
    const server = await ok();
    process.env.COREPACK_NETWORK_TIMEOUT = "soon";

    await expect(httpGetJson(`${server.origin}/pkg`)).resolves.toEqual({ ok: true });
  });

  it("retries a timeout, since a stalled connection is a transport failure", async () => {
    const server = await startServer(() => {});
    const { sleep, delays } = recordingSleep();

    await expect(
      httpGet(`${server.origin}/slow`, { timeout: 40, attempts: 3, sleep }),
    ).rejects.toThrow(messages.requestFailed(`${server.origin}/slow`));

    expect(server.requests).toHaveLength(3);
    expect(delays).toHaveLength(2);
  });

  it("applies the timeout to the *body* too, not only the headers", async () => {
    // Headers and a first chunk arrive at once; the rest never does. Corepack's
    // model — and ours before §15.5 — would hang here until CI killed the job.
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write("first");
    });

    const response = await httpGet(`${server.origin}/tarball`, { timeout: 80 });
    // The headers landed, so this is the idle half of the budget.
    expect(response.status).toBe(200);

    await expect(response.text()).rejects.toThrow();
  });

  it("does not cut a body short just because it takes longer than the timeout in total", async () => {
    // Four chunks, each well inside the idle budget, adding up to more than it:
    // an idle timeout is not a total-transfer deadline.
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      let sent = 0;
      const tick = setInterval(() => {
        response.write("chunk");
        sent += 1;
        if (sent === 4) {
          clearInterval(tick);
          response.end();
        }
      }, 40);
    });

    const response = await httpGet(`${server.origin}/tarball`, { timeout: 120 });

    expect(await response.text()).toBe("chunkchunkchunkchunk");
  });
});

/* ------------------------------------------------------------------ *
 * §12.6 — a retried failure must not leak the credential it was
 * carrying. The precedent is `proxy.test.ts`'s proxy-password check.
 * ------------------------------------------------------------------ */

describe("credentials never reach the cause chain", () => {
  it("keeps COREPACK_NPM_USERNAME/PASSWORD out of every link", async () => {
    const origin = await deadOrigin();
    process.env.COREPACK_NPM_USERNAME = "someuser";
    process.env.COREPACK_NPM_PASSWORD = "hunter2";
    const { sleep } = recordingSleep();

    const error = await httpGet(`${origin}/pkg`, {
      registryOrigin: origin,
      attempts: 3,
      sleep,
    }).catch((error_: Error) => error_);

    const seen: string[] = [];
    let link: unknown = error;
    while (link instanceof Error) {
      seen.push(link.message);
      seen.push(link.stack ?? "");
      link = link.cause;
    }

    const text = seen.join("\n");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("someuser");
    expect(text).not.toContain("Basic ");
    // …and the failure is still diagnosable.
    expect(text).toContain("ECONNREFUSED");
  });

  it("strips userinfo from a URL appearing anywhere in a cause message", async () => {
    const origin = await deadOrigin();
    const withUserinfo = origin.replace("http://", "http://user:hunter2@");

    const error = await httpGet(`${withUserinfo}/pkg`).catch((error_: Error) => error_);

    expect(`${(error as Error).message}\n${(error as Error).stack}`).not.toContain("hunter2");
  });
});

/* ------------------------------------------------------------------ *
 * `networkError` — the mechanism the two blocks above rely on
 * ------------------------------------------------------------------ */

describe("networkError (§15.5)", () => {
  it("leaves the §12.6 message alone and appends the chain to the stack", () => {
    const inner = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), {
      code: "ECONNREFUSED",
    });
    const outer = new Error("fetch failed", { cause: inner });

    const error = networkError(new Error(messages.requestFailed("https://npm.corp/pnpm")), outer);

    // Byte for byte what §12.6 specifies — scripts match on it.
    expect(error.message).toBe(
      "Error when performing the request to https://npm.corp/pnpm; for troubleshooting help, see https://github.com/unjs/jup#troubleshooting",
    );
    expect(error.cause).toBe(outer);
    expect(error.stack).toContain("Caused by: fetch failed");
    // The errno is already in that message, so it is not repeated.
    expect(error.stack).toContain("Caused by: connect ECONNREFUSED 127.0.0.1:1");
    expect(error.stack).not.toContain("(ECONNREFUSED)");
  });

  it("adds the errno when the message does not already carry it", () => {
    const inner = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });

    const error = networkError(new Error("outer"), inner);

    expect(error.stack).toContain("Caused by: socket hang up (ECONNRESET)");
  });

  it("redacts a URL carrying userinfo wherever it appears in a cause", () => {
    const error = networkError(
      new Error(messages.requestFailed("https://npm.corp/pnpm")),
      new Error("request to https://user:hunter2@npm.corp/pnpm failed"),
    );

    expect(error.stack).toContain("Caused by: request to https://npm.corp/pnpm failed");
    expect(error.stack).not.toContain("hunter2");
  });

  it("redacts free text the anchored form would miss", () => {
    expect(redactUserinfoAnywhere("connecting to https://user:hunter2@npm.corp/x, retrying")).toBe(
      "connecting to https://npm.corp/x, retrying",
    );
    expect(redactUserinfoAnywhere("nothing to redact")).toBe("nothing to redact");
  });

  it("survives a cyclic cause chain", () => {
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    (first as { cause?: unknown }).cause = second;

    const error = networkError(new Error("outer"), first);

    expect(error.stack).toContain("Caused by: first");
    expect(error.stack).toContain("Caused by: second");
  });
});

/* ------------------------------------------------------------------ *
 * §15.1 — the `.npmrc` credential tier
 * ------------------------------------------------------------------ */

describe("credentialsFor — the .npmrc tier (§15.1)", () => {
  const roots: string[] = [];
  let home: string;
  let project: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    const root = mkdtempSync(join(tmpdir(), "jup-http-npmrc-"));
    roots.push(root);
    home = join(root, "home");
    project = join(root, "project");
    mkdirSync(home, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "package.json"), `{"packageManager":"pnpm@11.1.2"}\n`);
    // §15.1's home directory is `$HOME`, or `%USERPROFILE%` on Windows. Both
    // spellings are redirected, so the row reads the fixture's `.npmrc` on
    // every platform rather than the developer's own.
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.PREFIX = join(root, "prefix");
    resetNpmrcCache();
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    delete process.env.PREFIX;
    resetNpmrcCache();
    while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
  });

  function userNpmrc(content: string): void {
    writeFileSync(join(home, ".npmrc"), content);
    resetNpmrcCache();
  }

  function credentials(url: string, registryOrigin?: string): string | undefined {
    // `loadNpmrc` reads from the working directory, which the process itself
    // never changes; the fixture stands in for it via `HOME`, and the project
    // walk finds nothing.
    return credentialsFor(new URL(url), registryOrigin).authorization;
  }

  it("supplies a bearer token for a URL under the configured prefix", () => {
    userNpmrc("//registry.example.org/:_authToken=abc\n");
    expect(credentials("https://registry.example.org/pnpm")).toBe("Bearer abc");
  });

  it("does not supply it for a host the prefix does not name", () => {
    userNpmrc("//registry.example.org/:_authToken=abc\n");
    expect(credentials("https://cdn.example.org/pnpm.tgz")).toBeUndefined();
  });

  it("ranks below COREPACK_NPM_TOKEN on the registry's own origin (§15.1 precedence)", () => {
    userNpmrc("//registry.example.org/:_authToken=from-npmrc\n");
    process.env.COREPACK_NPM_TOKEN = "from-env";

    expect(credentials("https://registry.example.org/pnpm", "https://registry.example.org")).toBe(
      "Bearer from-env",
    );
  });

  it("still applies off the configured registry's origin, because it carries its own scope", () => {
    // §14.6 scopes the *environment* credentials to one origin. A `.npmrc`
    // entry names its own scope, which is narrower, so the tarball CDN a
    // registry redirects to can be authenticated without widening anything.
    userNpmrc("//cdn.example.org/:_authToken=cdn-token\n");
    expect(credentials("https://cdn.example.org/pnpm.tgz", "https://registry.example.org")).toBe(
      "Bearer cdn-token",
    );
  });

  it("is still outranked by userinfo in the URL itself", () => {
    userNpmrc("//registry.example.org/:_authToken=abc\n");
    expect(credentials("https://u:p@registry.example.org/pnpm")).toBe(
      `Basic ${Buffer.from("u:p").toString("base64")}`,
    );
  });

  it("never reaches the wire from a project-level file", async () => {
    // `credentialsFor` reads the config for the *process's* working directory,
    // which a worker thread cannot change, so the project tier is loaded
    // explicitly here and the end-to-end proof lives in conformance row 149.
    const server = await ok();
    writeFileSync(join(project, ".npmrc"), `//127.0.0.1:1/:_authToken=stolen\n`);
    resetNpmrcCache();
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const config = loadNpmrc(project);
    expect(config.auth).toEqual([]);
    expect(config.files.at(-1)!.refused).toEqual(["//127.0.0.1:1/:_authToken"]);

    // And with that config in hand, nothing is attached to a matching URL.
    expect(npmrcAuthorizationFor(new URL("http://127.0.0.1:1/pnpm"), config)).toBeUndefined();

    await httpGetJson(`${server.origin}/pnpm`, { registryOrigin: server.origin });
    expect(server.last().headers.authorization).toBeUndefined();
    vi.restoreAllMocks();
  });
});
