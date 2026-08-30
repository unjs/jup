/**
 * The two error helpers behind §12.6's diagnostics, and the round trip that keeps them honest.
 *
 * `parseBadStatus` reads back a sentence {@link messages.badStatus} produced, so
 * the pattern and the template have to agree byte for byte. Nothing enforces
 * that but this file: `http.ts` throws a plain `Error` and the proxy path must
 * not import it to learn the status.
 */

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import {
  advisory,
  explainFetchFailure,
  messages,
  parseBadStatus,
  UsageError,
} from "../../src/errors-cold.ts";

describe("parseBadStatus", () => {
  it("round-trips every status and URL shape messages.badStatus can render", () => {
    for (const [status, url] of [
      [404, "https://registry.npmjs.org/pnpm/-/pnpm-11.9.9.tgz"],
      [500, "http://127.0.0.1:41481/yarn"],
      [403, "https://example.test/a;b/c?d=1#e"],
      [401, "https://nexus.internal:8443/repository/npm-group/@yarnpkg/cli-dist"],
    ] as const) {
      expect(parseBadStatus(new Error(messages.badStatus(status, url))), url).toEqual({
        status,
        url,
      });
    }
  });

  it("answers null for anything that is not that sentence", () => {
    expect(parseBadStatus(new Error(messages.requestFailed("https://example.test/x")))).toBeNull();
    expect(parseBadStatus(new Error("Server answered with HTTP 404"))).toBeNull();
    expect(parseBadStatus(new Error(""))).toBeNull();
    expect(parseBadStatus("Server answered with HTTP 404 …")).toBeNull();
    expect(parseBadStatus(undefined)).toBeNull();
  });
});

describe("explainFetchFailure — §12.6", () => {
  const what = { name: "pnpm", range: "^11.0.0", version: "11.9.9" };

  it("names the seeding command when the network is disabled", () => {
    for (const message of [
      messages.networkDisabledUrl("https://registry.npmjs.org/pnpm/-/pnpm-11.9.9.tgz"),
      messages.networkDisabledRegistry("https://registry.npmjs.org"),
    ]) {
      const explained = explainFetchFailure(new Error(message), what);

      expect(explained).toBeInstanceOf(UsageError);
      expect(explained!.message).toBe(messages.notInCacheOffline("pnpm", "^11.0.0"));
      // The *range* the user wrote, so what the message tells them to run is
      // something they can paste back.
      expect(explained!.message).toContain("jup cache install -g --cache-only pnpm@^11.0.0");
    }
  });

  it("names the version as nonexistent on a 404, reporting the origin contacted", () => {
    const error = new Error(
      messages.badStatus(404, "https://registry.npmjs.org/pnpm/-/pnpm-11.9.9.tgz"),
    );

    const explained = explainFetchFailure(error, what);

    expect(explained).toBeInstanceOf(UsageError);
    expect(explained!.message).toBe(
      messages.versionDoesNotExist("pnpm", "11.9.9", "https://registry.npmjs.org"),
    );
  });

  it("leaves every other failure alone", () => {
    const cases: unknown[] = [
      new Error(messages.badStatus(500, "https://registry.npmjs.org/pnpm")),
      new Error(messages.badStatus(403, "https://registry.npmjs.org/pnpm")),
      new Error(messages.requestFailed("https://registry.npmjs.org/pnpm")),
      new Error(messages.mismatchHashes("sha512.a", "sha512.b")),
      "not an error at all",
      undefined,
    ];

    for (const error of cases) {
      expect(explainFetchFailure(error, what)).toBeNull();
    }
  });

  it("leaves a 404 alone when there is no version to name", () => {
    // A URL reference has no semver, and "<name>@undefined does not exist" would
    // be worse than the transport's own sentence.
    const error = new Error(messages.badStatus(404, "https://example.test/yarn.js"));

    expect(
      explainFetchFailure(error, { name: "yarn", range: "https://example.test/yarn.js" }),
    ).toBeNull();
  });

  it("redacts credentials out of the origin it reports", () => {
    const error = new Error(
      messages.badStatus(404, "https://user:secret@nexus.internal/npm/pnpm/-/pnpm-11.9.9.tgz"),
    );

    const explained = explainFetchFailure(error, what);

    expect(explained!.message).not.toContain("secret");
    expect(explained!.message).toContain("https://nexus.internal");
  });
});

/**
 * §11.3 — the advisory mute, and the half of stderr it must not reach.
 *
 * The gate is three lines of code; what needs a test is the *classification*.
 * The negative control lives in `manifest.test.ts`, next to the `devEngines`
 * warnings whose text §13 matches byte for byte.
 */
describe("advisory — §11.3", () => {
  let warn: MockInstance<typeof console.warn>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = process.env;
    process.env = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("COREPACK_") || key.startsWith("JUP_")) delete process.env[key];
    }
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it("prints by default", () => {
    advisory(messages.strictSslDisabled("JUP_STRICT_SSL"));

    expect(warn).toHaveBeenCalledWith(messages.strictSslDisabled("JUP_STRICT_SSL"));
  });

  it("is silent under JUP_QUIET_ADVISORIES=1", () => {
    process.env.JUP_QUIET_ADVISORIES = "1";

    advisory(messages.strictSslDisabled("JUP_STRICT_SSL"));

    expect(warn).not.toHaveBeenCalled();
  });

  // §11.6 — the pair is one variable, so the gate cannot be a bare lookup.
  it("is silent under the JUP_ spelling too", () => {
    process.env.JUP_QUIET_ADVISORIES = "1";

    advisory(messages.strictSslDisabled("JUP_STRICT_SSL"));

    expect(warn).not.toHaveBeenCalled();
  });

  // The value tables in §11 read `1`, not "anything truthy": `0` is how a user
  // turns the mute back off in a shell that already exports it.
  it.for([["0"], [""], ["true"], ["yes"]])("prints for the value %o", ([value]) => {
    process.env.JUP_QUIET_ADVISORIES = value;

    advisory(messages.strictSslDisabled("JUP_STRICT_SSL"));

    expect(warn).toHaveBeenCalledTimes(1);
  });
});
