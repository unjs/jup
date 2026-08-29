/**
 * A self-signed certificate, generated once and committed, used by the proxy
 * tests to run a TLS origin server at the far end of a `CONNECT` tunnel.
 *
 * **This key is not a secret.** It exists so the tests can prove that a
 * tunnelled request really speaks TLS end to end — the proxy sees ciphertext,
 * and the `Authorization` header never reaches it. Node has no certificate
 * *issuing* API, so the alternative would be shelling out to `openssl` at test
 * time; a fixture keeps the suite hermetic and dependency-free.
 *
 * Generated with:
 *
 *     openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
 *       -keyout key.pem -out cert.pem -days 36500 -subj "/CN=jup test" \
 *       -addext "subjectAltName=DNS:example.com,DNS:*.example.com,DNS:*.example,DNS:example,DNS:localhost,IP:127.0.0.1" \
 *       -addext "basicConstraints=critical,CA:TRUE" \
 *       -addext "keyUsage=digitalSignature,keyEncipherment,keyCertSign"
 *
 * It is its own CA, so trusting `CERT` — via `NODE_EXTRA_CA_CERTS` for a
 * spawned process, or `tls.setDefaultCACertificates` in-process — makes
 * verification genuinely pass rather than switching it off. Valid until 2126.
 */

export const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgI2iFRfo7EW7AyPrK
plp+KyMysl3YQPjKHSSK3y4enpuhRANCAAT0kVoXcSXnKgcp7cgtmNwdr9zXjIAf
9sJFAEax9ITY0De6gf3HPBtgmFESnnFczuf8yanB1z/ZXPpnAtsJtU/N
-----END PRIVATE KEY-----`;

export const CERT = `-----BEGIN CERTIFICATE-----
MIIB3jCCAYSgAwIBAgIUJLMv5FS7lQ4plFbtKWsxQhRR9k8wCgYIKoZIzj0EAwIw
FjEUMBIGA1UEAwwLcGlwYWNrIHRlc3QwIBcNMjYwODIyMDU1ODQ4WhgPMjEyNjA3
MjkwNTU4NDhaMBYxFDASBgNVBAMMC3BpcGFjayB0ZXN0MFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAE9JFaF3El5yoHKe3ILZjcHa/c14yAH/bCRQBGsfSE2NA3uoH9
xzwbYJhREp5xXM7n/Mmpwdc/2Vz6ZwLbCbVPzaOBrTCBqjAdBgNVHQ4EFgQUFaN3
GpURPJF7pc+2vWLg/7SvdWcwHwYDVR0jBBgwFoAUFaN3GpURPJF7pc+2vWLg/7Sv
dWcwSgYDVR0RBEMwQYILZXhhbXBsZS5jb22CDSouZXhhbXBsZS5jb22CCSouZXhh
bXBsZYIHZXhhbXBsZYIJbG9jYWxob3N0hwR/AAABMA8GA1UdEwEB/wQFMAMBAf8w
CwYDVR0PBAQDAgKkMAoGCCqGSM49BAMCA0gAMEUCIQDN/1gheHakGUXWlrW371be
WnbTovMY0YvP5uYFZyhwzwIgI4c4uqzbXDrgtvp1pWEDCAadCkMsAxhitULl85cC
Ars=
-----END CERTIFICATE-----`;

/* -------------------------------------------------------------------------- */
/* Certificates outside their validity window — §05.1                         */
/* -------------------------------------------------------------------------- */

/**
 * Two more self-signed CAs, identical to the pair above in every respect except
 * their validity window: one that stopped being valid in 2021, one that starts
 * being valid in 2100.
 *
 * They exist because §05.1's validity sentence is the one branch that cannot be
 * reached with `CERT`: it is good until 2126, so no amount of arranging makes a
 * real socket present it as expired. Faking the runtime's error code proves
 * only that the mapping table is wired up — it cannot prove that the code Node
 * actually raises for this is one of the two the table knows. Serving these is
 * what closes that gap, and it is why both halves of the window are here rather
 * than just the expired one: `CERT_HAS_EXPIRED` and `CERT_NOT_YET_VALID` are
 * separate codes, and a mapping is only checked for the codes it is given.
 *
 * **These keys are not secrets either**, for the same reason. Each is its own
 * CA, so trusting it — which is what the row does, via `JUP_CAFILE` — makes the
 * *chain* verify and leaves the date as the only thing wrong. That is the point:
 * an untrusted expired certificate fails as untrusted, and would say so.
 *
 * Generated with the command above, plus `-not_before` / `-not_after`:
 *
 *     -not_before 20200101000000Z -not_after 20210101000000Z   # EXPIRED_*
 *     -not_before 21000101000000Z -not_after 21010101000000Z   # NOT_YET_VALID_*
 */
export const EXPIRED_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgEb+IL0jdk58Vnj6U
g+bVmK5TtYq3m1B2wlCi6H1TMO+hRANCAATpvNVUy5pcMlpnXRm11vN2U1B242ys
oOJweLg/rs5yQtsbdWzWEF70kqot5VyN6vkWlDjIYf1tnLz4Y+dgasR1
-----END PRIVATE KEY-----`;

export const EXPIRED_CERT = `-----BEGIN CERTIFICATE-----
MIIB5jCCAYygAwIBAgIUR+jdGXEaXk2ROtvSe8IdNXR7/fMwCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQanVwIHRlc3QgZXhwaXJlZDAeFw0yMDAxMDEwMDAwMDBaFw0y
MTAxMDEwMDAwMDBaMBsxGTAXBgNVBAMMEGp1cCB0ZXN0IGV4cGlyZWQwWTATBgcq
hkjOPQIBBggqhkjOPQMBBwNCAATpvNVUy5pcMlpnXRm11vN2U1B242ysoOJweLg/
rs5yQtsbdWzWEF70kqot5VyN6vkWlDjIYf1tnLz4Y+dgasR1o4GtMIGqMB0GA1Ud
DgQWBBTRcMpkggfqmsFRMubyh8StTa5boTAfBgNVHSMEGDAWgBTRcMpkggfqmsFR
Mubyh8StTa5boTBKBgNVHREEQzBBggtleGFtcGxlLmNvbYINKi5leGFtcGxlLmNv
bYIJKi5leGFtcGxlggdleGFtcGxlgglsb2NhbGhvc3SHBH8AAAEwDwYDVR0TAQH/
BAUwAwEB/zALBgNVHQ8EBAMCAqQwCgYIKoZIzj0EAwIDSAAwRQIgdRNvWCth9tMr
DYgj/v95xhaT0DBOPUNLTwy8jeGczDICIQCEqusv5VYmEv8zDrQMq/4JaWZXwezs
j6f+uufX53C8sA==
-----END CERTIFICATE-----`;

export const NOT_YET_VALID_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg3H0rfBE9TT8aeLVW
B6maieZnH3nZ4nY/2uhmRO6p9JGhRANCAATXaYBnOcA3M0x2HSfRvPVwK9mwpRr6
wervPp3GD5wWmuyelqpvRnVYRuiz6GLmhlTJiY8hotSSYFRjkOFIqLIa
-----END PRIVATE KEY-----`;

export const NOT_YET_VALID_CERT = `-----BEGIN CERTIFICATE-----
MIIB9jCCAZygAwIBAgIUXG4VExtdobyV1LrGIPHdDUekMQgwCgYIKoZIzj0EAwIw
ITEfMB0GA1UEAwwWanVwIHRlc3Qgbm90IHlldCB2YWxpZDAiGA8yMTAwMDEwMTAw
MDAwMFoYDzIxMDEwMTAxMDAwMDAwWjAhMR8wHQYDVQQDDBZqdXAgdGVzdCBub3Qg
eWV0IHZhbGlkMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE12mAZznANzNMdh0n
0bz1cCvZsKUa+sHq7z6dxg+cFprsnpaqb0Z1WEbos+hi5oZUyYmPIaLUkmBUY5Dh
SKiyGqOBrTCBqjAdBgNVHQ4EFgQUZG+MTkbjoc+SaUggqVGrQF+zYAwwHwYDVR0j
BBgwFoAUZG+MTkbjoc+SaUggqVGrQF+zYAwwSgYDVR0RBEMwQYILZXhhbXBsZS5j
b22CDSouZXhhbXBsZS5jb22CCSouZXhhbXBsZYIHZXhhbXBsZYIJbG9jYWxob3N0
hwR/AAABMA8GA1UdEwEB/wQFMAMBAf8wCwYDVR0PBAQDAgKkMAoGCCqGSM49BAMC
A0gAMEUCIQCtd0YFT/EXqpKBCYZ6qdCNppWKyARLWjB62J1nRuBmUwIgDFptfl6K
vRhXi1E7jHqGZ42eagm6LRF/Gym7hMb/BYU=
-----END CERTIFICATE-----`;
