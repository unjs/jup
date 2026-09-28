import { describe, expect, it } from "vitest";
import {
  binDrift,
  NODE_LTS_AFTER_DAYS,
  nodeLtsDue,
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
    // Per-host metadata, `{exe}` substituted per host.
    const aube = { aube: "bin/aube", aubr: "bin/aubr", aubx: "bin/aubx" };
    expect(binDrift("aube", lastBand("aube").bin, aube, "")).toEqual([]);
    const aubeWin = { aube: "bin/aube.exe", aubr: "bin/aubr.exe", aubx: "bin/aubx.exe" };
    expect(binDrift("aube", lastBand("aube").bin, aubeWin, ".exe")).toEqual([]);
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
