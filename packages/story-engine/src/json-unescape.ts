/**
 * Decodes JSON string escapes (\n, \t, \uXXXX, etc.) from a raw (still-escaped)
 * string slice. Tolerant of a truncated stream: an incomplete trailing escape
 * (e.g. a `\u20` cut off mid-codepoint, or a lone trailing backslash) is
 * dropped rather than left as garbage in the output.
 *
 * Consecutive `\uXXXX` escapes that form a UTF-16 surrogate pair (e.g. an
 * emoji) decode correctly because `String.fromCharCode` on each half, applied
 * in order, reproduces the original UTF-16 code unit sequence.
 */
export function unescapeJsonString(str: string): string {
  let cleaned = str.replace(/\\(?:u[0-9a-fA-F]{0,3}|[0-9a-fA-F]{0,3})?$/u, "");
  if (cleaned.endsWith("\\")) cleaned = cleaned.slice(0, -1);
  return cleaned
    .replace(/\\u([0-9a-fA-F]{4})/gu, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n/gu, "\n")
    .replace(/\\r/gu, "\r")
    .replace(/\\t/gu, "\t")
    .replace(/\\"/gu, '"')
    .replace(/\\\\/gu, "\\")
    .replace(/\\\//gu, "/")
    .replace(/\\b/gu, "\b")
    .replace(/\\f/gu, "\f");
}
