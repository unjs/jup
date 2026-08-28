/**
 * Surgical manifest edits preserve formatting and avoid pulling cold writing machinery into the warm path. Every result is reparsed before emission.
 */

import { EOL } from "node:os";
import {
  BOM,
  CH_BACKSLASH,
  CH_COLON,
  CH_COMMA,
  CH_CR,
  CH_LBRACE,
  CH_LBRACKET,
  CH_LF,
  CH_QUOTE,
  CH_RBRACE,
  CH_RBRACKET,
  isWhitespace,
  skipWhitespace,
  stripBom,
} from "./json.ts";

export interface ManifestFormat {
  /** First `/^[ \t]+/m` match in the original, else two spaces. Preserves tabs. */
  indent: string;
  /** `\r\n` iff CRLF strictly outnumbers bare LF; platform EOL if the file had no newlines. */
  eol: string;
  hasBom: boolean;
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

/**
 * Byte span of a top-level key's *value*, or null when the key is absent.
 *
 * Duplicate keys are legal JSON, and both `JSON.parse` and `scanTopLevelFields`
 * resolve them **last-wins**. So the scan does not stop at the first match: it
 * keeps walking and returns the last one, or it would rewrite an occurrence no
 * reader ever consults and report a change that never took effect.
 */
export function scanTopLevelKey(text: string, key: string): { start: number; end: number } | null {
  let i = text.startsWith(BOM) ? BOM.length : 0;
  i = skipWhitespace(text, i);
  if (text.charCodeAt(i) !== CH_LBRACE) {
    return null; // Not an object at the top level: no top-level keys to find.
  }
  i = skipWhitespace(text, i + 1);

  let found: { start: number; end: number } | null = null;

  while (i < text.length) {
    if (text.charCodeAt(i) === CH_RBRACE) {
      return found; // End of the object.
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
      found = { start: valueStart, end: valueEnd };
    }

    i = skipWhitespace(text, valueEnd);
    if (text.charCodeAt(i) === CH_COMMA) {
      i = skipWhitespace(text, i + 1);
      continue;
    }
    return found; // `}` or garbage — nothing further to find either way.
  }
  return found;
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

  // §16.4: validate by re-scanning our own output — the literal has to be where
  // the next reader will look for it.
  const span = scanTopLevelKey(result, key);
  if (!span || result.slice(span.start, span.end) !== literal) {
    throw new Error(`Failed to set "${key}" in package.json`);
  }
  // The re-scan alone is not validation: `scanTopLevelKey` is a *scanner*. It
  // balances braces and brackets on one shared counter and never inspects the
  // values it steps over, so it reports success on input that was already
  // malformed (`{"a": ]}`, `{"a": 1]}`) and we would hand `writeFileSync` a
  // manifest that does not parse. Parsing is the only check that proves it does.
  // `pin.ts` relies on this guard to prevent writing a broken manifest, and
  // `setNestedString` applies the same validation (§16.4).
  try {
    JSON.parse(stripBom(result));
  } catch {
    throw new Error(`Failed to set "${key}" in package.json`);
  }
  return result;
}

/**
 * The same surgical edit, one level down: `devEngines.packageManager.version`.
 *
 * §15.26 requires every field that encodes the pin to be updated together, and
 * `devEngines.packageManager` is an object. Everything {@link setTopLevelString}
 * preserves is preserved here too — key order, indentation, line endings, the
 * BOM — because this walks to the innermost object's *text span* and then reuses
 * the very same rewrite on it.
 *
 * Every intermediate key must already exist and hold an object; the leaf may be
 * absent and is inserted. `null` is returned when the path cannot be walked, so
 * a caller can fall back rather than corrupt a manifest it did not understand.
 */
export function setNestedString(
  text: string,
  path: readonly string[],
  value: string,
): string | null {
  const leaf = path[path.length - 1];
  if (leaf === undefined) return null;
  if (path.length === 1) return setTopLevelString(text, leaf, value);

  const prefix = text.startsWith(BOM) ? BOM : "";
  const body = stripBom(text);

  // Walk to the innermost object, carrying its span in the *original* text.
  let start = 0;
  let end = body.length;
  for (let depth = 0; depth < path.length - 1; depth++) {
    const span = scanTopLevelKey(body.slice(start, end), path[depth]!);
    if (span === null) return null;
    const nextStart = start + span.start;
    const nextEnd = start + span.end;
    // Only an object can be descended into; anything else is a different shape
    // than the caller believed and must not be rewritten blind.
    if (body.charCodeAt(skipWhitespace(body, nextStart)) !== CH_LBRACE) return null;
    start = nextStart;
    end = nextEnd;
  }

  const inner = body.slice(start, end);
  // The insert branch indents against the object being edited, not the document:
  // a member of `devEngines.packageManager` sits two levels in, and inheriting
  // the top-level indent would visibly misalign it.
  const format = detectFormat(body);
  const nested = /\n([ \t]+)\S/.exec(inner)?.[1];
  let rewritten: string;
  try {
    rewritten = rewriteBody(
      inner,
      leaf,
      JSON.stringify(value),
      nested === undefined ? format : { ...format, indent: nested },
    );
  } catch {
    return null;
  }

  const result = prefix + body.slice(0, start) + rewritten + body.slice(end);

  // §16.4 — validate by re-scanning our own output, exactly as the top-level
  // form does. A surgical edit that produced something unparseable must never
  // reach `writeFileSync`.
  try {
    if (JSON.parse(stripBom(result)) === null) return null;
  } catch {
    return null;
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
