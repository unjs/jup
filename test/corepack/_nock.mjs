/**
 * The upstream `recordRequests.js`, ported to ESM so it can be `--import`ed
 * alongside jup's type-stripped entry point.
 *
 * `NOCK_ENV=record` writes every response into a local SQLite file;
 * `NOCK_ENV=replay` serves them back and fails loudly on a miss. Unset — the
 * default — leaves `fetch` alone and the suite talks to the real registries,
 * which is also how upstream behaves.
 *
 * The recording is keyed on a hash of the request, so it is specific to the
 * client: jup sends its own `user-agent` and abridged-metadata `accept`
 * headers, which means upstream's `nocks.db` cannot be reused and a jup
 * recording has to be made locally. That file is untracked; see the README.
 */

import { createHash } from "node:crypto";
import { DatabaseSync as SQLite3 } from "node:sqlite";
import { fileURLToPath } from "node:url";

const MODE = process.env.NOCK_ENV;

if (MODE === `record` || MODE === `replay`) {
  const dbPath = process.env.JUP_NOCK_DB ?? fileURLToPath(new URL(`./nocks.db`, import.meta.url));
  const db = new SQLite3(dbPath);
  process.once(`exit`, () => {
    db.close();
  });

  db.exec(`CREATE TABLE IF NOT EXISTS nocks (
    hash BLOB PRIMARY KEY NOT NULL,
    body BLOB NOT NULL,
    headers BLOB NOT NULL,
    status INTEGER NOT NULL
  )`);

  const getRequestHash = (input, init) => {
    const hash = createHash(`sha256`);
    hash.update(`${input}\0`);

    if (init) {
      for (const key in init) {
        if (init[key] === undefined) continue;

        switch (key) {
          case `headers`:
            hash.update(`${JSON.stringify(Object.fromEntries(new Headers(init.headers || {})))}\0`);
            break;
          // jup passes a few extra init fields upstream never does. None of
          // them change what comes back for the idempotent GETs the suite
          // makes, so they are deliberately left out of the key rather than
          // making every recording unreplayable.
          case `signal`:
          case `redirect`:
          case `dispatcher`:
          case `method`:
            break;
          default:
            throw new Error(`Hashing for "${key}" not implemented`);
        }
      }
    }

    return hash.digest();
  };

  const realFetch = globalThis.fetch;

  if (MODE === `record`) {
    const insert = db.prepare(
      `INSERT OR REPLACE INTO nocks (hash, body, headers, status) VALUES (?, ?, jsonb(?), ?)`,
    );

    globalThis.fetch = async (input, init) => {
      const response = await realFetch(input, init);
      const data = await response.arrayBuffer();

      const minimalHeaders = new Headers();
      for (const headerName of [`content-type`, `content-length`]) {
        const headerValue = response.headers.get(headerName);
        if (headerValue != null) minimalHeaders.set(headerName, headerValue);
      }

      insert.run(
        getRequestHash(input, init),
        Buffer.from(data),
        JSON.stringify(Object.fromEntries(minimalHeaders)),
        response.status,
      );

      return new Response(data, { status: response.status, headers: minimalHeaders });
    };
  } else {
    const select = db.prepare(
      `SELECT body, json(headers) as headers, status FROM nocks WHERE hash = ?`,
    );

    globalThis.fetch = async (input, init) => {
      const mock = select.get(getRequestHash(input, init));
      if (!mock)
        throw new Error(
          `No mock found for ${input}; run the tests with NOCK_ENV=record to generate one`,
        );

      return new Response(mock.body, {
        status: mock.status,
        headers: JSON.parse(mock.headers),
      });
    };
  }
}
