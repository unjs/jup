/**
 * TLS configuration and diagnostics — §15.4, conformance row 153.
 *
 * Everything here runs against a **real** TLS server holding
 * `test/_fixtures/tls.ts`, which is its own CA and is trusted by nothing until a
 * test says so. That is the only way to tell the three failures apart: an
 * untrusted issuer, a certificate that is not valid for the name asked for, and
 * a check that was switched off — each of which corepack reports as the same
 * `Error when performing the request to <url>` (#332).
 *
 * The process trust store is global, so every test that touches it restores what
 * it found, and every test that installs a bundle writes it to a **fresh** path
 * (the module memoises by path, exactly as a real run wants).
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer, type Server } from "node:https";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messages } from "../../src/errors.ts";
import { httpGet, httpGetJson } from "../../src/http.ts";
import { resetNpmrcCache } from "../../src/npmrc.ts";
import {
  applyTlsConfiguration,
  classifyTlsFailure,
  isTlsFailure,
  readCaBundle,
  tlsConfigured,
  tlsConnectOptions,
  tlsSettings,
  tlsTransportRequired,
} from "../../src/tls.ts";
import { CERT, KEY } from "../_fixtures/tls.ts";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const closers: Array<() => Promise<void>> = [];

interface Origin {
  port: number;
  /** How many TCP connections the server accepted — a retry would show up here. */
  connections: number;
}

/**
 * A TLS origin on `0.0.0.0`, so the same server can be reached as `127.0.0.1`
 * (which the certificate names) and as `127.0.0.2` (which it does not).
 */
async function startTlsOrigin(): Promise<Origin> {
  const server: Server = createHttpsServer({ key: KEY, cert: CERT }, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(`{"ok":true}`);
  });
  return await listen(server);
}

async function startPlainOrigin(): Promise<Origin> {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(`{"ok":true}`);
  });
  return await listen(server);
}

async function listen(server: Server | ReturnType<typeof createHttpServer>): Promise<Origin> {
  const sockets = new Set<Socket>();
  const origin: Origin = { port: 0, connections: 0 };

  server.on("connection", (socket: Socket) => {
    origin.connections += 1;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  // A TLS handshake that fails is not an error the *test* should crash on.
  server.on("tlsClientError", () => {});

  await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
  origin.port = (server.address() as AddressInfo).port;

  closers.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  );
  return origin;
}

/** A PEM bundle at a path nothing has seen before, so the memo cannot mask a bug. */
function bundleFile(...certificates: string[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "pipack-ca-")), "bundle.pem");
  writeFileSync(path, `${certificates.join("\n")}\n`);
  return path;
}

const ENV_KEYS = [
  "COREPACK_CAFILE",
  "COREPACK_STRICT_SSL",
  "COREPACK_NETWORK_RETRIES",
  "COREPACK_NETWORK_TIMEOUT",
  "COREPACK_ENABLE_NETWORK",
  "HTTP_PROXY",
  "http_proxy",
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
] as const;

let saved: Record<string, string | undefined>;
let defaultCertificates: string[];
let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  resetNpmrcCache();
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  defaultCertificates = getCACertificates("default");
  realFetch = globalThis.fetch;
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setDefaultCACertificates(defaultCertificates);
  globalThis.fetch = realFetch;
  // `vi.spyOn` on an already-spied method hands back the *same* mock, history
  // and all, so a stale spy would otherwise carry another test's warning in.
  vi.restoreAllMocks();
  await Promise.all(closers.splice(0).map((close) => close()));
});

/* ------------------------------------------------------------------ *
 * Settings
 * ------------------------------------------------------------------ */

describe("tlsSettings (§15.4)", () => {
  it("verifies with the platform trust store when nothing is configured", () => {
    expect(tlsSettings()).toEqual({ verify: true });
    expect(tlsConfigured()).toBe(false);
    expect(tlsTransportRequired()).toBe(false);
    expect(tlsConnectOptions()).toBeUndefined();
  });

  it("takes the bundle from COREPACK_CAFILE and names the source", () => {
    process.env.COREPACK_CAFILE = "/etc/corp.pem";

    expect(tlsSettings()).toEqual({
      cafile: "/etc/corp.pem",
      cafileSource: "COREPACK_CAFILE",
      verify: true,
    });
    expect(tlsConfigured()).toBe(true);
    // A custom CA does not change transport: `fetch` reads the process store.
    expect(tlsTransportRequired()).toBe(false);
  });

  it("treats an empty COREPACK_CAFILE as unset", () => {
    process.env.COREPACK_CAFILE = "";

    expect(tlsSettings().cafile).toBeUndefined();
    expect(tlsConfigured()).toBe(false);
  });

  it('disables verification only for the exact string "0"', () => {
    for (const value of ["1", "true", "false", "", "00"]) {
      process.env.COREPACK_STRICT_SSL = value;
      expect(tlsSettings().verify).toBe(true);
      expect(tlsTransportRequired()).toBe(false);
    }

    process.env.COREPACK_STRICT_SSL = "0";
    expect(tlsSettings()).toEqual({ verify: false, verifySource: "COREPACK_STRICT_SSL" });
    expect(tlsTransportRequired()).toBe(true);
    expect(tlsConnectOptions()).toEqual({ rejectUnauthorized: false });
  });
});

/* ------------------------------------------------------------------ *
 * The bundle
 * ------------------------------------------------------------------ */

describe("readCaBundle", () => {
  it("splits a concatenated bundle and ignores what surrounds the armour", () => {
    const path = bundleFile(
      "subject=/CN=first\nissuer=/CN=first",
      CERT,
      "Bag Attributes: nonsense",
      CERT,
    );

    const certificates = readCaBundle(path);

    expect(certificates).toHaveLength(2);
    expect(certificates[0]).toBe(CERT);
    expect(certificates[0]).not.toContain("subject=");
  });

  it("reports an unreadable bundle by path", () => {
    const path = join(tmpdir(), "pipack-nonexistent-ca.pem");

    expect(() => readCaBundle(path)).toThrow(messages.cafileUnreadable(path));
    expect(() => readCaBundle(path)).toThrow(
      `Unable to read the TLS certificate bundle at ${path} (set by COREPACK_CAFILE)`,
    );
  });

  it("reports a bundle with no certificate in it", () => {
    const path = bundleFile("-----BEGIN RSA PRIVATE KEY-----\nnope\n-----END RSA PRIVATE KEY-----");

    expect(() => readCaBundle(path)).toThrow(messages.cafileEmpty(path));
  });
});

/* ------------------------------------------------------------------ *
 * Classification — the codes, not the message text
 * ------------------------------------------------------------------ */

/** An error carrying an OpenSSL/Node verify code, the way the runtime raises it. */
function coded(code: string, message = "boom"): Error {
  return Object.assign(new Error(message), { code });
}

describe("classifyTlsFailure (§15.4)", () => {
  it.for([
    ["UNABLE_TO_GET_ISSUER_CERT"],
    ["UNABLE_TO_GET_ISSUER_CERT_LOCALLY"],
    ["UNABLE_TO_VERIFY_LEAF_SIGNATURE"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT"],
    ["SELF_SIGNED_CERT_IN_CHAIN"],
    ["SELF_SIGNED_CERTIFICATE"],
    ["SELF_SIGNED_CERTIFICATE_IN_CHAIN"],
    ["CERT_UNTRUSTED"],
  ])("maps %s to the unknown-authority sentence", ([code]) => {
    expect(classifyTlsFailure(coded(code!), "npm.corp")).toBe(
      messages.tlsUnknownAuthority("npm.corp"),
    );
  });

  it.for([["CERT_HAS_EXPIRED"], ["CERT_NOT_YET_VALID"]])(
    "maps %s to the validity sentence",
    ([code]) => {
      expect(classifyTlsFailure(coded(code!), "npm.corp")).toBe(
        messages.tlsBadValidity("npm.corp"),
      );
    },
  );

  it("maps ERR_TLS_CERT_ALTNAME_INVALID to the hostname sentence", () => {
    expect(classifyTlsFailure(coded("ERR_TLS_CERT_ALTNAME_INVALID"), "npm.corp")).toBe(
      messages.tlsHostnameMismatch("npm.corp"),
    );
  });

  it("says the three sentences byte for byte", () => {
    expect(messages.tlsUnknownAuthority("npm.corp")).toBe(
      "TLS certificate verification failed for npm.corp: the certificate was issued by an unknown authority. If your network uses a TLS-inspecting proxy, point COREPACK_CAFILE at its CA bundle.",
    );
    expect(messages.tlsBadValidity("npm.corp")).toBe(
      "TLS certificate for npm.corp is expired or not yet valid (check the system clock).",
    );
    expect(messages.tlsHostnameMismatch("npm.corp")).toBe(
      "TLS certificate for npm.corp does not match that hostname.",
    );
  });

  it("walks the whole cause chain, because fetch wraps", () => {
    const wrapped = new TypeError("fetch failed", {
      cause: new Error("outer", { cause: coded("CERT_HAS_EXPIRED") }),
    });

    expect(classifyTlsFailure(wrapped, "npm.corp")).toBe(messages.tlsBadValidity("npm.corp"));
  });

  it("looks inside an AggregateError, which is how a multi-address attempt fails", () => {
    const aggregate = new AggregateError(
      [coded("ECONNREFUSED"), coded("UNABLE_TO_VERIFY_LEAF_SIGNATURE")],
      "all attempts failed",
    );

    expect(
      classifyTlsFailure(new TypeError("fetch failed", { cause: aggregate }), "npm.corp"),
    ).toBe(messages.tlsUnknownAuthority("npm.corp"));
  });

  it("survives a cyclic cause chain", () => {
    const first = new Error("first");
    const second = new Error("second", { cause: first });
    (first as { cause?: unknown }).cause = second;

    expect(classifyTlsFailure(first, "npm.corp")).toBeUndefined();
  });

  it("leaves a non-TLS failure alone", () => {
    expect(classifyTlsFailure(coded("ECONNREFUSED"), "npm.corp")).toBeUndefined();
    expect(classifyTlsFailure(coded("ENOTFOUND"), "npm.corp")).toBeUndefined();
    expect(classifyTlsFailure(new Error("plain"), "npm.corp")).toBeUndefined();
    expect(classifyTlsFailure(undefined, "npm.corp")).toBeUndefined();
  });
});

describe("isTlsFailure", () => {
  it("covers the classified codes and the wider ERR_TLS_/ERR_SSL_ families", () => {
    expect(isTlsFailure(coded("CERT_HAS_EXPIRED"))).toBe(true);
    expect(isTlsFailure(coded("ERR_TLS_HANDSHAKE_TIMEOUT"))).toBe(true);
    expect(isTlsFailure(coded("ERR_SSL_WRONG_VERSION_NUMBER"))).toBe(true);
    expect(isTlsFailure(coded("ECONNRESET"))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * End to end, against a real certificate
 * ------------------------------------------------------------------ */

describe("an untrusted certificate authority (row 153)", () => {
  it("names the host, the cause, and COREPACK_CAFILE", async () => {
    const origin = await startTlsOrigin();

    const error = await httpGet(`https://127.0.0.1:${origin.port}/pkg`).catch(
      (error_: Error) => error_,
    );

    // Not `Error when performing the request to …`: §15.4 forbids surfacing a
    // bare transport error for exactly this case.
    expect((error as Error).message).toBe(messages.tlsUnknownAuthority(`127.0.0.1:${origin.port}`));
    expect((error as Error).message).toContain("COREPACK_CAFILE");
    expect((error as Error).message).not.toContain("performing the request");
    // §15.5 — the underlying reason survives, on the chain and in the stack.
    expect((error as Error).cause).toBeDefined();
    expect((error as Error).stack).toContain("Caused by:");
  });

  it("is not retried — a certificate is not a hiccup", async () => {
    const origin = await startTlsOrigin();
    process.env.COREPACK_NETWORK_RETRIES = "5";

    await expect(httpGet(`https://127.0.0.1:${origin.port}/pkg`)).rejects.toThrow(
      messages.tlsUnknownAuthority(`127.0.0.1:${origin.port}`),
    );

    expect(origin.connections).toBe(1);
  });

  it("succeeds once COREPACK_CAFILE names the issuer", async () => {
    const origin = await startTlsOrigin();
    process.env.COREPACK_CAFILE = bundleFile(CERT);

    await expect(httpGetJson(`https://127.0.0.1:${origin.port}/pkg`)).resolves.toEqual({
      ok: true,
    });
  });

  it("reports a COREPACK_CAFILE that does not exist", async () => {
    const origin = await startTlsOrigin();
    const path = join(tmpdir(), "pipack-missing-bundle.pem");
    process.env.COREPACK_CAFILE = path;

    await expect(httpGet(`https://127.0.0.1:${origin.port}/pkg`)).rejects.toThrow(
      messages.cafileUnreadable(path),
    );
    // Nothing was sent: the bundle is applied before a socket is opened.
    expect(origin.connections).toBe(0);
  });
});

describe("a certificate for another name", () => {
  it("says so, rather than blaming the authority", async () => {
    const origin = await startTlsOrigin();
    // The issuer is trusted, so the only thing left to fail is the name: the
    // fixture's SAN list has `IP:127.0.0.1` and not `127.0.0.2`.
    process.env.COREPACK_CAFILE = bundleFile(CERT);

    const error = await httpGet(`https://127.0.0.2:${origin.port}/pkg`).catch(
      (error_: Error) => error_,
    );

    expect((error as Error).message).toBe(messages.tlsHostnameMismatch(`127.0.0.2:${origin.port}`));
  });
});

describe("COREPACK_STRICT_SSL=0", () => {
  it("connects anyway, and says so once, verbatim", async () => {
    const origin = await startTlsOrigin();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.COREPACK_STRICT_SSL = "0";

    await expect(httpGetJson(`https://127.0.0.1:${origin.port}/pkg`)).resolves.toEqual({
      ok: true,
    });
    await expect(httpGetJson(`https://127.0.0.1:${origin.port}/pkg`)).resolves.toEqual({
      ok: true,
    });

    expect(warn).toHaveBeenCalledWith(
      "! TLS certificate verification is disabled (set by COREPACK_STRICT_SSL)",
    );
    expect(warn).toHaveBeenCalledWith(messages.strictSslDisabled("COREPACK_STRICT_SSL"));
    // A standing property of the run, announced once — not once per request.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("streams the body, so the download pipeline still tees it", async () => {
    const origin = await startTlsOrigin();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.COREPACK_STRICT_SSL = "0";

    const response = await httpGet(`https://127.0.0.1:${origin.port}/pkg`);

    expect(response.body).toBeInstanceOf(ReadableStream);
    expect(await response.json()).toEqual({ ok: true });
  });
});

/* ------------------------------------------------------------------ *
 * The no-configuration path must not move
 * ------------------------------------------------------------------ */

describe("transport selection", () => {
  /** Count `fetch` calls without changing what it does. */
  function countFetches(): { calls: number } {
    const counter = { calls: 0 };
    const real = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      counter.calls += 1;
      return real(input, init);
    }) as typeof fetch;
    return counter;
  }

  it("stays on native fetch when nothing is configured", async () => {
    const origin = await startPlainOrigin();
    const counter = countFetches();

    await httpGetJson(`http://127.0.0.1:${origin.port}/pkg`);

    expect(counter.calls).toBe(1);
  });

  it("stays on native fetch for a custom CA — the store is process-wide", async () => {
    const origin = await startTlsOrigin();
    process.env.COREPACK_CAFILE = bundleFile(CERT);
    const counter = countFetches();

    await httpGetJson(`https://127.0.0.1:${origin.port}/pkg`);

    expect(counter.calls).toBe(1);
  });

  it("leaves fetch behind only when verification is disabled", async () => {
    const origin = await startTlsOrigin();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.COREPACK_STRICT_SSL = "0";
    const counter = countFetches();

    await httpGetJson(`https://127.0.0.1:${origin.port}/pkg`);

    // `fetch` cannot express "do not verify", so this one request — and only
    // this one — goes out through the `node:https` dispatcher.
    expect(counter.calls).toBe(0);
  });
});

describe("applyTlsConfiguration", () => {
  it("installs the bundle into the process trust store", () => {
    const path = bundleFile(CERT);

    applyTlsConfiguration({ cafile: path, cafileSource: "COREPACK_CAFILE", verify: true });

    // Replacement, not extension: §15.4 states a precedence order ending at the
    // platform store, and npm's `cafile` replaces the default set too.
    // `getCACertificates` normalises the PEM with a trailing newline.
    expect(getCACertificates("default").map((pem) => pem.trim())).toEqual([CERT]);
  });

  it("does nothing at all when nothing is configured", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    applyTlsConfiguration({ verify: true });

    expect(getCACertificates("default")).toEqual(defaultCertificates);
    expect(warn).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ *
 * §01.3 / §16.3 — the warm path must not reach TLS
 *
 * `main.test.ts` owns the module-graph budget, but its
 * `COLD_PATH_MODULES` list names modules explicitly, so a *new* cold
 * module is invisible to it until someone remembers to add it. This is
 * the cheap standing guard for this one: nothing on the warm chain may
 * name `tls.ts` or `node:tls` at all.
 * ------------------------------------------------------------------ */

describe("the warm path never reaches TLS (§16.3)", () => {
  const WARM = ["main.ts", "bin.ts", "shim.ts", "index.ts", "resolve.ts", "store.ts", "exec.ts"];

  it.for(WARM.map((name) => [name]))("src/%s names neither tls.ts nor node:tls", ([name]) => {
    const source = readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8");

    expect(source).not.toContain('"./tls.ts"');
    expect(source).not.toContain("node:tls");
  });

  it("only http.ts and proxy.ts import it, and both are cold-path already", () => {
    const importers = WARM.concat(["http.ts", "proxy.ts", "install.ts", "registry.ts"]).filter(
      (name) =>
        readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8").includes('"./tls.ts"'),
    );

    expect(importers.sort()).toEqual(["http.ts", "proxy.ts"]);
  });
});

/* ------------------------------------------------------------------ *
 * §15.1's middle tier — `cafile` / `ca` / `strict-ssl` from `.npmrc`
 * ------------------------------------------------------------------ */

describe("tlsSettings — the .npmrc tier (§15.1, §15.4)", () => {
  const roots: string[] = [];
  let home: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    const root = mkdtempSync(join(tmpdir(), "pipack-tls-npmrc-"));
    roots.push(root);
    home = join(root, "home");
    mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    process.env.PREFIX = join(root, "prefix");
    resetNpmrcCache();
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    delete process.env.PREFIX;
    resetNpmrcCache();
    while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
  });

  function userNpmrc(content: string): void {
    writeFileSync(join(home, ".npmrc"), content);
    resetNpmrcCache();
  }

  it("reads `cafile`, naming the file it came from", () => {
    userNpmrc("cafile=/etc/ssl/corp.pem\n");

    const settings = tlsSettings();
    expect(settings.cafile).toBe("/etc/ssl/corp.pem");
    expect(settings.cafileSource).toBe(`cafile (${join(home, ".npmrc")})`);
    expect(tlsConfigured()).toBe(true);
  });

  it("lets COREPACK_CAFILE outrank it (§15.4's precedence)", () => {
    userNpmrc("cafile=/etc/ssl/corp.pem\n");
    process.env.COREPACK_CAFILE = "/etc/ssl/env.pem";

    expect(tlsSettings()).toMatchObject({
      cafile: "/etc/ssl/env.pem",
      cafileSource: "COREPACK_CAFILE",
    });
  });

  it("reads inline `ca` when no `cafile` is set", () => {
    userNpmrc(String.raw`ca="${CERT.replace(/\n/g, String.raw`\n`)}"` + "\n");

    const settings = tlsSettings();
    expect(settings.cafile).toBeUndefined();
    expect(settings.ca).toEqual([CERT.trim()]);
    expect(tlsConnectOptions()?.ca).toEqual([CERT.trim()]);
  });

  it("honours `strict-ssl=false` and names the file in the warning", () => {
    userNpmrc("strict-ssl=false\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const settings = tlsSettings();
    expect(settings.verify).toBe(false);
    expect(settings.verifySource).toBe(`strict-ssl (${join(home, ".npmrc")})`);
    // §15.4's verbatim sentence, naming the source rather than the setting.
    applyTlsConfiguration(settings);
    expect(warn).toHaveBeenCalledWith(
      messages.strictSslDisabled(`strict-ssl (${join(home, ".npmrc")})`),
    );
    // And the request has to leave native `fetch`, which cannot express it.
    expect(tlsTransportRequired()).toBe(true);
    warn.mockRestore();
  });

  it("lets an explicit COREPACK_STRICT_SSL win in both directions", () => {
    userNpmrc("strict-ssl=false\n");
    process.env.COREPACK_STRICT_SSL = "1";
    expect(tlsSettings().verify).toBe(true);
    expect(tlsTransportRequired()).toBe(false);
  });

  it("costs nothing when the file says nothing about TLS", () => {
    userNpmrc("registry=https://mirror.example.org\n");
    expect(tlsConfigured()).toBe(false);
    expect(tlsConnectOptions()).toBeUndefined();
  });
});
