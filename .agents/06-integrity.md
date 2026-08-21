# 06 — Integrity & Trust

Three independent mechanisms, applied in a specific order. Understanding *which one
fires when* is the single most security-relevant part of this spec.

## 6.1 The decision table

Let `build[1]` be the hex digest from the reference's build suffix (§02.1), if any.

| Reference has a hash? | Registry type | `registry.bin` set? | Integrity checks disabled? | What happens |
|---|---|---|---|---|
| yes | any | any | any | **Hash check only.** Signature verification is skipped entirely. |
| no | `npm` | no | no | **Signature verification**, then the registry's signed `integrity` becomes the expected hash, then hash check. |
| no | `npm` | **yes** | no | **Nothing.** No signature, no hash. |
| no | `url` | — | — | **Nothing.** No signature, no hash. |
| no | any | any | **yes** | **Nothing.** |

Two consequences a re-implementation MUST NOT accidentally "fix":

* **A user-supplied hash overrides signature verification.** Pinning
  `yarn@1.9998.9999+sha1.deadbeef` against a registry serving a *bad signature* fails
  with a hash mismatch, not a signature error — and once the correct hash is supplied
  it installs successfully despite the invalid signature. This is intended: an
  explicit hash is a stronger, user-chosen assertion than the registry's own claim.
* **Yarn Berry downloaded via `npmRegistry` (which sets `registry.bin`) is verified by
  neither mechanism** unless the user pins a hash, because the single extracted file's
  digest cannot be compared against the whole-tarball `dist.integrity`. See §14.10 —
  this is a genuine hole and this spec requires closing it.

## 6.2 Hash verification

```
algo   := build[0] ?? "sha512"
actual := <hex digest of the downloaded bytes, see below>
if build[1] and actual !== build[1]:
    → Error `Mismatch hashes. Expected <build[1]>, got <actual>`
```

**What gets hashed** depends on the download shape:

| Download shape | Bytes hashed |
|---|---|
| `.tgz` full extraction | the **raw tarball stream** as received (compressed bytes) |
| `.js` single file | the **file bytes** as received |
| `.tgz` with `registry.bin` filter | the **extracted single file** on disk, re-read after extraction |

The third case is why hashing cannot always be done inline with the download.

`algo` is any digest name the host's crypto supports — there is no allowlist.
`sha1`, `sha224`, `sha256`, `sha384`, `sha512` all appear in real `packageManager`
fields in the wild. A conforming implementation MUST support at minimum
`sha1`, `sha256`, `sha512`, and `sha224` (the last is what Yarn's own tooling emits).

> **Divergence (§14.11):** the comparison is a plain string `!==`. A conforming
> implementation MUST use a constant-time comparison. It MUST also **reject unknown
> or weak-by-request algorithms** rather than crashing, and SHOULD warn when a
> `packageManager` field pins `sha1` or `md5`.

On mismatch, the temp folder is discarded and **nothing is cached**. Re-running
reproduces the same error — the bad artifact must never be promoted into the store.

## 6.3 npm registry signature verification

npm signs a statement about each published version with an ECDSA key. The tool
verifies that signature and then trusts the `integrity` value it covers.

### The signed payload

```
<packageName>@<version>:<integrity>
```

Concatenated with no whitespace, UTF-8 encoded. `integrity` is the full SRI string
exactly as it appears in `dist.integrity`, including the `sha512-` prefix, e.g.:

```
@yarnpkg/cli-dist@4.14.1:sha512-AbCdEf0123…==
```

### The algorithm

```
verifySignature({signatures, integrity, packageName, version}):
  1. if signatures is not an array, or is empty:
         → Error `No compatible signature found in package metadata`

  2. trustedKeys := COREPACK_INTEGRITY_KEYS
                        ? JSON.parse(COREPACK_INTEGRITY_KEYS).npm
                        : <embedded config>.keys.npm

  3. walk trustedKeys IN ORDER; for each trusted key k,
     find the first signature s with s.keyid === k.keyid.
     Stop at the first trusted key that has a matching signature.

  4. if no match, or the matched signature has no .sig:
         → UsageError `The package was not signed by any trusted keys: ` +
             JSON.stringify({signatures, trustedKeys}, undefined, 2)

  5. pem := "-----BEGIN PUBLIC KEY-----\n" + k.key + "\n-----END PUBLIC KEY-----"
     ok  := ECDSA-verify(SHA-256, pem, base64decode(s.sig), payload)
     if !ok:
         → Error `Signature does not match`
```

Notes:

* `k.key` is the **base64 body of a DER SubjectPublicKeyInfo**, with no PEM armour —
  the armour is added at verification time. A native implementation can skip the PEM
  round-trip and parse the DER directly.
* The signature algorithm is generic ECDSA-with-SHA-256 over whatever curve the key
  material declares. The `keytype`/`scheme` fields (`ecdsa-sha2-nistp256`) are
  **not consulted** by the reference implementation — the curve comes from the key.
  A native implementation targeting only P-256 MUST validate that the parsed key's
  curve is P-256 and reject others rather than silently mis-verifying.
* Signature encoding is DER-encoded `(r, s)`, base64'd — not raw 64-byte
  concatenation.
* The `keyid` format is `"SHA256:" + base64(SHA256(<PEM-encoded SPKI>))`. It is used
  only as a selector, never as a security check — matching keyids is not evidence of
  anything; the ECDSA verification is.

### Deriving the expected hash from the verified integrity

After a successful verification, and only when the reference carried no hash:

```
build[1] := hex(base64decode(integrity.slice("sha512-".length)))
```

which is then checked against the downloaded bytes by §6.2. This gives an
end-to-end chain: trusted key → signature → `integrity` → tarball bytes.

> **Note.** The `.slice(7)` assumes the SRI algorithm is exactly `sha512`. A
> conforming implementation MUST parse the SRI string properly (`<algo>-<base64>`),
> use that algorithm for the digest, and reject SRI algorithms it does not support —
> rather than blindly stripping seven characters. See §14.12.

## 6.4 Disabling and overriding

```
shouldSkipIntegrityCheck() := COREPACK_INTEGRITY_KEYS === "" || COREPACK_INTEGRITY_KEYS === "0"
```

Exactly those two values disable verification. Any other non-empty value is parsed
as JSON and **replaces** (does not merge with) the embedded trust store. The shape
must match the embedded `keys` object:

```json
{"npm": [{"expires": null, "keyid": "SHA256:…", "keytype": "…", "scheme": "…", "key": "<base64 SPKI>"}]}
```

A malformed JSON value causes a parse error at verification time, not at startup.

> **Divergence (§14.5):** because `COREPACK_INTEGRITY_KEYS` can be set from a
> project-local `.corepack.env`, a hostile repository can currently substitute its own
> trust store or disable verification entirely by committing a file. A conforming
> implementation MUST ignore this variable when it originates from an env file.

## 6.5 Key expiry

Each trust-store entry carries `expires`: either `null` (never expires) or an ISO-8601
timestamp. The reference implementation **stores this field and never reads it**.

> **Divergence (§14.4):** a conforming implementation MUST evaluate expiry:
> * A key whose `expires` is in the past MUST NOT be selected in step 3.
> * If the *only* matching key is expired, the error MUST name it:
>   `The package was signed with an expired key (<keyid>, expired <expires>)`.
> * Expiry is evaluated against the system clock. Since a wrong clock could then
>   reject valid keys, an implementation SHOULD fall back to accepting an expired key
>   with a warning rather than hard-failing when *no* unexpired key matches and the
>   signature is otherwise valid — but MUST NOT do so silently.
>
> The embedded table's first key expired on 2025-01-29 and is dead weight today; a
> re-implementation should ship only unexpired keys and refresh them the way the
> reference does (a scheduled job comparing `keys.npm` against
> `GET https://registry.npmjs.org/-/npm/v1/keys`). The conformance suite (§13)
> includes that comparison as a live test.

## 6.6 Threat model summary

What this design defends against, and what it does not:

| Threat | Defended? |
|---|---|
| Registry serves a modified tarball for a hash-pinned version | **Yes** — hash check |
| Registry serves a modified tarball for an unpinned version, npm registry | **Yes** — signature chain, provided npm's key is not compromised |
| Compromised **mirror** (`COREPACK_NPM_REGISTRY`) serving unpinned versions | **Yes** — the signature is over the package name + version + integrity, and the mirror does not have npm's key |
| Compromised mirror serving unpinned **Yarn Berry** (`npmRegistry` path, `registry.bin` set) | **No** — see §14.10 |
| Compromised `repo.yarnpkg.com` serving unpinned Yarn Berry | **No** — url-type registries have no signatures at all |
| Man-in-the-middle on the wire | Via TLS only |
| Hostile repository disabling verification via `.corepack.env` | **No** — see §14.5 |
| Hostile repository pointing `packageManager` at an arbitrary URL | **Yes** for known package managers (blocked unless `COREPACK_ENABLE_UNSAFE_CUSTOM_URLS=1`); **no** for unknown names |
| Tarball path traversal / symlink escape during extraction | Delegated to the tar library; see §07.4 |
