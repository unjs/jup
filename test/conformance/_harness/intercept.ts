/**
 * A `--import` preload for the spawned tool, used only by the conformance
 * harness: it points the *hardcoded* hosts in the embedded table
 * (`registry.npmjs.org`, `registry.yarnpkg.com`, `repo.yarnpkg.com`) at the mock
 * registry, and tells the mock what URL was originally asked for.
 *
 * This is the spawned-process equivalent of the `fetch` spy the unit tests
 * install, and it is what lets the conformance rows exercise the **default**
 * registry paths — including §14.9's host check, which compares `dist.tarball`
 * against `https://registry.npmjs.org` — without touching the network or
 * `src/`.
 */

const target = process.env.PIPACK_MOCK_ORIGIN;

const REWRITTEN_HOSTS = new Set(["registry.npmjs.org", "registry.yarnpkg.com", "repo.yarnpkg.com"]);

if (target !== undefined && target !== "") {
  const real = globalThis.fetch;

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const href =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;

    let url: URL;
    try {
      url = new URL(href);
    } catch {
      return real(input as RequestInfo, init);
    }

    if (!REWRITTEN_HOSTS.has(url.hostname)) {
      return real(input as RequestInfo, init);
    }

    const rewritten = new URL(`${url.pathname}${url.search}`, target);
    const headers = new Headers(init?.headers);
    headers.set("x-original-url", url.href);

    return real(rewritten.href, { ...init, headers });
  }) as typeof fetch;
}
