/**
 * A `--import` preload for the spawned tool, used only by the conformance
 * harness: it merges §17.9's fixture entries into the embedded table before
 * `bin.ts` runs.
 *
 * The same trick as `intercept.ts`, one layer down. A `--import` module is
 * evaluated to completion before the entry point starts, and an ES module is
 * keyed by its resolved URL — so importing the very `config/table.ts` the tool
 * is about to import hands back the same module instance, and mutating the
 * `DEFINITIONS` object it exports is a table substitution rather than a second
 * table nobody reads. `reindexTable()` then re-derives `SUPPORTED_NAMES` and the
 * binary/registry maps, which were built from the entries that were there a
 * moment ago.
 *
 * The module to patch is named in the payload rather than imported directly,
 * because `copyTool()` runs a throwaway *copy* of `src/` whose table is a
 * different module from this checkout's (`test/conformance/15-28-native.test.ts`
 * runs one). Patching the wrong instance would leave the fixture invisible and
 * every row failing on `Unsupported package manager`.
 *
 * `JUP_TEST_TABLE` is read **here** and nowhere in `src/`: the released binary
 * has no reader for it, so this is not the user-extensible registry §01.7 and
 * §15.21 forbid. `run()` sets it, `cleanEnv()` strips an inherited one.
 */

import type { Tool } from "../../../src/types.ts";

interface Payload {
  /** `file:` URL of the `config/table.ts` the spawned tool will import. */
  module: string;
  tools: Record<string, Tool>;
}

const raw = process.env.JUP_TEST_TABLE;

if (raw !== undefined && raw !== "") {
  const payload = JSON.parse(raw) as Payload;
  const table = (await import(payload.module)) as typeof import("../../../src/config/table.ts");

  Object.assign(table.DEFINITIONS, payload.tools);
  table.reindexTable();
}
