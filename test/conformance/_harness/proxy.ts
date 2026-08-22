/**
 * A real forward proxy for conformance rows 71 and 72 (§05.1, §14.8, §15.6).
 *
 * It speaks both halves of the contract:
 *
 *   * `GET http://host/path HTTP/1.1` — absolute-form, the shape a proxy gets
 *     for an `http://` target;
 *   * `CONNECT host:443` — a byte pipe, the shape it gets for an `https://` one.
 *
 * Whatever authority is asked for, both paths end at the mock registry: the
 * tunnel terminates at a TLS server holding `test/_fixtures/tls.ts`, which
 * forwards the decrypted request on. The spawned tool trusts that certificate
 * through `NODE_EXTRA_CA_CERTS` ({@link ProxyFixture.caFile}), so the rows run
 * with certificate verification **on** — a tunnel that skipped verification
 * would prove nothing about §14.6.
 *
 * `x-original-url` carries the URL the tool actually asked for, which is what
 * the mock writes its `dist.tarball` against, exactly as the `intercept.ts`
 * preload does for the unproxied rows.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CERT, KEY } from "../../_fixtures/tls.ts";

export interface ProxyFixture {
  /** `http://127.0.0.1:<port>` — the value for `HTTP_PROXY` / `HTTPS_PROXY`. */
  origin: string;
  /** Every `CONNECT` authority the proxy was asked to tunnel to, in order. */
  connects: string[];
  /** Every absolute-form request line the proxy received, in order. */
  absoluteForm: string[];
  /** A PEM file trusting the tunnel's certificate, for `NODE_EXTRA_CA_CERTS`. */
  caFile: string;
  reset(): void;
  stop(): Promise<void>;
}

/** Pass the decrypted request on to the mock, telling it what was asked for. */
function forward(
  request: IncomingMessage,
  response: ServerResponse,
  target: string,
  originalUrl: string,
  sockets: Set<Socket>,
): void {
  const mock = new URL(target);
  const path = new URL(originalUrl).pathname + new URL(originalUrl).search;

  const headers = { ...request.headers, host: mock.host, "x-original-url": originalUrl };
  delete headers["proxy-authorization"];

  const upstream = httpRequest(
    {
      host: mock.hostname,
      port: Number(mock.port),
      method: request.method,
      path,
      headers,
    },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    },
  );
  upstream.on("socket", (socket: Socket) => sockets.add(socket));
  upstream.on("error", () => {
    response.writeHead(502);
    response.end("proxy upstream failed");
  });
  request.pipe(upstream);
}

export async function startProxy(mockOrigin: () => string): Promise<ProxyFixture> {
  const sockets = new Set<Socket>();
  const track = (server: Server) => {
    server.on("connection", (socket: Socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    return server;
  };

  // The far end of every tunnel: real TLS, real certificate verification.
  const terminator = track(
    createHttpsServer({ key: KEY, cert: CERT }, (request, response) => {
      forward(
        request,
        response,
        mockOrigin(),
        `https://${request.headers.host ?? "example.com"}${request.url ?? "/"}`,
        sockets,
      );
    }),
  );

  const fixture: ProxyFixture = {
    origin: "",
    connects: [],
    absoluteForm: [],
    caFile: "",
    reset() {
      fixture.connects = [];
      fixture.absoluteForm = [];
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await Promise.all(
        [proxy, terminator].map(
          (server) =>
            new Promise<void>((resolve) => {
              server.closeAllConnections();
              server.close(() => resolve());
            }),
        ),
      );
    },
  };

  const proxy = track(
    createHttpServer((request, response) => {
      const url = request.url ?? "";
      fixture.absoluteForm.push(url);

      if (!url.startsWith("http://")) {
        // A proxy that is handed an origin-form request line has been misused.
        response.writeHead(400);
        response.end("expected an absolute-form request line");
        return;
      }

      forward(request, response, mockOrigin(), url, sockets);
    }),
  );

  proxy.on("connect", (request, socket: Socket, head: Buffer) => {
    fixture.connects.push(request.url ?? "");
    sockets.add(socket);

    const upstream = connect(
      { host: "127.0.0.1", port: (terminator.address() as AddressInfo).port },
      () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      },
    );
    sockets.add(upstream);
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.once("close", () => upstream.destroy());
    upstream.once("close", () => socket.destroy());
  });

  await new Promise<void>((resolve) => terminator.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));

  fixture.origin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  fixture.caFile = join(mkdtempSync(join(tmpdir(), "pipack-ca-")), "ca.pem");
  writeFileSync(fixture.caFile, `${CERT}\n`);

  return fixture;
}
