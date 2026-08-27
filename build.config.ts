import { readFileSync } from "node:fs";
import { type BuildConfig, defineBuildConfig } from "obuild/config";

/** Our own version, taken from the manifest **once, here**, and baked in below. */
const OWN_VERSION = (
  JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as { version: string }
).version;

/**
 * Rolldown's `PreRenderedChunk`, reached through obuild's hook signature so that
 * `rolldown` itself need not become a direct devDependency just for one type.
 */
type ChunkInfo = Parameters<
  Extract<
    Parameters<
      NonNullable<NonNullable<BuildConfig["hooks"]>["rolldownOutput"]>
    >[0]["chunkFileNames"],
    (...args: never) => unknown
  >
>[0];

/**
 * The modules a warm proxy invocation loads, relative to `src/` — §01.3, §16.3.
 *
 * This is the code that runs on every `yarn`, `npm` and `pnpm` invocation on the
 * machine, forever, so it is shipped as **one** chunk rather than the seven
 * rolldown emits on its own.
 *
 * The fragmentation is a side effect of the lazy cold path rather than anything
 * about these modules: every `import()` boundary is a new entry, and a module
 * gets its own chunk for each distinct set of entries that reaches it. So
 * `store.ts` (reached by the proxy, `install` and `enable`) and `manifest.ts`
 * (reached by the proxy, `cli` and `info`) land in different files despite
 * always being loaded together. Each additional module file costs roughly
 * 0.2 ms of resolve-and-link at startup — measured, and worth ~1 ms of a ~13 ms
 * warm run in total. Nothing about *what* is loaded changes.
 *
 * The list must equal the set of modules statically reachable from `shim.ts`,
 * and `test/unit/main.test.ts` asserts exactly that: a new static import on the
 * warm path fails the suite until it is added here, and a cold module added by
 * mistake fails it too.
 */
export const WARM_MODULES = [
  "cache/store.ts",
  "config/env-vars.ts",
  "config/table.ts",
  "errors.ts",
  "main.ts",
  "project/env.ts",
  "project/lockfile.ts",
  "project/manifest.ts",
  "project/version-file.ts",
  "run/exec.ts",
  "utils/json.ts",
  "utils/self.ts",
  "version/semver.ts",
];

/** `config/table.ts` → `config[\\/]table\.ts`, so the pattern matches on either separator. */
const pattern = (module: string) =>
  module.replaceAll(".", String.raw`\.`).replaceAll("/", String.raw`[\\/]`);

const WARM_CHUNK = new RegExp(String.raw`[\\/]src[\\/](?:${WARM_MODULES.map(pattern).join("|")})$`);

/** The one chunk this build asks for by name; everything else is named after its modules. */
const WARM_GROUP = "warm";

/**
 * `/abs/jup/src/net/registry.ts` → `net/registry`.
 *
 * `undefined` for anything outside `src/` and for the `.d.ts` modules of the
 * declaration build, which names its own output.
 */
const SOURCE_MODULE = /[\\/]src[\\/](.+)(?<!\.d)\.[cm]?ts$/;

function sourceName(id: string | undefined): string | undefined {
  if (id === undefined) return undefined;
  return SOURCE_MODULE.exec(id)?.[1]?.replaceAll("\\", "/");
}

/**
 * Name a chunk after the module it exists for, mirroring `src/` inside `_chunks/`.
 *
 * Rolldown's own names are the module *basenames*, which collide as soon as two
 * chunks share one — and here they always do, because a dynamically imported
 * module that is also statically imported somewhere else is emitted twice: a
 * re-export facade for the `import()` site, plus the chunk actually holding the
 * code. That produced `install.mjs`/`install2.mjs`, `pin.mjs`/`pin2.mjs` and
 * five more pairs where the digit, not the name, carried the meaning.
 *
 * So:
 *
 * - the `warm` group keeps the name it was asked for;
 * - a chunk fronting an `import()` is named for the module that `import()` names
 *   — `cache/install.ts` → `_chunks/cache/install.mjs`;
 * - a chunk that fronts no single module is a shared chunk, named for its root
 *   module (last in dependency order) plus `.shared` — so the pair above becomes
 *   `cache/install.mjs` and `cache/install.shared.mjs`, and `net/tls.shared.mjs`
 *   holds `net/tls.ts` together with the `keys.ts`/`npmrc.ts` it drags in.
 *
 * Declaration chunks and anything outside `src/` fall through to `[name]`; the
 * `.d.ts` pipeline renames its own output afterwards and must not be second
 * guessed. Nothing here forces a module into a chunk — this only labels the
 * chunks rolldown decided on, so the split stays whatever the import graph says.
 *
 * The subdirectories are safe: `getOwnRoot` and `findEntryModule` walk *up* to
 * find the package root precisely because a bundler is free to nest chunks, and
 * `test/unit/self.test.ts` pins that.
 */
function chunkName(chunk: ChunkInfo): string {
  if (chunk.name === WARM_GROUP) return WARM_GROUP;

  const entry = sourceName(chunk.facadeModuleId);
  if (entry !== undefined) return entry;

  const shared = sourceName(chunk.moduleIds.at(-1));
  return shared === undefined ? "[name]" : `${shared}.shared`;
}

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: ["./src/index.ts", "./src/bin.ts", "./src/shim.ts"],
      // `utils/self.ts` reads this instead of locating and parsing our own
      // manifest at runtime. A build cannot then be wrong about its own version
      // the way a filesystem walk can (see `getOwnVersion`), and `--version`,
      // `info` and the `user-agent` all stop touching the disk for it.
      rolldown: { transform: { define: { __JUP_VERSION__: JSON.stringify(OWN_VERSION) } } },
    },
  ],
  hooks: {
    rolldownOutput(cfg) {
      cfg.codeSplitting = {
        // Keep obuild's own groups (it splits `node_modules` into `libs/*`) so a
        // dependency, should one ever appear, still lands where obuild expects.
        groups: [
          { name: WARM_GROUP, test: WARM_CHUNK },
          ...(typeof cfg.codeSplitting === "object" ? (cfg.codeSplitting.groups ?? []) : []),
        ],
      };
      cfg.chunkFileNames = (chunk) => `_${chunkName(chunk)}.mjs`;
    },
  },
});
