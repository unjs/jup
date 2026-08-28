/**
 * HTTP proxy transport supporting standard proxy variables, CONNECT for HTTPS, absolute-form forwarding for HTTP, redirect credential stripping, and TLS policy overrides. Socket modules load lazily so unproxied requests remain on native `fetch`.
 */

import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Readable } from "node:stream";
import { PROXY_ENV } from "../config/env-vars.ts";
import { NetworkError, networkError } from "../errors-cold.ts";
import { classifyTlsFailure, tlsConnectOptions, tlsTransportRequired } from "./tls.ts";

/** §05.1 — "MUST cap the chain (≤ 10 recommended)". */
const MAX_REDIRECTS = 10;

/** A CONNECT response header block larger than this is a broken peer, not a header block. */
const MAX_CONNECT_HEADER = 64 * 1024;

export interface ProxySelection {
  /**
   * The proxy, **with userinfo stripped**. Every message in this module is
   * formatted from `url.host`, so a proxy password cannot reach a log.
   */
  url: URL;
  /** `Proxy-Authorization` value implied by the proxy URL's own `user:pass@`. */
  authorization?: string;
}

/**
 * The `proxy-from-env` lookup: lowercase first, then uppercase.
 *
 * The precedence is the traditional CGI-safety rule — a CGI script's environment
 * carries `HTTP_PROXY` synthesised from a client-supplied `Proxy:` header, so the
 * lowercase form, which no header can produce, wins. We only *prefer* lowercase
 * rather than ignoring uppercase, because outside CGI `HTTP_PROXY` is what people
 * actually set.
 *
 * An empty value means "not set", which is how a shell unsets a proxy for one
 * command (`HTTPS_PROXY= cmd`).
 */
function fromEnv(name: string): string | undefined {
  const lower = process.env[name.toLowerCase()];
  if (lower !== undefined && lower !== "") return lower;
  const upper = process.env[name.toUpperCase()];
  if (upper !== undefined && upper !== "") return upper;
  return undefined;
}

/**
 * `NO_PROXY` matching (§15.6): `*` disables proxying entirely, entries are
 * comma- (or whitespace-) separated host suffixes, a leading `.` or `*.` marks a
 * suffix explicitly, a bare entry matches the host *and* its subdomains, and a
 * `:port` qualifier restricts the entry to that port.
 *
 * The bare-suffix case is where `proxy-from-env` itself is stricter than the
 * spec: it requires an exact match unless the entry starts with `.` or `*`. §15.6
 * requires "bare hostnames" *and* subdomain matching, and `NO_PROXY=internal`
 * failing to cover `registry.internal` is a surprise nobody wants behind a
 * corporate proxy.
 */
export function bypassesProxy(target: URL): boolean {
  const raw = fromEnv(PROXY_ENV.NO);
  if (raw === undefined) return false;

  const host = target.hostname.toLowerCase();
  const port = portOf(target);

  for (const entry of raw.split(/[\s,]+/)) {
    if (entry === "") continue;
    if (entry === "*") return true;

    let rule = entry.toLowerCase();

    // `host:port` — but not the port-less `[::1]`, whose colons are the address.
    const qualified = /^(.+):(\d+)$/.exec(rule);
    if (qualified !== null) {
      if (Number(qualified[2]) !== port) continue;
      rule = qualified[1]!;
    }

    // `*.example.com` is spelled that way in the wild; it means `.example.com`.
    if (rule.startsWith("*")) rule = rule.slice(1);
    if (rule === "") continue;

    if (rule.startsWith(".")) {
      // `.example.com` covers `example.com` itself as well as its subdomains.
      if (host === rule.slice(1) || host.endsWith(rule)) return true;
    } else if (host === rule || host.endsWith(`.${rule}`)) {
      return true;
    }
  }

  return false;
}

/**
 * The proxy that applies to `target`, or `undefined` for a direct request.
 *
 * Pure environment parsing — this is called on every outbound request, so it
 * loads nothing and allocates almost nothing.
 *
 * A proxy URL with a scheme we cannot speak (`socks5://`, typically from a
 * blanket `ALL_PROXY`) is treated as no proxy rather than as an error: erroring
 * would break users whose registry is reachable directly, and this module only
 * claims HTTP proxies.
 */
export function proxyForUrl(target: URL): ProxySelection | undefined {
  if (target.protocol !== "http:" && target.protocol !== "https:") return undefined;
  if (bypassesProxy(target)) return undefined;

  const scheme = target.protocol === "https:" ? PROXY_ENV.HTTPS : PROXY_ENV.HTTP;
  const configured = fromEnv(scheme) ?? fromEnv(PROXY_ENV.ALL);
  if (configured === undefined) return undefined;

  let url: URL;
  try {
    // A bare `proxy.corp:3128` is a common spelling and means HTTP.
    url = new URL(/^[a-z][\d+.a-z-]*:\/\//i.test(configured) ? configured : `http://${configured}`);
  } catch {
    return undefined;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;

  const authorization = proxyAuthorization(url);
  // Strip the userinfo so nothing downstream — an error message above all — can
  // hold the proxy's password.
  url.username = "";
  url.password = "";

  return authorization === undefined ? { url } : { url, authorization };
}

/** `Proxy-Authorization`, never `Authorization`: the tunnel is not the origin. */
function proxyAuthorization(proxy: URL): string | undefined {
  if (proxy.username === "" && proxy.password === "") return undefined;
  const username = decode(proxy.username);
  const password = decode(proxy.password);
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/** Userinfo is percent-encoded in a URL; a password with an `@` or `:` needs it back. */
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function portOf(url: URL): number {
  if (url.port !== "") return Number(url.port);
  return url.protocol === "https:" ? 443 : 80;
}

/** `URL.hostname` brackets an IPv6 literal; the socket layer wants it bare. */
function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** SNI is a *name*: sending an IP literal is a protocol violation Node warns about. */
function sniFor(hostname: string): string | undefined {
  if (hostname.startsWith("[")) return undefined;
  return /^[\d.]+$/.test(hostname) ? undefined : hostname;
}
/**
 * A `fetch`-shaped transport built on `node:http` / `node:https`.
 *
 * `http.ts` selects it only for a matched proxy (§14.8) or
 * `COREPACK_STRICT_SSL=0` (§15.4); other requests use native `fetch`.
 */
export const nodeFetch: typeof globalThis.fetch = async (input, init) => {
  const href =
    typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  const target = new URL(href);
  return await follow(target, init ?? {});
};

/**
 * The redirect chain, hop by hop, because we are the redirect follower now.
 *
 * Each hop re-asks {@link proxyForUrl}: a redirect can leave the proxied side of
 * `NO_PROXY`, and when it does we hand the rest of the chain back to `fetch`
 * rather than tunnelling a request that was never meant to be tunnelled.
 */
async function follow(start: URL, init: RequestInit): Promise<Response> {
  const headers = headerRecord(init.headers);
  const signal = init.signal ?? undefined;

  let target = start;
  let proxy = proxyForUrl(target);

  for (let hop = 0; ; hop++) {
    if (proxy === undefined && !tlsTransportRequired()) {
      // With no proxy or special TLS requirements, `fetch` follows
      // the remainder, and drops `Authorization` across origins on its own.
      return await globalThis.fetch(target.href, { ...init, headers });
    }

    const response = await sendOnce(target, headers, proxy, signal);

    const location = response.headers.get("location");
    if (!isRedirect(response.status) || location === null || init.redirect === "manual") {
      return response;
    }
    if (init.redirect === "error") {
      throw new Error(`Redirected while requesting ${redactedHref(target)}`);
    }
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`Too many redirects while requesting ${redactedHref(start)}`);
    }

    // Drain rather than abandon: the same rule §05.1 states for a non-2xx, for
    // the same reason — the connection stays reusable.
    await response.arrayBuffer().catch(() => undefined);

    let next: URL;
    try {
      next = new URL(location, target);
    } catch {
      throw new Error(`Invalid redirect target from ${redactedHref(target)}`);
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      throw new Error(`Refusing to follow a redirect to ${next.protocol}//${next.host}`);
    }

    // §14.6 — credentials do not survive a cross-origin hop, tunnel or no tunnel.
    if (next.origin !== target.origin) delete headers.authorization;

    target = next;
    proxy = proxyForUrl(next);
  }
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** Only ever called on URLs we built ourselves, but a message is a message. */
function redactedHref(url: URL): string {
  if (url.username === "" && url.password === "") return url.href;
  const stripped = new URL(url.href);
  stripped.username = "";
  stripped.password = "";
  return stripped.href;
}

/** `Headers` normalises names to lower case, which is what the rest of this file assumes. */
function headerRecord(headers: HeadersInit | undefined): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [name, value] of new Headers(headers)) record[name] = value;
  return record;
}

/** One request, through the proxy, with no redirect handling. */
async function sendOnce(
  target: URL,
  headers: Record<string, string>,
  proxy: ProxySelection | undefined,
  signal: AbortSignal | undefined,
): Promise<Response> {
  signal?.throwIfAborted();

  // GET only: §05.1's transport issues nothing else, and a request body would
  // have to be piped into the tunnel before the response could be read.
  const method = "GET";
  const request =
    proxy === undefined
      ? directRequest(target, headers, method)
      : target.protocol === "https:"
        ? await tunnelledRequest(target, headers, proxy, signal, method)
        : forwardedRequest(target, headers, proxy, method);

  return await new Promise<Response>((resolve, reject) => {
    const onAbort = () => request.destroy(abortError(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    request.once("close", () => signal?.removeEventListener("abort", onAbort));

    request.once("error", reject);
    request.once("response", (message: IncomingMessage) => {
      try {
        resolve(toResponse(message));
      } catch (error) {
        message.destroy();
        reject(error as Error);
      }
    });
    request.end();
  });
}

/**
 * `https://` through the proxy: `CONNECT host:port`, then a TLS session inside
 * the tunnel whose certificate is validated against the *target's* name. The
 * proxy sees a byte stream and nothing else — in particular it never sees the
 * `Authorization` header, which is exactly why CONNECT exists.
 */
async function tunnelledRequest(
  target: URL,
  headers: Record<string, string>,
  proxy: ProxySelection,
  signal: AbortSignal | undefined,
  method: string,
) {
  const socket = await openTunnel(target, proxy, signal);
  const { request } = process.getBuiltinModule("node:https");
  const { connect } = process.getBuiltinModule("node:tls");

  const host = bareHost(target.hostname);
  const port = portOf(target);

  return request({
    host,
    port,
    method,
    path: `${target.pathname}${target.search}`,
    // Node would spell the default port out (`example.com:443`); `URL.host`
    // omits it, which is what `fetch` puts on the wire.
    headers: { ...headers, host: target.host },
    // No agent: the socket is ours, and `createConnection` is only consulted
    // when the request has none (see `_http_client`), so `agent: false` — which
    // *creates* an agent — would quietly ignore the tunnel.
    // §15.4 — the certificate checked here is the *target's*; a corporate CA
    // bundle (or a disabled check) has to reach inside the tunnel, which is
    // exactly where a TLS-inspecting proxy puts its own certificate.
    createConnection: () =>
      connect({
        socket,
        host,
        port,
        servername: sniFor(target.hostname),
        ...tlsConnectOptions(),
      }),
  });
}

/**
 * No proxy, but §15.4 has something to say about TLS: the same `node:https`
 * request `fetch` would have made, with the certificate policy attached.
 *
 * Only reachable when {@link tlsTransportRequired} is true; everything else goes
 * out through native `fetch`.
 */
function directRequest(target: URL, headers: Record<string, string>, method: string) {
  const { request } =
    target.protocol === "https:"
      ? process.getBuiltinModule("node:https")
      : process.getBuiltinModule("node:http");

  return request({
    host: bareHost(target.hostname),
    port: portOf(target),
    method,
    path: `${target.pathname}${target.search}`,
    // Node would spell the default port out; `URL.host` omits it, which is what
    // `fetch` puts on the wire.
    headers: { ...headers, host: target.host },
    agent: false,
    servername: target.protocol === "https:" ? sniFor(target.hostname) : undefined,
    ...(target.protocol === "https:" ? tlsConnectOptions() : undefined),
  });
}

/**
 * `http://` through the proxy: one request to the proxy itself whose request
 * line is absolute-form. `Host` names the origin server, not the proxy.
 */
function forwardedRequest(
  target: URL,
  headers: Record<string, string>,
  proxy: ProxySelection,
  method: string,
) {
  const { request } =
    proxy.url.protocol === "https:"
      ? process.getBuiltinModule("node:https")
      : process.getBuiltinModule("node:http");

  const forwarded: Record<string, string> = { ...headers, host: target.host };
  if (proxy.authorization !== undefined) {
    forwarded["proxy-authorization"] = proxy.authorization;
  }

  return request({
    host: bareHost(proxy.url.hostname),
    port: portOf(proxy.url),
    method,
    // The absolute-form request target — the whole of the forward-proxy protocol.
    path: target.href,
    headers: forwarded,
    agent: false,
    servername: proxy.url.protocol === "https:" ? sniFor(proxy.url.hostname) : undefined,
  });
}

/** Open the socket to the proxy and complete the CONNECT handshake on it. */
async function openTunnel(
  target: URL,
  proxy: ProxySelection,
  signal: AbortSignal | undefined,
): Promise<Socket> {
  const socket = await connectToProxy(proxy.url, signal);

  const authority = `${target.hostname}:${portOf(target)}`;
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
  if (proxy.authorization !== undefined) {
    lines.push(`Proxy-Authorization: ${proxy.authorization}`);
  }

  return await new Promise<Socket>((resolve, reject) => {
    let buffered = Buffer.alloc(0);

    const fail = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buffered.length > MAX_CONNECT_HEADER) {
          fail(new Error(`The proxy at ${proxy.url.host} sent an oversized CONNECT response`));
        }
        return;
      }

      const status = Number(
        /^HTTP\/\d\.\d (\d{3})/.exec(buffered.subarray(0, end).toString("latin1"))?.[1] ?? 0,
      );
      if (status < 200 || status > 299) {
        // The proxy's host, never its userinfo — and never the target's, which
        // is why the authority is rebuilt from `hostname` and the port.
        fail(
          new Error(
            `The proxy at ${proxy.url.host} refused to tunnel to ${authority} (HTTP ${status || "?"})`,
          ),
        );
        return;
      }

      cleanup();
      // A well-behaved proxy says nothing after the header block, but if it
      // spoke early those bytes are the origin server's and belong to TLS.
      const rest = buffered.subarray(end + 4);
      socket.pause();
      if (rest.length > 0) socket.unshift(rest);
      resolve(socket);
    };
    const onError = (error: Error) => fail(error);
    const onClose = () =>
      fail(new Error(`The proxy at ${proxy.url.host} closed the connection during CONNECT`));
    const onAbort = () => fail(abortError(signal));

    function cleanup() {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    }

    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });

    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
  });
}

async function connectToProxy(proxy: URL, signal: AbortSignal | undefined): Promise<Socket> {
  const host = bareHost(proxy.hostname);
  const port = portOf(proxy);

  if (proxy.protocol === "https:") {
    const { connect } = process.getBuiltinModule("node:tls");
    const socket = connect({
      host,
      port,
      servername: sniFor(proxy.hostname),
      ...tlsConnectOptions(),
    });
    try {
      await connected(socket, "secureConnect", signal);
    } catch (error) {
      // §15.4 — name the *proxy* here. Classifying this failure against the
      // target's host, which is what an outer classifier would do, would send
      // the user looking at the wrong certificate.
      const classified = classifyTlsFailure(error, proxy.host);
      if (classified === undefined) throw error;
      throw networkError(new NetworkError(classified), error);
    }
    return socket;
  }

  const { connect } = process.getBuiltinModule("node:net");
  const socket = connect({ host, port });
  await connected(socket, "connect", signal);
  return socket;
}

function connected(socket: Socket, event: string, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.removeListener(event, onReady);
      socket.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      const error = abortError(signal);
      cleanup();
      socket.destroy(error);
      reject(error);
    };

    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    socket.once(event, onReady);
    socket.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal | undefined): Error {
  const reason: unknown = signal?.reason;
  return reason instanceof Error ? reason : new Error("The request was aborted");
}
/**
 * The seam back to the web API the rest of the tool speaks: `install.ts` tees
 * `response.body` to hash and extract in one pass (§16.5), so the body has to be
 * a real streaming `ReadableStream`, not a buffered one.
 */
function toResponse(message: IncomingMessage): Response {
  const status = message.statusCode ?? 0;
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    for (const single of Array.isArray(value) ? value : [value]) {
      try {
        headers.append(name, single);
      } catch {
        // A header name the web API rejects is one no consumer here can read.
      }
    }
  }

  // 204/304 and friends must have a null body, and `Response` enforces it.
  if (status === 204 || status === 205 || status === 304) {
    message.resume();
    return new Response(null, { status, statusText: reason(message), headers });
  }

  // We never send `Accept-Encoding`, so a body normally arrives identity —
  // but a proxy that compresses anyway must not corrupt a digest, and `fetch`
  // would have decoded it too.
  const encoding = (message.headers["content-encoding"] ?? "").toLowerCase().trim();
  const body = encoding === "" ? message : decompressed(message, encoding);
  if (body !== message) {
    headers.delete("content-encoding");
    headers.delete("content-length");
  }

  return new Response(webStream(body), { status, statusText: reason(message), headers });
}

/** An invalid reason phrase would make the `Response` constructor throw. */
function reason(message: IncomingMessage): string {
  const statusMessage = message.statusMessage ?? "";
  return /^[\t -~]*$/.test(statusMessage) ? statusMessage : "";
}

function decompressed(message: IncomingMessage, encoding: string): Readable {
  // Lazily, and only for a response that actually claims an encoding: `node:zlib`
  // is one of the modules the warm path is measured against.
  const zlib = process.getBuiltinModule("node:zlib");
  const stream =
    encoding === "gzip" || encoding === "x-gzip"
      ? zlib.createGunzip()
      : encoding === "deflate"
        ? zlib.createInflate()
        : encoding === "br"
          ? zlib.createBrotliDecompress()
          : undefined;
  if (stream === undefined) return message;
  // `pipe` forwards data but not failures, and `webStream` listens on the
  // decompressor alone. Without this hop a socket reset mid-body leaves the
  // gunzip stream neither ended nor errored, so the `ReadableStream` never
  // settles and the download awaits forever — and the idle watchdog cannot save
  // it, since aborting the request errors the source it is not listening to.
  message.on("error", (error) => stream.destroy(error));
  message.pipe(stream);
  return stream;
}

/** A `Readable` as a web stream, with backpressure: pull, don't buffer. */
function webStream(source: Readable): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      source.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        source.pause();
      });
      source.once("end", () => {
        try {
          controller.close();
        } catch {
          // Already closed by a cancel().
        }
      });
      source.once("error", (error: Error) => controller.error(error));
      source.pause();
    },
    pull() {
      source.resume();
    },
    cancel(cause) {
      source.destroy(cause instanceof Error ? cause : undefined);
    },
  });
}
