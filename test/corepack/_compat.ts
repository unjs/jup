/**
 * The three Corepack internals the ported tests import, mapped onto jup's.
 *
 * Upstream reads `config.json` and `sources/{Engine,types}.ts`; jup keeps the
 * same information in the embedded table (§02.4), in the same shape — a
 * `default` reference per package manager, and a binary list per name — so the
 * mapping is a rename, not a translation.
 */

import {
  DEFINITIONS,
  getBinariesFor,
  shimsByDefault,
  SUPPORTED_NAMES,
} from "../../src/config/table.ts";

/**
 * Stands in for `import config from '../config.json'`.
 *
 * The ported rows read `config.definitions.pnpm.default` directly, the way
 * upstream's JSON import lets them. jup's table is a `Record`, and the project
 * compiles with `noUncheckedIndexedAccess`, so the type is narrowed to the
 * three names those rows actually name — otherwise every such read would need a
 * non-null assertion added to the test body.
 */
type Definition = (typeof DEFINITIONS)[string];

export const config = { definitions: DEFINITIONS } as unknown as {
  definitions: Record<SupportedPackageManager, Definition>;
};

/** Stands in for `new Engine()`; only `getBinariesFor` is ever called. */
export const engine = { getBinariesFor };

/**
 * Upstream types this as a set of the literal names; the rows index `config` with
 * it. Corepack's three, plus §03.1's four and §02.3's runtime — none of which
 * upstream has any notion of, and which the rows that iterate this set therefore
 * have to be read against: see the `deno --version` note in `main.test.ts`.
 *
 * The name the type carries is upstream's and is now half wrong — `node` is a
 * runtime — but renaming it would diverge from the vendored rows for nothing.
 */
export type SupportedPackageManager =
  | "npm"
  | "pnpm"
  | "yarn"
  | "bun"
  | "deno"
  | "aube"
  | "nub"
  | "node";

export const SupportedPackageManagerSet = new Set(
  SUPPORTED_NAMES as readonly SupportedPackageManager[],
);

/**
 * The set the shim rows iterate: what a bare `enable`/`disable` acts on.
 *
 * Upstream's name says "without npm" (§10.1), and that is still the reason npm is
 * absent here even though §10.7 put it back in jup's own default set — these rows
 * assert corepack's behaviour and are skipped where the two diverge. §02.5's `bun`
 * and `deno` are excluded for the *live* reason: they set `shimByDefault: false`,
 * so a bare `enable` genuinely does not create them, and a row expecting otherwise
 * would be asserting something jup does not do. `nub` sets it too, and is excluded
 * for the same reason despite being a package manager. §03.1's `aube` does not
 * set it and so is *included*, which is the point of filtering on the flag rather
 * than listing names.
 */
export const SupportedPackageManagerSetWithoutNpm = new Set(
  (SUPPORTED_NAMES as readonly SupportedPackageManager[]).filter(
    (name) => name !== `npm` && shimsByDefault(name),
  ),
);
