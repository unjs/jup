/**
 * Manifest reading and format-preserving rewriting — §03.7, §16.4, §14.7.
 *
 * `use` / `up` / auto-pin must edit `package.json` while preserving key order,
 * indentation, line endings, and (per §14.7) the BOM. Serialising a parsed DOM
 * loses all of that, so the write path is a **surgical text edit**: locate the
 * value span of the top-level key and replace just the string literal.
 *
 * This needs a JSON *scanner* — one that respects escapes and nesting so a
 * nested `"packageManager"` is never mistaken for the top-level one — but not a
 * *builder*.
 */

export interface ManifestFormat {
  /** First `/^[ \t]+/m` match in the original, else two spaces. Preserves tabs. */
  indent: string;
  /** `\r\n` iff CRLF strictly outnumbers bare LF; platform EOL if the file had no newlines. */
  eol: string;
  hasBom: boolean;
}

/** Tolerant read: strips a BOM for parsing, treats empty content as `{}`. */
export function parseManifest(text: string): unknown {
  throw new Error(`TODO(T5): parseManifest(${text.length} chars)`);
}

export function detectFormat(text: string): ManifestFormat {
  throw new Error(`TODO(T5): detectFormat(${text.length} chars)`);
}

/** Byte span of a top-level key's *value*, or null when the key is absent. */
export function scanTopLevelKey(text: string, key: string): { start: number; end: number } | null {
  throw new Error(`TODO(T5): scanTopLevelKey(${key})`);
}

/**
 * Replace (or insert) a top-level string-valued key, touching nothing else.
 * Inserts after the opening brace at the detected indentation when absent, and
 * handles the empty-object case.
 */
export function setTopLevelString(text: string, key: string, value: string): string {
  throw new Error(`TODO(T5): setTopLevelString(${key}, ${value})`);
}
