# 06 — Integrity & Trust

Every artifact must pass an authentication check before promotion.

## 6.1 The decision table

Let `build[1]` be the hex digest from the reference's build suffix (§02.1), if any.

| Reference has a hash? | Registry type | Integrity checks disabled? | What happens |
|---|---|---|---|
| yes | any | any | **Hash check only.** Signature verification is skipped entirely. |
| no | `npm` | no | **Signature verification**, then the registry's signed `integrity` becomes the expected hash, then hash check. |
| no | `url` | — | Refuse unless the ambient environment sets `JUP_ALLOW_UNVERIFIED=1`. |
| no | any | **yes** | Refuse unless the ambient environment sets `JUP_ALLOW_UNVERIFIED=1`. |

Every artifact MUST clear a user-pinned hash, a verified registry signature, or a
verified detached signature from its distribution channel. Verified TLS alone is not
a verification tier. When none is available, fail with the exact message:

`Refusing to install <name>@<version>: <source> provides no signature and no hash was pinned. Pin a hash in the packageManager field, or set JUP_ALLOW_UNVERIFIED=1.`

An ambient `JUP_ALLOW_UNVERIFIED=1` or compatibility
`COREPACK_ALLOW_UNVERIFIED=1` permits that artifact for the current run and MUST
emit an advisory warning naming the artifact and source. Project env files MUST NOT
set this opt-out; ignore the attempted setting and warn as required by §11.6.

Use `artifactRegistry`, when present, as the source of artifact metadata. Its signed
integrity must describe the bytes fetched for this host. Never put a host-specific
digest in a portable locator or manifest pin; host lock and marker data may carry it.

A user-supplied hash takes precedence over registry signatures. It is an explicit
assertion and is checked directly against the downloaded bytes.

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

Hash inline as bytes arrive. Support at least SHA-1, SHA-224, SHA-256, and SHA-512.
Validate the requested algorithm, reject unsupported or unsafe choices cleanly, warn
for weak user pins, and compare equal-length decoded digests in constant time.

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

Parse SRI as `<algo>-<base64>`, use its declared supported algorithm, and reject
invalid or unsupported algorithms.

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

Trust overrides and verification opt-outs MUST come from the ambient environment;
ignore and warn about attempts from project env files.

## 6.5 Key expiry

`expires` is `null` or an ISO-8601 timestamp evaluated against the system clock.
Try matching unexpired keys first. If none match, verify with a matching expired key:

- if its signature is valid, accept it and emit the exact warning in §12.12;
- if it is invalid, raise
  `The package was signed with an expired key (<keyid>, expired <expires>)`.

Never accept an expired key silently. Refresh embedded npm keys from
`https://registry.npmjs.org/-/npm/v1/keys` through the reviewed maintenance workflow.

## 6.6 Threat model summary

What this design defends against, and what it does not:

| Threat | Defended? |
|---|---|
| Registry serves a modified tarball for a hash-pinned version | **Yes** — hash check |
| Registry serves a modified tarball for an unpinned version, npm registry | **Yes** — signature chain, provided npm's key is not compromised |
| Compromised mirror serving unpinned versions | **Yes** — the signature covers package, version, and integrity |
| Man-in-the-middle on the wire | Via verified TLS |
| Hostile repository changing trust or disabling verification | **Yes** — project env sources cannot set those controls |
| Hostile repository pointing a known tool at an arbitrary URL | **Yes** — blocked unless ambient `JUP_ENABLE_UNSAFE_CUSTOM_URLS=1` |
| Tar path traversal, unsafe links, or special files | **Yes** — extraction rules in §07.4 |
