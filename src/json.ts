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

import { EOL } from "node:os";

const BOM = "﻿";

const CH_TAB = 0x09;
const CH_LF = 0x0a;
const CH_CR = 0x0d;
const CH_SPACE = 0x20;
const CH_QUOTE = 0x22;
const CH_COMMA = 0x2c;
const CH_COLON = 0x3a;
const CH_LBRACKET = 0x5b;
const CH_BACKSLASH = 0x5c;
const CH_RBRACKET = 0x5d;
const CH_LBRACE = 0x7b;
const CH_RBRACE = 0x7d;

export interface ManifestFormat {
  /** First `/^[ \t]+/m` match in the original, else two spaces. Preserves tabs. */
  indent: string;
  /** `\r\n` iff CRLF strictly outnumbers bare LF; platform EOL if the file had no newlines. */
  eol: string;
  hasBom: boolean;
}

/** Tolerant read: strips a BOM for parsing, treats empty content as `{}`. */
export function parseManifest(text: string): unknown {
  const body = stripBom(text);
  // An empty (or whitespace-only) manifest behaves as `{}` — §03.7 step 4.
  if (body.trim().length === 0) {
    return {};
  }
  return JSON.parse(body);
}

export function detectFormat(text: string): ManifestFormat {
  const indent = /^[ \t]+/m.exec(text)?.[0] ?? "  ";

  // Count CRLF against *bare* LF; a CRLF file has zero bare LFs. §03.7 step 8.
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === CH_LF) {
      if (i > 0 && text.charCodeAt(i - 1) === CH_CR) {
        crlf++;
      } else {
        lf++;
      }
    }
  }
  const eol = crlf === 0 && lf === 0 ? EOL : crlf > lf ? "\r\n" : "\n";

  return { indent, eol, hasBom: text.startsWith(BOM) };
}

/** Byte span of a top-level key's *value*, or null when the key is absent. */
export function scanTopLevelKey(text: string, key: string): { start: number; end: number } | null {
  let i = text.startsWith(BOM) ? BOM.length : 0;
  i = skipWhitespace(text, i);
  if (text.charCodeAt(i) !== CH_LBRACE) {
    return null; // Not an object at the top level: no top-level keys to find.
  }
  i = skipWhitespace(text, i + 1);

  while (i < text.length) {
    if (text.charCodeAt(i) === CH_RBRACE) {
      return null; // End of the object; key absent.
    }
    if (text.charCodeAt(i) !== CH_QUOTE) {
      return null; // Malformed — refuse to guess.
    }

    const keyStart = i;
    const keyEnd = skipString(text, i);
    if (keyEnd < 0) {
      return null;
    }
    const name = decodeStringLiteral(text.slice(keyStart, keyEnd));

    i = skipWhitespace(text, keyEnd);
    if (text.charCodeAt(i) !== CH_COLON) {
      return null;
    }
    i = skipWhitespace(text, i + 1);

    const valueStart = i;
    const valueEnd = skipValue(text, i);
    if (valueEnd < 0) {
      return null;
    }
    if (name === key) {
      return { start: valueStart, end: valueEnd };
    }

    i = skipWhitespace(text, valueEnd);
    if (text.charCodeAt(i) === CH_COMMA) {
      i = skipWhitespace(text, i + 1);
      continue;
    }
    return null; // `}` or garbage — either way the key is not here.
  }
  return null;
}

/**
 * Replace (or insert) a top-level string-valued key, touching nothing else.
 * Inserts after the opening brace at the detected indentation when absent, and
 * handles the empty-object case.
 */
export function setTopLevelString(text: string, key: string, value: string): string {
  const format = detectFormat(text);
  const prefix = format.hasBom ? BOM : "";
  const body = stripBom(text);
  const literal = JSON.stringify(value);

  const result = prefix + rewriteBody(body, key, literal, format);

  // §16.4: validate by re-scanning our own output.
  const span = scanTopLevelKey(result, key);
  if (!span || result.slice(span.start, span.end) !== literal) {
    throw new Error(`Failed to set "${key}" in package.json`);
  }
  return result;
}

function rewriteBody(body: string, key: string, literal: string, format: ManifestFormat): string {
  const { indent, eol } = format;

  const span = scanTopLevelKey(body, key);
  if (span) {
    // The key exists: swap the value span, byte for byte, and nothing else.
    return body.slice(0, span.start) + literal + body.slice(span.end);
  }

  const entry = `${JSON.stringify(key)}: ${literal}`;

  const braceStart = skipWhitespace(body, 0);
  if (body.charCodeAt(braceStart) !== CH_LBRACE) {
    if (body.trim().length !== 0) {
      throw new Error(`Failed to set "${key}" in package.json`);
    }
    // No manifest at all (§03.7 step 9 creates one from scratch).
    return `{${eol}${indent}${entry}${eol}}${eol}`;
  }

  const objectEnd = skipValue(body, braceStart);
  if (objectEnd < 0) {
    throw new Error(`Failed to set "${key}" in package.json`);
  }
  const afterBrace = braceStart + 1;
  const firstMember = skipWhitespace(body, afterBrace);
  const isEmpty = body.charCodeAt(firstMember) === CH_RBRACE;

  if (isEmpty) {
    // `{}` — drop the entry between the braces, discarding the empty interior.
    return `${body.slice(0, afterBrace)}${eol}${indent}${entry}${eol}${body.slice(firstMember)}`;
  }

  // A one-line object stays on one line; anything else gets its own line.
  const inline = !body.slice(braceStart, objectEnd).includes("\n");
  const lead = inline ? "" : eol + indent;
  return `${body.slice(0, afterBrace)}${lead}${entry},${body.slice(afterBrace)}`;
}

/* -------------------------------------------------------------------------- */
/* Warm-path field extraction — §16.3                                          */
/* -------------------------------------------------------------------------- */

/** Deeper than any real manifest; past it the scan gives up and defers to `JSON.parse`. */
const MAX_SCAN_DEPTH = 64;

/**
 * Pull a handful of top-level fields out of a document without building a DOM.
 *
 * The proxy path reads exactly two fields of `package.json` (§03.3), and
 * resolving a 400-dependency manifest into a general-purpose object costs
 * hundreds of allocations to answer that — against §16.1's budget of fewer than
 * fifty on the whole warm path. This walks the text instead, allocating only for
 * the values actually asked for.
 *
 * The walk is a **strict** JSON validator, never a lenient one: anything this
 * accepts, `JSON.parse` accepts too, with the same values. Whenever it cannot be
 * certain — a malformed document, an escaped key name, a pathologically nested
 * one, or a top level that is not an object — it returns `null`, and the caller
 * must fall back to a real parse so that §03.1's `Invalid package.json` still
 * fires on exactly the same inputs.
 */
export function scanTopLevelFields(
  text: string,
  keys: readonly string[],
): Record<string, unknown> | null {
  let i = text.startsWith(BOM) ? BOM.length : 0;
  i = skipWhitespace(text, i);
  if (text.charCodeAt(i) !== CH_LBRACE) {
    return null; // Not an object at the top level; `JSON.parse` decides what it is.
  }
  i = skipWhitespace(text, i + 1);

  const found: Record<string, unknown> = {};

  if (text.charCodeAt(i) === CH_RBRACE) {
    return atEnd(text, i + 1) ? found : null;
  }

  for (;;) {
    if (text.charCodeAt(i) !== CH_QUOTE) return null;
    const keyStart = i;
    const keyEnd = validateString(text, i);
    if (keyEnd < 0) return null;

    // An escaped key cannot be compared byte for byte, and decoding one here to
    // save two microseconds is not worth a second code path: defer instead.
    for (let k = keyStart + 1; k < keyEnd - 1; k++) {
      if (text.charCodeAt(k) === CH_BACKSLASH) return null;
    }

    i = skipWhitespace(text, keyEnd);
    if (text.charCodeAt(i) !== CH_COLON) return null;
    i = skipWhitespace(text, i + 1);

    const valueStart = i;
    const valueEnd = validateValue(text, i, 0);
    if (valueEnd < 0) return null;

    // A plain loop, not `keys.find`: this runs once per member of the manifest,
    // and a closure per member is the one allocation the scan exists to avoid.
    for (let k = 0; k < keys.length; k++) {
      const key = keys[k]!;
      if (!literalEquals(text, keyStart, keyEnd, key)) continue;
      // The only allocation the scan makes, and only for a requested field.
      // Duplicate keys therefore behave as `JSON.parse` does: the last one wins.
      found[key] = JSON.parse(text.slice(valueStart, valueEnd));
      break;
    }

    i = skipWhitespace(text, valueEnd);
    const code = text.charCodeAt(i);
    if (code === CH_COMMA) {
      i = skipWhitespace(text, i + 1);
      continue;
    }
    if (code === CH_RBRACE) {
      return atEnd(text, i + 1) ? found : null;
    }
    return null;
  }
}

/** Only whitespace left? A document with trailing garbage is not valid JSON. */
function atEnd(text: string, index: number): boolean {
  return skipWhitespace(text, index) === text.length;
}

/** Does the string literal spanning `[start, end)` spell exactly `key`? */
function literalEquals(text: string, start: number, end: number, key: string): boolean {
  if (end - start !== key.length + 2) return false;
  for (let k = 0; k < key.length; k++) {
    if (text.charCodeAt(start + 1 + k) !== key.charCodeAt(k)) return false;
  }
  return true;
}

/** Index just past a **valid** string literal at `index`, or -1. */
function validateString(text: string, index: number): number {
  let i = index + 1;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === CH_QUOTE) return i + 1;
    if (code < 0x20) return -1; // Raw control characters are not legal in JSON.
    if (code !== CH_BACKSLASH) {
      i++;
      continue;
    }
    const escape = text.charCodeAt(i + 1);
    if (escape === 0x75 /* u */) {
      for (let k = 2; k < 6; k++) {
        if (!isHexDigit(text.charCodeAt(i + k))) return -1;
      }
      i += 6;
      continue;
    }
    // `"` `\` `/` `b` `f` `n` `r` `t` — anything else is an invalid escape.
    if (!ESCAPES.has(escape)) return -1;
    i += 2;
  }
  return -1;
}

const ESCAPES = new Set([0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74]);

function isHexDigit(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x61 && code <= 0x66) ||
    (code >= 0x41 && code <= 0x46)
  );
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/** Index just past a **valid** number literal at `index`, or -1. */
function validateNumber(text: string, index: number): number {
  let i = index;
  if (text.charCodeAt(i) === 0x2d /* - */) i++;

  if (text.charCodeAt(i) === 0x30 /* 0 */) {
    i++; // A leading zero may not be followed by another digit.
  } else if (isDigit(text.charCodeAt(i))) {
    while (isDigit(text.charCodeAt(i))) i++;
  } else {
    return -1;
  }

  if (text.charCodeAt(i) === 0x2e /* . */) {
    i++;
    if (!isDigit(text.charCodeAt(i))) return -1;
    while (isDigit(text.charCodeAt(i))) i++;
  }

  const exponent = text.charCodeAt(i);
  if (exponent === 0x65 || exponent === 0x45 /* e E */) {
    i++;
    const sign = text.charCodeAt(i);
    if (sign === 0x2b || sign === 0x2d) i++;
    if (!isDigit(text.charCodeAt(i))) return -1;
    while (isDigit(text.charCodeAt(i))) i++;
  }

  return i;
}

/** Index just past a **valid** value at `index`, or -1. Never allocates. */
function validateValue(text: string, index: number, depth: number): number {
  if (depth > MAX_SCAN_DEPTH) return -1;

  const code = text.charCodeAt(index);
  if (code === CH_QUOTE) return validateString(text, index);
  if (code === CH_LBRACE) return validateObject(text, index, depth);
  if (code === CH_LBRACKET) return validateArray(text, index, depth);
  if (text.startsWith("true", index)) return index + 4;
  if (text.startsWith("false", index)) return index + 5;
  if (text.startsWith("null", index)) return index + 4;
  if (code === 0x2d || isDigit(code)) return validateNumber(text, index);
  return -1;
}

function validateObject(text: string, index: number, depth: number): number {
  let i = skipWhitespace(text, index + 1);
  if (text.charCodeAt(i) === CH_RBRACE) return i + 1;

  for (;;) {
    if (text.charCodeAt(i) !== CH_QUOTE) return -1;
    const keyEnd = validateString(text, i);
    if (keyEnd < 0) return -1;

    i = skipWhitespace(text, keyEnd);
    if (text.charCodeAt(i) !== CH_COLON) return -1;
    i = skipWhitespace(text, i + 1);

    const valueEnd = validateValue(text, i, depth + 1);
    if (valueEnd < 0) return -1;

    i = skipWhitespace(text, valueEnd);
    const code = text.charCodeAt(i);
    if (code === CH_COMMA) {
      i = skipWhitespace(text, i + 1);
      continue; // A trailing comma lands on `}` above and is rejected there.
    }
    if (code === CH_RBRACE) return i + 1;
    return -1;
  }
}

function validateArray(text: string, index: number, depth: number): number {
  let i = skipWhitespace(text, index + 1);
  if (text.charCodeAt(i) === CH_RBRACKET) return i + 1;

  for (;;) {
    const valueEnd = validateValue(text, i, depth + 1);
    if (valueEnd < 0) return -1;

    i = skipWhitespace(text, valueEnd);
    const code = text.charCodeAt(i);
    if (code === CH_COMMA) {
      i = skipWhitespace(text, i + 1);
      continue;
    }
    if (code === CH_RBRACKET) return i + 1;
    return -1;
  }
}

function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

function isWhitespace(code: number): boolean {
  return code === CH_SPACE || code === CH_TAB || code === CH_LF || code === CH_CR;
}

function skipWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length && isWhitespace(text.charCodeAt(i))) {
    i++;
  }
  return i;
}

/** Index just past the closing quote of the string starting at `index`, or -1. */
function skipString(text: string, index: number): number {
  let i = index + 1;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === CH_BACKSLASH) {
      i += 2; // An escaped character can never end the string — not even `\"`.
      continue;
    }
    if (code === CH_QUOTE) {
      return i + 1;
    }
    i++;
  }
  return -1;
}

/** Index just past the value starting at `index`, or -1 when it is malformed. */
function skipValue(text: string, index: number): number {
  const code = text.charCodeAt(index);
  if (code === CH_QUOTE) {
    return skipString(text, index);
  }
  if (code === CH_LBRACE || code === CH_LBRACKET) {
    let depth = 0;
    let i = index;
    while (i < text.length) {
      const current = text.charCodeAt(i);
      if (current === CH_QUOTE) {
        // Braces and brackets inside a string are just characters.
        const end = skipString(text, i);
        if (end < 0) {
          return -1;
        }
        i = end;
        continue;
      }
      if (current === CH_LBRACE || current === CH_LBRACKET) {
        depth++;
      } else if (current === CH_RBRACE || current === CH_RBRACKET) {
        depth--;
        if (depth === 0) {
          return i + 1;
        }
      }
      i++;
    }
    return -1;
  }
  // A number, `true`, `false` or `null`: runs until a structural delimiter.
  let i = index;
  while (i < text.length) {
    const current = text.charCodeAt(i);
    if (
      isWhitespace(current) ||
      current === CH_COMMA ||
      current === CH_RBRACE ||
      current === CH_RBRACKET
    ) {
      break;
    }
    i++;
  }
  return i > index ? i : -1;
}

function decodeStringLiteral(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : null;
  } catch {
    return null;
  }
}
