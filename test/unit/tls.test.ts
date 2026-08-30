/**
 * TLS configuration and diagnostics — §05.1, conformance row 153.
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
import { messages } from "../../src/errors-cold.ts";
import { httpGet, httpGetJson } from "../../src/net/http.ts";
import { resetNpmrcCache } from "../../src/net/npmrc.ts";
import {
  applyTlsConfiguration,
  classifyTlsFailure,
  isTlsFailure,
  readCaBundle,
  tlsConfigured,
  tlsConnectOptions,
  tlsSettings,
  tlsTransportRequired,
} from "../../src/net/tls.ts";
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

/** A TLS origin on `127.0.0.1`, which the certificate names. */
async function startTlsOrigin(host = "127.0.0.1"): Promise<Origin> {
  const server: Server = createHttpsServer({ key: KEY, cert: CERT }, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(`{"ok":true}`);
  });
  return await listen(server, host);
}

async function startPlainOrigin(): Promise<Origin> {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(`{"ok":true}`);
  });
  return await listen(server);
}

async function listen(
  server: Server | ReturnType<typeof createHttpServer>,
  host = "127.0.0.1",
): Promise<Origin> {
  const sockets = new Set<Socket>();
  const origin: Origin = { port: 0, connections: 0 };

  server.on("connection", (socket: Socket) => {
    origin.connections += 1;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  // A TLS handshake that fails is not an error the *test* should crash on.
  server.on("tlsClientError", () => {});

  await new Promise<void>((resolve) => server.listen(0, host, resolve));
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
  const path = join(mkdtempSync(join(tmpdir(), "jup-ca-")), "bundle.pem");
  writeFileSync(path, `${certificates.join("\n")}\n`);
  return path;
}

const ENV_KEYS = [
  "JUP_CAFILE",
  "JUP_STRICT_SSL",
  "JUP_NETWORK_RETRIES",
  "JUP_NETWORK_TIMEOUT",
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

describe("tlsSettings (§05.1)", () => {
  it("verifies with the platform trust store when nothing is configured", () => {
    expect(tlsSettings()).toEqual({ verify: true });
    expect(tlsConfigured()).toBe(false);
    expect(tlsTransportRequired()).toBe(false);
    expect(tlsConnectOptions()).toBeUndefined();
  });

  it("takes the bundle from JUP_CAFILE and names the source", () => {
    process.env.JUP_CAFILE = "/etc/corp.pem";

    expect(tlsSettings()).toEqual({
      cafile: "/etc/corp.pem",
      cafileSource: "JUP_CAFILE",
      verify: true,
    });
    expect(tlsConfigured()).toBe(true);
    // A custom CA does not change transport: `fetch` reads the process store.
    expect(tlsTransportRequired()).toBe(false);
  });

  it("treats an empty JUP_CAFILE as unset", () => {
    process.env.JUP_CAFILE = "";

    expect(tlsSettings().cafile).toBeUndefined();
    expect(tlsConfigured()).toBe(false);
  });

  it('disables verification only for the exact string "0"', () => {
    for (const value of ["1", "true", "false", "", "00"]) {
      process.env.JUP_STRICT_SSL = value;
      expect(tlsSettings().verify).toBe(true);
      expect(tlsTransportRequired()).toBe(false);
    }

    process.env.JUP_STRICT_SSL = "0";
    expect(tlsSettings()).toEqual({ verify: false, verifySource: "JUP_STRICT_SSL" });
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
    const path = join(tmpdir(), "jup-nonexistent-ca.pem");

    expect(() => readCaBundle(path)).toThrow(messages.cafileUnreadable(path));
    expect(() => readCaBundle(path)).toThrow(
      `Unable to read the TLS certificate bundle at ${path} (set by JUP_CAFILE)`,
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

describe("classifyTlsFailure (§05.1)", () => {
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
      "TLS certificate verification failed for npm.corp: the certificate was issued by an unknown authority. If your network uses a TLS-inspecting proxy, point JUP_CAFILE at its CA bundle.",
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
  it("names the host, the cause, and JUP_CAFILE", async () => {
    const origin = await startTlsOrigin();

    const error = await httpGet(`https://127.0.0.1:${origin.port}/pkg`).catch(
      (error_: Error) => error_,
    );

    // Not `Error when performing the request to …`: §05.1 forbids surfacing a
    // bare transport error for exactly this case.
    expect((error as Error).message).toBe(messages.tlsUnknownAuthority(`127.0.0.1:${origin.port}`));
    expect((error as Error).message).toContain("JUP_CAFILE");
    expect((error as Error).message).not.toContain("performing the request");
    // §05.1 — the underlying reason survives, on the chain and in the stack.
    expect((error as Error).cause).toBeDefined();
    expect((error as Error).stack).toContain("Caused by:");
  });

  it("is not retried — a certificate is not a hiccup", async () => {
    const origin = await startTlsOrigin();
    process.env.JUP_NETWORK_RETRIES = "5";

    await expect(httpGet(`https://127.0.0.1:${origin.port}/pkg`)).rejects.toThrow(
      messages.tlsUnknownAuthority(`127.0.0.1:${origin.port}`),
    );

    expect(origin.connections).toBe(1);
  });

  it("succeeds once JUP_CAFILE names the issuer", async () => {
    const origin = await startTlsOrigin();
    process.env.JUP_CAFILE = bundleFile(CERT);

    await expect(httpGetJson(`https://127.0.0.1:${origin.port}/pkg`)).resolves.toEqual({
      ok: true,
    });
  });

  it("reports a JUP_CAFILE that does not exist", async () => {
    const origin = await startTlsOrigin();
    const path = join(tmpdir(), "jup-missing-bundle.pem");
    process.env.JUP_CAFILE = path;

    // The variable the user actually set, not the canonical spelling: the
    // message names what to go and fix.
    await expect(httpGet(`https://127.0.0.1:${origin.port}/pkg`)).rejects.toThrow(
      messages.cafileUnreadable(path, "JUP_CAFILE"),
    );
    // Nothing was sent: the bundle is applied before a socket is opened.
    expect(origin.connections).toBe(0);
  });
});

describe("a certificate for another name", () => {
  it("says so, rather than blaming the authority", async () => {
    // IPv6 loopback, not `127.0.0.2`. The whole of `127.0.0.0/8` is local on
    // Linux, but macOS binds only `127.0.0.1` by default, so a connection to
    // `127.0.0.2` there is never refused and never answered — the row failed as
    // a five-second timeout rather than as a certificate error. `::1` is up on
    // all three platforms, and the fixture's SAN list — `DNS:localhost`,
    // `IP:127.0.0.1` and the `example` names — does not contain it.
    const origin = await startTlsOrigin("::1");
    // The issuer is trusted, so the only thing left to fail is the name.
    process.env.JUP_CAFILE = bundleFile(CERT);

    const error = await httpGet(`https://[::1]:${origin.port}/pkg`).catch(
      (error_: Error) => error_,
    );

    expect((error as Error).message).toBe(messages.tlsHostnameMismatch(`[::1]:${origin.port}`));
  });
});

describe("JUP_STRICT_SSL=0", () => {
  it("connects anyway, and says so once, verbatim", async () => {
    const origin = await startTlsOrigin();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.JUP_STRICT_SSL = "0";

    await expect(httpGetJson(`https://127.0.0.1:${origin.port}/pkg`)).resolves.toEqual({
      ok: true,
    });
    await expect(httpGetJson(`https://127.0.0.1:${origin.port}/pkg`)).resolves.toEqual({
      ok: true,
    });

    expect(warn).toHaveBeenCalledWith(
      "⚠ TLS certificate verification is disabled (set by JUP_STRICT_SSL)",
    );
    expect(warn).toHaveBeenCalledWith(messages.strictSslDisabled("JUP_STRICT_SSL"));
    // A standing property of the run, announced once — not once per request.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("streams the body, so the download pipeline still tees it", async () => {
    const origin = await startTlsOrigin();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.JUP_STRICT_SSL = "0";

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
    process.env.JUP_CAFILE = bundleFile(CERT);
    const counter = countFetches();

    await httpGetJson(`https://127.0.0.1:${origin.port}/pkg`);

    expect(counter.calls).toBe(1);
  });

  it("leaves fetch behind only when verification is disabled", async () => {
    const origin = await startTlsOrigin();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.JUP_STRICT_SSL = "0";
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

    applyTlsConfiguration({ cafile: path, cafileSource: "JUP_CAFILE", verify: true });

    // Replacement, not extension: §05.1 states a precedence order ending at the
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

  /**
   * §05.1, row 209 — `setDefaultCACertificates` returns nothing, so an unchecked
   * call is a wish. Without the readback both shapes below fail much later as a
   * bare `UNABLE_TO_GET_ISSUER_CERT`, which is the unexplained certificate error
   * §05.1 exists to abolish — reached, this time, by a user who has already
   * configured the fix.
   */
  function stubTls(tls: Record<string, unknown>): void {
    const real = process.getBuiltinModule.bind(process);
    vi.spyOn(process, "getBuiltinModule").mockImplementation(((name: string) =>
      name === "node:tls" ? tls : real(name as never)) as typeof process.getBuiltinModule);
  }

  it("209: fails, naming the source, when the runtime ignores the installed bundle", () => {
    stubTls({
      setDefaultCACertificates: () => {},
      getCACertificates: () => defaultCertificates,
    });

    expect(() =>
      applyTlsConfiguration({ cafile: bundleFile(CERT), cafileSource: "JUP_CAFILE", verify: true }),
    ).toThrow(
      "The TLS certificates from JUP_CAFILE were installed, but this runtime's trust store does not reflect them",
    );
  });

  it("209: fails when the runtime has no setDefaultCACertificates at all", () => {
    stubTls({});

    expect(() =>
      applyTlsConfiguration({ cafile: bundleFile(CERT), cafileSource: "JUP_CAFILE", verify: true }),
    ).toThrow("node:tls provides no setDefaultCACertificates");
  });

  it("209: says nothing when the runtime cannot be asked", () => {
    // A runtime with the setter and no reader has not answered "no".
    stubTls({ setDefaultCACertificates: () => {} });

    expect(() =>
      applyTlsConfiguration({ cafile: bundleFile(CERT), cafileSource: "JUP_CAFILE", verify: true }),
    ).not.toThrow();
  });

  it("209: leaves the check alone when the request is not going over fetch", () => {
    // `JUP_STRICT_SSL=0` routes through `node:https` with `ca` passed
    // explicitly (§05.1), so the process trust store is not what carries it.
    process.env.JUP_STRICT_SSL = "0";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubTls({ setDefaultCACertificates: () => {}, getCACertificates: () => defaultCertificates });

    expect(() =>
      applyTlsConfiguration({
        cafile: bundleFile(CERT),
        cafileSource: "JUP_CAFILE",
        verify: false,
      }),
    ).not.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * §01.3 / §16, Build shape — the warm path must not reach TLS
 *
 * `main.test.ts` owns the module-graph budget, but its
 * `COLD_PATH_MODULES` list names modules explicitly, so a *new* cold
 * module is invisible to it until someone remembers to add it. This is
 * the cheap standing guard for this one: nothing on the warm chain may
 * name `tls.ts` or `node:tls` at all.
 * ------------------------------------------------------------------ */

describe("the warm path never reaches TLS (§16)", () => {
  const WARM = [
    "main.ts",
    "bin.ts",
    "index.ts",
    "version/resolve.ts",
    "cache/store.ts",
    "run/exec.ts",
  ];

  // The specifier is matched by basename rather than by the literal relative
  // path, so a module moving between subdirectories cannot quietly defeat this.
  const IMPORTS_TLS = /from\s*"[^"]*\/tls\.ts"/;

  it.for(WARM.map((name) => [name]))("src/%s names neither tls.ts nor node:tls", ([name]) => {
    const source = readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8");

    expect(source).not.toMatch(IMPORTS_TLS);
    expect(source).not.toContain("node:tls");
  });

  it("only http.ts and proxy.ts import it, and both are cold-path already", () => {
    const importers = WARM.concat([
      "net/http.ts",
      "net/proxy.ts",
      "cache/install.ts",
      "net/registry.ts",
    ]).filter((name) =>
      IMPORTS_TLS.test(readFileSync(new URL(`../../src/${name}`, import.meta.url), "utf8")),
    );

    expect(importers.sort()).toEqual(["net/http.ts", "net/proxy.ts"]);
  });
});

/* ------------------------------------------------------------------ *
 * §05.3's middle tier — `cafile` / `ca` / `strict-ssl` from `.npmrc`
 * ------------------------------------------------------------------ */

describe("tlsSettings — the .npmrc tier (§05.3, §05.1)", () => {
  const roots: string[] = [];
  let home: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    const root = mkdtempSync(join(tmpdir(), "jup-tls-npmrc-"));
    roots.push(root);
    home = join(root, "home");
    mkdirSync(home, { recursive: true });
    // §05.3's home directory is `$HOME`, or `%USERPROFILE%` on Windows. Both
    // spellings are redirected, so the row reads the fixture's `.npmrc` on
    // every platform rather than the developer's own.
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.PREFIX = join(root, "prefix");
    resetNpmrcCache();
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
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

  it("lets JUP_CAFILE outrank it (§05.1's precedence)", () => {
    userNpmrc("cafile=/etc/ssl/corp.pem\n");
    process.env.JUP_CAFILE = "/etc/ssl/env.pem";

    expect(tlsSettings()).toMatchObject({
      cafile: "/etc/ssl/env.pem",
      cafileSource: "JUP_CAFILE",
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
    // §05.1's verbatim sentence, naming the source rather than the setting.
    applyTlsConfiguration(settings);
    expect(warn).toHaveBeenCalledWith(
      messages.strictSslDisabled(`strict-ssl (${join(home, ".npmrc")})`),
    );
    // And the request has to leave native `fetch`, which cannot express it.
    expect(tlsTransportRequired()).toBe(true);
    warn.mockRestore();
  });

  it("lets an explicit JUP_STRICT_SSL win in both directions", () => {
    userNpmrc("strict-ssl=false\n");
    process.env.JUP_STRICT_SSL = "1";
    expect(tlsSettings().verify).toBe(true);
    expect(tlsTransportRequired()).toBe(false);
  });

  it("costs nothing when the file says nothing about TLS", () => {
    userNpmrc("registry=https://mirror.example.org\n");
    expect(tlsConfigured()).toBe(false);
    expect(tlsConnectOptions()).toBeUndefined();
  });
});
