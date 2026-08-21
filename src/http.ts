/**
 * The HTTP layer — §05.1, §14.6, §14.9.
 *
 * Built on native `fetch`: `Response.body` is a web `ReadableStream`, which is
 * what the download pipeline tees (§16.5); `AbortSignal.timeout` covers the
 * timeouts; `fetch` follows redirects and drops `Authorization` on a
 * cross-origin hop, which is exactly what §14.6 requires.
 *
 * Proxy support (§14.8) is deferred — it is the one thing `fetch` cannot do
 * without a custom dispatcher. It hangs off {@link HttpOptions}.
 */

import { Buffer } from "node:buffer";
import { envDisabled, envFlag } from "./env.ts";
import { messages, UsageError } from "./errors.ts";

/** §05.1 — the reference implementation imposes none; we suggest 30 s. */
const DEFAULT_TIMEOUT = 30_000;

/**
 * §05.2 — identifies the tool and its version, and nothing about the user or
 * the machine. Native HTTP stacks generally must send *something*, and a
 * registry operator needs a name to point at when something misbehaves.
 */
export const USER_AGENT = "pipack/0.0.0 (+https://github.com/pi0/pipack)";

export interface HttpOptions {
  headers?: Record<string, string>;
  /**
   * The configured registry's origin. Credentials never leave it (§14.6), so
   * omitting this means "send no credentials".
   */
  registryOrigin?: string;
  /** Connect + idle timeout in ms. Default 30_000. */
  timeout?: number;
  /**
   * **Phase-2 seam — do not use yet.**
   *
   * Proxy support (§05.1, §14.8), retry/backoff (§15.5) and custom CA /
   * strict-ssl (§15.4) all hang off this one option: `fetch` cannot proxy
   * without a custom dispatcher, so when those land they build the dispatcher,
   * bind it, and hand the result in here. Everything else in this module stays
   * as it is, which is the point — adding a proxy touches this file only.
   *
   * Phase 1 leaves it undefined and calls the global `fetch`.
   */
  transport?: typeof globalThis.fetch;
}

/**
 * §14.6 — the single credential rule, used by metadata requests and downloads
 * alike. Corepack has two paths that disagree; this is the unified one.
 *
 *     userinfo present            -> Basic from userinfo, stripped from the URL
 *     origin !== registryOrigin   -> none
 *     COREPACK_NPM_TOKEN present  -> Bearer
 *     USERNAME and PASSWORD both  -> Basic
 *     otherwise                   -> none
 *
 * The returned URL is the one that MUST be sent and the one every error message
 * MUST be formatted from: it never carries userinfo.
 */
export function credentialsFor(
  url: URL,
  registryOrigin?: string,
): { url: URL; authorization?: string } {
  // The URL's own userinfo wins over the environment, and MUST be stripped: a
  // redirect would otherwise carry it to the redirect target, and every error
  // message below interpolates this URL.
  if (url.username !== "" || url.password !== "") {
    const authorization = basic(url.username, url.password);
    const stripped = new URL(url.href);
    stripped.username = "";
    stripped.password = "";
    return { url: stripped, authorization };
  }

  // Credentials never leave the configured registry's origin. This is §14.6's
  // fix: corepack scopes only the Bearer token, and happily sends
  // COREPACK_NPM_USERNAME/PASSWORD to whatever host a request targets.
  const registry = originOf(registryOrigin);
  if (registry === undefined || url.origin !== registry) {
    return { url };
  }

  // Presence, not truthiness — an empty COREPACK_NPM_TOKEN still counts, and
  // still suppresses Basic.
  const token = process.env.COREPACK_NPM_TOKEN;
  if (token !== undefined) {
    return { url, authorization: `Bearer ${token}` };
  }

  // Credentials embedded in COREPACK_NPM_REGISTRY itself (§11.2 documents that
  // it "may embed user:pass@") apply to every request to that origin — not just
  // to URLs that happen to carry the userinfo themselves. Without this a private
  // registry configured this way authenticates its metadata requests, which are
  // built from the registry URL, and then fails the artifact download with a
  // 401: `dist.tarball` is same-origin but carries no userinfo of its own.
  //
  // Ranked above the environment pair, mirroring §05.1's `url.username ||
  // COREPACK_NPM_USERNAME`, and below the token, which §05.1 step 4 has
  // overwrite Basic.
  const registryUserinfo = userinfoOf(registryOrigin);
  if (registryUserinfo !== undefined) {
    return { url, authorization: registryUserinfo };
  }

  const username = process.env.COREPACK_NPM_USERNAME;
  const password = process.env.COREPACK_NPM_PASSWORD;
  if (username !== undefined && password !== undefined) {
    return { url, authorization: basic(username, password) };
  }

  return { url };
}

/** The `Basic` header a registry URL's own `user:pass@` implies, if it has one. */
function userinfoOf(registryUrl: string | undefined): string | undefined {
  if (registryUrl === undefined) return undefined;
  try {
    const parsed = new URL(registryUrl);
    if (parsed.username === "" && parsed.password === "") return undefined;
    return basic(parsed.username, parsed.password);
  } catch {
    return undefined;
  }
}

/**
 * §14.9 — the URL must parse, its scheme must be exactly `https:` (or `http:`
 * when the configured registry is itself `http:`), and its host must equal the
 * configured registry's host unless the user opts in.
 *
 * Corepack accepts anything that `startsWith("http")`, which also matches
 * `httpfoo://`, and imposes no relationship at all between a `dist.tarball`
 * host and the registry that vouched for it.
 *
 * The opt-out is `COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=1`, and it relaxes only
 * the host check: a plain-HTTP mirror must never be silently upgraded, and an
 * `https:` registry must never be silently downgraded.
 */
export function assertSafeArtifactUrl(url: string, registryUrl: string): URL {
  // Never interpolate the registry's own userinfo into an error message.
  const shownRegistry = redactUserinfo(registryUrl);

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(messages.refusingToDownload(redactUserinfo(url), shownRegistry));
  }

  let registry: URL;
  try {
    registry = new URL(registryUrl);
  } catch {
    throw new Error(messages.refusingToDownload(parsed.host, shownRegistry));
  }

  const httpAllowed = registry.protocol === "http:";
  if (parsed.protocol !== "https:" && !(httpAllowed && parsed.protocol === "http:")) {
    // Name the scheme: `httpfoo://registry.npmjs.org/…` has a matching host, so
    // a host-only message would read as a lie.
    throw new Error(
      messages.refusingToDownload(`${parsed.protocol}//${parsed.host}`, shownRegistry),
    );
  }

  if (parsed.host !== registry.host && !envFlag("COREPACK_ENABLE_UNSAFE_CUSTOM_URLS")) {
    throw new Error(messages.refusingToDownload(parsed.host, shownRegistry));
  }

  return parsed;
}

/**
 * GET, following redirects, throwing the §12.6 messages on transport failure and
 * on any non-2xx (after draining the body so the connection stays reusable).
 *
 * Error text is always formatted from the **stripped** URL, never carrying
 * userinfo or the `authorization` header.
 */
export async function httpGet(url: string, options: HttpOptions = {}): Promise<Response> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error(messages.requestFailed(redactUserinfo(url)), { cause: error });
  }

  const { url: target, authorization } = credentialsFor(parsed, options.registryOrigin);
  // Userinfo-free by construction, so it is safe in an error message.
  const href = target.href;

  // Before any socket is opened.
  if (envDisabled("COREPACK_ENABLE_NETWORK")) {
    throw new UsageError(messages.networkDisabledUrl(href));
  }

  const headers = new Headers(options.headers);
  // §14.6: `credentialsFor` owns this header. A caller cannot smuggle one past
  // the origin check by passing it in `options.headers`.
  headers.delete("authorization");
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  if (!headers.has("user-agent")) {
    headers.set("user-agent", USER_AGENT);
  }

  // Not `AbortSignal.timeout`: that signal stays live for the lifetime of the
  // response, so a 30 s budget would also cap the *body* — and this response's
  // body is a multi-megabyte tarball read by the download pipeline. The timer
  // is cleared once the headers land. (A per-chunk idle timeout is phase 2, and
  // hangs off `options.transport` with everything else.)
  const controller = new AbortController();
  const timeout = options.timeout ?? DEFAULT_TIMEOUT;
  const timer = setTimeout(() => {
    controller.abort(new Error(`Timed out after ${timeout}ms`));
  }, timeout);
  timer.unref();

  const transport = options.transport ?? globalThis.fetch;

  let response: Response;
  try {
    response = await transport(href, {
      method: "GET",
      headers,
      // `fetch` caps the chain at 20 and drops `authorization` on a
      // cross-origin hop — asserted by test rather than assumed.
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (error) {
    // Timeouts surface here too, as the transport-failure message.
    throw new Error(messages.requestFailed(href), { cause: error });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // Drain before throwing so the connection goes back to the pool instead of
    // being torn down.
    try {
      await response.arrayBuffer();
    } catch {
      // Nothing to drain, or the peer went away. Either way the status is the
      // error we care about.
    }
    throw new Error(messages.badStatus(response.status, href));
  }

  return response;
}

export async function httpGetJson<T = unknown>(url: string, options?: HttpOptions): Promise<T> {
  const response = await httpGet(url, options);
  try {
    return (await response.json()) as T;
  } catch (error) {
    throw new Error(messages.requestFailed(redactUserinfo(url)), { cause: error });
  }
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/** `undefined` when the registry is unusable as an origin, which means "no credentials". */
function originOf(registry: string | undefined): string | undefined {
  if (registry === undefined) {
    return undefined;
  }
  let origin: string;
  try {
    origin = new URL(registry).origin;
  } catch {
    return undefined;
  }
  // Opaque origins ("null") compare equal to each other; that must not be
  // mistaken for a match.
  return origin === "null" ? undefined : origin;
}

/**
 * Last line of defence for error text built from a string we could not parse
 * into a URL — the parsed paths all go through {@link credentialsFor}.
 */
function redactUserinfo(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username === "" && url.password === "") {
      return raw;
    }
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return raw.replace(/^([a-z][\d+.a-z-]*:\/\/)[^#/?]*@/i, "$1");
  }
}
