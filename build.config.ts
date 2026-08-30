import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineBuildConfig } from "obuild/config";
import { DEFINITIONS, getBinariesFor } from "./src/config/table.ts";
import { cliEntrySource, shimSource, stubNameFor } from "./src/commands/shims.ts";
import {
  BUILT_ENTRY_SPECIFIER,
  CLI_ENTRY_NAME,
  COREPACK_ENTRY_NAME,
  STUB_FOLDER_NAME,
} from "./src/utils/self.ts";

/** Our own version, taken from the manifest **once, here**, and baked in below. */
const OWN_VERSION = (
  JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

/**
 * **One bundled entry.** There were three — `index.ts`, `bin.ts` and `shim.ts` —
 * and with `codeSplitting: false` each of them was a complete copy of the same
 * module graph: 168 kB apiece, differing in their last few hundred bytes, for a
 * 527 kB `dist/`. `shim.ts` bought nothing at all (the warm set statically
 * reachable from it was *identical* to `index.ts`'s), and `bin.ts` bought nine
 * lines that need no bundler.
 *
 * Both now ship as static files in `bin/` that import this bundle by a relative
 * specifier — `jup.mjs` and the stubs beside it, written by
 * {@link writeStubFolder} from the `end` hook below. Nothing they contain
 * depends on the bundle, but hanging them off the same command is what keeps a
 * fresh clone one `pnpm build` away from a complete package, `bin/` out of the
 * repository, and the table's binary names from drifting away from the stubs
 * that serve them.
 */
export default defineBuildConfig({
  entries: [
    {
      type: "bundle",
      input: "./src/index.ts",
      minify: true,
      rolldown: { transform: { define: { __JUP_VERSION__: JSON.stringify(OWN_VERSION) } } },
    },
  ],
  hooks: {
    rolldownOutput(cfg) {
      cfg.codeSplitting = false;
    },
    end(ctx) {
      const written = writeStubFolder(join(ctx.pkgDir, STUB_FOLDER_NAME));
      console.log(`Wrote ${STUB_FOLDER_NAME}/: ${written.join(", ")}`);
    },
  },
});

/**
 * The modules a warm proxy invocation **evaluates**, relative to `src/` — §01.3,
 * §16.3. This is the code that runs on every `yarn`, `npm` and `pnpm` invocation
 * on the machine, forever.
 *
 * The build is a single file (`codeSplitting: false`), so this is not a
 * statement about which chunk a module lands in: rolldown wraps every module in
 * a lazy init thunk and rewrites `import()` to
 * `Promise.resolve().then(() => (init_x(), x_exports))`, so a cold module sitting
 * in the same file as the warm path is still not executed until something asks
 * for it. What the list names is the set that *is* executed.
 *
 * The list must equal the set of modules statically reachable from `index.ts`,
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
  "utils/log.ts",
  "utils/self.ts",
  "version/semver.ts",
];

/** The line every file this writes carries, and the licence to delete a stale one. */
const GENERATED_MARKER = "edits are overwritten.";

/**
 * Write the static files that ship in `bin/`: our own CLI entry `jup.mjs`, and
 * the shim stubs beside it. Returns the names it wrote.
 *
 * They are build output like `dist/` is, but they cannot live *in* `dist/`: the
 * bundler empties that folder on every run, and §10.7 wants files that a global
 * npm install, a container image or an OS package can leave exactly where they
 * are. So they sit one directory over and reach the bundle by a relative
 * specifier. Shipping them also means `enable` finds them already correct and
 * writes nothing but the symlinks, which is what §10.2 property 4's idempotency
 * rests on when the install directory is read-only.
 *
 * The bodies come from `shimSource` and `cliEntrySource`, so there is exactly
 * one definition of what each file is; this only decides where they land, and
 * takes the folder rather than finding it so a test can point it somewhere
 * harmless.
 *
 * Stale removal is by marker, not by wildcard: a name that leaves the table must
 * not leave its stub behind — `bin/` is not emptied the way `dist/` is — but a
 * file a maintainer put there by hand is not ours to delete.
 *
 * The `0o755` is a convenience, not the guarantee: `npm pack` re-applies the
 * execute bit to `bin` targets alone, so these stubs reach a published install
 * `0o644` however this left them. What guarantees an executable stub is `enable`
 * itself, which chmods one that arrives without the bit (§15.45). The chmod
 * stays because a dev checkout and a tarball unpacked by other means both run
 * the files straight out of the tree.
 */
export function writeStubFolder(folder: string): string[] {
  // §10.2's stubs, one per binary name on every platform, plus the CLI entry
  // §10.8 points our own two names at. No interpreter is passed, so the shipped
  // files keep `#!/usr/bin/env node` and stay relocatable; `enable` bakes in an
  // absolute path only where §10.1 says it must.
  const sources = new Map<string, string>([
    [CLI_ENTRY_NAME, cliEntrySource()],
    // §10.9 — the same entry under corepack's name, and the only durable way to
    // know we were invoked as `corepack`: §10.1 rules out `process.argv[1]`,
    // which a pnpm `.bin` wrapper, a Windows `.cmd` and bun each lose.
    [COREPACK_ENTRY_NAME, cliEntrySource(undefined, true)],
    ...Object.keys(DEFINITIONS)
      .flatMap((name) => getBinariesFor(name))
      .map(
        (binName) => [stubNameFor(binName), shimSource(BUILT_ENTRY_SPECIFIER, binName)] as const,
      ),
  ]);

  mkdirSync(folder, { recursive: true });

  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isFile() || sources.has(entry.name)) continue;
    const file = join(folder, entry.name);
    if (readFileSync(file, "utf8").includes(GENERATED_MARKER)) rmSync(file);
  }

  for (const [name, source] of sources) {
    const file = join(folder, name);
    writeFileSync(file, source);
    chmodSync(file, 0o755);
  }

  return [...sources.keys()];
}
