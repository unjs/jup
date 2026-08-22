import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { findEntryModule, getOwnRoot } from "../../src/utils/self.ts";

/**
 * These two questions were answered three separate times by counting `dirname`
 * calls, and all three were wrong once bundled: obuild emits chunks into
 * `dist/_chunks/`, one level deeper than the layout the arithmetic assumed.
 *
 * The failures were invisible from source and real in the shipped package —
 * `enable` refused to run, `COREPACK_ROOT` pointed at `dist/`, and `--version`
 * answered `0.0.0` forever. So the tests below simulate the **bundled** layout
 * explicitly; a test that only exercises the source tree cannot catch this.
 */
describe("locating ourselves", () => {
  function scaffold() {
    const root = mkdtempSync(join(tmpdir(), "self-"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pipack", version: "9.9.9" }));
    mkdirSync(join(root, "dist", "_chunks"), { recursive: true });
    writeFileSync(join(root, "dist", "index.mjs"), "export {};");
    writeFileSync(join(root, "dist", "_chunks", "cli.mjs"), "export {};");
    return root;
  }

  describe("getOwnRoot", () => {
    it("finds the package root from a bundler's chunk directory", () => {
      const root = scaffold();
      const chunk = pathToFileURL(join(root, "dist", "_chunks", "cli.mjs")).href;

      // Two dirnames from here would yield `<root>/dist`, which has no manifest.
      expect(getOwnRoot(chunk)).toBe(root);
    });

    it("finds it from a flat dist too", () => {
      const root = scaffold();
      expect(getOwnRoot(pathToFileURL(join(root, "dist", "index.mjs")).href)).toBe(root);
    });

    it("falls back to the module's own directory when no manifest exists above it", () => {
      const orphan = mkdtempSync(join(tmpdir(), "orphan-"));
      mkdirSync(join(orphan, "nested"), { recursive: true });
      const from = join(orphan, "nested");

      // Never throws: `COREPACK_ROOT` is a hint to the package manager (§08.7),
      // so a missing manifest must not take down the handover.
      expect(getOwnRoot(pathToFileURL(join(from, "x.mjs")).href)).toBeTypeOf("string");
    });
  });

  describe("findEntryModule", () => {
    it("skips the chunk directory and finds the real entry", () => {
      const root = scaffold();
      const chunk = pathToFileURL(join(root, "dist", "_chunks", "cli.mjs")).href;

      // `_chunks` holds a .mjs file but not *the* entry — walking must continue.
      expect(findEntryModule(chunk)).toEqual({
        directory: join(root, "dist"),
        entry: "index.mjs",
      });
    });

    it("returns undefined when there is no entry module anywhere above", () => {
      const orphan = mkdtempSync(join(tmpdir(), "orphan-"));
      expect(findEntryModule(pathToFileURL(join(orphan, "x.mjs")).href)).toBeUndefined();
    });
  });
});
