/** Pure Markdown text helpers shared by the panel and tests. */

export interface TextRange {
  from: number;
  to: number;
}

const TITLE_MAX = 60;

/**
 * Finds the selected passage in the latest text. Prefers the original offsets, then the
 * occurrence nearest to them. Returns null when the passage no longer exists.
 */
export function locateSelection(text: string, range: TextRange, selected: string): TextRange | null {
  if (text.slice(range.from, range.to) === selected) return range;
  let best: number | null = null;
  for (let i = text.indexOf(selected); i !== -1; i = text.indexOf(selected, i + 1)) {
    if (best === null || Math.abs(i - range.from) < Math.abs(best - range.from)) best = i;
  }
  return best === null ? null : { from: best, to: best + selected.length };
}

/**
 * Offset where a block may be inserted after the block containing `end`: the first blank line
 * at or after that line, skipping fenced code; or the line after a fence that closes there; or
 * the end of the text.
 */
export function findBlockEnd(text: string, end: number): number {
  const lines = text.split("\n");
  const endLine = text.slice(0, Math.max(0, end - 1)).split("\n").length - 1;
  let offset = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isFence = /^\s*(```|~~~)/.test(line);
    if (i >= endLine && !inFence && !isFence && line.trim() === "") return offset;
    if (isFence) {
      inFence = !inFence;
      if (i >= endLine && !inFence) return Math.min(text.length, offset + line.length + 1);
    }
    offset += line.length + 1;
  }
  return text.length;
}

/** A Markdown note callout quoting the question and holding the answer. */
export function buildCallout(selected: string, answer: string): string {
  const flat = selected.replace(/\s+/g, " ").trim();
  const title = flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX)}…` : flat;
  const body = answer
    .trim()
    .split("\n")
    .map((line) => (line.trim() === "" ? ">" : `> ${line}`));
  return [`> [!note] 질문: ${title}`, ">", ...body].join("\n");
}

/** Inserts `block` at `offset` as its own paragraph, with exactly one blank line around it. */
export function insertBlock(text: string, offset: number, block: string): string {
  const before = text.slice(0, offset).replace(/\n+$/, "");
  const after = text.slice(offset).replace(/^\n+/, "");
  if (before === "") return after === "" ? `${block}\n` : `${block}\n\n${after}`;
  if (after === "") return `${before}\n\n${block}\n`;
  return `${before}\n\n${block}\n\n${after}`;
}

/** Inserts the answer callout after the block holding the selection, or null if it is gone. */
export function insertAnswer(
  text: string,
  range: TextRange,
  selected: string,
  answer: string,
): string | null {
  const found = locateSelection(text, range, selected);
  if (!found) return null;
  return insertBlock(text, findBlockEnd(text, found.to), buildCallout(selected, answer));
}
