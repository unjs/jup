/**
 * §03.1 — the version-file reader, at the grammar level.
 *
 * The conformance rows prove the walk consults it and what happens when it says
 * something jup cannot answer. These are the cases underneath: nvm's own content
 * rules (`nvm_process_nvmrc_content`), and the observation the whole design rests
 * on — that the numeric half of nvm's vocabulary is already §04.2 range syntax
 * and needs no translation at all.
 */

import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { versionFileFor } from "../../src/config/table.ts";
import { UsageError } from "../../src/errors.ts";
import {
  loadVersionFile,
  type VersionFile,
  versionFileRange,
} from "../../src/project/version-file.ts";

const NVM: VersionFile["format"] = "nvm";

const rangeOf = (content: string): string =>
  versionFileRange({ path: "/p/.nvmrc", content, format: NVM }, ".nvmrc");

describe("§03.1 version files", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jup-vf-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("nvm's content grammar", () => {
    it("reads a bare version, however it is spelled", () => {
      // Every one of these is already a valid §04.2 range or version, `v` prefix
      // included — which is why translation is not where the work is.
      expect(rangeOf("20\n")).toBe("20");
      expect(rangeOf("v20\n")).toBe("v20");
      expect(rangeOf("20.10\n")).toBe("20.10");
      expect(rangeOf("v20.10.0\n")).toBe("v20.10.0");
      expect(rangeOf("20.x\n")).toBe("20.x");
      // No trailing newline, CRLF, and surrounding space all read the same.
      expect(rangeOf("20.10.0")).toBe("20.10.0");
      expect(rangeOf("  20.10.0  \r\n")).toBe("20.10.0");
    });

    it("passes a range through, though nvm would not understand one", () => {
      // A superset on purpose: the file is being read by jup, and refusing a
      // range jup can resolve would be an arbitrary narrowing.
      expect(rangeOf("^20.0.0\n")).toBe("^20.0.0");
      expect(rangeOf(">=18 <21\n")).toBe(">=18 <21");
      expect(rangeOf("*\n")).toBe("*");
    });

    it("strips comments, blank lines and `key=value` settings", () => {
      expect(rangeOf("# a note\n\n20.10.0 # bumped\n")).toBe("20.10.0");
      // The pairs are a later nvm addition carrying settings jup has no
      // counterpart for. Skipped rather than validated: rejecting a key we have
      // not heard of would break on nvm's next release.
      expect(rangeOf("some-setting=on\n20.10.0\nanother=off\n")).toBe("20.10.0");
      // Duplicate keys are nvm's error to raise, not ours.
      expect(rangeOf("a=1\na=2\n20.10.0\n")).toBe("20.10.0");
    });

    it("treats an empty key as the version, as nvm does", () => {
      // `nvm_process_nvmrc_content` tests the text *before* the first `=` for
      // emptiness, so `=20` is the bare line rather than a pair. It happens to
      // round-trip: §04.2's grammar accepts a leading `=`.
      expect(rangeOf("=20.10.0\n")).toBe("=20.10.0");
    });

    it("refuses a file that does not carry exactly one version", () => {
      for (const content of ["", "\n\n", "# only a comment\n", "a=1\n", "20\n22\n"]) {
        expect(() => rangeOf(content)).toThrow(UsageError);
        expect(() => rangeOf(content)).toThrow(/Invalid \.nvmrc/);
      }
    });
  });

  describe("aliases", () => {
    it("resolves the two that mean `the newest release`", () => {
      // nvm rewrites the bare tool name to `stable` before resolving; both are a
      // request for the newest published version, which is npm's `latest` tag.
      expect(rangeOf("node\n")).toBe("latest");
      expect(rangeOf("stable\n")).toBe("latest");
    });

    it("refuses the rest, naming the word and the field that can express it", () => {
      // `lts/*` has no data source: the `node` launcher publishes `latest` and
      // `v4-lts` … `v20-lts`, and the series tags stop there. `lts/<codename>`
      // would need a compiled-in codename table growing by a release per LTS
      // line. `system`, `iojs` and `default` name machine state, not a project's
      // requirement — and `system` asks for a node jup cannot vouch for (§06).
      for (const alias of ["lts/*", "lts/jod", "system", "iojs", "default", "unstable"]) {
        expect(() => rangeOf(`${alias}\n`)).toThrow(
          new RegExp(`Unsupported version .*${alias.replace("*", "\\*")}`),
        );
        expect(() => rangeOf(`${alias}\n`)).toThrow(/devEngines\.runtime/);
      }
    });
  });

  describe("loadVersionFile", () => {
    const spec = { path: ".nvmrc", format: NVM } as const;

    it("returns null when the file is absent", () => {
      expect(loadVersionFile(dir, spec)).toBeNull();
    });

    it("returns the content and the absolute path when it is there", () => {
      writeFileSync(join(dir, ".nvmrc"), "20\n");
      expect(loadVersionFile(dir, spec)).toEqual({
        path: join(dir, ".nvmrc"),
        content: "20\n",
        format: NVM,
      });
    });

    it("propagates anything that is not ENOENT", () => {
      // A directory of that name is the reachable case, and papering over it
      // would silently run a version the project did not ask for.
      mkdirSync(join(dir, ".nvmrc"));
      expect(() => loadVersionFile(dir, spec)).toThrow();
    });

    it("follows a symlink, because the reader does not care how the bytes arrive", () => {
      writeFileSync(join(dir, "shared"), "20.10.0\n");
      symlinkSync(join(dir, "shared"), join(dir, ".nvmrc"));
      expect(loadVersionFile(dir, spec)?.content).toBe("20.10.0\n");
    });
  });

  describe("the table is the authority", () => {
    it("declares the file on `node` and on nothing else", () => {
      // §02.3 — one entry in the table, no code. If a second tool ever declares
      // one, this is the only line that has to change.
      expect(versionFileFor("node")).toEqual({ path: ".nvmrc", format: "nvm" });
      for (const name of ["npm", "pnpm", "yarn", "bun", "deno", "aube", "nub"]) {
        expect(versionFileFor(name)).toBeUndefined();
      }
      expect(versionFileFor("nonesuch")).toBeUndefined();
    });
  });
});
