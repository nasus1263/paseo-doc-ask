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
const MARKUP = /[\s*_`~#>[\]|\-+=•\\⁰¹²³⁴⁵⁶⁷⁸⁹]/;

/** Whether `ch` survives the markup filter used to match rendered text against source. */
export function isKept(ch: string): boolean {
  return !MARKUP.test(ch);
}

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

/** Whether wrapping `slice` in `==` keeps its emphasis, code and links intact. */
function wrappable(slice: string): boolean {
  const count = (re: RegExp) => slice.match(re)?.length ?? 0;
  return (
    slice.trim() !== "" &&
    !slice.includes("\n") &&
    !slice.includes("==") &&
    !slice.includes("[^") &&
    count(/\*\*/g) % 2 === 0 &&
    count(/(?<!\*)\*(?!\*)/g) % 2 === 0 &&
    count(/~~/g) % 2 === 0 &&
    count(/`/g) % 2 === 0 &&
    count(/\[/g) === count(/\]/g) &&
    !/\]\([^)]*$/.test(slice)
  );
}

/**
 * The range to wrap in `==` for a selection: the selection itself, or widened over adjacent
 * markup so delimiters stay balanced. Null when no such range exists, such as across lines or
 * inside fenced code.
 */
export function highlightRange(text: string, at: TextRange): TextRange | null {
  if (inFenceAt(text, at.from)) return null;
  let left = at.from;
  while (left > 0 && "*_~`[".includes(text[left - 1])) left--;
  let right = at.to;
  for (;;) {
    if ("*_~`".includes(text[right] ?? "\n")) right++;
    else if (text.startsWith("](", right) && text.indexOf(")", right) !== -1) right = text.indexOf(")", right) + 1;
    else break;
  }
  const candidates = [at, { from: left, to: at.to }, { from: at.from, to: right }, { from: left, to: right }];
  return candidates.find((range) => wrappable(text.slice(range.from, range.to))) ?? null;
}

/**
 * Adds a footnote for the selection `at`: highlights it with `==` when that keeps the markup
 * intact, references the footnote right after it, and appends the definition at the end.
 */
export function addFootnote(text: string, at: TextRange, label: string, subject: string, answer: string): string {
  const id = nextFootnoteLabel(text);
  const ref = `[^${id}]`;
  const mark = highlightRange(text, at);
  if (mark) {
    text = `${text.slice(0, mark.from)}==${text.slice(mark.from, mark.to)}==${text.slice(mark.to)}`;
    at = { from: mark.from, to: mark.to + 4 };
  }
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

/** A `==highlight==` removed for display; `number` is its footnote when one follows it. */
export interface Mark {
  text: string;
  number: number | null;
}

const INLINE_TOKEN = /==(?=\S)([^=\n]*?\S)==(\[\^([^\]\s]+)\])?|\[\^([^\]\s]+)\]/g;

/**
 * Prepares Markdown for display: removes footnote definitions, replaces references with
 * superscript numbers (numbered by first reference), and unwraps `==highlights==`. Returns the
 * body, the notes in number order (unreferenced definitions last), and the highlights in
 * document order. Fenced and inline code are left alone.
 */
export function prepareFootnotes(text: string): { body: string; notes: Footnote[]; marks: Mark[] } {
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
  const marks: Mark[] = [];
  const numberOf = (label: string) => {
    let n = numbers.get(label);
    if (n === undefined) numbers.set(label, (n = numbers.size + 1));
    return n;
  };
  inFence = false;
  const body = bodyLines
    .map((line) => {
      if (FENCE.test(line)) inFence = !inFence;
      if (inFence || (!line.includes("[^") && !line.includes("=="))) return line;
      // Odd parts are inline code spans.
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, index) =>
          index % 2 === 1
            ? part
            : part.replace(
                INLINE_TOKEN,
                (match, marked: string | undefined, markRef: string | undefined, markLabel: string | undefined, label: string | undefined, offset: number) => {
                  if (marked !== undefined) {
                    const linked = markLabel !== undefined && definitions.has(markLabel);
                    const n = linked ? numberOf(markLabel) : null;
                    marks.push({ text: marked, number: n });
                    if (markRef === undefined) return marked;
                    return n === null ? marked + markRef : marked + superscript(n);
                  }
                  if (label === undefined || !definitions.has(label)) return match;
                  const adjacent = offset > 0 && part.slice(0, offset).endsWith("]");
                  return `${adjacent ? "," : ""}${superscript(numberOf(label))}`;
                },
              ),
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
  return { body, notes, marks };
}
