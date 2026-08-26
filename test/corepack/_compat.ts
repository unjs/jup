/**
 * The three Corepack internals the ported tests import, mapped onto jup's.
 *
 * Upstream reads `config.json` and `sources/{Engine,types}.ts`; jup keeps the
 * same information in the embedded table (§02.4), in the same shape — a
 * `default` reference per package manager, and a binary list per name — so the
 * mapping is a rename, not a translation.
 */

import { DEFINITIONS, getBinariesFor, SUPPORTED_NAMES } from "../../src/config/table.ts";

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

/** Upstream types this as a set of the literal names; the rows index `config` with it. */
export type SupportedPackageManager = "npm" | "pnpm" | "yarn";

export const SupportedPackageManagerSet = new Set(
  SUPPORTED_NAMES as readonly SupportedPackageManager[],
);

/** `enable`/`disable` never touch npm's shims by default (§10.1). */
export const SupportedPackageManagerSetWithoutNpm = new Set(
  (SUPPORTED_NAMES as readonly SupportedPackageManager[]).filter((name) => name !== `npm`),
);
