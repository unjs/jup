import { describe, expect, it } from "vitest";
import {
  binDrift,
  NODE_LTS_AFTER_DAYS,
  nodeLtsDue,
  nodeMirrorLag,
  publishedBins,
} from "../../scripts/refresh-review.ts";
import { DEFINITIONS } from "../../src/config/table.ts";

/**
 * §16 — what `scripts/refresh-table.mjs` flags for review. The script itself
 * talks to the registry; its judgement lives in `refresh-review.ts` so it can be
 * pinned here with the metadata shapes npm actually publishes.
 */
describe("refresh review: bin drift", () => {
  const lastBand = (name: string) => DEFINITIONS[name]!.ranges.at(-1)![1];

  it("normalizes npm's `bin` field, string form included", () => {
    expect(publishedBins("@scope/tool", "./cli.js")).toEqual({ tool: "cli.js" });
    expect(publishedBins("npm", { npm: "bin/npm-cli.js" })).toEqual({ npm: "bin/npm-cli.js" });
    expect(publishedBins("pnpm", undefined)).toBeUndefined();
  });

  it("accepts the bins today's releases publish", () => {
    expect(
      binDrift("npm", lastBand("npm").bin, { npm: "bin/npm-cli.js", npx: "bin/npx-cli.js" }, ""),
    ).toEqual([]);
    // Per-host metadata, `{exe}` substituted per host. From 2.7.0 aube publishes
    // one bin, and the band's `aubr` and `aubx` alias its path.
    expect(binDrift("aube", lastBand("aube").bin, { aube: "bin/aube" }, "")).toEqual([]);
    expect(binDrift("aube", lastBand("aube").bin, { aube: "bin/aube.exe" }, ".exe")).toEqual([]);
  });

  it("allows a band-only alias of a published path", () => {
    expect(
      binDrift("nub", { nub: "./bin/nub", nubx: "./bin/nub" }, { nub: "bin/nub" }, ""),
    ).toEqual([]);
  });

  it("flags a moved path, a vanished bin and an unexposed new one", () => {
    const found = binDrift(
      "tool@2.0.0",
      { tool: "./bin/tool.js", toolx: "./bin/toolx.js" },
      { tool: "dist/tool.mjs", extra: "dist/extra.mjs" },
      "",
    );
    expect(found).toEqual([
      "tool@2.0.0: `tool` is dist/tool.mjs upstream but bin/tool.js in the band",
      "tool@2.0.0: the band's `toolx` (bin/toolx.js) is not a bin upstream publishes",
      "tool@2.0.0: upstream adds `extra` (dist/extra.mjs), which the band does not expose",
    ]);
  });
});

describe("refresh review: node LTS nudge", () => {
  const day = 86_400_000;
  const released = Date.parse("2026-05-06T00:00:00.000Z");
  const time = { "26.0.0": new Date(released).toISOString() };

  it("stays quiet until the next even major is about six months old", () => {
    expect(nodeLtsDue(time, 24, released + (NODE_LTS_AFTER_DAYS - 1) * day)).toBeUndefined();
    expect(nodeLtsDue({}, 24, released + 400 * day)).toBeUndefined();
  });

  it("asks once it is", () => {
    expect(nodeLtsDue(time, 24, released + NODE_LTS_AFTER_DAYS * day)).toMatch(
      /^node 26\.0\.0 was published 170 days ago .* move to 26 \(§02\.3\)\.$/,
    );
  });
});

describe("refresh review: node mirror lag", () => {
  // The shape and order nodejs.org/dist/index.json publishes: newest first,
  // every line interleaved.
  const releases = [
    { version: "v26.12.0", date: "2026-10-19" },
    { version: "v24.22.1", date: "2026-10-20" },
    { version: "v24.22.0", date: "2026-10-14" },
    { version: "v22.30.4", date: "2026-10-01" },
  ];

  it("flags a release on the line that npm does not carry yet", () => {
    expect(nodeMirrorLag(releases, 24, "24.22.0")).toBe(
      "node 24.22.1 is out on nodejs.org (2026-10-20) but npm's `node` packages stop at " +
        "24.22.0 — the table follows npm (§02.2), so re-run once npm publishes it.",
    );
  });

  it("compares numerically, not as strings", () => {
    const later = [{ version: "v24.100.0", date: "2027-01-01" }, ...releases];
    expect(nodeMirrorLag(later, 24, "24.99.9")).toMatch(/^node 24\.100\.0 /);
  });

  it("stays quiet when npm has caught up, or the index is empty", () => {
    expect(nodeMirrorLag(releases, 24, "24.22.1")).toBeUndefined();
    expect(nodeMirrorLag([], 24, "24.22.0")).toBeUndefined();
  });

  it("ignores other lines and prereleases", () => {
    const noise = [{ version: "v24.23.0-rc.1", date: "2026-10-21" }, ...releases];
    expect(nodeMirrorLag(noise, 22, "22.30.4")).toBeUndefined();
    expect(nodeMirrorLag(noise, 24, "24.22.1")).toBeUndefined();
  });
});
