/**
 * §15.38 row 153 — a registry behind an unknown certificate authority (§15.4).
 *
 * Corepack has no TLS surface at all, so the single most common corporate
 * failure — a TLS-inspecting proxy re-signing everything with a CA the trust
 * store has never seen — reaches the user as `Error when performing the request
 * to <url>` and nothing more. That is #332, and the thread is a queue of people
 * guessing. This row pins the opposite: name the host, name the cause, and name
 * the variable that fixes it.
 *
 * The registry here is the ordinary mock behind a real TLS server holding
 * `test/_fixtures/tls.ts` — its own CA, trusted by nothing until a test says so.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer, type Server } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { messages } from "../../src/errors.ts";
import { CERT, KEY } from "../_fixtures/tls.ts";
import {
  cleanupFixtures,
  createFixture,
  MockRegistry,
  packageManagerTarball,
  run,
} from "./_harness/index.ts";

const registry = new MockRegistry();

/** A PEM file holding the fixture CA, for `COREPACK_CAFILE`. */
const caFile = join(mkdtempSync(join(tmpdir(), "pipack-conf-ca-")), "bundle.pem");
writeFileSync(caFile, `${CERT}\n`);

interface TlsFront {
  origin: string;
  stop: () => Promise<void>;
}

/**
 * A TLS front for the mock registry.
 *
 * `x-original-url` names the *https* URL the tool asked for, which is what the
 * mock writes `dist.tarball` against — so the artifact stays on the same host
 * and §14.9's check is satisfied, exactly as `intercept.ts` arranges for the
 * unencrypted rows.
 */
async function startTlsFront(target: () => string): Promise<TlsFront> {
  const sockets = new Set<Socket>();

  const handler = (request: IncomingMessage, response: ServerResponse) => {
    const mock = new URL(target());
    const path = request.url ?? "/";
    const upstream = httpRequest(
      {
        host: mock.hostname,
        port: Number(mock.port),
        method: request.method,
        path,
        headers: { ...request.headers, host: mock.host, "x-original-url": `${origin}${path}` },
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    upstream.on("error", () => {
      response.writeHead(502);
      response.end("upstream failed");
    });
    upstream.end();
  };

  const server: Server = createHttpsServer({ key: KEY, cert: CERT }, handler);
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("tlsClientError", () => {});

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    origin,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}

function trusted(extra?: Record<string, string | undefined>): Record<string, string | undefined> {
  return { COREPACK_INTEGRITY_KEYS: registry.trustStore(), ...extra };
}

beforeAll(async () => {
  await registry.start();
  registry.publish("pnpm", "6.6.2", packageManagerTarball("pnpm", "6.6.2"));
});

afterAll(async () => {
  cleanupFixtures();
  await registry.stop();
});

beforeEach(() => registry.reset());

describe("§15.38 TLS (§15.4)", () => {
  it("153: an unknown authority is named as such, and names COREPACK_CAFILE", async () => {
    const front = await startTlsFront(() => registry.origin);
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    try {
      const result = await run(["pnpm", "--version"], {
        ...fixture,
        env: trusted({ COREPACK_NPM_REGISTRY: front.origin }),
      });

      expect(result.exitCode).toBe(1);
      const host = new URL(front.origin).host;
      expect(result.stderr).toContain(messages.tlsUnknownAuthority(host));
      expect(result.stderr).toContain(
        `TLS certificate verification failed for ${host}: the certificate was issued by an unknown authority. If your network uses a TLS-inspecting proxy, point COREPACK_CAFILE at its CA bundle.`,
      );
      // §15.4 forbids surfacing a bare transport error for this case.
      expect(result.stderr).not.toContain("Error when performing the request");
      // §15.5 — the runtime's own reason survives alongside it.
      expect(result.stderr).toContain("Caused by:");
      // Nothing was installed.
      expect(result.stdout).toBe("");
    } finally {
      await front.stop();
    }
  });

  it("153: COREPACK_CAFILE pointing at the issuer makes the same run succeed", async () => {
    const front = await startTlsFront(() => registry.origin);
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    try {
      const result = await run(["pnpm", "--version"], {
        ...fixture,
        env: trusted({ COREPACK_NPM_REGISTRY: front.origin, COREPACK_CAFILE: caFile }),
      });

      // The control for the row above: same server, same certificate, and the
      // only difference is the bundle the error message told the user about.
      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("6.6.2\n");
    } finally {
      await front.stop();
    }
  });

  it("COREPACK_STRICT_SSL=0 connects anyway, and says so verbatim", async () => {
    const front = await startTlsFront(() => registry.origin);
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    try {
      const result = await run(["pnpm", "--version"], {
        ...fixture,
        env: trusted({ COREPACK_NPM_REGISTRY: front.origin, COREPACK_STRICT_SSL: "0" }),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("6.6.2\n");
      // Loud, once, and byte for byte.
      expect(result.stderr).toBe(
        "! TLS certificate verification is disabled (set by COREPACK_STRICT_SSL)\n",
      );
      expect(result.stderr).toBe(`${messages.strictSslDisabled("COREPACK_STRICT_SSL")}\n`);
    } finally {
      await front.stop();
    }
  });

  it("a project's .corepack.env cannot disable verification or nominate a CA (§15.37)", async () => {
    const front = await startTlsFront(() => registry.origin);
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });
    fixture.write(".corepack.env", `COREPACK_STRICT_SSL=0\nCOREPACK_CAFILE=${caFile}\n`);

    try {
      const result = await run(["pnpm", "--version"], {
        ...fixture,
        env: trusted({ COREPACK_NPM_REGISTRY: front.origin }),
      });

      // Both were refused, each announced, and the run still failed the way an
      // untrusted certificate should.
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("! Ignoring COREPACK_STRICT_SSL from ");
      expect(result.stderr).toContain("! Ignoring COREPACK_CAFILE from ");
      expect(result.stderr).toContain("this variable can only be set in the environment");
      expect(result.stderr).toContain("TLS certificate verification failed for");
      expect(result.stderr).not.toContain("verification is disabled");
    } finally {
      await front.stop();
    }
  });
});
