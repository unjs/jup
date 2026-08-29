# 06 — Integrity & Trust

Every artifact clears an authentication check before promotion. Verified TLS is
not one: it says the bytes came from the host the URL named, not that the host is
publishing what it published yesterday.

## 6.1 The tiers

An artifact is acceptable when it clears one of:

1. **A user-pinned hash** — from the reference's build suffix, a URL fragment, or
   `devEngines.…​.integrity`. An explicit, user-chosen assertion.
2. **A verified registry signature**, whose signed `integrity` then becomes the
   expected digest.
3. **A registry-published digest without a signature** — a soft-fail, warned once
   per artifact, for registries (commonly Artifactory) that strip signatures.

| Reference has a hash? | Registry | Verification disabled? | Outcome |
|---|---|---|---|
| yes | any | any | Hash check only; no signature request at all |
| no | npm | no | Signature → `integrity` → hash check, or tier 3, or refusal |
| no | url | — | Refuse unless `JUP_ALLOW_UNVERIFIED=1` |
| no | any | yes | Refuse unless `JUP_ALLOW_UNVERIFIED=1` |

Row 1 turns signature verification off deliberately: an explicit hash is stronger
than the registry's claim about itself, and consulting the registry would add a
request to a path that already knows what it expects. A registry that returned no
signatures is still worth one warning when the metadata was fetched anyway.

When nothing clears a tier, the install is refused by name, pointing at both a
pinned hash and `JUP_ALLOW_UNVERIFIED=1`. That opt-out is ambient-only — a
project env file cannot set it — applies to the current run, and warns for each
artifact it permits.

What the refusal actually closes: a `type: "url"` source that publishes neither
signatures nor digests, and a custom `packageManager` URL with no `#<algo>.<hex>`
fragment (that path is already behind `JUP_ENABLE_UNSAFE_CUSTOM_URLS`, which
permits the *host*; the fragment is how the user says what should arrive from it).
It does not fire for the ordinary entries: the table pins a hash on `default` and
`transparent.default`, and §04.6's `latest` lookup attaches the registry's signed
digest.

`JUP_REQUIRE_SIGNATURES=1` turns tier 3 into a hard failure, for organisations
mandating signed sources. It is deliberately not consulted on tier 1.

Use `artifactRegistry`, where present, as the source of artifact metadata: its
signed integrity must describe the bytes fetched **for this host**. A
host-specific digest never goes into a portable locator or manifest pin; the
marker and `jup.lock`'s host map are where it belongs.

## 6.2 Hash verification

```
algo   := the pinned algorithm, else sha512
actual := hex digest of the downloaded bytes
mismatch → "Mismatch hashes. Expected <expected>, got <actual>"
```

What is hashed is the bytes **as received**: the raw compressed tarball stream
for a `.tgz`, the file bytes for a single `.js`. Hashing happens inline as bytes
arrive, in the same pass that writes them.

At least SHA-1, SHA-224, SHA-256 and SHA-512 are supported. An unsupported or
unsafe algorithm is rejected cleanly by name, weak user pins are warned about,
and digests are compared in constant time over equal-length decoded bytes.

On mismatch the temp directory is discarded and **nothing is cached**, so
re-running reproduces the same error rather than silently succeeding.

## 6.3 npm signature verification

npm signs a statement about each published version with an ECDSA key. jup
verifies that signature and then trusts the `integrity` it covers.

The signed payload is `<packageName>@<version>:<integrity>`, concatenated with no
whitespace, UTF-8, where `integrity` is the full SRI string exactly as it appears
in `dist.integrity`, `sha512-` prefix included.

```
1. signatures not a non-empty array → "No compatible signature found in package metadata"
2. trusted keys := JUP_INTEGRITY_KEYS (parsed as JSON) or the embedded store
3. walk the trusted keys IN ORDER; take the first that has a matching keyid
4. no match, or the match has no .sig → "The package was not signed by any trusted keys: …"
5. ECDSA-verify(SHA-256, key, base64decode(sig), payload)
   failure → "Signature does not match"
```

Notes:

* `key` is the base64 body of a DER SubjectPublicKeyInfo; the PEM armour is added
  at verification time.
* The curve comes from the key material — `keytype`/`scheme` are not consulted —
  so an implementation targeting only P-256 must validate the parsed curve rather
  than assume it.
* Signatures are DER `(r, s)`, base64'd, not a raw 64-byte concatenation.
* `keyid` is `"SHA256:" + base64(SHA256(PEM SPKI))` and is only a **selector**.
  Matching keyids is not evidence of anything; the ECDSA check is.

After a successful verification, and only when the reference carried no hash, the
expected digest is `hex(base64decode(integrity))`, checked against the downloaded
bytes by §6.2. That is the whole chain: trusted key → signature → `integrity` →
tarball bytes.

### Two recovery paths

* **Signatures missing from the version document.** Some registries strip
  `dist.signatures` there while the package root still carries them. One extra
  request to the package root is made — only on a path already heading for a
  degraded outcome, and never when there is no `integrity` for a recovered
  signature to cover.
* **An unmatched keyid.** npm rotates keys. On an unmatched keyid — and only
  that failure, never a bad signature or an expired key — jup fetches
  `https://registry.npmjs.org/-/npm/v1/keys` **anonymously, from npm's own
  origin regardless of any registry override**, sanitises every field, merges
  (embedded keys first, a repeated keyid kept at its first position) into
  `<home>/keys.json`, and retries once. A fruitless refresh suppresses the next
  for five minutes. The cache is written temp-then-rename, degrades to "nothing
  cached" on anything malformed, and never fails a run.

## 6.4 Disabling and overriding

`JUP_INTEGRITY_KEYS` set to `""` or `0` — exactly those two values — disables
the mechanism outright: no verification, no warning, no request. Any other
non-empty value is parsed as JSON and **replaces** (never merges with) the
embedded trust store, in the shape of §02.6. Malformed JSON raises at
verification time, not at startup.

Both this and `JUP_ALLOW_UNVERIFIED` are ambient-only; an attempt from a project
env file is ignored and warned about.

## 6.5 Key expiry

`expires` is `null` or an ISO-8601 timestamp, evaluated against the system clock.
Unexpired keys are tried first. If none match, a matching **expired** key is
tried:

* a valid signature is accepted with an advisory naming the key and its expiry;
* an invalid one raises "The package was signed with an expired key (…)".

An expired key is never accepted silently.

## 6.6 Threat model

| Threat | Covered? |
|---|---|
| Registry serves modified bytes for a hash-pinned version | yes — hash check |
| Registry serves modified bytes for an unpinned version (npm) | yes — signature chain, given npm's key is not compromised |
| Compromised mirror serving unpinned versions | yes — the signature covers package, version and integrity |
| Registry that strips signatures but publishes digests | partly — tier 3, warned; `JUP_REQUIRE_SIGNATURES=1` closes it |
| Man-in-the-middle on the wire | via verified TLS |
| Hostile repo changing trust, disabling verification, or weakening TLS | yes — project env sources cannot set those |
| Hostile repo pointing a known tool at an arbitrary URL | yes — blocked without ambient `JUP_ENABLE_UNSAFE_CUSTOM_URLS=1` |
| Hostile repo exfiltrating credentials to its own registry | yes — auth is origin-scoped and project files cannot set it |
| Tar path traversal, unsafe links, special files | yes — §07.4 |
| A freshly published compromised release | partly — `JUP_MINIMUM_RELEASE_AGE` |

One known weak spot: the built-in `default` pins carry **sha1** digests, which
tier 1 accepts and which §6.2 would warn about coming from a user. Moving the
table to sha512 pins would close it.
