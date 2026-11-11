import type { TextRange } from "./markdown";

/** Stops a one-letter query in a long document from painting an unbounded number of ranges. */
const MAX_MATCHES = 5_000;

/** Offsets of each non-overlapping, case-insensitive occurrence of `query` in `text`. */
export function findMatches(text: string, query: string): TextRange[] {
  if (!query) return [];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  // Lower-casing keeps offsets only when it keeps lengths; otherwise match case exactly.
  const caseless = lowerText.length === text.length && lowerQuery.length === query.length;
  const haystack = caseless ? lowerText : text;
  const needle = caseless ? lowerQuery : query;
  const matches: TextRange[] = [];
  for (
    let at = haystack.indexOf(needle);
    at !== -1 && matches.length < MAX_MATCHES;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    matches.push({ from: at, to: at + needle.length });
  }
  return matches;
}

/** The match `step` away from `index` among `count`, wrapping around both ends. */
export function stepMatch(index: number, count: number, step: number): number {
  if (count === 0) return 0;
  const current = Math.min(index, count - 1);
  return (((current + step) % count) + count) % count;
}
