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
 *       -keyout key.pem -out cert.pem -days 36500 -subj "/CN=pipack test" \
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
