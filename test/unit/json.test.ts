import { EOL } from "node:os";
import { describe, expect, it } from "vitest";
import {
  detectFormat,
  parseManifest,
  scanTopLevelFields,
  scanTopLevelKey,
  setNestedString,
  setTopLevelString,
} from "../../src/json.ts";

const BOM = "﻿";

describe("parseManifest", () => {
  it("parses a plain manifest", () => {
    expect(parseManifest(`{"name":"x"}`)).toEqual({ name: "x" });
  });

  it("treats empty and whitespace-only content as {} (§03.7 step 4)", () => {
    expect(parseManifest("")).toEqual({});
    expect(parseManifest("\n\t \r\n")).toEqual({});
  });

  it("strips a UTF-8 BOM before parsing (test 12)", () => {
    expect(parseManifest(`${BOM}{"packageManager":"yarn@1.22.4"}`)).toEqual({
      packageManager: "yarn@1.22.4",
    });
  });

  it("throws on invalid JSON so the caller can report Invalid package.json", () => {
    expect(() => parseManifest(`{"name":}`)).toThrow();
    expect(() => parseManifest(`nope`)).toThrow();
  });
});

describe("detectFormat", () => {
  it("keeps tabs as tabs and spaces as spaces", () => {
    expect(detectFormat(`{\n\t"name": "x"\n}\n`).indent).toBe("\t");
    expect(detectFormat(`{\n    "name": "x"\n}\n`).indent).toBe("    ");
  });

  it("falls back to two spaces when nothing is indented", () => {
    expect(detectFormat(`{"name":"x"}`).indent).toBe("  ");
  });

  it("picks CRLF only when it strictly outnumbers bare LF", () => {
    expect(detectFormat(`{\r\n\t"name": "x"\r\n}\r\n`).eol).toBe("\r\n");
    expect(detectFormat(`{\n  "name": "x"\n}\n`).eol).toBe("\n");
    // A tie falls back to LF.
    expect(detectFormat(`{\r\n  "a": 1,\n  "b": 2}`).eol).toBe("\n");
  });

  it("uses the platform EOL when the file has no newline at all", () => {
    expect(detectFormat(`{"name":"x"}`).eol).toBe(EOL);
  });

  it("reports the BOM", () => {
    expect(detectFormat(`${BOM}{}`).hasBom).toBe(true);
    expect(detectFormat(`{}`).hasBom).toBe(false);
  });
});

describe("scanTopLevelKey", () => {
  it("returns the span of the value, not the key", () => {
    const text = `{"name":"x","packageManager":"yarn@1.0.0"}`;
    const span = scanTopLevelKey(text, "packageManager")!;
    expect(text.slice(span.start, span.end)).toBe(`"yarn@1.0.0"`);
  });

  it("returns null when the key is absent or the document is not an object", () => {
    expect(scanTopLevelKey(`{"name":"x"}`, "packageManager")).toBeNull();
    expect(scanTopLevelKey(`{}`, "packageManager")).toBeNull();
    expect(scanTopLevelKey(`[1,2,3]`, "packageManager")).toBeNull();
    expect(scanTopLevelKey(``, "packageManager")).toBeNull();
  });

  it("skips a BOM", () => {
    const text = `${BOM}{"packageManager":"yarn@1.0.0"}`;
    const span = scanTopLevelKey(text, "packageManager")!;
    expect(text.slice(span.start, span.end)).toBe(`"yarn@1.0.0"`);
  });

  it("never mistakes a nested packageManager inside devEngines for the top-level one", () => {
    const text = [
      `{`,
      `  "devEngines": {`,
      `    "packageManager": { "name": "pnpm", "version": "9.x" }`,
      `  },`,
      `  "packageManager": "pnpm@9.1.0"`,
      `}`,
    ].join("\n");
    const span = scanTopLevelKey(text, "packageManager")!;
    expect(text.slice(span.start, span.end)).toBe(`"pnpm@9.1.0"`);
  });

  it("returns null when the only packageManager is nested", () => {
    const nestedObject = `{"devEngines":{"packageManager":{"name":"pnpm"}}}`;
    expect(scanTopLevelKey(nestedObject, "packageManager")).toBeNull();

    const nestedArray = `{"workspaces":[{"packageManager":"yarn@1.0.0"}],"name":"x"}`;
    expect(scanTopLevelKey(nestedArray, "packageManager")).toBeNull();
  });

  it("is not confused by escaped quotes and braces inside strings", () => {
    const text = `{"description":"a \\" }{ \\\\","other":"{\\"packageManager\\":\\"yarn@9.9.9\\"}","packageManager":"yarn@1.0.0"}`;
    const span = scanTopLevelKey(text, "packageManager")!;
    expect(text.slice(span.start, span.end)).toBe(`"yarn@1.0.0"`);
    // Sanity: the fixture really is valid JSON with a nested-looking string.
    expect((parseManifest(text) as Record<string, string>).other).toBe(
      `{"packageManager":"yarn@9.9.9"}`,
    );
  });

  it("finds keys whose values are numbers, booleans, null, arrays and objects", () => {
    const text = `{"a":1e-3,"b":true,"c":null,"d":[1,[2]],"e":{"f":{}},"packageManager":"yarn@1.0.0"}`;
    for (const [key, expected] of [
      ["a", "1e-3"],
      ["b", "true"],
      ["c", "null"],
      ["d", "[1,[2]]"],
      ["e", `{"f":{}}`],
      ["packageManager", `"yarn@1.0.0"`],
    ] as const) {
      const span = scanTopLevelKey(text, key)!;
      expect(text.slice(span.start, span.end)).toBe(expected);
    }
  });

  it("decodes escaped key names", () => {
    const text = `{"packageManag\\u0065r":"yarn@1.0.0"}`;
    const span = scanTopLevelKey(text, "packageManager")!;
    expect(text.slice(span.start, span.end)).toBe(`"yarn@1.0.0"`);
  });
});

describe("setTopLevelString", () => {
  it("replaces an existing value and touches nothing else", () => {
    const before = `{\n  "name": "x",\n  "packageManager": "yarn@1.0.0",\n  "private": true\n}\n`;
    const after = setTopLevelString(before, "packageManager", "yarn@1.22.4+sha512.abc");
    expect(after).toBe(
      `{\n  "name": "x",\n  "packageManager": "yarn@1.22.4+sha512.abc",\n  "private": true\n}\n`,
    );
  });

  it("overwrites a malformed non-string value (test 109)", () => {
    for (const value of [`10`, `null`, `{"name":"yarn"}`, `["yarn@1"]`]) {
      const after = setTopLevelString(
        `{"packageManager":${value},"name":"x"}`,
        "packageManager",
        "yarn@1.22.4",
      );
      expect(after).toBe(`{"packageManager":"yarn@1.22.4","name":"x"}`);
    }
  });

  it("preserves tab indentation and key order when inserting (test 116)", () => {
    const before = `{\n\t"name": "x",\n\t"version": "1.0.0"\n}\n`;
    const after = setTopLevelString(before, "packageManager", "yarn@1.22.4");
    expect(after).toBe(
      `{\n\t"packageManager": "yarn@1.22.4",\n\t"name": "x",\n\t"version": "1.0.0"\n}\n`,
    );
    expect(Object.keys(parseManifest(after) as object)).toEqual([
      "packageManager",
      "name",
      "version",
    ]);
  });

  it("round-trips a CRLF file with only the pin changed (test 116)", () => {
    const before = `{\r\n  "name": "x",\r\n  "packageManager": "yarn@1.0.0"\r\n}\r\n`;
    const after = setTopLevelString(before, "packageManager", "yarn@1.22.4");
    expect(after).toBe(`{\r\n  "name": "x",\r\n  "packageManager": "yarn@1.22.4"\r\n}\r\n`);
    expect(
      after.split("\n").every((line, i, all) => i === all.length - 1 || line.endsWith("\r")),
    ).toBe(true);
  });

  it("uses CRLF for the inserted line in a CRLF file (test 116)", () => {
    const before = `{\r\n  "name": "x"\r\n}\r\n`;
    const after = setTopLevelString(before, "packageManager", "yarn@1.22.4");
    expect(after).toBe(`{\r\n  "packageManager": "yarn@1.22.4",\r\n  "name": "x"\r\n}\r\n`);
  });

  it("keeps the BOM after a rewrite (test 13, §14.7)", () => {
    const replaced = setTopLevelString(
      `${BOM}{\n  "packageManager": "yarn@1.0.0"\n}\n`,
      "packageManager",
      "yarn@1.22.4",
    );
    expect(replaced.startsWith(BOM)).toBe(true);
    expect(replaced).toBe(`${BOM}{\n  "packageManager": "yarn@1.22.4"\n}\n`);

    const inserted = setTopLevelString(`${BOM}{\n  "name": "x"\n}\n`, "packageManager", "yarn@1");
    expect(inserted.startsWith(BOM)).toBe(true);
    expect(parseManifest(inserted)).toEqual({ packageManager: "yarn@1", name: "x" });
  });

  it("inserts into an empty object", () => {
    expect(setTopLevelString(`{}\n`, "packageManager", "yarn@1.22.4")).toBe(
      `{\n  "packageManager": "yarn@1.22.4"\n}\n`,
    );
    expect(setTopLevelString(`{\n}\n`, "packageManager", "yarn@1.22.4")).toBe(
      `{\n  "packageManager": "yarn@1.22.4"\n}\n`,
    );
  });

  it("creates a manifest from empty content (§03.7 step 9)", () => {
    const created = setTopLevelString("", "packageManager", "yarn@1.22.4");
    expect(created).toBe(`{${EOL}  "packageManager": "yarn@1.22.4"${EOL}}${EOL}`);
    expect(parseManifest(created)).toEqual({ packageManager: "yarn@1.22.4" });
  });

  it("handles a file with no newlines at all", () => {
    expect(setTopLevelString(`{"name":"x"}`, "packageManager", "yarn@1.22.4")).toBe(
      `{"packageManager": "yarn@1.22.4","name":"x"}`,
    );
    expect(setTopLevelString(`{}`, "packageManager", "yarn@1.22.4")).toBe(
      `{${EOL}  "packageManager": "yarn@1.22.4"${EOL}}`,
    );
  });

  it("does not overwrite a nested key of the same name", () => {
    const before = `{\n  "devEngines": {\n    "packageManager": { "name": "pnpm" }\n  }\n}\n`;
    const after = setTopLevelString(before, "packageManager", "pnpm@9.1.0");
    expect(after).toBe(
      `{\n  "packageManager": "pnpm@9.1.0",\n  "devEngines": {\n    "packageManager": { "name": "pnpm" }\n  }\n}\n`,
    );
    expect(parseManifest(after)).toEqual({
      packageManager: "pnpm@9.1.0",
      devEngines: { packageManager: { name: "pnpm" } },
    });
  });

  it("escapes values that need escaping", () => {
    const after = setTopLevelString(`{}`, "packageManager", `yarn@"1"`);
    expect(parseManifest(after)).toEqual({ packageManager: `yarn@"1"` });
  });

  it("keeps surrounding keys in order when replacing", () => {
    const before = `{\n  "a": 1,\n  "packageManager": "yarn@1.0.0",\n  "z": 2\n}\n`;
    const after = setTopLevelString(before, "packageManager", "yarn@2.0.0");
    expect(Object.keys(parseManifest(after) as object)).toEqual(["a", "packageManager", "z"]);
  });

  it("refuses to edit content that is not a JSON object", () => {
    expect(() => setTopLevelString(`[1,2,3]`, "packageManager", "yarn@1")).toThrow();
    expect(() => setTopLevelString(`{`, "packageManager", "yarn@1")).toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * §16.3 — the DOM-free warm-path scan
 * ------------------------------------------------------------------ */

const FIELDS = ["packageManager", "devEngines"];

describe("scanTopLevelFields", () => {
  it("extracts the requested top-level fields and nothing else", () => {
    const text = `{"name":"x","packageManager":"pnpm@9.1.0","dependencies":{"a":"^1"}}`;
    expect(scanTopLevelFields(text, FIELDS)).toEqual({ packageManager: "pnpm@9.1.0" });
  });

  it("reads a nested devEngines block", () => {
    const text = `{"devEngines":{"packageManager":{"name":"pnpm","onFail":"warn"}}}`;
    expect(scanTopLevelFields(text, FIELDS)).toEqual({
      devEngines: { packageManager: { name: "pnpm", onFail: "warn" } },
    });
  });

  it("never mistakes a nested key for a top-level one", () => {
    const text = `{"nested":{"packageManager":"yarn@1.0.0"},"a":[{"packageManager":1}]}`;
    expect(scanTopLevelFields(text, FIELDS)).toEqual({});
  });

  it("skips the BOM and an empty object", () => {
    expect(scanTopLevelFields(`${BOM}{"packageManager":"yarn@1.22.4"}`, FIELDS)).toEqual({
      packageManager: "yarn@1.22.4",
    });
    expect(scanTopLevelFields(`  {}  `, FIELDS)).toEqual({});
  });

  it("takes the last of duplicate keys, exactly as JSON.parse does", () => {
    const text = `{"packageManager":"yarn@1.0.0","packageManager":"pnpm@9.0.0"}`;
    expect(scanTopLevelFields(text, FIELDS)).toEqual(JSON.parse(text) as Record<string, unknown>);
  });

  it.for([
    ['{"packageManager":"yarn@1.0.0"'],
    ["{"],
    [""],
    ["   "],
    ["[1,2,3]"],
    ["null"],
    ['{"a":tru}'],
    ['{"a":01}'],
    ['{"a":+1}'],
    ['{"a":1.}'],
    ['{"a":1e}'],
    ['{"a":1,}'],
    ['{"a" 1}'],
    ['{"a":"unterminated}'],
    ['{"a":"bad \\x escape"}'],
    ['{"a":"raw\u0001control"}'],
    ['{"a":1} trailing'],
    ["{a:1}"],
    ["{'a':1}"],
    ['{"a":[1,]}'],
    ['{"a":{"b":}}'],
    ['{"pack\\u0061geManager":"yarn@1.0.0"}'],
  ])("defers to the real parser for %j", ([text]) => {
    // Never a guess: anything the scan cannot prove well-formed comes back
    // `null`, so §03.1's `Invalid package.json` still fires on exactly the same
    // inputs it fired on before.
    expect(scanTopLevelFields(text!, FIELDS)).toBeNull();
  });

  it("accepts nothing JSON.parse would reject", () => {
    // A differential check over the shapes a manifest can take: whenever the
    // scan answers, the answer agrees with a real parse.
    const corpus = [
      `{}`,
      `{"packageManager":"yarn@1.0.0"}`,
      `{"a":-0.5e+10,"packageManager":"pnpm@9.0.0"}`,
      `{"a":[],"b":{},"c":[[{"d":[true,false,null]}]]}`,
      String.raw`{"a":"\u00e9\n\t\\\"","devEngines":{"packageManager":{"name":"npm"}}}`,
      `{"a":1}`,
      `{ "a" : 1 , "b" : 2 }`,
      `\n{\n  "packageManager": "yarn@4.0.0"\n}\n`,
    ];

    for (const text of corpus) {
      const scanned = scanTopLevelFields(text, FIELDS);
      expect(scanned).not.toBeNull();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      for (const key of FIELDS) {
        expect(scanned![key]).toEqual(parsed[key]);
      }
    }
  });

  it("gives up rather than recursing without bound", () => {
    const deep = `{"a":${"[".repeat(200)}1${"]".repeat(200)}}`;
    expect(scanTopLevelFields(deep, FIELDS)).toBeNull();
    // And the caller's fallback still reads it correctly.
    expect(parseManifest(deep)).toBeTypeOf("object");
  });
});

describe("setNestedString — §15.26", () => {
  const manifest = [
    "{",
    `  "name": "project",`,
    `  "devEngines": {`,
    `    "packageManager": {`,
    `      "name": "pnpm",`,
    `      "version": "^11.0.0"`,
    "    }",
    "  },",
    `  "scripts": {`,
    `    "build": "tsc"`,
    "  }",
    "}",
    "",
  ].join("\n");

  const PATH = ["devEngines", "packageManager", "version"];

  it("replaces a nested value, touching nothing else", () => {
    const updated = setNestedString(manifest, PATH, "11.1.2")!;

    expect(updated).toBe(manifest.replace(`"^11.0.0"`, `"11.1.2"`));
    expect(JSON.parse(updated)).toMatchObject({
      devEngines: { packageManager: { name: "pnpm", version: "11.1.2" } },
    });
  });

  it("inserts an absent leaf at the enclosing object's own indentation", () => {
    const updated = setNestedString(
      manifest,
      ["devEngines", "packageManager", "integrity"],
      "sha512-abc",
    )!;

    // Six spaces, not the document's two: a member of `devEngines.packageManager`
    // sits two levels in, and inheriting the top-level indent misaligns it.
    expect(updated).toContain(`      "integrity": "sha512-abc",`);
    expect(JSON.parse(updated)).toMatchObject({
      devEngines: { packageManager: { name: "pnpm", integrity: "sha512-abc" } },
    });
  });

  it("preserves tab indentation, CRLF line endings and a BOM", () => {
    const original =
      '\uFEFF{\r\n\t"devEngines": {\r\n\t\t"packageManager": {\r\n\t\t\t"version": "1.0.0"\r\n\t\t}\r\n\t}\r\n}\r\n';

    const updated = setNestedString(original, PATH, "2.0.0")!;

    expect(updated).toBe(original.replace(`"1.0.0"`, `"2.0.0"`));
    expect(updated.startsWith("\uFEFF")).toBe(true);
  });

  it("delegates a single-segment path to setTopLevelString", () => {
    expect(setNestedString(manifest, ["name"], "renamed")).toBe(
      setTopLevelString(manifest, "name", "renamed"),
    );
  });

  it("answers null rather than guessing when the path is not walkable", () => {
    // A missing intermediate, an intermediate that is not an object, and a top
    // level that is not an object at all.
    expect(setNestedString(`{"name":"x"}`, PATH, "1.0.0")).toBeNull();
    expect(setNestedString(`{"devEngines":42}`, PATH, "1.0.0")).toBeNull();
    expect(setNestedString(`{"devEngines":{"packageManager":[]}}`, PATH, "1.0.0")).toBeNull();
    expect(setNestedString(`[1,2,3]`, PATH, "1.0.0")).toBeNull();
    expect(setNestedString(`{`, PATH, "1.0.0")).toBeNull();
    expect(setNestedString(manifest, [], "1.0.0")).toBeNull();
  });

  it("re-parses its own output, so a bad edit never reaches disk", () => {
    const updated = setNestedString(manifest, PATH, `a "quoted" \\ value`)!;
    expect(JSON.parse(updated)).toMatchObject({
      devEngines: { packageManager: { version: `a "quoted" \\ value` } },
    });
  });

  it("handles an empty innermost object", () => {
    const updated = setNestedString(
      `{\n  "devEngines": {\n    "packageManager": {}\n  }\n}\n`,
      PATH,
      "1.0.0",
    )!;
    expect(JSON.parse(updated)).toEqual({
      devEngines: { packageManager: { version: "1.0.0" } },
    });
  });
});
