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

/** §02.1 — a package manager name plus anything range-ish: version, range, tag, URL. */
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

/** §02.4 — `{ [binaryName]: relativePathInPackage }`, used when the download is a tarball. */
export type BinSpec = Record<string, string>;

/** §02.4 — `[binaryName, …]`, used when the download is a single `.js` file. */
export type BinList = string[];

/** §07.2 — the parsed `.jup` marker plus the directory it was found in. */
export interface InstallSpec {
  location: string;
  /** Optional: a marker written by an older corepack may not carry one (§08.1). */
  bin?: BinSpec | BinList;
  hash: string;
}

/** §07.2 — the on-disk shape of the `.jup` marker file. */
export interface CorepackMarker {
  locator: Locator;
  /** Optional: markers written by older corepack releases omit it (§08.1). */
  bin?: BinSpec | BinList;
  hash: string;
}

/* -------------------------------------------------------------------------- */
/* Registry specs — §02.2                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Talk the npm registry protocol (§05.2).
 *
 * `bin` is a path *inside the tarball* to a single file; when present the
 * downloader extracts only that one file (§07.4).
 */
export interface NpmRegistrySpec {
  type: "npm";
  package: string;
  bin?: string;
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
/* Package manager definitions — §02.3, §02.4                                 */
/* -------------------------------------------------------------------------- */

/** §02.4 — how to download and run one version band of a package manager. */
export interface PackageManagerSpec {
  /** Download URL template; `{}` is replaced by the version. */
  url: string;
  bin: BinSpec | BinList;
  /** Default version source. */
  registry: RegistrySpec;
  /** Used *instead of* `registry` when the user has set a custom npm registry (§05.3). */
  npmRegistry?: NpmRegistrySpec;
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
 * §02.3 — one supported package manager.
 *
 * `ranges` is an **ordered list**, not a map: lookup reverses it and takes the
 * first entry whose range is satisfied, so **last declared wins**. Dist-tags are
 * always resolved against the **last** entry's registry.
 */
export interface PackageManagerDefinition {
  /** Compiled-in fallback version, hash-pinned. */
  default: string;
  /** Where "what's the newest stable?" is answered. */
  fetchLatestFrom: RegistrySpec;
  transparent: {
    /** Fallback version for transparent commands only (§01.4). */
    default?: string;
    /** Command prefixes that bypass the project check. */
    commands: string[][];
  };
  ranges: Array<readonly [range: string, spec: PackageManagerSpec]>;
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

export interface DevEnginesPackageManager {
  name?: unknown;
  version?: unknown;
  onFail?: unknown;
}

export interface Manifest {
  packageManager?: unknown;
  devEngines?: { packageManager?: unknown };
  [key: string]: unknown;
}

/** §03.1 — the `devEngines.packageManager.version` range, when one is declared. */
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
      /** §15.26 — the declared `devEngines.packageManager`, version or not. */
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
      binaryName: string;
      /** Present when the CLI argument was `<binary>@<version>` (§04.6). */
      binaryVersion?: string;
      args: string[];
    }
  | { mode: "management"; args: string[] };
