# 05 — Network & Registry Protocol

## 5.1 The HTTP layer

This section defines observable behavior, not the transport implementation.

### Request construction

For every metadata and artifact request:

1. If networking is disabled, raise the matching message from §12.6.
2. Parse the URL. Strip userinfo before sending or formatting errors.
3. Select credentials once:
   - URL userinfo wins and becomes Basic auth.
   - Otherwise, send no credentials when the URL origin differs from the configured
     registry origin.
   - On the registry origin, a present token becomes Bearer auth; otherwise a
     present username and password pair becomes Basic auth.
4. Follow 301, 302, 303, 307, and 308 redirects, with at most 10 hops. Drop
   authorization on a cross-origin hop.
5. Use a connect and idle timeout (`JUP_NETWORK_TIMEOUT`, default 30000 ms). Retry
   only idempotent GETs, on transport failures and HTTP 408, 425, 429, and 5xx, up
   to `JUP_NETWORK_RETRIES` attempts (default 3). Use exponential backoff with
   jitter and honor `Retry-After`; `JUP_NETWORK_RETRIES=0` disables retries. Never
   retry another 4xx. After the final attempt, include the underlying errno or TLS
   cause in the error.
6. Drain non-2xx response bodies, then raise the matching §12.6 error. Never expose
   authorization, URL userinfo, or secrets in logs or errors.

TLS certificates MUST be verified using system trust and optional `JUP_CAFILE`.
A configured CA bundle MUST be installed into the request's trust store and then
validated through the runtime's trust-store inspection API when available. If the
runtime cannot install or confirm it, fail with a message naming the ignored setting
instead of continuing with default trust.

`JUP_STRICT_SSL=0`, or user/global `.npmrc` `strict-ssl=false`, disables verification
and MUST emit exactly `! TLS certificate verification is disabled (set by <source>)`.
Project files cannot set auth or weaken TLS. Classify common TLS failures rather than
wrapping them as generic transport errors:

- unknown CA: `TLS certificate verification failed for <host>: the certificate was issued by an unknown authority. If your network uses a TLS-inspecting proxy, point JUP_CAFILE at its CA bundle.`
- expired or not-yet-valid: `TLS certificate for <host> is expired or not yet valid (check the system clock).`
- hostname mismatch: `TLS certificate for <host> does not match that hostname.`

Honor `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and lowercase forms directly.
Lowercase `http_proxy` wins. `NO_PROXY` is comma-separated; `*` disables proxying,
a leading dot or bare suffix matches subdomains, and `:port` narrows a match.
HTTPS uses `CONNECT`; HTTP uses an absolute-form request line.

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

> **Requirement:** `startsWith("http")` also accepts `httpfoo://…`. A conforming
> implementation MUST require the URL to parse and its scheme to be exactly `https:`
> (or `http:` when the configured registry itself is `http:` — a plain-HTTP mirror
> must not be able to be silently upgraded/downgraded). It MUST additionally reject a
> `dist.tarball` whose host differs from the configured registry's host unless the
> user has opted in, since a compromised or hostile mirror can otherwise redirect the
> download to an arbitrary server.

For *known* package managers the download URL normally comes from the embedded table
(`spec.url` with `{}` replaced by the version), **not** from the packument. The
packument path is only taken when `COREPACK_NPM_REGISTRY` is set.

### Registry override rewriting

When `COREPACK_NPM_REGISTRY` is set, parse both the download URL and the default
registry URL. Compare their origins by scheme, host, and port, treating host names
case-insensitively. If the origins match, rebuild the download URL with the override's
scheme, host, and port, prepend the override's path prefix to the original path, and
preserve the remaining URL components. Never rewrite a URL by substring replacement.
The resulting host must pass the tarball-host validation above.

If a range spec declares `npmRegistry`, use that package metadata source instead of
its ordinary `registry` before applying the same parsed-origin override rule.

## 5.3 `.npmrc`

Read these files from lowest to highest precedence:

1. `<prefix>/etc/npmrc` (global),
2. `$HOME/.npmrc` or `%USERPROFILE%\.npmrc` (user),
3. the closest `.npmrc` found by walking from the working directory to the project
   root, skipping directories inside `node_modules` (project).

Honor only `registry`, `@scope:registry`, `//host/path/:_authToken`,
`//host/path/:_auth`, `//host/path/:username` with `:_password`, `cafile`, `ca`, and
`strict-ssl`. `_authToken` is Bearer credentials, `_auth` is pre-encoded Basic
credentials, and `_password` is base64. A scoped registry overrides the default for
that scope; closer project files override farther ones.

Configuration precedence is ambient registry/auth environment settings, eligible
env-file settings, `.npmrc` in the order above, then the built-in registry. Project
`.npmrc` files may set only `registry` and `@scope:registry`; ignore project
credentials, `ca`, `cafile`, and `strict-ssl`. Interpolate only environment variables
already present; do not run commands or expand unlisted configuration. Match auth by
the longest origin/path prefix and never send it to a redirected origin.

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
