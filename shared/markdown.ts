/** Pure Markdown text helpers shared by the panel and tests. */

export interface TextRange {
  from: number;
  to: number;
}

const TITLE_MAX = 60;
const FENCE = /^\s*(```|~~~)/;
const FOOTNOTE_REF = /^\[\^[^\]\s]+\]:?/;
const FOOTNOTE_DEF = /^\[\^([^\]\s]+)\]:[ \t]?(.*)$/;
const INDENTED = /^( {4}|\t)/;
const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";

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
 * Characters that rendered Markdown drops or adds: whitespace, markup, bullets, escapes, and
 * the superscript numbers the preview draws for footnote references.
 */
const MARKUP = /[\s*_`~#>[\]|\-+•\\⁰¹²³⁴⁵⁶⁷⁸⁹]/;

/**
 * Maps text selected in rendered Markdown back to a source range. Both sides drop markup
 * characters, link targets, and footnote references, then the occurrence nearest to `hint`
 * wins. `hint` is the count of kept characters before the selection in the rendered text.
 */
export function locateRendered(source: string, selected: string, hint = 0): TextRange | null {
  const needle = [...selected].filter((ch) => !MARKUP.test(ch)).join("");
  if (needle === "") return null;
  let plain = "";
  const map: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source.startsWith("](", i)) {
      const close = source.indexOf(")", i + 2);
      if (close !== -1 && !source.slice(i, close).includes("\n")) {
        i = close;
        continue;
      }
    }
    if (source.startsWith("[^", i)) {
      const ref = FOOTNOTE_REF.exec(source.slice(i, i + 80));
      if (ref) {
        i += ref[0].length - 1;
        continue;
      }
    }
    const ch = source[i];
    if (MARKUP.test(ch)) continue;
    plain += ch;
    map.push(i);
  }
  let best: number | null = null;
  for (let i = plain.indexOf(needle); i !== -1; i = plain.indexOf(needle, i + 1)) {
    if (best === null || Math.abs(i - hint) < Math.abs(best - hint)) best = i;
  }
  if (best === null) return null;
  return { from: map[best], to: map[best + needle.length - 1] + 1 };
}

/** Number of characters `locateRendered` keeps in `text`; turns a rendered prefix into a hint. */
export function keptLength(text: string): number {
  return [...text].filter((ch) => !MARKUP.test(ch)).length;
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
    const isFence = FENCE.test(line);
    if (i >= endLine && !inFence && !isFence && line.trim() === "") return offset;
    if (isFence) {
      inFence = !inFence;
      if (i >= endLine && !inFence) return Math.min(text.length, offset + line.length + 1);
    }
    offset += line.length + 1;
  }
  return text.length;
}

/** Inserts `block` at `offset` as its own paragraph, with exactly one blank line around it. */
export function insertBlock(text: string, offset: number, block: string): string {
  const before = text.slice(0, offset).replace(/\n+$/, "");
  const after = text.slice(offset).replace(/^\n+/, "");
  if (before === "") return after === "" ? `${block}\n` : `${block}\n\n${after}`;
  if (after === "") return `${before}\n\n${block}\n`;
  return `${before}\n\n${block}\n\n${after}`;
}

function inFenceAt(text: string, offset: number): boolean {
  let inFence = false;
  for (const line of text.slice(0, offset).split("\n").slice(0, -1)) {
    if (FENCE.test(line)) inFence = !inFence;
  }
  return inFence;
}

/**
 * Where a footnote reference for a selection ending at `end` goes: after trailing emphasis or
 * code closers and link targets, so the reference never lands inside markup. Inside fenced code
 * it returns null; the reference then gets its own paragraph after the block.
 */
export function referenceOffset(text: string, end: number): number | null {
  let i = end;
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  if (inFenceAt(text, i)) return null;
  const lineStart = text.lastIndexOf("\n", i - 1) + 1;
  if ((text.slice(lineStart, i).match(/`/g)?.length ?? 0) % 2 === 1) {
    const close = text.indexOf("`", i);
    const lineEnd = text.indexOf("\n", i);
    if (close !== -1 && (lineEnd === -1 || close < lineEnd)) i = close;
  }
  for (;;) {
    if ("*_~`".includes(text[i] ?? "\n")) {
      i++;
    } else if (text.startsWith("](", i) && text.indexOf(")", i) !== -1) {
      i = text.indexOf(")", i) + 1;
    } else {
      return i;
    }
  }
}

/** The next unused numeric footnote label. */
export function nextFootnoteLabel(text: string): string {
  let max = 0;
  for (const match of text.matchAll(/\[\^(\d+)\]/g)) max = Math.max(max, Number(match[1]));
  return String(max + 1);
}

/** A footnote definition titled `label: subject` whose body is the answer, indented as GFM requires. */
export function buildFootnote(id: string, label: string, subject: string, answer: string): string {
  const flat = subject.replace(/\s+/g, " ").trim();
  const title = flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX)}…` : flat;
  const body = answer
    .trim()
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : `    ${line}`));
  return [`[^${id}]: **${label}: ${title}**`, "", ...body].join("\n");
}

/**
 * Adds a footnote reference after the selection ending at `at.to` and appends its definition at
 * the end of the document.
 */
export function addFootnote(text: string, at: TextRange, label: string, subject: string, answer: string): string {
  const id = nextFootnoteLabel(text);
  const ref = `[^${id}]`;
  const offset = referenceOffset(text, at.to);
  const withRef =
    offset === null
      ? insertBlock(text, findBlockEnd(text, at.to), ref)
      : text.slice(0, offset) + ref + text.slice(offset);
  return `${withRef.replace(/\s+$/, "")}\n\n${buildFootnote(id, label, subject, answer)}\n`;
}

export interface Footnote {
  label: string;
  number: number;
  content: string;
}

export function superscript(n: number): string {
  return String(n).replace(/\d/g, (d) => SUPERSCRIPT[Number(d)]);
}

/** Reads a superscript number such as "¹²" back; NaN when `text` is not one. */
export function fromSuperscript(text: string): number {
  const digits = [...text].map((ch) => SUPERSCRIPT.indexOf(ch));
  return digits.length > 0 && digits.every((d) => d >= 0) ? Number(digits.join("")) : NaN;
}

/**
 * Prepares Markdown for display: removes footnote definitions and replaces references with
 * superscript numbers, numbered by first reference. Returns the body and the notes in number
 * order; definitions nobody references come last. Fenced and inline code are left alone.
 */
export function prepareFootnotes(text: string): { body: string; notes: Footnote[] } {
  const lines = text.split("\n");
  const bodyLines: string[] = [];
  const definitions = new Map<string, string>();
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) inFence = !inFence;
    const def = inFence ? null : FOOTNOTE_DEF.exec(line);
    if (!def) {
      bodyLines.push(line);
      continue;
    }
    const content = [def[2]];
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (INDENTED.test(next)) content.push(next.replace(INDENTED, ""));
      else if (next.trim() === "" && i + 2 < lines.length && INDENTED.test(lines[i + 2])) content.push("");
      else break;
      i++;
    }
    definitions.set(def[1], content.join("\n").trim());
  }

  const numbers = new Map<string, number>();
  inFence = false;
  const body = bodyLines
    .map((line) => {
      if (FENCE.test(line)) inFence = !inFence;
      if (inFence || !line.includes("[^")) return line;
      // Odd parts are inline code spans.
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, index) =>
          index % 2 === 1
            ? part
            : part.replace(/\[\^([^\]\s]+)\]/g, (match, label: string, offset: number) => {
                if (!definitions.has(label)) return match;
                let n = numbers.get(label);
                if (n === undefined) numbers.set(label, (n = numbers.size + 1));
                const adjacent = offset > 0 && part.slice(0, offset).endsWith("]");
                return `${adjacent ? "," : ""}${superscript(n)}`;
              }),
        )
        .join("");
    })
    .join("\n")
    .replace(/\s+$/, "");
  for (const label of definitions.keys()) {
    if (!numbers.has(label)) numbers.set(label, numbers.size + 1);
  }
  const notes = [...numbers].map(([label, number]) => ({
    label,
    number,
    content: definitions.get(label) ?? "",
  }));
  return { body, notes };
}
