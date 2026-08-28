# 05 — Network & Registry Protocol

## 5.1 The HTTP layer

The reference implementation has **no HTTP client of its own** — it calls the host's
`fetch` and lets the runtime handle TLS, redirects, connection pooling, and proxying.
A zero-dependency native implementation must supply these itself. This section
specifies the observable contract, not the transport.

### Request construction

```
send(url, extraHeaders):
  1. if COREPACK_ENABLE_NETWORK === "0":
         → UsageError `Network access disabled by the environment; can't reach <url>`
  2. parse url
  3. Basic auth:
         username := url.username || COREPACK_NPM_USERNAME
         password := url.password || COREPACK_NPM_PASSWORD
         if username or password is truthy:
             header authorization = "Basic " + base64(`${username}:${password}`)
             strip userinfo from the URL before sending          # MUST
  4. Bearer auth (origin-scoped):
         if COREPACK_NPM_TOKEN is set:
             registry := new URL(COREPACK_NPM_REGISTRY || "https://registry.npmjs.org")
             if url.origin === registry.origin:
                 header authorization = "Bearer " + COREPACK_NPM_TOKEN   # OVERWRITES Basic
  5. issue the request, following redirects
  6. on transport failure:
         → Error `Error when performing the request to <url>; for troubleshooting help, see https://github.com/nodejs/corepack#troubleshooting`
            (with the transport error attached as cause)
  7. if status is not 2xx:
         drain the response body, then
         → Error `Server answered with HTTP <status> when performing the request to <url>; for troubleshooting help, see https://github.com/nodejs/corepack#troubleshooting`
```

Requirements a re-implementation MUST meet:

* **Userinfo in the URL wins over the env vars**, and MUST be stripped before the
  request goes out — otherwise credentials leak into the request line and into any
  redirect target.
* **Bearer is origin-scoped; Basic is not.** A tarball served from a CDN on a
  different origin than the registry gets no Bearer token. This is deliberate (don't
  leak the registry token to a third party) and MUST be preserved.
  See §14.6 — the asymmetry (Basic auth being sent to *any* host) is a real leak and
  this spec requires scoping Basic auth to the registry origin too.
* **Draining the body before throwing** on a non-2xx keeps the connection reusable.
* **Errors must not include the Authorization header or the userinfo** in their text.
  Note the messages above interpolate `<url>` *after* userinfo stripping in step 3 —
  a re-implementation MUST format the message from the stripped URL.

### Redirects, timeouts, retries, TLS

| Concern | Reference behaviour | Requirement for a re-implementation |
|---|---|---|
| Redirects | Followed by the host `fetch` (limit 20) | MUST follow 301/302/303/307/308, MUST cap the chain (≤ 10 recommended), MUST drop the `authorization` header on a cross-origin hop |
| Timeout | **None** | SHOULD impose a connect + idle timeout (30 s suggested) and surface it as the transport-failure message above |
| Retry | **None** — a single failure is fatal | MAY retry idempotent GETs on transport errors and 5xx with backoff; MUST NOT retry 4xx |
| TLS | Host defaults | MUST verify certificates; SHOULD honour `NODE_EXTRA_CA_CERTS`-equivalent / system trust store |

### Proxies

The reference implementation contains **zero proxy code**. It relies on the host
runtime's opt-in env-proxy support, which in current Node requires
`NODE_USE_ENV_PROXY=1` to be set — so `HTTP_PROXY` alone does nothing.

> **Divergence (§14.8):** this is a usability trap. A conforming implementation
> **MUST** implement proxy support directly and honour `HTTP_PROXY`, `HTTPS_PROXY`,
> `ALL_PROXY`, and `NO_PROXY` **without** requiring an extra opt-in flag, using
> standard `proxy-from-env` semantics:
> * lowercase variants take precedence over uppercase for `http_proxy` (the
>   traditional CGI-safety rule); for the others either case is accepted.
> * `NO_PROXY` is a comma-separated list of host suffixes; `*` disables proxying
>   entirely; a leading `.` or bare suffix matches subdomains; an optional `:port`
>   restricts the match.
> * `https://` targets go through `CONNECT`; `http://` targets use an absolute-form
>   request line.

## 5.2 npm registry protocol

### Base URL

```
registryUrl := (COREPACK_NPM_REGISTRY || "https://registry.npmjs.org")
                  with all trailing "/" stripped

if COREPACK_ENABLE_NETWORK === "0":
    → UsageError `Network access disabled by the environment; can't reach npm repository <registryUrl>`
```

Note this is a **second, distinct** network-disabled message: the npm-registry layer
checks the flag itself and names the *registry*, while the transport layer (§5.1)
names the *URL*. Both strings are observable and both MUST be reproduced.

Trailing-slash stripping is **required**: some mirrors (e.g. `registry.npmmirror.com`)
return 404 for a doubled slash.

### Default headers

```
Accept: application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8
```

This requests the **abbreviated packument**, which omits per-version metadata the tool
does not need. The `q=0.8` fallback to plain JSON exists because some third-party
registries do not implement the abbreviated format. A conforming implementation MUST
send this exact header and MUST parse both response shapes.

No `User-Agent` is set by the reference implementation. A re-implementation SHOULD
send one identifying itself and its version (native HTTP stacks generally must send
something), and MUST NOT send anything identifying the user or machine.

### Endpoints

| Purpose | Request | Response fields used |
|---|---|---|
| All versions | `GET {registry}/{package}` | `Object.keys(body.versions)` |
| Dist-tags | `GET {registry}/{package}` | `body["dist-tags"]` |
| Latest stable | `GET {registry}/{package}/latest` | `body.version`, `body.dist.{integrity, signatures, shasum}` |
| One version's metadata | `GET {registry}/{package}/{version}` | `body.dist.{tarball, integrity, signatures}` |

`{package}` is inserted **without percent-encoding**. Scoped names therefore appear
literally: `https://registry.npmjs.org/@yarnpkg/cli-dist`. This matches npm registry
convention and MUST be preserved.

`{version}` may be a literal dist-tag string; the registry resolves it server-side.
That is how "latest" is fetched in one request rather than two.

### Tarball URL

The tool never synthesises a tarball URL from an npm packument — it reads
`body.dist.tarball` verbatim, and validates it:

```
if tarball is undefined or does not start with "http":
    → Error `<packageName>@<version> does not have a valid tarball.`
```

> **Divergence (§14.9):** `startsWith("http")` also accepts `httpfoo://…`. A conforming
> implementation MUST require the URL to parse and its scheme to be exactly `https:`
> (or `http:` when the configured registry itself is `http:` — a plain-HTTP mirror
> must not be able to be silently upgraded/downgraded). It MUST additionally reject a
> `dist.tarball` whose host differs from the configured registry's host unless the
> user has opted in, since a compromised or hostile mirror can otherwise redirect the
> download to an arbitrary server. (Corepack had exactly this class of bug —
> "incorrect registry origin check", fixed in 0.34.1.)

For *known* package managers the download URL normally comes from the embedded table
(`spec.url` with `{}` replaced by the version), **not** from the packument. The
packument path is only taken when `COREPACK_NPM_REGISTRY` is set.

### Registry override rewriting

When `COREPACK_NPM_REGISTRY` is set, two rewrites happen (§07.3):

1. If the range's spec declares `npmRegistry`, that spec is used **instead of**
   `registry`. **No entry declares one.** This is how Yarn Berry used to switch from
   `repo.yarnpkg.com` to the `@yarnpkg/cli-dist` npm package once a mirror was
   configured; §15.41 made `@yarnpkg/cli-dist` the band itself, so the swap is
   unconditional and this rewrite has no subject. The mechanism is retained for a
   band published somewhere that is not an npm registry.
2. Any occurrence of the literal default registry origin
   `https://registry.npmjs.org` in the download URL is replaced with the override.

Rewrite 2 is a plain string replacement on the prefix. It applies both to
table-derived URLs and to URL-typed `packageManager` references that happen to point
at the default registry.

## 5.3 URL-typed registries

For `{type: "url", url, fields}`:

* `GET url`, parse JSON (through the same HTTP layer, so auth/network rules apply).
* Tags: `body[fields.tags]` — an object mapping tag → version.
* Versions: `body[fields.versions]` — an **array** of versions, or an object whose
  keys are versions. Both MUST be handled.
* Latest stable: `body[fields.tags].stable`.

Yarn's tags document maps `fields.tags → "aliases"` and `fields.versions → "tags"`,
which is confusingly inverted relative to the field names. That is the data's fault,
not the algorithm's; a re-implementation must follow the mapping, not the names.

## 5.4 Authentication summary

There are two distinct auth code paths in the reference implementation and they do
**not** agree. Both are observable, and both are in the test suite.

**Path A — registry metadata requests** (`{registry}/{package}…`):

```
if "COREPACK_NPM_TOKEN" is PRESENT in the environment (even if empty):
    authorization = Bearer <token>
else if BOTH "COREPACK_NPM_USERNAME" and "COREPACK_NPM_PASSWORD" are PRESENT:
    authorization = Basic base64(username + ":" + password)
else:
    no authorization header
```
Presence test, not truthiness. Username without password sends nothing.
Not origin-scoped.

**Path B — downloads and URL-registry fetches** (§5.1):

```
username := url.username || COREPACK_NPM_USERNAME       (truthiness)
password := url.password || COREPACK_NPM_PASSWORD
if username OR password:  authorization = Basic …       (either alone suffices)
if COREPACK_NPM_TOKEN and url.origin === registry.origin:
    authorization = Bearer …                            (overwrites)
```

> **Divergence (§14.6):** the two paths MUST be unified. A conforming implementation
> uses a single rule:
>
> ```
> credentialsFor(url):
>     if url has userinfo → Basic from userinfo (and strip it)
>     else if url.origin !== registryOrigin → no credentials
>     else if COREPACK_NPM_TOKEN is present → Bearer
>     else if both USERNAME and PASSWORD are present → Basic
>     else → none
> ```
>
> This fixes: credentials being sent to arbitrary hosts, username-without-password
> producing a half-formed header on one path and nothing on the other, and Bearer
> silently clobbering a URL's own userinfo.

### `.npmrc`

The reference implementation does **not** read `.npmrc`, at any level. Registry and
auth configuration comes only from `COREPACK_*` variables (and, indirectly,
`.jup.env`).

This is corepack's single most-requested missing capability. **§15.1 requires a
conforming implementation to read a constrained subset of `.npmrc`**, and specifies
exactly which keys, which files, and in what precedence.

## 5.5 The download prompt

Before streaming any **artifact** download (not metadata JSON):

```
if COREPACK_ENABLE_DOWNLOAD_PROMPT === "1":
    stderr: `! jup is about to download <url>\n`
    if stdin is a TTY and the CI env var is not set:
        stderr: `? Do you want to continue? [Y/n] `
        read one chunk from stdin
        if first byte is 'n' (0x6e) or 'N' (0x4e):
            → UsageError `Aborted by the user`
        stderr: `\n`
```

Any other input — including a bare newline — is treated as yes.

The default value of `COREPACK_ENABLE_DOWNLOAD_PROMPT` is set **by the entry point**,
not by the tool's core (§10.1):

| Entry point | Default |
|---|---|
| The tool's own name (`jup …`) | `0` — the user explicitly asked for it |
| A package-manager shim (`yarn …`) | `1` — the user did not ask to download anything |

Both are `??=`-style defaults, so a real environment variable overrides them. This
default MUST NOT be settable from `.jup.env` (§03.2).
