/**
 * TLS configuration and diagnostics — §15.4.
 *
 * Corepack has no TLS surface at all. A machine behind a TLS-inspecting proxy
 * therefore gets `Error when performing the request to <url>` and nothing else,
 * which is the whole of #332: the actual cause is a certificate signed by a CA
 * the trust store has never heard of, and the remedy is a runtime environment
 * variable corepack never mentions. This module is the two halves of the fix —
 * a place to put the CA, and a sentence that says which of the three TLS
 * failures happened.
 *
 * **Nothing here costs anything unless it is configured.** {@link tlsSettings}
 * is pure environment parsing, `node:tls` is reached through
 * `process.getBuiltinModule` and only when a bundle is actually being applied,
 * and the PEM file is read at most once per process. The no-configuration path
 * never leaves native `fetch` (§05.1) — which is why the CA is installed with
 * `tls.setDefaultCACertificates` rather than by routing requests through a
 * hand-rolled client: `fetch` honours the process trust store, so a custom CA
 * costs one file read and no change of transport at all.
 *
 * Disabling verification is the exception: no `fetch` option can express it, so
 * that one case is dispatched through `proxy.ts`'s `node:https` transport
 * (§14.8's dispatcher, which had to exist anyway).
 */

import { readFileSync } from "node:fs";
import { corepackSpelling, ENV, envEntry, readEnv } from "../config/env-vars.ts";
import { advisory, messages } from "../errors.ts";
import { type NpmrcOrigin, npmrcTlsSettings } from "./npmrc.ts";

/** What the environment (and, later, `.npmrc`) says about TLS. */
export interface TlsSettings {
  /** Path to a PEM bundle that **replaces** the platform trust store. */
  cafile?: string;
  /** Where {@link cafile} came from, for diagnostics. */
  cafileSource?: string;
  /**
   * §15.1's `ca` — the certificates inline rather than by path. Same tier as
   * {@link cafile} and the same semantics: it **replaces** the platform store.
   */
  ca?: string[];
  /** Where {@link ca} came from, for diagnostics. */
  caSource?: string;
  /** `false` disables certificate verification entirely. */
  verify: boolean;
  /** Where the decision to disable verification came from; names the source in the warning. */
  verifySource?: string;
}

/**
 * §15.4's precedence: `COREPACK_CAFILE`, then `.npmrc`'s `cafile`/`ca`, then the
 * platform trust store.
 *
 * The `.npmrc` middle tier is §15.1's, and it is read from the **user and
 * global files only** — a project-level `.npmrc` is attacker-controlled in a
 * cloned repository, and `cafile` / `ca` / `strict-ssl` are exactly the keys
 * §15.1 forbids it from supplying. `npmrc.ts` enforces that at parse time, so a
 * project file's value never reaches this function at all.
 *
 * `ca` (inline PEM) and `cafile` (a path) are the same tier; `cafile` wins when
 * a file sets both, matching npm.
 */
export function tlsSettings(): TlsSettings {
  const settings: TlsSettings = { verify: true };

  const cafile = envEntry(ENV.CAFILE);
  if (cafile !== undefined && cafile.value !== "") {
    settings.cafile = cafile.value;
    settings.cafileSource = cafile.name;
  } else {
    const npmrc = npmrcTlsSettings();
    if (npmrc.cafile !== undefined) {
      settings.cafile = npmrc.cafile.value;
      settings.cafileSource = describe(npmrc.cafile.origin);
    } else if (npmrc.ca !== undefined) {
      settings.ca = npmrc.ca.value;
      settings.caSource = describe(npmrc.ca.origin);
    }
  }

  // §11's value table spells every flag as an exact string, and this one is no
  // different: only `0` disables verification. A typo must fail closed.
  const strictSsl = envEntry(ENV.STRICT_SSL);
  if (strictSsl?.value === "0") {
    settings.verify = false;
    settings.verifySource = strictSsl.name;
  } else if (strictSsl === undefined) {
    // §15.4 — "`strict-ssl=false` MUST be honoured only from the user/global
    // files, and MUST print a warning naming the file it came from".
    const npmrc = npmrcTlsSettings();
    if (npmrc.strictSsl?.value === false) {
      settings.verify = false;
      settings.verifySource = describe(npmrc.strictSsl.origin);
    }
  }

  return settings;
}

/** `strict-ssl (/home/u/.npmrc)` — the setting *and* the file, as §15.4 asks. */
function describe(origin: NpmrcOrigin): string {
  return `${origin.key} (${origin.path})`;
}

/**
 * `true` when anything at all says something about TLS.
 *
 * The hot question, asked once per request: `false` means the request stays on
 * native `fetch` with the platform trust store, having loaded no `node:tls` and
 * read no PEM. The `.npmrc` read behind it is memoised per working directory, so
 * this stays one map lookup after the first request.
 */
export function tlsConfigured(): boolean {
  if (readEnv(ENV.STRICT_SSL) === "0") return true;
  if ((readEnv(ENV.CAFILE) ?? "") !== "") return true;
  const npmrc = npmrcTlsSettings();
  return npmrc.cafile !== undefined || npmrc.ca !== undefined || npmrc.strictSsl?.value === false;
}

/* -------------------------------------------------------------------------- */
/* Applying the configuration                                                 */
/* -------------------------------------------------------------------------- */

/** Memoised per bundle path: a PEM file is read at most once per process. */
const bundles = new Map<string, string[]>();

/** Whether the warning has been printed, and for which source. */
const warned = new Set<string>();

/** The bundle currently installed into the process trust store, if any. */
let installed: string | undefined;

/**
 * Read a PEM bundle into its individual certificates.
 *
 * A bundle is a concatenation, and both `tls.setDefaultCACertificates` and the
 * `ca` request option want the certificates separated, so the armour is the
 * delimiter. Anything outside it — the human-readable subject dumps `openssl`
 * likes to interleave — is ignored, exactly as OpenSSL ignores it.
 */
export function readCaBundle(path: string, source: string = ENV.CAFILE): string[] {
  const cached = bundles.get(path);
  if (cached !== undefined) return cached;

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(unreadable(path, source), { cause: error });
  }

  const certificates = certificatesIn(content);

  if (certificates.length === 0) {
    throw new Error(messages.cafileEmpty(path));
  }

  bundles.set(path, certificates);
  return certificates;
}

/**
 * §12's table words this failure as `(set by COREPACK_CAFILE)`, which is exactly
 * right when the environment set it and a lie when `.npmrc`'s `cafile` did. The
 * normative string is kept for the normative case; the other names the file.
 */
function unreadable(path: string, source: string): string {
  return corepackSpelling(source) === ENV.CAFILE
    ? messages.cafileUnreadable(path)
    : `Unable to read the TLS certificate bundle at ${path} (set by ${source})`;
}

/**
 * The PEM blocks inside a bundle.
 *
 * A bundle is a concatenation, and both `tls.setDefaultCACertificates` and the
 * `ca` request option want the certificates separated, so the armour is the
 * delimiter. Anything outside it — the human-readable subject dumps `openssl`
 * likes to interleave — is ignored, exactly as OpenSSL ignores it.
 */
function certificatesIn(content: string): string[] {
  return [...content.matchAll(/-----BEGIN CERTIFICATE-----[\S\s]*?-----END CERTIFICATE-----/g)].map(
    (match) => match[0],
  );
}

/** §15.1's `ca`: the certificates are already in hand, so only the armour matters. */
export function inlineCertificates(values: string[], source: string): string[] {
  const certificates = values.flatMap((value) => certificatesIn(value));
  if (certificates.length === 0) {
    throw new Error(`The TLS certificates supplied by ${source} contain no PEM certificate`);
  }
  return certificates;
}

/**
 * Install the configured trust store and announce a disabled one. Idempotent.
 *
 * Called before the first request goes out, never during module load: a run that
 * never reaches the network reads no PEM file and prints nothing.
 */
export function applyTlsConfiguration(settings: TlsSettings = tlsSettings()): void {
  const certificates = trustStoreFor(settings);
  const key = settings.cafile ?? settings.caSource;
  if (certificates !== undefined && key !== undefined && installed !== key) {
    // Replaces rather than extends: §15.4 states a *precedence* order ending at
    // the platform store, and npm's own `cafile`/`ca` — the §15.1 tier feeding
    // this same seam — replace the default set too, as does `COREPACK_CAFILE`.
    // A TLS-inspecting proxy re-signs everything with the CA being configured
    // here, so replacement is also the shape that actually works behind one.
    process.getBuiltinModule("node:tls").setDefaultCACertificates(certificates);
    installed = key;
  }

  // §15.4, verbatim. Once per source per process: it is a standing property of
  // the run, not a property of any one request.
  if (!settings.verify) {
    const source = settings.verifySource ?? "the environment";
    if (!warned.has(source)) {
      warned.add(source);
      advisory(messages.strictSslDisabled(source));
    }
  }
}

/**
 * TLS options for a `node:tls` / `node:https` connection, or `undefined` when
 * the defaults are correct.
 *
 * Used by the `node:https` transport and by the certificate check *inside* a
 * `CONNECT` tunnel — a corporate proxy is precisely where both a custom CA and
 * a tunnel are in play at once.
 */
export function tlsConnectOptions(): { ca?: string[]; rejectUnauthorized?: boolean } | undefined {
  const settings = tlsSettings();
  const certificates = trustStoreFor(settings);
  if (settings.verify && certificates === undefined) return undefined;

  const options: { ca?: string[]; rejectUnauthorized?: boolean } = {};
  // Passing `ca` explicitly as well as setting the process default costs
  // nothing and keeps this path correct on a runtime whose
  // `setDefaultCACertificates` we could not use.
  if (certificates !== undefined) options.ca = certificates;
  if (!settings.verify) options.rejectUnauthorized = false;
  return options;
}

/** The configured trust store, from either spelling, or `undefined` for the platform's. */
function trustStoreFor(settings: TlsSettings): string[] | undefined {
  if (settings.cafile !== undefined) {
    return readCaBundle(settings.cafile, settings.cafileSource ?? ENV.CAFILE);
  }
  if (settings.ca !== undefined) {
    return inlineCertificates(settings.ca, settings.caSource ?? ".npmrc ca");
  }
  return undefined;
}

/**
 * Whether a request must leave native `fetch` for the `node:https` transport.
 *
 * Only one setting forces it: `fetch` has no way to express "do not verify".
 * A custom CA does *not* force it — that is installed process-wide instead.
 */
export function tlsTransportRequired(): boolean {
  const strictSsl = readEnv(ENV.STRICT_SSL);
  if (strictSsl === "0") return true;
  if (strictSsl !== undefined) return false;
  return npmrcTlsSettings().strictSsl?.value === false;
}

/* -------------------------------------------------------------------------- */
/* Diagnostics                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The certificate-verification failures worth a sentence of their own.
 *
 * These are `error.code` values, not message text: the messages are OpenSSL's
 * and change between versions, while the codes are the contract Node documents.
 * Both the historical and the OpenSSL 3 spellings are listed, because Node
 * passes the verify-error short name straight through and it was renamed.
 */
const UNKNOWN_AUTHORITY = new Set([
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "SELF_SIGNED_CERTIFICATE",
  "SELF_SIGNED_CERTIFICATE_IN_CHAIN",
  "CERT_UNTRUSTED",
  "UNABLE_TO_GET_CRL",
]);

const BAD_VALIDITY = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CRL_HAS_EXPIRED",
  "CRL_NOT_YET_VALID",
]);

const HOSTNAME_MISMATCH = new Set(["ERR_TLS_CERT_ALTNAME_INVALID", "ERR_TLS_INVALID_ALTNAME"]);

/** Every `code` on an error and everything it wraps, outermost first. */
function codesOf(error: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === null || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);

    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);

    // `fetch` wraps: a certificate failure arrives as `TypeError: fetch failed`
    // whose `cause` is the real error — and sometimes as an `AggregateError`
    // over one attempt per resolved address.
    queue.push((current as { cause?: unknown }).cause);
    const aggregated = (current as { errors?: unknown }).errors;
    if (Array.isArray(aggregated)) queue.push(...aggregated);
  }

  return codes;
}

/**
 * §15.4 — the sentence for a TLS failure, or `undefined` when this is not one.
 *
 * @param host The authority whose certificate was rejected: the target's,
 * normally, but the *proxy's* when the failure happened while connecting to an
 * `https://` proxy.
 */
export function classifyTlsFailure(error: unknown, host: string): string | undefined {
  for (const code of codesOf(error)) {
    if (UNKNOWN_AUTHORITY.has(code)) return messages.tlsUnknownAuthority(host);
    if (BAD_VALIDITY.has(code)) return messages.tlsBadValidity(host);
    if (HOSTNAME_MISMATCH.has(code)) return messages.tlsHostnameMismatch(host);
  }
  return undefined;
}

/** `true` for a failure that retrying cannot fix — a certificate is not a hiccup. */
export function isTlsFailure(error: unknown): boolean {
  return codesOf(error).some(
    (code) =>
      UNKNOWN_AUTHORITY.has(code) ||
      BAD_VALIDITY.has(code) ||
      HOSTNAME_MISMATCH.has(code) ||
      code.startsWith("ERR_TLS_") ||
      code.startsWith("ERR_SSL_"),
  );
}
