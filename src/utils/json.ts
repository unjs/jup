/**
 * Warm-path manifest scanning extracts selected fields without a DOM and falls back to `JSON.parse` whenever correctness is uncertain.
 */

/** Shared with `json-write.ts`. */
export const BOM = "\ufeff";

const CH_TAB = 0x09;
export const CH_LF = 0x0a;
export const CH_CR = 0x0d;
const CH_SPACE = 0x20;
export const CH_QUOTE = 0x22;
export const CH_COMMA = 0x2c;
export const CH_COLON = 0x3a;
export const CH_LBRACKET = 0x5b;
export const CH_BACKSLASH = 0x5c;
export const CH_RBRACKET = 0x5d;
export const CH_LBRACE = 0x7b;
export const CH_RBRACE = 0x7d;

/** Tolerant read: strips a BOM for parsing, treats empty content as `{}`. */
export function parseManifest(text: string): unknown {
  const body = stripBom(text);
  // An empty (or whitespace-only) manifest behaves as `{}` — §03.7 step 4.
  if (body.trim().length === 0) {
    return {};
  }
  return JSON.parse(body);
}
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

export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

export function isWhitespace(code: number): boolean {
  return code === CH_SPACE || code === CH_TAB || code === CH_LF || code === CH_CR;
}

export function skipWhitespace(text: string, index: number): number {
  let i = index;
  while (i < text.length && isWhitespace(text.charCodeAt(i))) {
    i++;
  }
  return i;
}
