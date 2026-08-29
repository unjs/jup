/**
 * rows 154 and 155 — timeouts and retries (§05.1).
 *
 * The reference implementation has no timeout, no retry and no backoff: a
 * single transport hiccup is fatal and the message says nothing about what
 * happened. That is the shape of #458 — intermittent CI failures whose root
 * cause was never found. These rows pin a registry that stumbles twice and is
 * survived, and one that stalls and is given up on with a sentence that says so.
 */

import { request as httpRequest, createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupFixtures,
  createFixture,
  MockRegistry,
  packageManagerTarball,
  run,
} from "./_harness/index.ts";

const registry = new MockRegistry();

interface Front {
  origin: string;
  /** Requests the front received, in order. */
  requests: string[];
  stop: () => Promise<void>;
}

/**
 * A front for the mock registry that answers `status` to its first `failures`
 * requests, then forwards. `x-original-url` keeps `dist.tarball` pointing here,
 * so the artifact download passes §05.2's host check.
 */
async function startFlakyFront(
  target: () => string,
  failures: number,
  status = 503,
): Promise<Front> {
  const sockets = new Set<Socket>();
  const requests: string[] = [];
  let seen = 0;

  const server: Server = createServer((request, response) => {
    const path = request.url ?? "/";
    requests.push(path);
    seen += 1;

    if (seen <= failures) {
      response.writeHead(status, { "content-type": "text/plain" });
      response.end("try again");
      return;
    }

    const mock = new URL(target());
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
  });

  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    origin,
    requests,
    stop: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}

/** A server that accepts the connection and then says nothing, ever. */
async function startStalledServer(): Promise<Front> {
  const sockets = new Set<Socket>();
  const requests: string[] = [];

  const server = createServer((request) => {
    requests.push(request.url ?? "/");
  });
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    origin,
    requests,
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

describe("§05.1 network resilience", () => {
  it("154: two 503s then a 200 — the install survives them", async () => {
    const front = await startFlakyFront(() => registry.origin, 2);
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    try {
      const result = await run(["pnpm", "--version"], {
        ...fixture,
        env: trusted({ COREPACK_NPM_REGISTRY: front.origin }),
      });

      expect(result.stderr).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("6.6.2\n");

      // Three attempts at the metadata — the default §05.1 states — and then the
      // artifact, on a front that has stopped failing.
      expect(front.requests).toEqual([
        "/pnpm/6.6.2",
        "/pnpm/6.6.2",
        "/pnpm/6.6.2",
        "/pnpm/-/pnpm-6.6.2.tgz",
      ]);
    } finally {
      await front.stop();
    }
  });

  it("154: JUP_NETWORK_RETRIES=0 fails immediately", async () => {
    const front = await startFlakyFront(() => registry.origin, 2);
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    try {
      const result = await run(["pnpm", "--version"], {
        ...fixture,
        env: trusted({ COREPACK_NPM_REGISTRY: front.origin, JUP_NETWORK_RETRIES: "0" }),
      });

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        `Server answered with HTTP 503 when performing the request to ${front.origin}/pnpm/6.6.2`,
      );
      // One request, not three: the whole point of the switch.
      expect(front.requests).toEqual(["/pnpm/6.6.2"]);
    } finally {
      await front.stop();
    }
  });

  it("154: a 4xx is never retried", async () => {
    const front = await startFlakyFront(() => registry.origin, 2, 404);
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    try {
      const result = await run(["pnpm", "--version"], {
        ...fixture,
        env: trusted({ COREPACK_NPM_REGISTRY: front.origin }),
      });

      expect(result.exitCode).toBe(1);
      // §04.1 redirected the message: a 404 on an artifact download is now
      // reported as a nonexistent version. What this row is really about is the
      // request count below — a 4xx is a verdict, not a hiccup, and retrying it
      // only multiplies the wait.
      expect(result.stderr).toContain("pnpm@6.6.2 does not exist in");
      expect(front.requests).toEqual(["/pnpm/6.6.2"]);
    } finally {
      await front.stop();
    }
  });

  it("155: a registry that stalls past JUP_NETWORK_TIMEOUT times out, and says so", async () => {
    const stalled = await startStalledServer();
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    try {
      const result = await run(["pnpm", "--version"], {
        ...fixture,
        env: trusted({
          COREPACK_NPM_REGISTRY: stalled.origin,
          JUP_NETWORK_TIMEOUT: "300",
          JUP_NETWORK_RETRIES: "0",
        }),
      });

      expect(result.exitCode).toBe(1);
      // §12.6's wrapper, as ever…
      expect(result.stderr).toContain(
        `Error when performing the request to ${stalled.origin}/pnpm/6.6.2`,
      );
      // …and §05.1's timeout-specific reason with it, naming the budget, the URL
      // and the variable that changes it. Corepack surfaces the wrapper alone.
      expect(result.stderr).toContain(
        `Timed out after 300ms waiting for ${stalled.origin}/pnpm/6.6.2`,
      );
      expect(result.stderr).toContain("JUP_NETWORK_TIMEOUT");
      expect(stalled.requests).toEqual(["/pnpm/6.6.2"]);
    } finally {
      await stalled.stop();
    }
  });

  it("155: a stalled registry is retried before it is given up on", async () => {
    const stalled = await startStalledServer();
    const fixture = createFixture({ packageManager: "pnpm@6.6.2" });

    try {
      const result = await run(["pnpm", "--version"], {
        ...fixture,
        env: trusted({ COREPACK_NPM_REGISTRY: stalled.origin, JUP_NETWORK_TIMEOUT: "200" }),
      });

      expect(result.exitCode).toBe(1);
      expect(stalled.requests).toHaveLength(3);
      expect(result.stderr).toContain("Giving up after 3 attempts");
    } finally {
      await stalled.stop();
    }
  });
});
