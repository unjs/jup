# 05 — Network & Registry

This page describes observable behaviour, not the transport implementation.
`src/net/` holds it: `http.ts` (transport), `registry.ts` (npm protocol),
`npmrc.ts`, `tls.ts`, `proxy.ts`.

## 5.1 The HTTP layer

For every metadata and artifact request:

1. If networking is disabled, raise the matching message (§12).
2. Parse the URL. Strip userinfo before sending, logging, or formatting an error.
3. Select credentials once:
   * URL userinfo wins and becomes Basic auth;
   * otherwise send nothing when the URL's origin differs from the configured
     registry's origin;
   * on the registry origin, a token becomes Bearer auth, else a username and
     password pair becomes Basic auth.
4. Follow 301/302/303/307/308, at most 10 hops, **dropping authorization on a
   cross-origin hop**.
5. Apply a connect and idle timeout (`JUP_NETWORK_TIMEOUT`, default 30000 ms).
   Retry only idempotent GETs, only on transport failures from a known-retryable
   errno list and on HTTP 408, 425, 429 and 5xx, up to `JUP_NETWORK_RETRIES`
   attempts (default 3, `0` disables, hard cap 10). Exponential backoff with
   jitter; honour `Retry-After`, except that one longer than 30 s is honoured by
   *not* retrying. Never retry another 4xx. After the last attempt, include the
   underlying errno or TLS cause.
6. Drain a bounded prefix of a non-2xx body — enough to keep the connection
   reusable, not enough to be a denial of service — then raise the matching
   error. Never expose authorization, userinfo, or secrets in logs or errors.
7. Parsed JSON documents are size-capped.

### TLS

Certificates are verified using system trust plus an optional `JUP_CAFILE`. A
configured bundle must be installed into the request's trust store **and then
confirmed** through the runtime's trust-store inspection API where one exists; if
it cannot be installed or confirmed, fail with a message naming the ignored
setting rather than continuing on default trust.

`JUP_STRICT_SSL=0`, or user/global `.npmrc` `strict-ssl=false`, disables
verification and prints the disabled-verification warning naming its source.
Project files can neither set auth nor weaken TLS.

Common TLS failures are classified rather than wrapped as generic transport
errors: unknown authority (pointing at `JUP_CAFILE` for TLS-inspecting proxies),
expired or not-yet-valid (pointing at the clock), and hostname mismatch.

### Proxies

`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY` are honoured in both
cases, lowercase first — the CGI-safety rule. `NO_PROXY` is comma-separated; `*`
disables proxying, a leading dot or bare suffix matches subdomains, and `:port`
narrows a match. HTTPS uses `CONNECT`; HTTP uses an absolute-form request line.

## 5.2 The npm protocol

### Base URL and precedence

The registry for a request is chosen from four tiers, highest first:

1. `JUP_REGISTRY_<NAME>` — per-tool, where `<NAME>` is the upper-cased tool name
   with non-alphanumerics folded to `_`;
2. `JUP_NPM_REGISTRY` — the whole table;
3. `.npmrc` (`registry`, or `@scope:registry` for a scoped package);
4. the built-in default, `https://registry.npmjs.org`.

All trailing slashes are stripped: some mirrors 404 on a doubled slash.

`JUP_ENABLE_NETWORK=0` is checked *here* as well as in the transport, and this
layer's message names the **registry** where the transport's names the **URL**.
Both are observable.

### Headers

```
Accept: application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8
```

This asks for the abbreviated packument, which omits per-version metadata jup
does not need; the `q=0.8` fallback exists because some third-party registries do
not implement it. Both response shapes are parsed. The one exception is §04.1's
candidate list under `JUP_MINIMUM_RELEASE_AGE`, which asks for `application/json`
because only the full document carries `time`.

No `User-Agent` identifying the user or machine is ever sent.

### Endpoints

| Purpose | Request | Fields used |
|---|---|---|
| All versions | `GET {registry}/{package}` | `versions` keys |
| Dist-tags | `GET {registry}/{package}` | `dist-tags` |
| Latest stable | `GET {registry}/{package}/latest` | `version`, `dist.{integrity, signatures, shasum}` |
| One version | `GET {registry}/{package}/{version}` | `dist.{tarball, integrity, signatures}` |

`{package}` is inserted without percent-encoding, so scoped names appear
literally (`…/@yarnpkg/cli-dist`), matching npm registry convention. `{version}`
may be a dist-tag, which the registry resolves server-side — that is how "latest"
costs one request rather than two.

### Tarball URLs

For a known tool the download URL normally comes from the table (`spec.url` with
`{}` and the host placeholders substituted). The packument's `dist.tarball` is
read verbatim when a registry override is in play, and it is validated:

* it must parse, and its scheme must be `https:` — or `http:` only when the
  configured registry itself is `http:`, so a plain-HTTP mirror can neither be
  silently upgraded nor downgraded;
* its host must match the configured registry's host, otherwise the download is
  refused by name. A compromised or hostile mirror can otherwise redirect the
  download to an arbitrary server.

### Override rewriting

Rewriting is always done by parsing both URLs, never by substring replacement,
which would normalise nothing and could match an unrelated URL:

* a URL derived from a tool's **own** table entry is moved onto
  `JUP_REGISTRY_<NAME>` unconditionally — a table URL is already known to use
  that tool's distribution origin;
* a URL on the **default** registry origin is moved onto `JUP_NPM_REGISTRY` when
  the origins match by scheme, host (case-insensitively) and port; the override's
  path prefix is prepended and the rest of the URL preserved.

Both are idempotent, and the result must pass the tarball-host validation above.

## 5.3 `.npmrc`

Read lowest precedence to highest:

1. `<prefix>/etc/npmrc` (global; `<prefix>` from `npm_config_prefix`/`PREFIX`),
2. `$HOME/.npmrc` or `%USERPROFILE%\.npmrc` (user),
3. the closest `.npmrc` walking from cwd to the project root, skipping package
   directories inside `node_modules` (project); closer files override farther.

Only these keys are honoured: `registry`, `@scope:registry`,
`//host/path/:_authToken`, `//host/path/:_auth`, `//host/path/:username` with
`:_password`, `cafile`, `ca`, `strict-ssl`. `_authToken` is Bearer, `_auth` is
pre-encoded Basic, `_password` is base64. Auth is matched by the longest
origin/path prefix and never sent to a redirected origin.

A **project** `.npmrc` may set only `registry` and `@scope:registry`. Its
credentials, `ca`, `cafile` and `strict-ssl` are ignored. `${VAR}` interpolation
substitutes only environment variables already present; no commands are run and
no unlisted configuration is expanded. Section headers are skipped rather than
honoured.

Parsing is memoised and stays off the warm path. `jup info` reports which file
and key supplied each effective setting.

## 5.4 The download prompt

Before streaming any **artifact** download — never before metadata:

```
JUP_ENABLE_DOWNLOAD_PROMPT=1:
    stderr: `! jup is about to download <url>`
    if stdin is a TTY and CI is unset:
        stderr: `? Do you want to continue? [Y/n] `
        read one chunk; a leading 'n' or 'N' aborts
```

Any other input, a bare newline included, means yes. Exactly one chunk is read,
and only under the TTY condition, so buffered stdin the tool did not need is left
for the package manager.

The **default** is set by the entry point, not by the core: `0` when jup was
invoked by its own name (the user asked for it), `1` through a package-manager
shim (the user asked for `yarn`, not for a download). Both are defaults a real
environment variable overrides, and neither may be set from an env file (§03.2).
