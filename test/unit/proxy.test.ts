/**
 * Proxy support — §05.1 ("Proxies"), §14.8, §15.6, conformance rows 71/72 and
 * 156/157.
 *
 * Everything here runs against a **real** proxy: a `node:http` server that
 * answers absolute-form requests and upgrades `CONNECT` into a byte pipe, with a
 * TLS origin server at the far end of the tunnel. That is the only way to assert
 * the two things that matter — that the request line was absolute-form, and that
 * the proxy saw a `CONNECT` and then ciphertext rather than an `Authorization`
 * header.
 *
 * The tunnel's certificate is verified for real: `test/_fixtures/tls.ts` is its
 * own CA and is added to the process trust store for the duration of the file,
 * so nothing here runs with certificate checking switched off.
 */

import { Buffer } from "node:buffer";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type AddressInfo, type Socket } from "node:net";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "../../src/errors.ts";
import { httpGet, httpGetJson } from "../../src/net/http.ts";
import { bypassesProxy, proxyForUrl } from "../../src/net/proxy.ts";
import { CERT, KEY } from "../_fixtures/tls.ts";

/* ------------------------------------------------------------------ *
 * Servers
 * ------------------------------------------------------------------ */

interface Recorded {
  url: string;
  headers: Record<string, string | string[] | undefined>;
}

interface Origin {
  port: number;
  requests: Recorded[];
  close: () => Promise<void>;
}

interface Proxy {
  origin: string;
  port: number;
  /** Absolute-form requests, in order. */
  requests: Recorded[];
  /** `CONNECT` authorities, in order. */
  connects: string[];
  /** Headers of each `CONNECT`. */
  connectHeaders: Record<string, string | string[] | undefined>[];
  /** When set, a request whose `Proxy-Authorization` differs is refused. */
  requiredAuthorization?: string;
  close: () => Promise<void>;
}

const closers: Array<() => Promise<void>> = [];

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

/**
 * Shut a fixture server down, sockets and all.
 *
 * `closeAllConnections()` is not enough here: a socket handed to a `connect`
 * listener has been detached from the HTTP server, so nothing but our own
 * bookkeeping can still reach it — and `close()` waits for it forever.
 */
function closer(server: Server, sockets: Set<Socket>): () => Promise<void> {
  return () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close(() => resolve());
    });
}

/** Track every socket the server accepts, plus any we open ourselves. */
function tracked(server: Server): Set<Socket> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return sockets;
}

/** An origin server answering `{"ok":true,…}` and echoing what it received. */
async function startOrigin(tls: boolean): Promise<Origin> {
  const requests: Recorded[] = [];
  const handler = (request: IncomingMessage, response: ServerResponse) => {
    requests.push({ url: request.url ?? "", headers: { ...request.headers } });
    if (request.url === "/missing") {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("nope");
      return;
    }
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "https://elsewhere.example.com/final" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        ok: true,
        url: request.url,
        authorization: request.headers.authorization ?? null,
        host: request.headers.host,
      }),
    );
  };

  const server = tls
    ? createHttpsServer({ key: KEY, cert: CERT }, handler)
    : createHttpServer(handler);
  const sockets = tracked(server);
  const port = await listen(server);
  const close = closer(server, sockets);
  closers.push(close);
  return { port, requests, close };
}

/**
 * A proxy that speaks both halves of the contract: absolute-form forwarding for
 * `http://` targets, and `CONNECT` for `https://` ones. Whatever authority is
 * asked for, it connects to `target` — which is what a real proxy does too, only
 * with DNS instead of a fixture.
 */
async function startProxy(target: () => number): Promise<Proxy> {
  const proxy: Partial<Proxy> = { requests: [], connects: [], connectHeaders: [] };

  const server: Server = createHttpServer((request, response) => {
    proxy.requests!.push({ url: request.url ?? "", headers: { ...request.headers } });

    if (
      proxy.requiredAuthorization !== undefined &&
      request.headers["proxy-authorization"] !== proxy.requiredAuthorization
    ) {
      response.writeHead(407, { "proxy-authenticate": "Basic realm=fixture" });
      response.end("proxy authentication required");
      return;
    }

    // `request.url` is absolute-form here; forward the path to the fixture origin.
    let parsed: URL;
    try {
      parsed = new URL(request.url ?? "");
    } catch {
      response.writeHead(400);
      response.end("not absolute-form");
      return;
    }

    const headers = { ...request.headers, host: parsed.host };
    delete headers["proxy-authorization"];

    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: target(),
        method: request.method,
        path: `${parsed.pathname}${parsed.search}`,
        headers,
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    upstream.on("error", () => {
      response.writeHead(502);
      response.end("upstream failed");
    });
    upstream.end();
  });

  server.on("connect", (request, socket: Socket, head: Buffer) => {
    proxy.connects!.push(request.url ?? "");
    proxy.connectHeaders!.push({ ...request.headers });

    if (
      proxy.requiredAuthorization !== undefined &&
      request.headers["proxy-authorization"] !== proxy.requiredAuthorization
    ) {
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      return;
    }

    const upstream = connect({ host: "127.0.0.1", port: target() }, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    // Both ends of the tunnel are ours to clean up: the client socket left the
    // HTTP server's bookkeeping the moment `connect` fired.
    sockets.add(socket).add(upstream);
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.once("close", () => upstream.destroy());
    upstream.once("close", () => socket.destroy());
  });

  const sockets = tracked(server);
  const port = await listen(server);
  const close = closer(server, sockets);
  closers.push(close);

  return Object.assign(proxy as Proxy, {
    port,
    origin: `http://127.0.0.1:${port}`,
    close,
  });
}

/* ------------------------------------------------------------------ *
 * Environment
 * ------------------------------------------------------------------ */

const PROXY_KEYS = [
  "http_proxy",
  "HTTP_PROXY",
  "https_proxy",
  "HTTPS_PROXY",
  "all_proxy",
  "ALL_PROXY",
  "no_proxy",
  "NO_PROXY",
  "COREPACK_NPM_TOKEN",
  "COREPACK_NPM_USERNAME",
  "COREPACK_NPM_PASSWORD",
  // §15.4 / §15.5 — the tunnel now consults both, and the retry default would
  // otherwise turn each failure assertion into three round trips.
  "COREPACK_CAFILE",
  "COREPACK_STRICT_SSL",
  "COREPACK_NETWORK_RETRIES",
  "COREPACK_NETWORK_TIMEOUT",
] as const;

let saved: Record<string, string | undefined>;
let trust: string[];

beforeAll(() => {
  // Appended, not replaced: everything else in the process keeps the real roots.
  trust = getCACertificates("default");
  setDefaultCACertificates([...trust, CERT]);
});

afterAll(() => {
  setDefaultCACertificates(trust);
});

beforeEach(() => {
  saved = {};
  for (const key of PROXY_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  // Every assertion in this file is about the shape of a single attempt; the
  // §15.5 retry schedule has its own tests in `http.test.ts`.
  process.env.COREPACK_NETWORK_RETRIES = "0";
});

afterEach(async () => {
  for (const key of PROXY_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(closers.splice(0).map((close) => close()));
});

const base64 = (value: string) => Buffer.from(value).toString("base64");

/* ------------------------------------------------------------------ *
 * §05.1 — the two request shapes
 * ------------------------------------------------------------------ */

describe("tunnelling (§05.1, §14.8)", () => {
  it("sends https:// through CONNECT, and the proxy sees no Authorization (rows 71, 156)", async () => {
    const origin = await startOrigin(true);
    const proxy = await startProxy(() => origin.port);
    process.env.HTTPS_PROXY = proxy.origin;
    process.env.COREPACK_NPM_TOKEN = "secret-token";

    const body = await httpGetJson<{
      ok: boolean;
      url: string;
      authorization: string;
      host: string;
    }>("https://example.com/pkg", { registryOrigin: "https://example.com" });

    // The proxy was asked to open a tunnel to the *target*, port and all.
    expect(proxy.connects).toEqual(["example.com:443"]);
    // …and it never saw an absolute-form request, because there wasn't one.
    expect(proxy.requests).toHaveLength(0);

    // Inside the tunnel, TLS: the origin got the real request and the credential.
    expect(body.ok).toBe(true);
    expect(body.url).toBe("/pkg");
    expect(body.authorization).toBe("Bearer secret-token");
    // `fetch` spells the default port implicitly; so do we.
    expect(body.host).toBe("example.com");

    // The credential was inside the encrypted channel, never on the CONNECT.
    const headers = proxy.connectHeaders[0]!;
    expect(headers.authorization).toBeUndefined();
    expect(JSON.stringify(headers)).not.toContain("secret-token");
  });

  it("sends http:// as an absolute-form request line (row 71)", async () => {
    const origin = await startOrigin(false);
    const proxy = await startProxy(() => origin.port);
    process.env.HTTP_PROXY = proxy.origin;

    const body = await httpGetJson<{ url: string; host: string }>("http://example.com/pkg?x=1");

    // The request line the proxy received names the whole URL — that *is* the
    // forward-proxy protocol.
    expect(proxy.requests.map((request) => request.url)).toEqual(["http://example.com/pkg?x=1"]);
    expect(proxy.connects).toHaveLength(0);
    // `Host` names the origin server, not the proxy.
    expect(proxy.requests[0]!.headers.host).toBe("example.com");
    expect(body.url).toBe("/pkg?x=1");
    expect(origin.requests).toHaveLength(1);
  });

  it("keeps the user agent and the caller's headers through the proxy", async () => {
    const origin = await startOrigin(false);
    const proxy = await startProxy(() => origin.port);
    process.env.HTTP_PROXY = proxy.origin;

    await httpGet("http://example.com/pkg", { headers: { accept: "application/json" } });

    expect(proxy.requests[0]!.headers.accept).toBe("application/json");
    expect(proxy.requests[0]!.headers["user-agent"]).toMatch(/^jup\//);
  });

  it("streams the body through the tunnel rather than buffering it", async () => {
    const origin = await startOrigin(true);
    const proxy = await startProxy(() => origin.port);
    process.env.HTTPS_PROXY = proxy.origin;

    const response = await httpGet("https://example.com/pkg");
    // §16.5 — `install.ts` tees this stream to hash and extract in one pass, so
    // a proxied response has to expose a real `ReadableStream`, not a promise of
    // bytes.
    expect(response.body).toBeInstanceOf(ReadableStream);
    const [a, b] = response.body!.tee();
    const [first, second] = await Promise.all([drain(a), drain(b)]);
    expect(first).toBe(second);
    expect(JSON.parse(first).ok).toBe(true);
    expect(proxy.connects).toEqual(["example.com:443"]);
  });

  it("propagates the origin's non-2xx as the §12.6 message, formatted from the target", async () => {
    const origin = await startOrigin(true);
    const proxy = await startProxy(() => origin.port);
    process.env.HTTPS_PROXY = proxy.origin;

    // The status is the origin server's, and the URL named is the one asked
    // for — the proxy is not part of the story a user reads.
    await expect(httpGet("https://example.com/missing")).rejects.toThrow(
      messages.badStatus(404, "https://example.com/missing"),
    );
    expect(proxy.connects).toEqual(["example.com:443"]);
  });
});

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/* ------------------------------------------------------------------ *
 * §14.8 — no second opt-in
 * ------------------------------------------------------------------ */

describe("no second opt-in (§14.8, rows 72 and 156)", () => {
  it("proxies with HTTPS_PROXY alone — no NODE_USE_ENV_PROXY", async () => {
    const origin = await startOrigin(true);
    const proxy = await startProxy(() => origin.port);
    process.env.HTTPS_PROXY = proxy.origin;

    expect(process.env.NODE_USE_ENV_PROXY).toBeUndefined();

    await httpGetJson("https://example.com/pkg");

    expect(proxy.connects).toEqual(["example.com:443"]);
  });

  it("selects no proxy at all when the environment names none", async () => {
    expect(proxyForUrl(new URL("https://registry.npmjs.org/pnpm"))).toBeUndefined();
    expect(proxyForUrl(new URL("http://registry.npmjs.org/pnpm"))).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * Variable precedence
 * ------------------------------------------------------------------ */

describe("variable precedence (§05.1)", () => {
  it("prefers lowercase http_proxy over HTTP_PROXY", () => {
    process.env.http_proxy = "http://lower.example:1";
    process.env.HTTP_PROXY = "http://upper.example:2";

    expect(proxyForUrl(new URL("http://target.example/pkg"))?.url.host).toBe("lower.example:1");
  });

  it("still accepts the uppercase HTTP_PROXY on its own", () => {
    process.env.HTTP_PROXY = "http://upper.example:2";

    expect(proxyForUrl(new URL("http://target.example/pkg"))?.url.host).toBe("upper.example:2");
  });

  it("prefers lowercase https_proxy, and accepts either case", () => {
    process.env.HTTPS_PROXY = "http://upper.example:2";
    expect(proxyForUrl(new URL("https://target.example/pkg"))?.url.host).toBe("upper.example:2");

    process.env.https_proxy = "http://lower.example:1";
    expect(proxyForUrl(new URL("https://target.example/pkg"))?.url.host).toBe("lower.example:1");
  });

  it("keeps the http and https variables apart", () => {
    process.env.HTTP_PROXY = "http://plain.example:1";
    process.env.HTTPS_PROXY = "http://secure.example:2";

    expect(proxyForUrl(new URL("http://target.example/pkg"))?.url.host).toBe("plain.example:1");
    expect(proxyForUrl(new URL("https://target.example/pkg"))?.url.host).toBe("secure.example:2");
  });

  it("falls back to ALL_PROXY for either scheme", () => {
    process.env.ALL_PROXY = "http://all.example:3";

    expect(proxyForUrl(new URL("http://target.example/pkg"))?.url.host).toBe("all.example:3");
    expect(proxyForUrl(new URL("https://target.example/pkg"))?.url.host).toBe("all.example:3");

    process.env.HTTPS_PROXY = "http://secure.example:2";
    expect(proxyForUrl(new URL("https://target.example/pkg"))?.url.host).toBe("secure.example:2");
  });

  it("treats an empty value as unset — `HTTPS_PROXY= cmd` disables it for one run", () => {
    process.env.HTTPS_PROXY = "";
    expect(proxyForUrl(new URL("https://target.example/pkg"))).toBeUndefined();

    process.env.ALL_PROXY = "http://all.example:3";
    expect(proxyForUrl(new URL("https://target.example/pkg"))?.url.host).toBe("all.example:3");
  });

  it("accepts a scheme-less proxy as HTTP, the way every other client does", () => {
    process.env.HTTP_PROXY = "proxy.corp:3128";
    expect(proxyForUrl(new URL("http://target.example/pkg"))?.url.href).toBe(
      "http://proxy.corp:3128/",
    );
  });

  it("ignores a proxy scheme it cannot speak rather than failing the run", () => {
    process.env.ALL_PROXY = "socks5://socks.example:1080";
    expect(proxyForUrl(new URL("https://target.example/pkg"))).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ *
 * NO_PROXY (§15.6)
 * ------------------------------------------------------------------ */

describe("NO_PROXY (§15.6)", () => {
  const bypasses = (noProxy: string, url: string): boolean => {
    process.env.NO_PROXY = noProxy;
    return bypassesProxy(new URL(url));
  };

  it("* disables proxying entirely", () => {
    expect(bypasses("*", "https://registry.npmjs.org/pnpm")).toBe(true);
    expect(bypasses("*", "http://anything.example/x")).toBe(true);
  });

  it("matches an exact host", () => {
    expect(bypasses("registry.npmjs.org", "https://registry.npmjs.org/pnpm")).toBe(true);
    expect(bypasses("registry.npmjs.org", "https://REGISTRY.NPMJS.ORG/pnpm")).toBe(true);
  });

  it("matches subdomains from a leading-dot suffix", () => {
    expect(bypasses(".internal", "https://registry.internal/pnpm")).toBe(true);
    expect(bypasses(".internal", "https://deep.registry.internal/pnpm")).toBe(true);
    // A leading-dot entry covers the bare domain too.
    expect(bypasses(".internal", "https://internal/pnpm")).toBe(true);
    expect(bypasses(".internal", "https://notinternal/pnpm")).toBe(false);
  });

  it("matches subdomains from a bare suffix", () => {
    expect(bypasses("example.com", "https://registry.example.com/pnpm")).toBe(true);
    expect(bypasses("example.com", "https://example.com/pnpm")).toBe(true);
    // …but only on a label boundary: this is a different domain.
    expect(bypasses("example.com", "https://notexample.com/pnpm")).toBe(false);
  });

  it("honours a :port qualifier", () => {
    expect(bypasses("example.com:8080", "http://example.com:8080/pnpm")).toBe(true);
    expect(bypasses("example.com:8080", "http://example.com:9090/pnpm")).toBe(false);
    // The implicit port counts: https is 443, http is 80.
    expect(bypasses("example.com:443", "https://example.com/pnpm")).toBe(true);
    expect(bypasses("example.com:80", "https://example.com/pnpm")).toBe(false);
    expect(bypasses("example.com:80", "http://example.com/pnpm")).toBe(true);
  });

  it("does not bypass for a non-matching entry", () => {
    expect(bypasses("other.example", "https://registry.npmjs.org/pnpm")).toBe(false);
    expect(bypasses(".other.example", "https://registry.npmjs.org/pnpm")).toBe(false);
    expect(bypasses("", "https://registry.npmjs.org/pnpm")).toBe(false);
  });

  it("reads a comma- or whitespace-separated list, and accepts *.host", () => {
    expect(bypasses("a.example, .internal ,b.example", "https://x.internal/pnpm")).toBe(true);
    expect(bypasses("a.example b.example", "https://b.example/pnpm")).toBe(true);
    expect(bypasses("*.internal", "https://x.internal/pnpm")).toBe(true);
    expect(bypasses("a.example,b.example", "https://c.example/pnpm")).toBe(false);
  });

  it("prefers lowercase no_proxy but accepts either case", () => {
    process.env.NO_PROXY = "nomatch.example";
    process.env.no_proxy = "*";
    expect(bypassesProxy(new URL("https://registry.npmjs.org/pnpm"))).toBe(true);
  });

  it("takes precedence over a configured proxy", () => {
    process.env.HTTPS_PROXY = "http://proxy.example:3128";
    process.env.NO_PROXY = ".internal";

    expect(proxyForUrl(new URL("https://registry.internal/pnpm"))).toBeUndefined();
    expect(proxyForUrl(new URL("https://registry.npmjs.org/pnpm"))?.url.host).toBe(
      "proxy.example:3128",
    );
  });

  it("really goes direct for a bypassed host (row 157)", async () => {
    const origin = await startOrigin(false);
    const proxy = await startProxy(() => origin.port);
    process.env.HTTP_PROXY = proxy.origin;
    process.env.NO_PROXY = "127.0.0.1";

    await httpGetJson(`http://127.0.0.1:${origin.port}/pkg`);

    expect(origin.requests).toHaveLength(1);
    expect(proxy.requests).toHaveLength(0);
    expect(proxy.connects).toHaveLength(0);
  });

  it("still proxies a host the list does not name (row 157's other half)", async () => {
    const origin = await startOrigin(false);
    const proxy = await startProxy(() => origin.port);
    process.env.HTTP_PROXY = proxy.origin;
    process.env.NO_PROXY = ".internal,other.example";

    await httpGetJson("http://example.com/pkg");

    expect(proxy.requests.map((request) => request.url)).toEqual(["http://example.com/pkg"]);
  });
});

/* ------------------------------------------------------------------ *
 * Proxy credentials
 * ------------------------------------------------------------------ */

describe("proxy credentials", () => {
  it("sends Proxy-Authorization on a CONNECT, never Authorization", async () => {
    const origin = await startOrigin(true);
    const proxy = await startProxy(() => origin.port);
    proxy.requiredAuthorization = `Basic ${base64("proxyuser:proxypass")}`;
    process.env.HTTPS_PROXY = `http://proxyuser:proxypass@127.0.0.1:${proxy.port}`;

    const body = await httpGetJson<{ ok: boolean }>("https://example.com/pkg");

    expect(body.ok).toBe(true);
    const headers = proxy.connectHeaders[0]!;
    expect(headers["proxy-authorization"]).toBe(`Basic ${base64("proxyuser:proxypass")}`);
    expect(headers.authorization).toBeUndefined();
    // Nothing about the proxy's credentials crossed into the tunnel.
    expect(origin.requests[0]!.headers["proxy-authorization"]).toBeUndefined();
    expect(origin.requests[0]!.headers.authorization).toBeUndefined();
  });

  it("sends Proxy-Authorization on an absolute-form request", async () => {
    const origin = await startOrigin(false);
    const proxy = await startProxy(() => origin.port);
    proxy.requiredAuthorization = `Basic ${base64("proxyuser:proxypass")}`;
    process.env.HTTP_PROXY = `http://proxyuser:proxypass@127.0.0.1:${proxy.port}`;

    await httpGetJson("http://example.com/pkg");

    expect(proxy.requests[0]!.headers["proxy-authorization"]).toBe(
      `Basic ${base64("proxyuser:proxypass")}`,
    );
    expect(proxy.requests[0]!.headers.authorization).toBeUndefined();
  });

  it("percent-decodes userinfo, so a password may contain @ and :", () => {
    process.env.HTTPS_PROXY = "http://user%40corp:p%40ss%3Aword@proxy.example:3128";

    const selection = proxyForUrl(new URL("https://target.example/pkg"));

    expect(selection?.authorization).toBe(`Basic ${base64("user@corp:p@ss:word")}`);
    // The selection itself carries no userinfo — messages are built from it.
    expect(selection?.url.href).toBe("http://proxy.example:3128/");
    expect(selection?.url.username).toBe("");
  });

  it("keeps the proxy password out of every error message (§12.6)", async () => {
    const origin = await startOrigin(true);
    const proxy = await startProxy(() => origin.port);
    proxy.requiredAuthorization = "Basic something-else";
    process.env.HTTPS_PROXY = `http://proxyuser:hunter2@127.0.0.1:${proxy.port}`;

    const error = await httpGet("https://example.com/pkg").catch((error_: Error) => error_);

    // §12.6 verbatim, formatted from the *target* URL as ever.
    expect((error as Error).message).toBe(messages.requestFailed("https://example.com/pkg"));

    // …and not one link of the cause chain names the password.
    let cause: unknown = error;
    const seen: string[] = [];
    while (cause instanceof Error) {
      seen.push(cause.message);
      cause = cause.cause;
    }
    expect(seen.join("\n")).not.toContain("hunter2");
    expect(seen.join("\n")).not.toContain("proxyuser");
    // The refusal is still diagnosable: it names the proxy and the status.
    expect(seen.join("\n")).toContain(`127.0.0.1:${proxy.port}`);
    expect(seen.join("\n")).toContain("407");
  });

  it("keeps the proxy password out of a plain-HTTP failure too", async () => {
    const origin = await startOrigin(false);
    const proxy = await startProxy(() => origin.port);
    proxy.requiredAuthorization = "Basic something-else";
    process.env.HTTP_PROXY = `http://proxyuser:hunter2@127.0.0.1:${proxy.port}`;

    const error = await httpGet("http://example.com/pkg").catch((error_: Error) => error_);

    expect((error as Error).message).toBe(messages.badStatus(407, "http://example.com/pkg"));
    expect((error as Error).message).not.toContain("hunter2");
  });
});

/* ------------------------------------------------------------------ *
 * §14.6 through the tunnel
 * ------------------------------------------------------------------ */

describe("§14.6 survives the tunnel", () => {
  it("sends no credentials to an origin that is not the registry (row 70)", async () => {
    const origin = await startOrigin(true);
    const proxy = await startProxy(() => origin.port);
    process.env.HTTPS_PROXY = proxy.origin;
    process.env.COREPACK_NPM_TOKEN = "secret-token";

    // A CDN-hosted tarball: same tunnel, different origin.
    const body = await httpGetJson<{ authorization: string | null }>(
      "https://cdn.example.com/pkg.tgz",
      {
        registryOrigin: "https://registry.example",
      },
    );

    expect(body.authorization).toBeNull();
    expect(proxy.connects).toEqual(["cdn.example.com:443"]);
    expect(JSON.stringify(proxy.connectHeaders)).not.toContain("secret-token");
  });

  it("drops Authorization on a cross-origin redirect taken through the proxy", async () => {
    const origin = await startOrigin(true);
    const proxy = await startProxy(() => origin.port);
    process.env.HTTPS_PROXY = proxy.origin;
    process.env.COREPACK_NPM_TOKEN = "secret-token";

    // `/redirect` answers 302 to https://elsewhere.example.com/final; the fixture
    // origin serves both, because the proxy points every authority at it.
    const body = await httpGetJson<{ url: string; authorization: string | null }>(
      "https://example.com/redirect",
      { registryOrigin: "https://example.com" },
    );

    expect(body.url).toBe("/final");
    expect(body.authorization).toBeNull();
    // Two tunnels: one per origin, the second opened for the redirect target.
    expect(proxy.connects).toEqual(["example.com:443", "elsewhere.example.com:443"]);
    expect(origin.requests[0]!.headers.authorization).toBe("Bearer secret-token");
    expect(origin.requests[1]!.headers.authorization).toBeUndefined();
  });

  it("keeps Authorization on a same-origin redirect through the proxy", async () => {
    const origin = await startOrigin(false);
    const proxy = await startProxy(() => origin.port);
    process.env.HTTP_PROXY = proxy.origin;
    process.env.COREPACK_NPM_USERNAME = "user";
    process.env.COREPACK_NPM_PASSWORD = "hunter2";

    await httpGetJson("http://example.com/pkg", { registryOrigin: "http://example.com" });

    expect(origin.requests[0]!.headers.authorization).toBe(`Basic ${base64("user:hunter2")}`);
  });

  it("never sends the registry credential to the proxy itself", async () => {
    const origin = await startOrigin(true);
    const proxy = await startProxy(() => origin.port);
    process.env.HTTPS_PROXY = proxy.origin;
    process.env.COREPACK_NPM_TOKEN = "secret-token";

    await httpGetJson("https://example.com/pkg", { registryOrigin: "https://example.com" });

    // The CONNECT is the only thing the proxy can read, and it is credential-free.
    expect(JSON.stringify(proxy.connectHeaders)).not.toContain("secret-token");
    expect(JSON.stringify(proxy.requests)).not.toContain("secret-token");
  });
});

/* ------------------------------------------------------------------ *
 * Failure modes
 * ------------------------------------------------------------------ */

describe("failures (§12.6)", () => {
  it("reports an unreachable proxy as the transport-failure message", async () => {
    const origin = await startOrigin(false);
    const proxy = await startProxy(() => origin.port);
    const port = proxy.port;
    await proxy.close();
    closers.splice(closers.indexOf(proxy.close), 1);
    process.env.HTTPS_PROXY = `http://127.0.0.1:${port}`;

    await expect(httpGet("https://example.com/pkg")).rejects.toThrow(
      messages.requestFailed("https://example.com/pkg"),
    );
  });

  it("surfaces a timeout while the tunnel is being opened", async () => {
    // A proxy that accepts the connection and never answers the CONNECT.
    const server = createHttpServer();
    server.on("connect", () => {});
    const sockets = tracked(server);
    const port = await listen(server);
    closers.push(closer(server, sockets));
    process.env.HTTPS_PROXY = `http://127.0.0.1:${port}`;

    await expect(httpGet("https://example.com/pkg", { timeout: 100 })).rejects.toThrow(
      messages.requestFailed("https://example.com/pkg"),
    );
  });

  it("names the proxy, not the target, when the tunnel is refused", async () => {
    const server = createHttpServer();
    const sockets = tracked(server);
    server.on("connect", (_request, socket: Socket) => {
      sockets.add(socket);
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    });
    const port = await listen(server);
    closers.push(closer(server, sockets));
    process.env.HTTPS_PROXY = `http://127.0.0.1:${port}`;

    const error = await httpGet("https://example.com/pkg").catch((error_: Error) => error_);

    expect((error as Error).message).toBe(messages.requestFailed("https://example.com/pkg"));
    expect(((error as Error).cause as Error).message).toBe(
      `The proxy at 127.0.0.1:${port} refused to tunnel to example.com:443 (HTTP 502)`,
    );
    // §15.5 — and the reason is *visible*, not merely attached: `main.ts`
    // presents an unexpected error as its stack, and a stack says nothing about
    // `cause`. Before this, a CONNECT refused with 502 reached the user as
    // §12.6's generic sentence and nothing else.
    expect((error as Error).stack).toContain(
      `Caused by: The proxy at 127.0.0.1:${port} refused to tunnel to example.com:443 (HTTP 502)`,
    );
  });
});

/* ------------------------------------------------------------------ *
 * §15.4 — TLS inside the tunnel
 *
 * A corporate interception proxy is where a custom CA and a CONNECT
 * tunnel meet: the certificate presented at the far end is the proxy's
 * re-signed one, and the trust decision has to reach *inside* the
 * tunnel to be made at all. This block un-trusts the fixture CA that
 * the rest of the file installs, so the tunnel really is facing an
 * unknown issuer.
 * ------------------------------------------------------------------ */

describe("TLS inside the tunnel (§15.4)", () => {
  beforeEach(() => {
    setDefaultCACertificates(trust);
  });

  afterEach(() => {
    setDefaultCACertificates([...trust, CERT]);
  });

  /** A CA bundle at a path nothing has seen before — the module memoises by path. */
  function bundleFile(): string {
    const path = join(mkdtempSync(join(tmpdir(), "jup-proxy-ca-")), "bundle.pem");
    writeFileSync(
      path,
      `${CERT}
`,
    );
    return path;
  }

  it("classifies an unknown issuer against the *target*, not the proxy", async () => {
    const origin = await startOrigin(true);
    const proxy = await startProxy(() => origin.port);
    process.env.HTTPS_PROXY = proxy.origin;

    const error = await httpGet("https://example.com/pkg").catch((error_: Error) => error_);

    // The tunnel was opened — the failure is the certificate at the far end of
    // it, and the host named is the one whose certificate it is.
    expect(proxy.connects).toEqual(["example.com:443"]);
    expect((error as Error).message).toBe(messages.tlsUnknownAuthority("example.com"));
    expect((error as Error).message).toContain("JUP_CAFILE");
  });

  it("verifies against COREPACK_CAFILE inside the tunnel", async () => {
    const origin = await startOrigin(true);
    const proxy = await startProxy(() => origin.port);
    process.env.HTTPS_PROXY = proxy.origin;
    process.env.COREPACK_CAFILE = bundleFile();

    await expect(httpGetJson<{ ok: boolean }>("https://example.com/pkg")).resolves.toMatchObject({
      ok: true,
    });
    expect(proxy.connects).toEqual(["example.com:443"]);
  });

  it("skips the check inside the tunnel under COREPACK_STRICT_SSL=0", async () => {
    const origin = await startOrigin(true);
    const proxy = await startProxy(() => origin.port);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.HTTPS_PROXY = proxy.origin;
    process.env.COREPACK_STRICT_SSL = "0";

    await expect(httpGetJson<{ ok: boolean }>("https://example.com/pkg")).resolves.toMatchObject({
      ok: true,
    });
    expect(warn).toHaveBeenCalledWith(messages.strictSslDisabled("COREPACK_STRICT_SSL"));
    warn.mockRestore();
  });
});
