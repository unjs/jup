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
