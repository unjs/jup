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

export interface HttpOptions {
  headers?: Record<string, string>;
  /**
   * The configured registry's origin. Credentials never leave it (§14.6), so
   * omitting this means "send no credentials".
   */
  registryOrigin?: string;
  /** Connect + idle timeout in ms. Default 30_000. */
  timeout?: number;
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
 */
export function credentialsFor(
  url: URL,
  registryOrigin?: string,
): { url: URL; authorization?: string } {
  throw new Error(`TODO(T7): credentialsFor(${url.href})`);
}

/**
 * §14.9 — the URL must parse, its scheme must be exactly `https:` (or `http:`
 * when the configured registry is itself `http:`), and its host must equal the
 * configured registry's host unless the user opts in.
 */
export function assertSafeArtifactUrl(url: string, registryUrl: string): URL {
  throw new Error(`TODO(T7): assertSafeArtifactUrl(${url}, ${registryUrl})`);
}

/**
 * GET, following redirects, throwing the §12.6 messages on transport failure and
 * on any non-2xx (after draining the body so the connection stays reusable).
 *
 * Error text is always formatted from the **stripped** URL, never carrying
 * userinfo or the `authorization` header.
 */
export function httpGet(url: string, options?: HttpOptions): Promise<Response> {
  throw new Error(`TODO(T7): httpGet(${url})`);
}

export function httpGetJson<T = unknown>(url: string, options?: HttpOptions): Promise<T> {
  throw new Error(`TODO(T7): httpGetJson(${url})`);
}
