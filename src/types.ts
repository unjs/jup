/**
 * Core data model — see `.agents/02-data-model.md`.
 *
 * Three types carry the whole pipeline, and keeping them distinct is what makes
 * each resolution stage checkable:
 *
 *     Descriptor   "what the project asked for"      §03 produces, §04 consumes
 *     Locator      "the exact thing to install"      §04 produces, §07 consumes
 *     InstallSpec  "where it landed on disk"         §07 produces, §08 consumes
 */

/**
 * §02.3, §15.39 — which of §03's rules an entry is subject to.
 *
 * The *only* discriminator between a package manager and a runtime, and it
 * decides exactly four things: which manifest field is the project spec (§03.3),
 * whether the name is legal in `packageManager` (§03.4), whether §03.5's name
 * mismatch is enforced, and that a runtime must stay out of the default shim set
 * (§10.5). Nothing in §04–§08 may branch on it: resolution, registry access,
 * integrity, the store and execution are one path over both kinds.
 */
export type ToolKind = "package-manager" | "runtime";

/**
 * §02.7, §15.39 — the `devEngines` member that carries a tool's pin.
 *
 * Chosen by the requested tool's {@link ToolKind}, not by what the manifest
 * happens to declare: a project may carry both, and neither constrains the other.
 */
export type DevEnginesField = "packageManager" | "runtime";

/**
 * §02.3, §15.40 — a file the tool's own ecosystem writes the wanted version
 * into, consulted when the manifest declares nothing for this tool.
 *
 * Per **entry**, so the name of the file is a table fact and appears nowhere
 * else: §15.21 requires that adding one be a data-only change, and hardcoding
 * "if the tool is node, read `.nvmrc`" anywhere in §03 would be exactly the
 * name-in-the-structure that rule forbids.
 *
 * `format` is the dialect of the contents, not the file name — two ecosystems
 * that spell the same grammar differently are two formats, and two file names
 * carrying one grammar are one.
 */
export interface VersionFileSpec {
  /** File name, looked for in each directory of §03.1's walk. */
  path: string;
  /** Content grammar. `"nvm"` is `.nvmrc` as `nvm_process_nvmrc_content` reads it. */
  format: "nvm";
}

/** §02.1 — a tool name plus anything range-ish: version, range, tag, URL. */
export interface Descriptor {
  name: string;
  range: string;
}

/** §02.1 — an exact version (optionally hash-suffixed) or a URL. */
export interface Locator {
  name: string;
  reference: string;
}

/**
 * §02.1 — identical to {@link Locator} except the reference is a thunk.
 *
 * The laziness is load-bearing: it is the difference between "an offline project
 * with a pinned version works" and "every invocation hits the network". Never
 * materialise this until the project turns out to have no usable spec.
 */
export interface LazyLocator {
  name: string;
  reference: () => Promise<string>;
}

/** §02.4 — `{ [binaryName]: relativePathInPackage }`. The only form a `bin` takes. */
export type BinSpec = Record<string, string>;

/** §07.2 — the parsed `.jup` marker plus the directory it was found in. */
export interface InstallSpec {
  location: string;
  /**
   * Optional: §07.7 always records one, but §07.10 promotes markers that arrived
   * inside somebody else's archive, and one of those may omit it. §08.1's
   * `installSpec.bin ?? spec.bin` is what stands in when it does.
   */
  bin?: BinSpec;
  hash: string;
}

/** §07.2 — the on-disk shape of the `.jup` marker file. */
export interface CorepackMarker {
  locator: Locator;
  /** Optional, per §08.1 — see {@link InstallSpec.bin}. */
  bin?: BinSpec;
  hash: string;
}

/* -------------------------------------------------------------------------- */
/* Registry specs — §02.2                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Talk the npm registry protocol (§05.2).
 *
 * There is no `bin` here any more. It named a path *inside* the tarball and made
 * the downloader extract only that one file — machinery that existed solely so
 * Yarn Berry could arrive as a lone `yarn.js` when a custom npm registry served
 * it. §15.41 put Berry on `@yarnpkg/cli-dist` for every user, so the filtered
 * extraction had no caller left; §07.4 now always extracts the whole archive.
 */
export interface NpmRegistrySpec {
  type: "npm";
  package: string;
}

/**
 * Fetch one JSON document and read two fields out of it (§05.3).
 *
 * `fields.tags` names the tag→version object; `fields.versions` names either an
 * array of versions or an object whose *keys* are versions — both must be
 * accepted. `fetchLatestStableVersion` reads `data[fields.tags].stable`, note
 * **stable**, not `latest`.
 */
export interface UrlRegistrySpec {
  type: "url";
  url: string;
  fields: { tags: string; versions: string };
}

export type RegistrySpec = NpmRegistrySpec | UrlRegistrySpec;

/* -------------------------------------------------------------------------- */
/* Tool definitions — §02.3, §02.4                                            */
/* -------------------------------------------------------------------------- */

/** §02.4 — how to download and run one version band of a tool. */
export interface ToolSpec {
  /**
   * Download URL template.
   *
   * `{}` is replaced by the version, always. §15.28 adds three opt-in
   * placeholders for a band whose artifact is per-host: `{platform}`, `{arch}`,
   * and `{target}` — the last being whatever {@link ToolSpec.targets}
   * maps this host's `<platform>-<arch>` onto.
   */
  url: string;
  /**
   * `bin` paths may carry `{exe}` — `.exe` on Windows, empty everywhere else.
   *
   * This is the only variation a native band's entry points show across hosts:
   * `@oven/bun-windows-x64` ships `bin/bun.exe` where every other bun artifact
   * ships `bin/bun`, and the platform packages declare no `bin` of their own for
   * §07.7 to read instead. Bin *names* never carry it; only the paths do.
   */
  bin: BinSpec;
  /**
   * Default version source — where "which versions exist?" is answered.
   *
   * For a per-host band this is deliberately **not** where the artifact comes
   * from: `bun` and `deno` publish one launcher package that carries the version
   * line and the dist-tags, and one binary package per host. See
   * {@link ToolSpec.artifactRegistry}.
   */
  registry: RegistrySpec;
  /** Used *instead of* `registry` when the user has set a custom npm registry (§05.3). */
  npmRegistry?: NpmRegistrySpec;
  /**
   * §15.28 — `<platform>-<arch>` → the string `{target}` expands to.
   *
   * A table rather than a pair of alias maps because the published names are not
   * a product of two independent axes: bun spells the same two architectures
   * `x64`/`aarch64` and calls Windows `windows`, while deno keeps Node's spelling
   * but suffixes only its Linux artifacts with `-glibc`. Enumerating the hosts a
   * band actually ships for also makes "this host is not supported" a table
   * lookup that fails before any byte moves, rather than a 404 on a URL the user
   * never typed.
   *
   * The keys are the normalised pair (`linux-x64`, `darwin-arm64`, `win32-x64`,
   * …), so the vocabulary is the same one `{platform}` and `{arch}` draw on.
   */
  targets?: Record<string, string>;
  /**
   * §15.28 — the npm package the **artifact** is published as, when it differs
   * from the one {@link ToolSpec.registry} answers version questions
   * about. `package` may carry `{target}`, `{platform}` and `{arch}`.
   *
   * Splitting the two is what lets a native band keep npm's signature chain: the
   * signed `dist.integrity` for `@oven/bun-linux-x64@1.4.0` describes the bytes
   * this host is about to run, whereas the one for `bun@1.4.0` describes a 15 kB
   * launcher nobody downloads. §06 follows this spec, §04 follows `registry`.
   */
  artifactRegistry?: NpmRegistrySpec;
  /** argv to run after `jup use` / `up`. */
  commands?: { use?: string[] };
  /**
   * §15.28 — how the `bin` targets are executed.
   *
   * Absent (or `"js"`) is §08.2's model: the entry point is JavaScript and is
   * loaded into this process. `"native"` means the `bin` targets are real
   * executables and are run **directly**, so §08.3.1's runtime lookup is skipped
   * entirely — which makes a native package manager *faster* to hand over to
   * than a JavaScript one, not slower.
   *
   * This is per **range entry**, not per package manager: a tool that ships JS
   * up to some version and native after it is exactly the migration #295's
   * thread describes, and a per-band flag expresses it without a code change.
   */
  exec?: "js" | "native";
}

/**
 * §02.3 — one supported tool.
 *
 * `ranges` is an **ordered list**, not a map: lookup reverses it and takes the
 * first entry whose range is satisfied, so **last declared wins**. Dist-tags are
 * always resolved against the **last** entry's registry.
 */
export interface ToolDefinition {
  /**
   * §02.3, §15.39 — what sort of tool this is. Absent means
   * `"package-manager"`, which is every entry corepack ever had.
   *
   * Consult it in §03 and §10 only, and only for the four questions
   * {@link ToolKind} lists. A `"runtime"` entry MUST also set
   * `shimByDefault: false`: §10.5's test is whether the name means anything
   * outside a project, and a runtime's does by definition.
   */
  kind?: ToolKind;
  /** Compiled-in fallback version, hash-pinned. */
  default: string;
  /**
   * §04.1 step 3 — dist-tags this table answers **itself**, checked before the
   * registry is asked and never age-capped.
   *
   * For the one case it exists for, node's `lts`, the registry's own tags are
   * not merely stale but structurally unable to say it: npm's `node` package
   * publishes 22.x and 24.x yet stopped adding `v<N>-lts` tags after `v20-lts`
   * (20.11.1), so the newest tag naming an LTS line points two majors behind the
   * line that is actually in maintenance. There is no query over those tags that
   * reaches the right answer, and §15.21 rules out reaching for a second source
   * to get it.
   *
   * So the value is a literal on the same footing as {@link ToolDefinition.default}:
   * a human-reviewed constant, resolved with no request at all — which also makes
   * `node@lts` work offline. It rots the way `default` rots, and
   * `scripts/refresh-table.mjs` flags it for review for the same reason it does
   * not auto-merge one (§16.9, §15.33).
   *
   * A name here shadows the registry's tag of the same name. Nothing in the
   * table currently shadows one; node's `lts` fills a gap rather than
   * overriding an answer.
   */
  tags?: Record<string, string>;
  /** Where "what's the newest stable?" is answered. */
  fetchLatestFrom: RegistrySpec;
  transparent: {
    /** Fallback version for transparent commands only (§01.4). */
    default?: string;
    /** Command prefixes that bypass the project check. */
    commands: string[][];
  };
  ranges: Array<readonly [range: string, spec: ToolSpec]>;
  /**
   * §02.3, §15.40 — the version file this entry's ecosystem already writes.
   *
   * Absent for every package manager, and for a runtime whose ecosystem has no
   * such convention: it is not a property of the {@link ToolKind}. It ranks
   * strictly below the manifest — §03.1 consults it only where the manifest
   * declared nothing — and is never written back.
   */
  versionFile?: VersionFileSpec;
  /**
   * §10.5 — whether a bare `jup enable` installs this entry's shims.
   *
   * Absent means yes, which is every entry corepack ever had. `false` is for an
   * entry whose binary name is routinely a *system* install the user chose
   * deliberately — bun and deno are runtimes first and package managers second —
   * so silently taking the name over on upgrade would be a change nobody asked
   * for. Naming the entry (`jup enable bun`) still installs it; `--all` in
   * `install` is unaffected, because that is about the cache, not `PATH`.
   *
   * Required to be `false` when {@link ToolDefinition.kind} is `"runtime"`.
   */
  shimByDefault?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Trust store — §02.6                                                        */
/* -------------------------------------------------------------------------- */

export interface TrustedKey {
  /** ISO-8601 timestamp, or `null` for "never expires". Honoured per §14.4. */
  expires: string | null;
  keyid: string;
  keytype: string;
  scheme: string;
  /** base64 DER SubjectPublicKeyInfo, no PEM armour. */
  key: string;
}

/**
 * §02.6, §15.10 — keyed by registry origin.
 *
 * Phase 1 populates only `https://registry.npmjs.org`. Corepack's legacy
 * `{"npm": [...]}` shape maps onto the default registry's origin on read.
 */
export type TrustStore = Record<string, TrustedKey[]>;

/**
 * One `dist.signatures` entry from an npm packument.
 *
 * Both fields are optional: the array reaches §06.3 exactly as the registry sent
 * it (an entry missing its `keyid` must take step 4's branch and appear in the
 * diagnostic, not be silently dropped), so neither field can be assumed present.
 */
export interface RegistrySignature {
  keyid?: string;
  sig?: string;
}

/* -------------------------------------------------------------------------- */
/* Project manifest — §02.7, §03                                              */
/* -------------------------------------------------------------------------- */

/** The raw, unvalidated shape of one `devEngines` member (§02.7). */
export interface DevEnginesEntry {
  name?: unknown;
  version?: unknown;
  onFail?: unknown;
}

export interface Manifest {
  /**
   * §03.4, §15.39 — never a `kind: "runtime"` name. A manifest that says
   * otherwise is the §12.12 error, not a pin.
   */
  packageManager?: unknown;
  devEngines?: {
    packageManager?: unknown;
    /** §15.39 — the only field a runtime's pin can live in. */
    runtime?: unknown;
  };
  [key: string]: unknown;
}

/**
 * §03.1 — the declared `version` range of the `devEngines` member that speaks
 * for the requested tool, when one is declared.
 *
 * Which member that is comes from the tool's {@link ToolKind}: `packageManager`
 * for a package manager, `runtime` for a runtime (§03.3). It is not carried on
 * this view: every consumer already knows the tool it asked about, and deriving
 * the member from that is what keeps one answer rather than two.
 */
export interface DevEnginesRange {
  name: string;
  range: string;
  onFail?: string;
}

/**
 * §15.26 — the validated `devEngines.packageManager`, whether or not it names a
 * version.
 *
 * {@link DevEnginesRange} is the Descriptor-shaped view and exists only when a
 * `version` was declared, because §09.1 hands it straight to the resolver. This
 * is the *declaration*, and the difference is load-bearing: a `devEngines` block
 * carrying only a `name` still constrains what a pin may say, and a `writePin`
 * that cannot see it will happily write a `packageManager` field that §03.3 then
 * refuses to read on every later run.
 */
export interface DevEnginesDeclaration {
  name: string;
  version?: string;
  onFail?: string;
}

/**
 * §03.4 — how strict `parseSpec` is about the version half of a spec.
 *
 * `requireVersion` is what used to be `enforceExactVersion`, and the change of
 * meaning is §15.23: a `packageManager` pin must still *name* a version (a bare
 * `yarn` is still the "No version specified" error), but that version may now be
 * a semver range or a dist-tag as well as an exact release. Nothing in the
 * pipeline demands an exact version any more; what a range costs instead is a
 * recorded resolution in `.jup.lock`.
 */
export interface ParseSpecOptions {
  requireVersion: boolean;
  /**
   * §03.4, §15.39 — is this string a manifest's `packageManager` field?
   *
   * The one place a `kind: "runtime"` name is rejected. It is a property of the
   * *field*, not of `parseSpec`: `jup node@22`, `jup use node@22` and
   * `jup install -g node@24` all put a runtime name through this same function
   * from `CLI arguments`, and all three are ordinary. Only the committed pin must
   * not claim a runtime is the project's package manager, because that is the
   * field §03.5 enforces `pnpm` and `yarn` with.
   */
  packageManagerField?: boolean;
}

/** §03.1 — the three outcomes of the upward walk. */
export type SpecResult =
  | { type: "NoProject"; target: string; envFilePath?: string }
  | { type: "NoSpec"; target: string; envFilePath?: string }
  | {
      type: "Found";
      target: string;
      /** Lazy: parses and validates only when called, so `use` can overwrite a malformed field. */
      getSpec: (opts: ParseSpecOptions) => Descriptor;
      range?: DevEnginesRange;
      /**
       * §15.26 — the declared `devEngines` member for the requested tool,
       * version or not. §15.39: `devEngines.packageManager` for a package
       * manager, `devEngines.runtime` for a runtime.
       */
      devEngines?: DevEnginesDeclaration;
      /**
       * Whether the manifest itself declares `packageManager`, as opposed to the
       * spec having been synthesised from `devEngines.packageManager` (§03.3).
       * §15.23's `up` needs the distinction: a declared range is the user's own
       * statement of intent and must survive an update, while a synthesised one
       * is what row 114 turns into a fresh pin.
       */
      hasPin?: boolean;
      envFilePath?: string;
    };

/* -------------------------------------------------------------------------- */
/* Invocation — §01.2                                                         */
/* -------------------------------------------------------------------------- */

export type Invocation =
  | {
      mode: "proxy";
      /** Any binary name the table declares (§02.4) — of either {@link ToolKind}. */
      binaryName: string;
      /** Present when the CLI argument was `<binary>@<version>` (§04.6). */
      binaryVersion?: string;
      args: string[];
    }
  | { mode: "management"; args: string[] };
