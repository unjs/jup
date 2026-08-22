/**
 * §15.23 — `.corepack.lock`.
 *
 * The conformance rows prove the pipeline end to end; these prove the rules the
 * pipeline leans on, in particular the two that are invisible from outside: an
 * exact pin never involves the file, and a damaged file degrades rather than
 * throws.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hashFromIntegrity,
  integrityFromHash,
  LOCKFILE_NAME,
  readLockfile,
  readResolution,
  removeResolution,
  resolutionKey,
  usesLockfile,
  writeResolution,
} from "../../src/lockfile.ts";

let dir: string;

const RANGE = { name: "pnpm", range: "^11.0.0" };
/** sha512 of nothing in particular; only its round-trip matters here. */
const HEX = "ab".repeat(64);
const HASH = `sha512.${HEX}`;

function write(content: string): void {
  writeFileSync(join(dir, LOCKFILE_NAME), content);
}

function read(): string {
  return readFileSync(join(dir, LOCKFILE_NAME), "utf8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pipack-lock-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("usesLockfile — §15.23", () => {
  it("is false for an exact version, so an exact pin never touches the file", () => {
    for (const range of ["1.22.4", "11.1.2", "4.0.0-rc.1", "1.22.4+sha1.abc"]) {
      expect(usesLockfile({ name: "yarn", range }), range).toBe(false);
    }
  });

  it("is false for a URL reference, which carries its own digest", () => {
    expect(usesLockfile({ name: "yarn", range: "https://example.test/yarn.js#sha1.ab" })).toBe(
      false,
    );
  });

  it("is true for a range or a dist-tag", () => {
    for (const range of ["^11.0.0", "6.x", "*", ">=2", "latest", "stable"]) {
      expect(usesLockfile({ name: "pnpm", range }), range).toBe(true);
    }
  });

  it("keys a resolution by the range exactly as written", () => {
    expect(resolutionKey({ name: "pnpm", range: "^11.0.0" })).toBe("pnpm@^11.0.0");
    expect(resolutionKey({ name: "pnpm", range: ">=11 <12" })).toBe("pnpm@>=11 <12");
  });
});

describe("readLockfile — §15.23", () => {
  it("returns null for a missing file", () => {
    expect(readLockfile(dir)).toBeNull();
  });

  it("returns null rather than throwing for anything it cannot use", () => {
    for (const content of [
      "{ not json",
      "[]",
      "null",
      `"a string"`,
      `{"resolutions":{}}`,
      `{"version":2,"resolutions":{}}`,
      `{"version":1}`,
      `{"version":1,"resolutions":[]}`,
    ]) {
      write(content);
      expect(readLockfile(dir), content).toBeNull();
    }
  });

  it("returns null for an unreadable file", () => {
    // A directory where the file should be fails with EISDIR, not ENOENT.
    mkdirSync(join(dir, LOCKFILE_NAME));
    expect(readLockfile(dir)).toBeNull();
  });

  it("drops individual malformed entries and keeps the rest", () => {
    write(
      JSON.stringify({
        version: 1,
        resolutions: {
          "pnpm@^11.0.0": { resolved: "11.1.2", integrity: "sha512-abc" },
          "pnpm@bad-version": { resolved: "not-a-version" },
          "pnpm@non-string": { resolved: 42 },
          "pnpm@null": null,
          "pnpm@array": [],
          "pnpm@no-integrity": { resolved: "10.5.0" },
          "pnpm@bad-integrity-type": { resolved: "10.0.0", integrity: 7 },
        },
      }),
    );

    expect(readLockfile(dir)?.resolutions).toEqual({
      "pnpm@^11.0.0": { resolved: "11.1.2", integrity: "sha512-abc" },
      "pnpm@no-integrity": { resolved: "10.5.0" },
      "pnpm@bad-integrity-type": { resolved: "10.0.0" },
    });
  });
});

describe("readResolution — §15.23", () => {
  it("returns the recorded version with its digest as a build suffix", () => {
    writeResolution(dir, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH);

    expect(readResolution(dir, RANGE)).toEqual({ name: "pnpm", reference: `11.1.2+${HASH}` });
  });

  it("returns null when the recorded version no longer satisfies the range", () => {
    write(JSON.stringify({ version: 1, resolutions: { "pnpm@^11.0.0": { resolved: "10.5.0" } } }));

    expect(readResolution(dir, RANGE)).toBeNull();
  });

  it("returns null for a key nobody recorded", () => {
    writeResolution(dir, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH);

    expect(readResolution(dir, { name: "pnpm", range: "^10.0.0" })).toBeNull();
  });

  it("keeps a recorded prerelease, which the lenient rule is there for", () => {
    // Under strict satisfaction `11.2.0-rc.1` fails `^11.0.0`, and every run
    // would go back to the registry for a version already recorded and installed.
    write(
      JSON.stringify({
        version: 1,
        resolutions: { "pnpm@^11.0.0": { resolved: "11.2.0-rc.1" } },
      }),
    );

    expect(readResolution(dir, RANGE)?.reference).toBe("11.2.0-rc.1");
  });

  it("stands until refreshed for a dist-tag, which has no range to violate", () => {
    write(JSON.stringify({ version: 1, resolutions: { "pnpm@latest": { resolved: "10.5.0" } } }));

    expect(readResolution(dir, { name: "pnpm", range: "latest" })?.reference).toBe("10.5.0");
  });

  it("falls back to an unpinned reference when the digest is unusable", () => {
    write(
      JSON.stringify({
        version: 1,
        resolutions: { "pnpm@^11.0.0": { resolved: "11.1.2", integrity: "nonsense" } },
      }),
    );

    expect(readResolution(dir, RANGE)?.reference).toBe("11.1.2");
  });
});

describe("writeResolution / removeResolution — §15.23", () => {
  it("writes the documented shape: two-space indent, sorted keys, trailing newline", () => {
    writeResolution(
      dir,
      { name: "pnpm", range: "^11.0.0" },
      { name: "pnpm", reference: "11.1.2" },
      HASH,
    );
    writeResolution(
      dir,
      { name: "npm", range: "10.x" },
      { name: "npm", reference: "10.9.0" },
      undefined,
    );

    expect(read()).toBe(
      `${JSON.stringify(
        {
          version: 1,
          resolutions: {
            "npm@10.x": { resolved: "10.9.0" },
            "pnpm@^11.0.0": { resolved: "11.1.2", integrity: integrityFromHash(HASH) },
          },
        },
        undefined,
        2,
      )}\n`,
    );
  });

  it("strips the build suffix from the recorded version", () => {
    writeResolution(dir, RANGE, { name: "pnpm", reference: `11.1.2+${HASH}` }, HASH);

    expect(readLockfile(dir)?.resolutions["pnpm@^11.0.0"]?.resolved).toBe("11.1.2");
  });

  it("round-trips: what it writes is what it reads back", () => {
    writeResolution(dir, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH);
    const first = read();

    writeResolution(dir, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH);

    expect(read()).toBe(first);
  });

  it("removes one key, and the whole file once nothing is left", () => {
    writeResolution(dir, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH);
    writeResolution(
      dir,
      { name: "npm", range: "10.x" },
      { name: "npm", reference: "10.9.0" },
      HASH,
    );

    removeResolution(dir, "npm@10.x");
    expect(Object.keys(readLockfile(dir)!.resolutions)).toEqual(["pnpm@^11.0.0"]);

    removeResolution(dir, "pnpm@^11.0.0");
    expect(readLockfile(dir)).toBeNull();
    expect(() => read()).toThrow();
  });

  it("is a no-op for a key that is not recorded, and for a missing file", () => {
    expect(() => removeResolution(dir, "pnpm@^11.0.0")).not.toThrow();

    writeResolution(dir, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH);
    const before = read();
    removeResolution(dir, "yarn@^1.0.0");

    expect(read()).toBe(before);
  });

  it("never throws when the project directory cannot be written", () => {
    const missing = join(dir, "gone");

    expect(() =>
      writeResolution(missing, RANGE, { name: "pnpm", reference: "11.1.2" }, HASH),
    ).not.toThrow();
  });
});

describe("the SRI codec — §15.23", () => {
  it("round-trips a hash through the spelling npm uses", () => {
    expect(integrityFromHash(HASH)).toMatch(/^sha512-[\d+/A-Za-z]+=*$/);
    expect(hashFromIntegrity(integrityFromHash(HASH)!)).toBe(HASH);
  });

  it("matches what the registry publishes, byte for byte", () => {
    // `sha512-4mgVEQ==` is `sha512` over the four bytes below, as npm spells it.
    const sri = `sha512-${Buffer.from("e2681511", "hex").toString("base64")}`;
    expect(hashFromIntegrity(sri)).toBe("sha512.e2681511");
    expect(integrityFromHash("sha512.e2681511")).toBe(sri);
  });

  it("answers undefined for anything it cannot convert", () => {
    for (const value of ["", "-", "sha512", "sha512-", "-abc", "1sha-abc"]) {
      expect(hashFromIntegrity(value), value).toBeUndefined();
    }
    for (const value of ["", ".", "sha512", "sha512.", ".abc", "sha512.xyz", "sha512.abc"]) {
      expect(integrityFromHash(value), value).toBeUndefined();
    }
  });

  it("takes the first entry of a multi-entry SRI string and drops its options", () => {
    expect(hashFromIntegrity("sha512-4mgVEQ==?foo=bar sha256-abcd")).toBe(
      hashFromIntegrity("sha512-4mgVEQ=="),
    );
  });
});
