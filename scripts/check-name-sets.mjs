/**
 * §17.4 R8 — the disjointness invariant, asserted at **build** time.
 *
 * The four sets are `NAMES` (the table's tool and binary names), `SCOPE_WORDS`,
 * `VERBS` and `RESERVED`, and they MUST be pairwise disjoint. R8 puts the check
 * here rather than at startup for a specific reason: R7's ordering means a
 * collision does not *fail*, it silently makes one of the two spellings
 * unreachable. A package manager named `use` would shadow the `use` command at
 * step 1; a scope word that became a binary name would shadow the scope at step
 * 4. Neither raises anything a `(exitCode, stdout, stderr)` row could catch,
 * which is why §17.9 row 215 is explicitly a build assertion instead.
 *
 * Running it at build time also keeps it off the warm path: this is a property
 * of the source, and re-deriving it on every `yarn --version` would be paying
 * forever for a mistake that can only be made once, in a commit.
 *
 * `NAMES` is a **union** of tool names and binary names, so `yarn` appearing in
 * both is normal and is not what the invariant is about — the sets are deduped
 * before they are compared.
 *
 * The checking function is exported and unit-tested against a poisoned table
 * (`test/unit/name-sets.test.ts`); together the two are §17.9 row 215.
 */

import { pathToFileURL } from "node:url";
import { RESERVED, SCOPE_WORDS } from "../src/commands/router.ts";
import { VERBS } from "../src/commands/usage.ts";
import { DEFINITIONS, getBinariesFor, SUPPORTED_NAMES } from "../src/config/table.ts";

/**
 * Every pair of sets that shares a word.
 *
 * Returns the collisions rather than throwing, so a caller can report all of
 * them at once — a table that collides on one word usually collides on several.
 *
 * @param {Record<string, readonly string[]>} sets
 * @returns {{ left: string, right: string, word: string }[]}
 */
export function findCollisions(sets) {
  const entries = Object.entries(sets).map(
    /** @returns {[string, Set<string>]} */
    ([name, words]) => [name, new Set(words)],
  );

  const collisions = [];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [left, leftWords] = entries[i];
      const [right, rightWords] = entries[j];
      for (const word of leftWords) {
        if (rightWords.has(word)) collisions.push({ left, right, word });
      }
    }
  }
  return collisions;
}

/**
 * {@link findCollisions}, as an assertion.
 *
 * @param {Record<string, readonly string[]>} sets
 */
export function assertDisjoint(sets) {
  const collisions = findCollisions(sets);
  if (collisions.length === 0) return;

  const detail = collisions
    .map(({ left, right, word }) => `  '${word}' is in both ${left} and ${right}`)
    .join("\n");
  throw new Error(
    `§17.4 R8: the name sets are not pairwise disjoint.\n${detail}\n\n` +
      `R7's ordering makes a collision silent rather than an error — one of the two\n` +
      `spellings simply becomes unreachable. Rename the tool or binary, or record the\n` +
      `decision: a scope word MUST NOT be renamed to accommodate a name collision.`,
  );
}

/** The four sets as this build actually has them. */
export function nameSets() {
  return {
    // §02.4 — `BINARY_NAMES ∪ TOOL_NAMES`, from the table and nowhere else.
    NAMES: [
      ...SUPPORTED_NAMES,
      ...Object.keys(DEFINITIONS).flatMap((name) => getBinariesFor(name)),
    ],
    SCOPE_WORDS: Object.keys(SCOPE_WORDS),
    VERBS: [...VERBS],
    RESERVED: [...RESERVED],
  };
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const sets = nameSets();
  assertDisjoint(sets);
  const total = Object.values(sets).reduce((sum, words) => sum + new Set(words).size, 0);
  console.log(`§17.4 R8: ${total} names across 4 sets, pairwise disjoint.`);
}
