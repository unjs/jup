import { defineBuildConfig } from "obuild/config";

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
  "config/table.ts",
  "env.ts",
  "errors.ts",
  "exec.ts",
  "json.ts",
  "lockfile.ts",
  "main.ts",
  "manifest.ts",
  "self.ts",
  "semver.ts",
  "store.ts",
];

/** `config/table.ts` → `config[\\/]table\.ts`, so the pattern matches on either separator. */
const pattern = (module: string) =>
  module.replaceAll(".", String.raw`\.`).replaceAll("/", String.raw`[\\/]`);

const WARM_CHUNK = new RegExp(String.raw`[\\/]src[\\/](?:${WARM_MODULES.map(pattern).join("|")})$`);

export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: ["./src/index.ts", "./src/bin.ts", "./src/shim.ts"],
    },
  ],
  hooks: {
    rolldownOutput(cfg) {
      cfg.codeSplitting = { groups: [{ name: "warm", test: WARM_CHUNK }] };
    },
  },
});
