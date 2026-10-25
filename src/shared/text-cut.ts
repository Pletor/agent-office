// Cutting text that leaves the office (process events, toasts, evidence) without breaking a character.
// A JS string is UTF-16: `.slice(0, n)` can stop between the two halves of an emoji, and a lone half
// is no Unicode at all. Opora (Python) refuses to store one ("surrogates not allowed"), which once cost
// a whole batch of process events. Pure, so the server and the browser share it.

/** A lone UTF-16 surrogate: a high half not followed by a low one, or a low half with no high before it. */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** `text` with every lone surrogate replaced by U+FFFD, so it is valid Unicode (String.prototype.toWellFormed). */
export function wellFormed(text: string): string {
  return text.replace(LONE, '�');
}

/**
 * `text` cut to at most `max` UTF-16 units, ending in `ellipsis` when it was cut, and never between the
 * two halves of a surrogate pair (it cuts by code point: an emoji stays whole or goes whole).
 */
export function cutText(text: string, max: number, ellipsis = '…'): string {
  const s = wellFormed(text);
  if (s.length <= max) return s;
  let end = Math.max(0, max - ellipsis.length);
  // Ending right after a high surrogate would split the pair: step back before it.
  if (end > 0 && /[\uD800-\uDBFF]/.test(s[end - 1])) end--;
  return `${s.slice(0, end)}${ellipsis}`;
}

/** The last `max` UTF-16 units of `text`, never starting on the low half of a surrogate pair. */
export function tailText(text: string, max: number): string {
  const s = wellFormed(text);
  if (s.length <= max) return s;
  let start = s.length - max;
  if (/[\uDC00-\uDFFF]/.test(s[start])) start++;
  return s.slice(start);
}
