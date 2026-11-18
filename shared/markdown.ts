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
 * Invisible characters the preview puts around each highlight, so the viewer can find the exact
 * rendered range instead of searching for the same words elsewhere.
 */
export const MARK_OPEN = "⁣";
export const MARK_CLOSE = "⁤";
/** The same around a reader's instruction on an agent answer, painted apart and unnumbered. */
export const COMMENT_OPEN = "⁡";
export const COMMENT_CLOSE = "⁢";

/**
 * The companion file holding a document's footnote definitions: `a.md` → `a.comment.md`.
 * Null for files that are not Markdown documents or are comment files themselves.
 */
export function commentPathOf(path: string): string | null {
  if (/\.comment\.md$/i.test(path)) return null;
  const base = path.replace(/\.(md|markdown)$/i, "");
  return base === path ? null : `${base}.comment.md`;
}

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
const MARKUP = /[\s*_`~#>[\]|\-+=•\\⁰¹²³⁴⁵⁶⁷⁸⁹⁣⁤⁡⁢]/;

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

/** The inline code span on the line around `offset`, including its backticks, if any. */
function codeSpanAround(text: string, offset: number): TextRange | null {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const lineEnd = text.indexOf("\n", offset) === -1 ? text.length : text.indexOf("\n", offset);
  const line = text.slice(lineStart, lineEnd);
  for (const match of line.matchAll(/`+[^`]*`+/g)) {
    const from = lineStart + (match.index ?? 0);
    const to = from + match[0].length;
    if (offset > from && offset < to) return { from, to };
  }
  return null;
}

/**
 * The range to wrap in `==` for a selection. Markup touching the selection stays inside the
 * highlight (`==**bold**==`, ``==`code`==``), because a highlight inside emphasis can break it
 * and one inside code is not markup at all. A selection inside inline code takes the whole span.
 * Null when no balanced range exists, such as across lines or inside fenced code.
 */
export function highlightRange(text: string, at: TextRange): TextRange | null {
  if (inFenceAt(text, at.from)) return null;
  const startCode = codeSpanAround(text, at.from);
  const endCode = codeSpanAround(text, at.to - 1);
  at = { from: startCode ? startCode.from : at.from, to: endCode ? endCode.to : at.to };
  let left = at.from;
  while (left > 0 && "*~`[".includes(text[left - 1])) left--;
  let right = at.to;
  for (;;) {
    if ("*~`".includes(text[right] ?? "\n")) right++;
    else if (text.startsWith("](", right) && text.indexOf(")", right) !== -1) right = text.indexOf(")", right) + 1;
    else break;
  }
  const candidates = [{ from: left, to: right }, { from: left, to: at.to }, { from: at.from, to: right }, at];
  return candidates.find((range) => wrappable(text.slice(range.from, range.to))) ?? null;
}

/** An existing annotation in a document: a highlight with an optional reference, or a bare reference. */
interface Annotation {
  /** Source ranges to delete to remove it: the `==` delimiters and the reference. */
  removals: TextRange[];
  /** The span it covers, from the opening `==` (or the reference) to the end of the reference. */
  span: TextRange;
  label: string | null;
  highlighted: boolean;
}

/** Highlights and footnote references of `doc`, outside fenced and inline code. */
function findAnnotations(doc: string): Annotation[] {
  const found: Annotation[] = [];
  const token = new RegExp(INLINE_TOKEN.source, "g");
  for (const match of doc.matchAll(token)) {
    const from = match.index ?? 0;
    if (inFenceAt(doc, from) || codeSpanAround(doc, from) || doc[from + match[0].length] === ":") continue;
    const [whole, marked, markRef, markLabel, refLabel] = match;
    const to = from + whole.length;
    if (marked !== undefined) {
      const close = from + 2 + marked.length;
      const removals = [{ from, to: from + 2 }, { from: close, to: close + 2 }];
      if (markRef !== undefined) removals.push({ from: close + 2, to });
      found.push({ removals, span: { from, to }, label: markLabel ?? null, highlighted: true });
    } else if (refLabel !== undefined) {
      found.push({ removals: [{ from, to }], span: { from, to }, label: refLabel, highlighted: false });
    }
  }
  return found;
}

/** Deletes the definition of footnote `label` from `text`, with one blank line next to it. */
function removeDefinition(text: string, label: string): string {
  const lines = text.split("\n");
  const span = definitionSpan(lines, label);
  if (!span) return text;
  let { first, last } = span;
  if (first > 0 && lines[first - 1].trim() === "") first--;
  else if (last + 1 < lines.length && lines[last + 1].trim() === "") last++;
  lines.splice(first, last - first + 1);
  return lines.join("\n");
}

/**
 * Removes annotations the selection `at` overlaps: highlights that intersect it, and bare
 * references inside it or right at its end. Their definitions are removed from both texts.
 * Returns the texts, the selection shifted to match, and the removed footnote labels.
 */
export function removeOverlapping(
  doc: string,
  comments: string,
  at: TextRange,
): { doc: string; comments: string; at: TextRange; removed: string[] } {
  const overlapping = findAnnotations(doc).filter((note) =>
    note.highlighted
      ? note.span.from < at.to && note.span.to > at.from
      : note.span.from >= at.from && note.span.from <= at.to,
  );
  const removals = overlapping.flatMap((note) => note.removals).sort((a, b) => b.from - a.from);
  let { from, to } = at;
  for (const cut of removals) {
    doc = doc.slice(0, cut.from) + doc.slice(cut.to);
    const length = cut.to - cut.from;
    const shift = (offset: number) => (offset >= cut.to ? offset - length : offset > cut.from ? cut.from : offset);
    from = shift(from);
    to = shift(to);
  }
  const removed = [...new Set(overlapping.map((note) => note.label).filter((label): label is string => label !== null))];
  for (const label of removed) {
    // Keep a definition another reference still uses.
    if (new RegExp(`\\[\\^${escapeRegExp(label)}\\](?!:)`).test(doc)) continue;
    doc = removeDefinition(doc, label);
    comments = removeDefinition(comments, label);
  }
  return { doc, comments, at: { from, to }, removed };
}

/**
 * Removes footnote `label` entirely: the highlights it is attached to, every reference to it,
 * and its definition (with its bookmark and memo) from both texts. `found` reports whether
 * anything was removed.
 */
export function removeFootnote(
  doc: string,
  comments: string,
  label: string,
): { doc: string; comments: string; found: boolean } {
  const cuts = findAnnotations(doc)
    .filter((note) => note.label === label)
    .flatMap((note) => note.removals)
    .sort((a, b) => b.from - a.from);
  let nextDoc = doc;
  for (const cut of cuts) nextDoc = nextDoc.slice(0, cut.from) + nextDoc.slice(cut.to);
  nextDoc = removeDefinition(nextDoc, label);
  const nextComments = removeDefinition(comments, label);
  return { doc: nextDoc, comments: nextComments, found: nextDoc !== doc || nextComments !== comments };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Annotates the selection `at` of `doc`: replaces annotations it overlaps, highlights it with
 * `==` when that keeps the markup intact, and references a new footnote right after it. The
 * definition is appended to `comments`, the document's companion comment file. Labels are
 * unique across both texts.
 */
export function annotate(
  doc: string,
  comments: string,
  at: TextRange,
  label: string,
  subject: string,
  answer: string,
  options: { comment?: boolean } = {},
): { doc: string; comments: string; id: string; replaced: string[] } {
  // A reader's comment keeps the annotations it overlaps. Highlights cannot nest, so an
  // overlapping comment gets only its reference.
  const cleared = options.comment
    ? { doc, comments, at, removed: [] as string[] }
    : removeOverlapping(doc, comments, at);
  ({ doc, comments, at } = cleared);
  const overlaps =
    options.comment &&
    findAnnotations(doc).some((note) => note.span.from < at.to && note.span.to > at.from);
  const id = nextFootnoteLabel(`${doc}\n${comments}`);
  const ref = `[^${id}]`;
  const mark = overlaps ? null : highlightRange(doc, at);
  if (mark) {
    doc = `${doc.slice(0, mark.from)}==${doc.slice(mark.from, mark.to)}==${doc.slice(mark.to)}`;
    at = { from: mark.from, to: mark.to + 4 };
  }
  const offset = referenceOffset(doc, at.to);
  const withRef =
    offset === null
      ? insertBlock(doc, findBlockEnd(doc, at.to), ref)
      : doc.slice(0, offset) + ref + doc.slice(offset);
  const plain = buildFootnote(id, label, subject, answer);
  const definition = options.comment ? (setNoteMeta(plain, id, { comment: true }) ?? plain) : plain;
  const existing = comments.replace(/\s+$/, "");
  return {
    doc: withRef,
    comments: existing === "" ? `${definition}\n` : `${existing}\n\n${definition}\n`,
    id,
    replaced: cleared.removed,
  };
}

/** Line indexes of the definition of footnote `label` in `lines`: its first and last line. */
function definitionSpan(lines: string[], label: string): { first: number; last: number } | null {
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) inFence = !inFence;
    const def = inFence ? null : FOOTNOTE_DEF.exec(lines[i]);
    if (!def || def[1] !== label) continue;
    let last = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (INDENTED.test(lines[j])) last = j;
      else if (!(lines[j].trim() === "" && j + 1 < lines.length && INDENTED.test(lines[j + 1]))) break;
    }
    return { first: i, last };
  }
  return null;
}

/** Whether `text` defines footnote `label`. */
export function definesFootnote(text: string, label: string): boolean {
  return definitionSpan(text.split("\n"), label) !== null;
}

/**
 * Appends a follow-up to the definition of footnote `label` in `text`: a bold `label: subject`
 * heading, `quote` (the passage of the footnote it was asked about, when the heading does not
 * already name it) as a blockquote, and the answer, indented to stay inside the footnote. Null
 * when `text` does not define the footnote.
 */
export function appendToFootnote(
  text: string,
  label: string,
  heading: string,
  subject: string,
  answer: string,
  quote?: string,
): string | null {
  const lines = text.split("\n");
  const span = definitionSpan(lines, label);
  if (!span) return null;
  const flat = subject.replace(/\s+/g, " ").trim();
  const title = flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX)}…` : flat;
  const indent = (line: string) => (line.trim() === "" ? "" : `    ${line}`);
  const quoted = quote?.trim()
    ? [
        ...quote
          .trim()
          .split("\n")
          .map((line) => `    > ${line}`.trimEnd()),
        "",
      ]
    : [];
  const body = answer.trim().split("\n").map(indent);
  lines.splice(span.last + 1, 0, "", `    **${heading}: ${title}**`, "", ...quoted, ...body);
  return lines.join("\n");
}

/**
 * Replaces the body of footnote `label` (the part under its title line, before any follow-up)
 * with `body`, indented to stay inside the footnote. Follow-ups are kept. Null when `text` does
 * not define the footnote.
 */
export function replaceFootnoteBody(text: string, label: string, body: string): string | null {
  const lines = text.split("\n");
  const span = definitionSpan(lines, label);
  if (!span) return null;
  let end = span.last + 1;
  for (let i = span.first + 2; i <= span.last; i++) {
    if (lines[i - 1].trim() === "" && FOLLOW_UP_HEADING.test(lines[i].trim())) {
      end = i - 1;
      break;
    }
  }
  const indented = body.trim()
    ? ["", ...body.trim().split("\n").map((line) => (line.trim() === "" ? "" : `    ${line}`))]
    : [];
  lines.splice(span.first + 1, end - (span.first + 1), ...indented);
  return lines.join("\n");
}

/** A follow-up's heading line inside a footnote, as `appendToFootnote` writes it. */
const FOLLOW_UP_HEADING = /^\*\*(설명|질문|시각화): .*\*\*$/;

/**
 * Splits a footnote's content into the original note and each follow-up appended to it, each
 * starting at its bold `설명: …`/`질문: …` heading on a paragraph of its own.
 */
export function splitFollowUps(content: string): string[] {
  const lines = content.split("\n");
  const parts: string[][] = [[]];
  lines.forEach((line, i) => {
    if (i > 0 && lines[i - 1].trim() === "" && FOLLOW_UP_HEADING.test(line)) parts.push([]);
    parts[parts.length - 1].push(line);
  });
  return parts.map((part) => part.join("\n").trim()).filter((part) => part !== "");
}

export interface Footnote {
  label: string;
  number: number;
  content: string;
  meta: NoteMeta;
  /** The passage the footnote was asked about, as plain text, when known. */
  passage?: string;
}

/** `markdown` reduced to one plain line: emphasis, code and highlight markers dropped. */
export function plainLine(markdown: string): string {
  return markdown.replace(/\*\*|__|==|`/g, "").replace(/\s+/g, " ").trim();
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
  /**
   * A reader's instruction on an agent answer: wrapped in `COMMENT_OPEN`/`COMMENT_CLOSE` and
   * painted pink, with no superscript. `number` still names its footnote for hover and click.
   */
  comment?: boolean;
}

// A highlight may contain a single `=` (as in "a = b"), never `==`.
const INLINE_TOKEN = /==(?=\S)((?:[^=\n]|=(?!=))*?\S)==(\[\^([^\]\s]+)\])?|\[\^([^\]\s]+)\]/g;
const INNER_REFERENCE = /\[\^([^\]\s]+)\](?!:)/g;
// Private-use characters that stand in for inline code spans while highlights are parsed.
const CODE_OPEN = "";
const CODE_CLOSE = "";
const CODE_PLACEHOLDER = /(\d+)/g;
const LEGACY_CODE_MARK = /`==((?:[^=`\n]|=(?!=))+?)==`/g;
const LEGACY_EMPHASIS_MARK = /(\*\*|\*|~~)==((?:[^=\n]|=(?!=))+?)==\1/g;

/**
 * Moves highlights written inside inline code or emphasis (`` `==x==` ``, `**==x==**`) outside
 * it for display. Inside code `==` is literal, and inside emphasis it can keep the emphasis from
 * closing. Older versions of this plugin wrote them that way.
 */
function hoistLegacyMarks(line: string): string {
  return line.replace(LEGACY_CODE_MARK, "==`$1`==").replace(LEGACY_EMPHASIS_MARK, "==$1$2$1==");
}

/** Splits footnote definitions out of `text`, adding them to `definitions`; returns the other lines. */
function extractDefinitions(text: string, definitions: Map<string, Definition>): string[] {
  const lines = text.split("\n");
  const bodyLines: string[] = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) inFence = !inFence;
    const def = inFence ? null : FOOTNOTE_DEF.exec(line);
    if (!def) {
      bodyLines.push(line);
      continue;
    }
    const { rest, meta } = splitMeta(def[2]);
    const content = [rest];
    while (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (INDENTED.test(next)) content.push(next.replace(INDENTED, ""));
      else if (next.trim() === "" && i + 2 < lines.length && INDENTED.test(lines[i + 2])) content.push("");
      else break;
      i++;
    }
    definitions.set(def[1], { content: content.join("\n").trim(), meta });
  }
  return bodyLines;
}

/** Per-footnote reader state: a bookmark and a free-form memo. */
export interface NoteMeta {
  bookmark?: boolean;
  /** When the footnote was bookmarked, as an ISO time; absent on bookmarks made before it was kept. */
  bookmarkedAt?: string;
  memo?: string;
  /** For a footnote on an agent message: which message, and which occurrence of which passage. */
  anchor?: NoteAnchor;
  /** The reader's own comment on the passage, as opposed to an AI explanation or answer. */
  comment?: boolean;
  /** A comment already sent to the agent with one of the reader's messages. */
  sent?: boolean;
  /** An unsent comment the reader held back from their next message. */
  excluded?: boolean;
}

export interface NoteAnchor {
  message: string;
  quote: string;
  occurrence: number;
}

function parseAnchor(value: unknown): NoteAnchor | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { message, quote, occurrence } = value as Record<string, unknown>;
  if (typeof message !== "string" || typeof quote !== "string" || quote === "") return undefined;
  return { message, quote, occurrence: typeof occurrence === "number" && occurrence >= 0 ? occurrence : 0 };
}

interface Definition {
  content: string;
  meta: NoteMeta;
}

/**
 * Metadata rides at the end of a definition's first line as an HTML comment, which other
 * Markdown viewers hide: `[^1]: **설명: x** <!-- doc-ask {"bookmark":true} -->`.
 */
const META = /\s*<!-- doc-ask (\{.*\}) -->\s*$/;

function splitMeta(firstLine: string): { rest: string; meta: NoteMeta } {
  const match = META.exec(firstLine);
  if (!match) return { rest: firstLine, meta: {} };
  let meta: NoteMeta = {};
  try {
    const parsed = JSON.parse(match[1]) as Record<string, unknown>;
    if (parsed.bookmark === true) meta.bookmark = true;
    if (meta.bookmark && typeof parsed.bookmarkedAt === "string") meta.bookmarkedAt = parsed.bookmarkedAt;
    if (typeof parsed.memo === "string" && parsed.memo.trim() !== "") meta.memo = parsed.memo;
    const anchor = parseAnchor(parsed.anchor);
    if (anchor) meta.anchor = anchor;
    if (parsed.comment === true) meta.comment = true;
    if (parsed.sent === true) meta.sent = true;
    if (parsed.excluded === true) meta.excluded = true;
  } catch {
    // Unreadable metadata is ignored, not shown.
  }
  return { rest: firstLine.slice(0, match.index), meta };
}

function encodeMeta(meta: NoteMeta): string {
  const clean: NoteMeta = {};
  if (meta.bookmark) clean.bookmark = true;
  // The time goes only with the bookmark it stamps.
  if (meta.bookmark && meta.bookmarkedAt) clean.bookmarkedAt = meta.bookmarkedAt;
  if (meta.memo?.trim()) clean.memo = meta.memo.trim();
  if (meta.anchor) clean.anchor = meta.anchor;
  if (meta.comment) clean.comment = true;
  if (meta.sent) clean.sent = true;
  if (meta.excluded) clean.excluded = true;
  if (!clean.bookmark && !clean.memo && !clean.anchor && !clean.comment && !clean.sent && !clean.excluded) return "";
  // Escape characters that could end the HTML comment early.
  const json = JSON.stringify(clean).replace(/>/g, "\\u003e").replace(/-/g, "\\u002d");
  return ` <!-- doc-ask ${json} -->`;
}

/** Sets footnote `label`'s metadata in `text`; null when `text` does not define it. */
export function setNoteMeta(text: string, label: string, meta: NoteMeta): string | null {
  const lines = text.split("\n");
  const span = definitionSpan(lines, label);
  if (!span) return null;
  lines[span.first] = lines[span.first].replace(META, "") + encodeMeta(meta);
  return lines.join("\n");
}

/** A bookmarked footnote of a comment file, for the workspace bookmark list. */
export interface Bookmark {
  label: string;
  /** The footnote's first line without its bold markers, such as "설명: Team Create". */
  title: string;
  memo: string | null;
  content: string;
  bookmarkedAt: string | null;
}

/** `meta` with its bookmark turned on (stamped with `now`) or off. */
export function toggledBookmark(meta: NoteMeta, now = new Date()): NoteMeta {
  const { bookmarkedAt: _, ...rest } = meta;
  return meta.bookmark ? { ...rest, bookmark: false } : { ...rest, bookmark: true, bookmarkedAt: now.toISOString() };
}

/** The bookmarked footnotes defined in `text`. */
export function listBookmarks(text: string): Bookmark[] {
  const definitions = new Map<string, Definition>();
  extractDefinitions(text, definitions);
  return [...definitions]
    .filter(([, definition]) => definition.meta.bookmark)
    .map(([label, definition]) => ({
      label,
      title: (definition.content.split("\n")[0] ?? "").replace(/\*\*/g, "").trim(),
      memo: definition.meta.memo ?? null,
      content: definition.content,
      bookmarkedAt: definition.meta.bookmarkedAt ?? null,
    }));
}

/**
 * Prepares Markdown for display: removes footnote definitions, replaces references with
 * superscript numbers (numbered by first reference), and unwraps `==highlights==`, wrapping each
 * in `MARK_OPEN`/`MARK_CLOSE`. A highlight's own reference is dropped from the body; the
 * highlight stands for it. Definitions come from the document and from `comments`, its
 * comment file; the document's own win. Returns the body, the notes in number order
 * (unreferenced definitions last), and the highlights in document order. Fenced and inline code
 * are left alone.
 */
export function prepareFootnotes(
  text: string,
  comments = "",
): { body: string; notes: Footnote[]; marks: Mark[] } {
  const definitions = new Map<string, Definition>();
  extractDefinitions(comments, definitions);
  const bodyLines = extractDefinitions(text, definitions);

  const numbers = new Map<string, number>();
  const marks: Mark[] = [];
  const numberOf = (label: string) => {
    let n = numbers.get(label);
    if (n === undefined) numbers.set(label, (n = numbers.size + 1));
    return n;
  };
  let inFence = false;
  const body = bodyLines
    .map((line) => {
      if (FENCE.test(line)) inFence = !inFence;
      if (inFence || (!line.includes("[^") && !line.includes("=="))) return line;
      // Inline code is opaque: swap each span for a placeholder so `==` inside it is left alone,
      // while a highlight around it (==`code`==) still parses.
      const spans: string[] = [];
      const masked = hoistLegacyMarks(line).replace(/`+[^`]*`+/g, (span) => {
        spans.push(span);
        return `${CODE_OPEN}${spans.length - 1}${CODE_CLOSE}`;
      });
      const restore = (text: string) =>
        text.replace(CODE_PLACEHOLDER, (_, index: string) => spans[Number(index)]);
      return restore(
        masked.replace(
          INLINE_TOKEN,
          (match, marked: string | undefined, markRef: string | undefined, markLabel: string | undefined, label: string | undefined, offset: number) => {
            if (marked !== undefined) {
              // References inside a highlight (a comment on part of it) come first in reading
              // order, so they are numbered before the highlight's own reference.
              const inner = marked.replace(INNER_REFERENCE, (ref, innerLabel: string) =>
                definitions.has(innerLabel) ? superscript(numberOf(innerLabel)) : ref,
              );
              const linked = markLabel !== undefined && definitions.has(markLabel);
              const n = linked ? numberOf(markLabel) : null;
              marks.push({ text: restore(marked.replace(INNER_REFERENCE, "")), number: n });
              const shown = MARK_OPEN + inner + MARK_CLOSE;
              // A linked highlight shows no number: hovering or clicking it opens the footnote.
              if (markRef === undefined || n !== null) return shown;
              return shown + markRef;
            }
            if (label === undefined || !definitions.has(label)) return match;
            const adjacent = offset > 0 && masked.slice(0, offset).endsWith("]");
            return `${adjacent ? "," : ""}${superscript(numberOf(label))}`;
          },
        ),
      );
    })
    .join("\n")
    .replace(/\s+$/, "");
  for (const label of definitions.keys()) {
    if (!numbers.has(label)) numbers.set(label, numbers.size + 1);
  }
  // A highlight names the passage its footnote is about.
  const passages = new Map<number, string>();
  for (const mark of marks) if (mark.number !== null && !passages.has(mark.number)) passages.set(mark.number, plainLine(mark.text));
  const notes = [...numbers].map(([label, number]) => {
    const passage = passages.get(number);
    return {
      label,
      number,
      content: definitions.get(label)?.content ?? "",
      meta: definitions.get(label)?.meta ?? {},
      ...(passage ? { passage } : {}),
    };
  });
  return { body, notes, marks };
}

/** What a footnote unit is: an AI explanation or answer, or the reader's own comment. */
export type NoteKind = "설명" | "질문" | "시각화" | "주석" | "지시";

const TITLE_LINE = /^\*\*(설명|질문|시각화|주석|지시): ([\s\S]*)\*\*\s*$/;

/**
 * A footnote unit's bold `kind: subject` title line split from its body, so the kind can be
 * shown as an icon. Null when the unit does not start with such a title.
 */
export function splitTitle(unit: string): { kind: NoteKind; subject: string; body: string } | null {
  const newline = unit.indexOf("\n");
  const first = newline === -1 ? unit : unit.slice(0, newline);
  const match = TITLE_LINE.exec(first.trim());
  if (!match) return null;
  return {
    kind: match[1] as NoteKind,
    subject: match[2]!.trim(),
    body: newline === -1 ? "" : unit.slice(newline + 1).replace(/^\s*\n/, ""),
  };
}
