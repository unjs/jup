import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

// `fileURLToPath`, not `.pathname`: on Windows the latter is `/D:/…`, which
// `join` and `readdirSync` then resolve against the current drive root as
// `D:\D:\…`.
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC = join(ROOT, "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

/**
 * Vitest transpiles, so it happily runs TypeScript that Node itself cannot.
 *
 * The conformance suite spawns the sources directly (`node src/bin.ts`), which
 * relies on Node's type-stripping mode — and that mode rejects any syntax that
 * needs code *generation* rather than erasure: parameter properties, enums,
 * namespaces, and legacy decorators. A module using one of those passes every
 * unit test and then fails the moment the CLI is run for real.
 *
 * This guard closes that gap. It caught `class EntryBody { constructor(private
 * readonly reader: ByteReader) {} }` in the tar reader.
 */
describe("every source module loads under Node's type stripping", () => {
  const files = sourceFiles(SRC);

  it("finds the source files", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.for(files.map((file) => relative(ROOT, file)))("%s", async (relativePath) => {
    const target = JSON.stringify(pathToFileURL(join(ROOT, relativePath)).href);

    // `bin.ts` runs the CLI on import, so type-check the syntax without
    // executing the module body.
    const source = relativePath.endsWith("bin.ts")
      ? `await import("node:module").then((m) => m.default);`
      : `await import(${target});`;

    await expect(
      execFileAsync(process.execPath, ["--input-type=module", "-e", source], { cwd: ROOT }),
    ).resolves.toBeDefined();
  });
});
