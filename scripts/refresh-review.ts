/**
 * §16, Built-in table and trust keys — the questions `refresh-table.mjs` can
 * *ask* but must not answer.
 *
 * A moved bin path needs a new `ranges` entry and a new LTS line needs
 * `NODE_LTS_LINE` moved; both are human review, and the script writes neither.
 * What it can do is notice, from registry metadata it already fetched, that one
 * of them is due — so the review is prompted by evidence rather than by a
 * reminder a reviewer has learned to skim past.
 *
 * Pure functions over npm metadata, kept out of the script so the suite can
 * pin their judgement without a network.
 */

import type { BinSpec } from "../src/types.ts";

/** npm's `bin`: a map, or a string that names one bin after the unscoped package. */
export type PublishedBin = string | Record<string, string> | undefined;

/** A `bin` path with the `./` npm tolerates removed, so both sides compare as written. */
function normalizePath(path: string): string {
  return path.replace(/^\.\//, "");
}

/** npm's `bin` field as a map, or `undefined` when the version publishes none. */
export function publishedBins(
  packageName: string,
  bin: PublishedBin,
): Record<string, string> | undefined {
  if (bin === undefined) return undefined;
  if (typeof bin === "string") {
    return { [packageName.replace(/^@[^/]+\//, "")]: normalizePath(bin) };
  }
  return Object.fromEntries(Object.entries(bin).map(([name, path]) => [name, normalizePath(path)]));
}

/**
 * Where a band's `bin` and what upstream publishes for a release disagree.
 *
 * `exe` is what `{exe}` becomes on the host `published` came from — `.exe` for a
 * `win32-*` artifact, empty otherwise. Three findings, one per way the band can
 * be wrong about a release:
 *
 * * a bin both sides name, at different paths — the band would exec a file that
 *   is not there;
 * * a band bin upstream does not name, at a path upstream does not ship either.
 *   A band-only *alias* (`nubx`, `pnpx`) pointing at a path upstream does
 *   publish is fine: jup dispatches it by `argv[0]` or `binArgs`;
 * * a bin upstream adds that the band does not expose — not breakage, but a
 *   decision nobody has made yet.
 */
export function binDrift(
  label: string,
  declared: BinSpec,
  published: Record<string, string>,
  exe: string,
): string[] {
  const found: string[] = [];
  const shipped = new Set(Object.values(published));

  for (const [name, raw] of Object.entries(declared)) {
    const path = normalizePath(raw).replaceAll("{exe}", exe);
    const upstream = published[name];
    if (upstream === undefined) {
      if (!shipped.has(path)) {
        found.push(`${label}: the band's \`${name}\` (${path}) is not a bin upstream publishes`);
      }
    } else if (upstream !== path) {
      found.push(`${label}: \`${name}\` is ${upstream} upstream but ${path} in the band`);
    }
  }

  for (const [name, path] of Object.entries(published)) {
    if (!(name in declared)) {
      found.push(`${label}: upstream adds \`${name}\` (${path}), which the band does not expose`);
    }
  }

  return found;
}

/**
 * Days after an even Node major's first release at which it is treated as
 * probably in LTS. Node 20, 22 and 24 were promoted 189, 188 and 175 days after
 * their `.0.0`; asking a little early costs a question, asking late costs weeks
 * on a line that is no longer the one `lts` means.
 */
export const NODE_LTS_AFTER_DAYS = 170;

/**
 * §02.3 — a nudge, from npm's own `time` field, that the next even major is
 * probably LTS by now.
 *
 * Not an answer: nodejs.org's schedule is the source §02.2 refuses, and moving
 * `NODE_LTS_LINE` stays a human's call. Release age is the one signal npm does
 * carry, and Node's cadence is regular enough for it to be worth asking.
 */
export function nodeLtsDue(
  time: Record<string, string>,
  line: number,
  now: number,
): string | undefined {
  const next = line + 2;
  const published = time[`${next}.0.0`];
  if (published === undefined) return undefined;

  const days = Math.floor((now - Date.parse(published)) / 86_400_000);
  if (days < NODE_LTS_AFTER_DAYS) return undefined;
  return (
    `node ${next}.0.0 was published ${days} days ago and even majors enter LTS about six ` +
    `months after release — check whether \`NODE_LTS_LINE\` should move to ${next} (§02.3).`
  );
}
