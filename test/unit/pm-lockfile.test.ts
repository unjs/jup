/**
 * §04.4 and §04.6 — the lockfile a package manager keeps for itself.
 *
 * Two rules read one `pnpm-lock.yaml`: the version a manager recorded for this
 * project's range, and the format the file was written in. Neither has a parser
 * behind it, so what they do with a shape they were not expecting is the
 * contract — anything but the exact shape pnpm writes must answer `null`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readDeclaredEntry, readDeclaredResolution } from "../../src/project/lockfile.ts";
import { readDeclaredFormat } from "../../src/project/lockfile-format.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jup-pm-lock-"));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

/* --------------- §04.4 — the committed resolution ---------------- */

/** The manager's document, as pnpm writes it: `---`, then the project's own. */
function pnpmLock(entry: string, project = "12.9.9"): string {
  return `---
lockfileVersion: '9.0'

importers:

  .:
    configDependencies: {}
    packageManagerDependencies:
${entry}

packages:

  pnpm@12.3.0:
    resolution: {integrity: sha512-nonsense}

---
lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      pnpm:
        specifier: ^12
        version: ${project}
`;
}

function writeManagerLock(content: string): void {
  writeFileSync(join(dir, "pnpm-lock.yaml"), content);
}

/** The shape under test throughout: `pnpm@^12`, recorded as 12.3.0. */
const DECLARED = { name: "pnpm", range: "^12" };
const ENTRY = `      pnpm:
        specifier: ^12
        version: 12.3.0`;

describe("readDeclaredEntry — §04.4's declared resolution", () => {
  it("reads the root importer's entry out of the first document", () => {
    writeManagerLock(pnpmLock(ENTRY));

    expect(readDeclaredEntry(dir, DECLARED)).toEqual({
      resolved: "12.3.0",
      specifier: "^12",
      path: join(dir, "pnpm-lock.yaml"),
    });
  });

  // The project's own `importers` carry entries of exactly this shape —
  // `<name>:` / `specifier:` / `version:` at the same indentation — so a reader
  // that did not stop at the document break would answer with a dependency's
  // version. The fixture's second document says `pnpm` on purpose.
  it("never reads past the document break into the project's own importers", () => {
    writeManagerLock(pnpmLock(ENTRY, "12.9.9"));

    expect(readDeclaredEntry(dir, DECLARED)?.resolved).toBe("12.3.0");
  });

  it("answers null when the project's document is all there is", () => {
    writeManagerLock(`lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      pnpm:
        specifier: ^12
        version: 12.9.9
`);

    expect(readDeclaredEntry(dir, DECLARED)).toBeNull();
  });

  // The same keying rule as `resolutionKey`: a record stands for the range it
  // was taken against and for no other, so editing the manifest retires it.
  it("requires the recorded specifier to be the range exactly as written", () => {
    writeManagerLock(pnpmLock(ENTRY));

    expect(readDeclaredEntry(dir, { name: "pnpm", range: "^12.0.0" })).toBeNull();
  });

  it("skips a version the range no longer admits", () => {
    writeManagerLock(
      pnpmLock(`      pnpm:
        specifier: ^12
        version: 11.26.0`),
    );

    expect(readDeclaredEntry(dir, DECLARED)).toBeNull();
  });

  it("skips a version that is not one", () => {
    writeManagerLock(
      pnpmLock(`      pnpm:
        specifier: ^12
        version: link:../pnpm`),
    );

    expect(readDeclaredEntry(dir, DECLARED)).toBeNull();
  });

  it("reads a quoted specifier, which is how a range with a space is written", () => {
    writeManagerLock(
      pnpmLock(`      pnpm:
        specifier: '>=12 <13'
        version: 12.3.0`),
    );

    expect(readDeclaredEntry(dir, { name: "pnpm", range: ">=12 <13" })?.resolved).toBe("12.3.0");
  });

  it("answers only for the tool asked about", () => {
    writeManagerLock(pnpmLock(ENTRY));

    expect(readDeclaredEntry(dir, { name: "yarn", range: "^12" })).toBeNull();
  });

  // An exact pin is its own record (§04.4), so the file is not even opened.
  it("is not consulted for an exact pin", () => {
    writeManagerLock(pnpmLock(ENTRY));

    expect(readDeclaredEntry(dir, { name: "pnpm", range: "12.3.0" })).toBeNull();
  });

  it("answers null with no file at all", () => {
    expect(readDeclaredEntry(dir, DECLARED)).toBeNull();
  });

  it("degrades to null on a file it cannot make sense of", () => {
    writeManagerLock("not: [a, lockfile\n\x00\x00");

    expect(readDeclaredEntry(dir, DECLARED)).toBeNull();
  });

  it("is switched off by JUP_ENABLE_PM_LOCKFILE=0", () => {
    writeManagerLock(pnpmLock(ENTRY));
    process.env.JUP_ENABLE_PM_LOCKFILE = "0";
    try {
      expect(readDeclaredEntry(dir, DECLARED)).toBeNull();
    } finally {
      delete process.env.JUP_ENABLE_PM_LOCKFILE;
    }
  });

  // §04.4 — the digest in that file describes the npm package pnpm installs for
  // itself, which is not necessarily the artifact jup's table installs for the
  // same version. The locator carries the version and nothing else.
  it("never turns the file's own integrity into a locator suffix", () => {
    writeManagerLock(pnpmLock(ENTRY));

    expect(readDeclaredResolution(dir, DECLARED)).toEqual({ name: "pnpm", reference: "12.3.0" });
  });
});

/* ------------------------------------------------------------------ *
 * §04.6 — the format that same file is written in.
 *
 * The mapping is data, and the rows below are the claims it makes: each
 * `lockfileVersion` pnpm has shipped, the majors that wrote it, and the
 * one format — `9.0` — that four current majors write and that must
 * therefore say nothing at all.
 * ------------------------------------------------------------------ */

/** The header pnpm writes, in whichever way this row spells the version. */
function formatHeader(version: string): string {
  return `lockfileVersion: ${version}

settings:
  autoInstallPeers: true

importers:

  .: {}
`;
}

describe("readDeclaredFormat — §04.6's inferred default", () => {
  it.each([
    ["5", ">=3.0.0 <3.5.0"],
    ["5.1", ">=3.5.0 <5.10.0"],
    ["5.2", ">=5.10.0 <6.0.0"],
    ["5.3", ">=6.0.0 <7.0.0"],
    ["5.4", ">=7.0.0 <8.0.0"],
    ["'6.0'", ">=8.0.0 <9.0.0"],
    ["'6.1'", ">=8.0.0 <9.0.0"],
  ])("maps lockfileVersion %s to the majors that write it", (version, range) => {
    writeManagerLock(formatHeader(version));

    expect(readDeclaredFormat(dir, "pnpm")?.range).toBe(range);
  });

  // pnpm 9, 10, 11 and 12 all write `9.0`, and for one project their output is
  // byte-identical. "Some major at or above 9" is not a statement worth
  // overriding the recorded default with, so the file is read and ignored.
  it("has no opinion about 9.0, which four majors write", () => {
    writeManagerLock(formatHeader("'9.0'"));

    expect(readDeclaredFormat(dir, "pnpm")).toBeNull();
  });

  it("reads the version pnpm >= 12 writes into the manager document", () => {
    writeManagerLock(pnpmLock(ENTRY).replace("lockfileVersion: '9.0'", "lockfileVersion: '6.0'"));

    expect(readDeclaredFormat(dir, "pnpm")).toEqual({
      format: "6",
      range: ">=8.0.0 <9.0.0",
      path: join(dir, "pnpm-lock.yaml"),
    });
  });

  // `6.0` and `6` are one format spelt two ways, and pnpm has spelt it both:
  // 5.4 is a bare YAML number, 6.0 and 9.0 are quoted strings.
  it.each(["6", "6.0", "'6.0'", '"6.0"'])("reads %s as the same format", (version) => {
    writeManagerLock(formatHeader(version));

    expect(readDeclaredFormat(dir, "pnpm")?.format).toBe("6");
  });

  // The trim is a suffix, not arithmetic: a hypothetical `6.10` is not `6.1`.
  it.each(["6.10", "10", "'9.0.0'", "six", "", "'", "6,0"])(
    "answers null for %s, which is no format this build knows",
    (version) => {
      writeManagerLock(formatHeader(version));

      expect(readDeclaredFormat(dir, "pnpm")).toBeNull();
    },
  );

  it("answers null for a tool that keeps no lockfile, and for a missing file", () => {
    writeManagerLock(formatHeader("'6.0'"));

    expect(readDeclaredFormat(dir, "yarn")).toBeNull();
    expect(readDeclaredFormat(join(dir, "elsewhere"), "pnpm")).toBeNull();
  });

  // Only the file's own header counts. A `lockfileVersion` indented under some
  // other key, or one in the *project's* document, is not pnpm's statement
  // about the file it wrote.
  it("reads the header at column zero and nothing deeper", () => {
    writeManagerLock(`importers:

  .:
    lockfileVersion: '6.0'
`);

    expect(readDeclaredFormat(dir, "pnpm")).toBeNull();
  });

  it("is switched off by JUP_ENABLE_PM_LOCKFILE=0, like every other read of it", () => {
    writeManagerLock(formatHeader("'6.0'"));
    process.env.JUP_ENABLE_PM_LOCKFILE = "0";

    try {
      expect(readDeclaredFormat(dir, "pnpm")).toBeNull();
    } finally {
      delete process.env.JUP_ENABLE_PM_LOCKFILE;
    }
  });
});
