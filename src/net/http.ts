/**
 * The HTTP layer — §05.1, §05.2.
 *
 * Built on native `fetch`: `Response.body` is a web `ReadableStream`, which is
 * what the download pipeline tees (§07.4); `fetch` follows redirects and drops
 * `Authorization` on a cross-origin hop, which is exactly what §05.1 requires.
 *
 * Two things `fetch` cannot do on its own arrive as a dispatcher behind
 * {@link HttpOptions.transport}: proxying and a disabled certificate
 * check (§05.1). Both are decided per request from the environment alone, so a
 * machine that configures neither never loads a socket stack — and a custom CA
 * (§05.1) does not even need the dispatcher, because it is installed into the
 * process trust store that `fetch` already consults.
 *
 * Requests use connect and idle timeouts plus bounded, jittered retries for
 * transient failures on idempotent GETs.
 */

import { ENV, readEnv } from "../config/env-vars.ts";
import { envDisabled, envFlag } from "../project/env.ts";
import {
  messages,
  NetworkError,
  networkError,
  redactUserinfo,
  UsageError,
} from "../errors-cold.ts";
import { npmrcAuthorizationFor, registryTrustFor, type RegistryTrust } from "./npmrc.ts";
import { nodeFetch, proxyForUrl } from "./proxy.ts";
import {
  applyTlsConfiguration,
  classifyTlsFailure,
  isTlsFailure,
  tlsConfigured,
  tlsTransportRequired,
} from "./tls.ts";
import { getOwnVersion } from "../utils/self.ts";

/**
 * §05.1 — connect **and** idle timeout, in milliseconds, overridable with
 * `COREPACK_NETWORK_TIMEOUT`; default 30 s.
 */
const DEFAULT_TIMEOUT = 30_000;

/**
 * §05.1 — "3 attempts, exponential backoff with jitter".
 *
 * The spec states both "3 attempts" and a `COREPACK_NETWORK_RETRIES` default of
 * `3`, which are only both true if the variable counts **attempts**, the first
 * one included. That is the reading taken here: `3` is three requests, `0`
 * disables retrying, and so does `1`.
 */
const DEFAULT_ATTEMPTS = 3;

/** More than this is a script in a loop, not a flaky network. */
const MAX_ATTEMPTS = 10;

/** First backoff step; doubles per attempt, jittered, capped by {@link MAX_BACKOFF}. */
const BASE_BACKOFF = 250;
const MAX_BACKOFF = 8_000;

/** A `Retry-After` longer than this is a "come back tomorrow"; failing is kinder. */
const MAX_RETRY_AFTER = 30_000;

/**
 * How much of a *failed* response is worth reading before the socket is worth
 * less than the memory.
 *
 * Draining keeps a connection reusable, which is why it is done at all — but
 * `arrayBuffer()` reads to the end whatever the end turns out to be, and the
 * peer chooses that. A registry's error document is JSON measured in bytes; a
 * hostile or broken peer can return an arbitrarily large error body. Past the
 * cap, the body is abandoned and the connection torn down.
 */
const MAX_DRAIN_BYTES = 64 * 1024;

/**
 * The largest JSON document this module will parse.
 *
 * `Response.json()` has no ceiling at all. npm's abbreviated packument for the
 * package managers in the table is measured in hundreds of kilobytes and the
 * full one — §04.1 step 6's candidate list, the only caller that asks for it —
 * in single-digit megabytes, so this is several times the largest legitimate
 * answer and still a bound. Follows `install.ts`'s `MAX_SINGLE_FILE_BYTES` in
 * style and in reasoning: a counter costs nothing, and "the registry decides how
 * much memory we allocate" is not a property worth keeping.
 */
const MAX_JSON_BYTES = 32 * 1024 * 1024;

/**
 * §05.1 — statuses worth trying again. Everything else in the 4xx range is a
 * statement about the request, and repeating it changes nothing.
 */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

/**
 * Transport failures worth trying again.
 *
 * Deliberately a list rather than "anything that is not a status": a name that
 * does not resolve will not start resolving, and a certificate that does not
 * verify will not start verifying. Retrying either only multiplies the time a
 * user waits for an error that was correct the first time.
 */
const RETRYABLE_ERRNO = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTDOWN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function isRetryableTransport(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  if (isTlsFailure(error)) return false;

  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== null && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current instanceof TimeoutError) return true;
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && RETRYABLE_ERRNO.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Our own abort reason, so a timeout is distinguishable from a caller's cancel. */
class TimeoutError extends Error {
  override readonly name = "TimeoutError";
}

/** `COREPACK_NETWORK_TIMEOUT` / `COREPACK_NETWORK_RETRIES` — a positive integer or the default. */
function envInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = readEnv(name);
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return fallback;
  return Math.min(Math.max(Number(raw.trim()), minimum), maximum);
}

/** Equal jitter: half the exponential step, plus a random half. */
function backoffFor(attempt: number): number {
  const step = Math.min(BASE_BACKOFF * 2 ** (attempt - 1), MAX_BACKOFF);
  return step / 2 + Math.random() * (step / 2);
}

/** A `Retry-After` past {@link MAX_RETRY_AFTER}: honour it by *not* retrying. */
export const RETRY_AFTER_TOO_LONG = "too-long";

/**
 * `Retry-After` in both of RFC 9110's forms, in milliseconds.
 *
 * A registry under load answers `429` with delta-seconds; a maintenance window
 * answers `503` with an HTTP-date. Honouring only the first is the common bug.
 *
 * `undefined` means "no usable header, back off as normal";
 * {@link RETRY_AFTER_TOO_LONG} means the origin named a wait past the cap. The
 * two are kept apart because they call for opposite behaviour, and collapsing
 * them into one `undefined` turned "come back in an hour" into a retry on the
 * ordinary 250 ms backoff.
 */
export function retryAfterMs(
  header: string | null,
  now: number = Date.now(),
): number | typeof RETRY_AFTER_TOO_LONG | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (value === "") return undefined;

  if (/^\d+$/.test(value)) {
    const milliseconds = Number(value) * 1000;
    return milliseconds > MAX_RETRY_AFTER ? RETRY_AFTER_TOO_LONG : milliseconds;
  }

  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  const milliseconds = at - now;
  if (milliseconds > MAX_RETRY_AFTER) return RETRY_AFTER_TOO_LONG;
  return milliseconds > 0 ? milliseconds : 0;
}

/**
 * The default backoff.
 *
 * Deliberately **not** `unref`'d, unlike the timeout timers: nothing else is
 * pending while a retry waits, so an unref'd timer lets the runtime decide the
 * program is finished and exit mid-backoff — which shows up as an unsettled
 * top-level await and an exit code nobody asked for.
 */
const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

/**
 * §05.2 — identifies the tool and its version, and nothing about the user or
 * the machine. Native HTTP stacks generally must send *something*, and a
 * registry operator needs a name to point at when something misbehaves.
 */
export const USER_AGENT = `jup/${getOwnVersion()} (+https://github.com/unjs/jup)`;

export interface HttpOptions {
  headers?: Record<string, string>;
  /**
   * The configured registry's origin. Credentials never leave it (§05.1), so
   * omitting this means "send no credentials".
   */
  registryOrigin?: string;
  /**
   * Connect + idle timeout in ms. Defaults to `COREPACK_NETWORK_TIMEOUT`, then
   * to 30_000 (§05.1).
   */
  timeout?: number;
  /**
   * §05.1 — total attempts, the first included. Defaults to
   * `COREPACK_NETWORK_RETRIES`, then to 3. `0` or `1` means "no retry".
   */
  attempts?: number;
  /**
   * The backoff seam. Defaults to a real sleep; tests may inject a no-op.
   */
  sleep?: (milliseconds: number) => Promise<void>;
  /**
   * Send no credentials at all, whatever the environment and `.npmrc` hold.
   *
   * Omitting `registryOrigin` already withholds the `COREPACK_*` tier, but not
   * §05.3's: an `.npmrc` entry names its own scope, so a request to a URL inside
   * that scope is authenticated on the file's authority alone. That is right for
   * a registry request and wrong for npm's public key document (§06.3), which
   * needs no credential and must not carry one.
   */
  anonymous?: boolean;
  /**
   * Who chose {@link registryOrigin} — the user, or the repository (§11.2).
   *
   * Left undefined it is derived from the origin itself, which is what every
   * caller relies on: `install.ts` hands over a `dist.tarball` and a registry
   * URL, not the `RegistryDecision` that produced them, and re-deriving is
   * cheaper than threading a field through the download pipeline. A caller that
   * *does* hold the decision may pass its `trust` and skip the derivation.
   */
  registryTrust?: RegistryTrust;
  /**
   * The transport seam.
   *
   * Left undefined — which every caller does — the transport is chosen per
   * request: native `fetch` when no proxy applies and TLS needs no special
   * handling, and `proxy.ts`'s `node:https` dispatcher when a proxy
   * applies or when verification has been switched off (§05.1).
   */
  transport?: typeof globalThis.fetch;
}

/**
 * §05.1 — the single credential rule for metadata requests and downloads, with
 * §05.3's `.npmrc` tier below the environment:
 *
 *     userinfo present                        -> Basic from userinfo, stripped from the URL
 *     origin === registryOrigin, and the registry is the user's own choice:
 *         COREPACK_NPM_TOKEN present          -> Bearer
 *         registry URL carries user:pass@     -> Basic
 *         USERNAME and PASSWORD both present  -> Basic
 *     .npmrc entry whose prefix matches       -> Bearer or Basic
 *     otherwise                               -> none
 *
 * One gate sits across the whole table, and it is about *who chose the registry*
 * rather than what the registry is (see `npmrc.RegistryTrust`): **a registry the
 * repository named gets no environment credential at all**, whatever its origin.
 *
 * The gate applies only to environment credentials. User-scoped `.npmrc`
 * credentials remain eligible under their host-and-path prefix, including when
 * the project selected the registry (§05.3).
 *
 * The `.npmrc` tier is **not** gated on `registryOrigin`, and that is not a
 * relaxation: `//host/path/:_authToken` names its own scope, and
 * `npmrcAuthorizationFor` attaches it only to a URL whose host *and* path prefix
 * fall inside it (§05.3). That is strictly narrower than an origin check, which
 * is the reason §05.3 can read credentials out of a file at all without
 * reopening §05.1's leak. A user who wrote that prefix named the host they are
 * willing to reach; a project can redirect us to it, but not to anywhere the
 * user has not already put a credential. Project-level files never contribute
 * one.
 *
 * The returned URL is the one that MUST be sent and the one every error message
 * MUST be formatted from: it never carries userinfo.
 */
export function credentialsFor(
  url: URL,
  registryOrigin?: string,
  registryTrust?: RegistryTrust,
): { url: URL; authorization?: string } {
  // Who moved us here. Derived from the registry decision when there is one and
  // from the target itself when there is not — a URL nobody redirected us to is
  // one no repository named, which is the deny-list `registryTrustFor`
  // documents.
  const trust = registryTrust ?? registryTrustFor(registryOrigin ?? url.href);
  const projectChosen = trust === "project";

  // The URL's own userinfo wins over the environment, and MUST be stripped: a
  // redirect would otherwise carry it to the redirect target, and every error
  // message below interpolates this URL. Stripping is unconditional, so
  // userinfo never reaches the wire or a message as part of the URL.
  if (url.username !== "" || url.password !== "") {
    const authorization = basicFromUrl(url);
    const stripped = new URL(url.href);
    stripped.username = "";
    stripped.password = "";
    return { url: stripped, authorization };
  }

  // Credentials never leave the configured registry origin.
  const registry = originOf(registryOrigin);
  if (registry === undefined || url.origin !== registry) {
    return { url, authorization: npmrcAuthorizationFor(url)?.authorization };
  }

  // Repository-selected origins do not receive ambient environment credentials.
  // `.npmrc` credentials remain eligible because their prefix scopes the host.
  if (projectChosen) {
    return { url, authorization: npmrcAuthorizationFor(url)?.authorization };
  }

  // Presence, not truthiness — an empty COREPACK_NPM_TOKEN still counts, and
  // still suppresses Basic.
  const token = readEnv(ENV.NPM_TOKEN);
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

  const username = readEnv(ENV.NPM_USERNAME);
  const password = readEnv(ENV.NPM_PASSWORD);
  if (username !== undefined && password !== undefined) {
    return { url, authorization: basic(username, password) };
  }

  // `.npmrc` credentials rank below every `COREPACK_*` credential source.
  return { url, authorization: npmrcAuthorizationFor(url)?.authorization };
}

/** The `Basic` header a registry URL's own `user:pass@` implies, if it has one. */
function userinfoOf(registryUrl: string | undefined): string | undefined {
  if (registryUrl === undefined) return undefined;
  try {
    const parsed = new URL(registryUrl);
    if (parsed.username === "" && parsed.password === "") return undefined;
    return basicFromUrl(parsed);
  } catch {
    return undefined;
  }
}

/**
 * §05.2 — the URL must parse, its scheme must be exactly `https:` (or `http:`
 * when the configured registry is itself `http:`), and its host must equal the
 * configured registry's host unless the user opts in.
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

  if (parsed.host !== registry.host && !envFlag(ENV.ENABLE_UNSAFE_CUSTOM_URLS)) {
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
    throw networkError(new Error(messages.requestFailed(redactUserinfo(url))), error);
  }

  const credentials = credentialsFor(parsed, options.registryOrigin, options.registryTrust);
  const target = credentials.url;
  // The URL is still the stripped one: `anonymous` withholds the header, it does
  // not put userinfo back on the wire or into an error message.
  const authorization = options.anonymous === true ? undefined : credentials.authorization;
  // Userinfo-free by construction, so it is safe in an error message.
  const href = target.href;

  // Before any socket is opened.
  if (envDisabled(ENV.ENABLE_NETWORK)) {
    throw new UsageError(messages.networkDisabledUrl(href));
  }

  const headers = new Headers(options.headers);
  // §05.1: `credentialsFor` owns this header. A caller cannot smuggle one past
  // the origin check by passing it in `options.headers`.
  headers.delete("authorization");
  if (authorization !== undefined) {
    headers.set("authorization", authorization);
  }
  if (!headers.has("user-agent")) {
    headers.set("user-agent", USER_AGENT);
  }

  const timeout =
    options.timeout ?? envInteger(ENV.NETWORK_TIMEOUT, DEFAULT_TIMEOUT, 1, 2 ** 31 - 1);
  const attempts = Math.max(
    1,
    options.attempts ?? envInteger(ENV.NETWORK_RETRIES, DEFAULT_ATTEMPTS, 0, MAX_ATTEMPTS),
  );
  const sleep = options.sleep ?? wait;

  // §05.1 — read the PEM bundle and announce a disabled trust store once, here
  // rather than at module load: a run that never reaches the network reads no
  // file and prints nothing.
  if (tlsConfigured()) applyTlsConfiguration();

  // §05.1 — `HTTP_PROXY` and friends are honoured with no second opt-in flag,
  // which is the whole divergence. The check is pure environment parsing and the
  // answer is `undefined` for everyone who has no proxy configured, so the
  // unproxied path is native `fetch`, byte for byte as it was. §05.1's
  // verification switch is the one other thing `fetch` cannot express, and it
  // borrows the same dispatcher.
  const transport =
    options.transport ??
    (proxyForUrl(target) === undefined && !tlsTransportRequired() ? globalThis.fetch : nodeFetch);

  // §05.1 — idempotent GETs only, which is every request this module makes.
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= attempts;

    // Not `AbortSignal.timeout`: that signal stays live for the lifetime of the
    // response, so one budget would cap the *body* as well — and this response's
    // body is a multi-megabyte tarball read by the download pipeline. This timer
    // covers connect-plus-headers, and hands over to the idle watchdog below
    // once the headers land.
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new TimeoutError(messages.networkTimeout(timeout, href)));
    }, timeout);
    timer.unref();

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
      clearTimeout(timer);

      // An abort raised by our own timer arrives as whatever the runtime chose
      // to throw; the reason is the thing worth reporting.
      const cause = controller.signal.aborted ? (controller.signal.reason ?? error) : error;

      // §05.1 — the three certificate failures replace the transport message
      // instead of hiding underneath it, and are never retried.
      // The host named is always the *target's*: a failure against a proxy's own
      // certificate has already been classified, and wrapped, where the proxy's
      // host was the one in hand.
      const classified =
        cause instanceof NetworkError ? cause.message : classifyTlsFailure(cause, target.host);
      if (classified !== undefined) {
        throw networkError(new NetworkError(classified), cause);
      }

      if (!last && isRetryableTransport(cause)) {
        await sleep(backoffFor(attempt));
        continue;
      }
      throw networkError(new Error(messages.requestFailed(href)), exhausted(cause, attempt));
    }

    clearTimeout(timer);

    if (!response.ok) {
      // Drain before throwing (or retrying) so the connection goes back to the
      // pool instead of being torn down — but only up to a point (see
      // {@link MAX_DRAIN_BYTES}).
      await drain(response);

      const after = retryAfterMs(response.headers.get("retry-after"));
      // A `Retry-After` past the cap is the origin saying "come back much
      // later". Waiting that long is not on offer, and retrying anyway on the
      // ordinary backoff is the behaviour that turns one rate-limited request
      // into three and gets a CI runner banned. Failing now is the kinder half
      // of the same decision, and the reason the cap exists.
      if (!last && after !== RETRY_AFTER_TOO_LONG && isRetryableStatus(response.status)) {
        await sleep(after ?? backoffFor(attempt));
        continue;
      }
      throw new Error(messages.badStatus(response.status, href));
    }

    // Header timeouts do not cover a connection that stalls mid-body.
    return withIdleTimeout(response, timeout, href, controller);
  }
}

/**
 * Read at most {@link MAX_DRAIN_BYTES} of a body, then let it go.
 *
 * Cancelling the reader is what releases the socket when the cap is hit; below
 * the cap the stream reaches its end on its own and the cancel is a no-op, which
 * is the case that keeps the connection reusable.
 */
async function drain(response: Response): Promise<void> {
  const body = response.body;
  if (body === null) return;

  const reader = body.getReader();
  try {
    let seen = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      seen += value?.byteLength ?? 0;
      if (seen > MAX_DRAIN_BYTES) return;
    }
  } catch {
    // Nothing to drain, or the peer went away. Either way the status is the
    // error we care about.
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * The body as text, refusing anything past `limit`.
 *
 * Stands in for `Response.text()`/`Response.json()`, which buffer to whatever
 * length the peer sends. The overflow is a plain `Error` and always arrives as
 * the *cause* of §12.6's `requestFailed`, so no new user-facing string enters
 * the contract.
 */
async function readCapped(response: Response, limit: number): Promise<string> {
  const body = response.body;
  if (body === null) return "";

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let seen = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      seen += value.byteLength;
      if (seen > limit) {
        throw new RangeError(`The response body exceeds the ${limit} byte limit`);
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return text + decoder.decode();
}

/** Note the retries in the cause chain, so "it tried three times" is visible. */
function exhausted(cause: unknown, attempts: number): unknown {
  if (attempts <= 1) return cause;
  return new Error(messages.retriesExhausted(attempts), { cause });
}

/**
 * Re-arm a watchdog on every chunk: the response fails if the peer goes quiet
 * for longer than the timeout, rather than hanging until CI kills the job.
 *
 * Aborting the controller — rather than only erroring the wrapper — is what
 * actually releases the socket.
 */
function withIdleTimeout(
  response: Response,
  timeout: number,
  href: string,
  controller: AbortController,
): Response {
  const body = response.body;
  if (body === null) return response;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const disarm = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const arm = () => {
    disarm();
    timer = setTimeout(() => {
      controller.abort(new TimeoutError(messages.networkTimeout(timeout, href)));
    }, timeout);
    timer.unref();
  };

  const watched = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start: arm,
      transform(chunk, controller_) {
        arm();
        controller_.enqueue(chunk);
      },
      // No `cancel` hook: it is not in every runtime's `Transformer`, and the
      // timer is unref'd, so an abandoned response cannot hold the process open
      // — the worst it can do is abort a controller nobody is listening to.
      flush: disarm,
    }),
  );

  return new Response(watched, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export async function httpGetJson<T = unknown>(url: string, options?: HttpOptions): Promise<T> {
  const response = await httpGet(url, options);
  try {
    // Not `response.json()`: it has no ceiling, and a metadata document is the
    // one response on this path whose whole content is held in memory at once.
    return JSON.parse(await readCapped(response, MAX_JSON_BYTES)) as T;
  } catch (error) {
    throw networkError(new Error(messages.requestFailed(redactUserinfo(url))), error);
  }
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

/**
 * The `Basic` header a URL's own `user:pass@` implies.
 *
 * `URL.username`/`URL.password` hand back the **percent-encoded** userinfo,
 * which is the only legal way to write a password containing `@`, `:`, `/`, `#`
 * or `?`. The credential is the decoded form, so the encoding has to come off
 * before it goes on the wire — `proxy.ts` does the same for `Proxy-Authorization`.
 *
 * Not folded into {@link basic}: its other caller passes `COREPACK_NPM_USERNAME`
 * and `COREPACK_NPM_PASSWORD`, which are literal values, and a `%` in one of
 * those means a `%`.
 */
function basicFromUrl(url: URL): string {
  return basic(decodeUserinfo(url.username), decodeUserinfo(url.password));
}

function decodeUserinfo(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // A stray `%` that is not an escape. npm sends such userinfo through as
    // written rather than refusing the request, and so do we.
    return value;
  }
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
