import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import {
  buildFootnote,
  COMMENT_CLOSE,
  COMMENT_OPEN,
  type Footnote,
  MARK_CLOSE,
  MARK_OPEN,
  type Mark,
  type NoteAnchor,
  nextFootnoteLabel,
  prepareFootnotes,
  removeFootnote,
  plainLine,
  setNoteMeta,
  superscript,
  type TextRange,
} from "./markdown";

/**
 * Footnotes on agent messages. Messages never change, so a footnote points at a message and the
 * nth occurrence of a passage in it instead of marking the text. The footnotes of one agent live
 * in a plugin-owned comment file on the daemon, in the same format as a document's.
 */

/** Reads an agent's footnotes; empty when it has none. */
export const chatNotesReadRpc = defineRpc({
  name: "doc-ask.chat-notes.read",
  input: z.object({ agentId: z.string() }),
  output: z.object({ text: z.string() }),
});

/** Writes an agent's footnotes if the file still holds `base`. */
export const chatNotesWriteRpc = defineRpc({
  name: "doc-ask.chat-notes.write",
  input: z.object({ agentId: z.string(), text: z.string(), base: z.string() }),
  output: z.object({ status: z.enum(["written", "conflict"]) }),
});

/**
 * A stable key for a message: a hash of its text. The provider's message id cannot be used:
 * Claude gives the API message id while an answer streams but the transcript entry's uuid when
 * the conversation is replayed after a restart, so footnotes keyed by id would vanish.
 */
export function messageKey(text: string): string {
  text = text.trim();
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `h:${hash.toString(16)}:${text.length}`;
}

/** The anchor for `range` of `text`: the passage and how many times it occurs before. */
export function anchorAt(message: string, text: string, range: TextRange): NoteAnchor {
  const quote = text.slice(range.from, range.to);
  let occurrence = 0;
  for (let i = text.indexOf(quote); i !== -1 && i < range.from; i = text.indexOf(quote, i + 1)) occurrence++;
  return { message, quote, occurrence };
}

/** Where an anchor points in `text`, or null when that occurrence no longer exists. */
export function anchorRange(text: string, anchor: NoteAnchor): TextRange | null {
  let index = text.indexOf(anchor.quote);
  for (let n = 0; index !== -1 && n < anchor.occurrence; n++) index = text.indexOf(anchor.quote, index + 1);
  return index === -1 ? null : { from: index, to: index + anchor.quote.length };
}

/**
 * An agent's footnotes in label order, numbered: AI explanations from 1, then the reader's
 * instructions after them. Instructions show no number, so explanations number without gaps;
 * theirs only tells footnotes apart for hover and click.
 */
export function chatNotes(comments: string): Footnote[] {
  const byLabel = prepareFootnotes("", comments).notes.sort(
    (a, b) => (Number(a.label) || 0) - (Number(b.label) || 0),
  );
  const ordered = [...byLabel.filter((note) => !note.meta.comment), ...byLabel.filter((note) => note.meta.comment)];
  return ordered.map((note, index) => ({
    ...note,
    number: index + 1,
    ...(note.meta.anchor ? { passage: plainLine(note.meta.anchor.quote) } : {}),
  }));
}

const NO_MARKS: Mark[] = [];

/** The footnotes on message `key` that still find their passage, in passage order. */
function placedNotes(text: string, key: string, notes: Footnote[]): { note: Footnote; range: TextRange }[] {
  return notes
    .filter((note) => note.meta.anchor?.message === key)
    .map((note) => ({ note, range: anchorRange(text, note.meta.anchor as NoteAnchor) }))
    .filter((entry): entry is { note: Footnote; range: TextRange } => entry.range !== null)
    .sort((a, b) => a.range.from - b.range.from || a.range.to - b.range.to || a.note.number - b.note.number);
}

/** The first of each run of overlapping passages, which alone can be highlighted. */
function firstOfOverlaps(placed: { note: Footnote; range: TextRange }[]): Set<Footnote> {
  const highlighted = new Set<Footnote>();
  let end = -1;
  for (const { note, range } of placed) {
    if (range.from >= end) {
      highlighted.add(note);
      end = range.to;
    }
  }
  return highlighted;
}

/**
 * Prepares one message for display. AI explanations: each passage is wrapped in the highlight
 * sentinels, with no number: hovering or clicking it opens the footnote. Where passages overlap,
 * the earlier one is highlighted and the others show only their superscript number, so every
 * footnote stays reachable. The reader's instructions are wrapped in their own sentinels, independent of
 * explanations, and get no number; an instruction overlapping an earlier one is reachable from
 * the side panel only.
 */
export function chatMarks(text: string, key: string, notes: Footnote[]): { body: string; marks: Mark[] } {
  // Most messages carry no footnote: return the text as is, with one shared empty list.
  if (!notes.some((note) => note.meta.anchor?.message === key)) return { body: text, marks: NO_MARKS };
  const placed = placedNotes(text, key, notes);
  const explained = placed.filter(({ note }) => !note.meta.comment);
  const instructed = placed.filter(({ note }) => note.meta.comment);
  const highlighted = firstOfOverlaps(explained);
  const shownInstructions = firstOfOverlaps(instructed);

  // Insertions by offset: closing sentinels (with the superscripts of every explanation ending
  // there, comma-separated so adjacent numbers stay distinct), then opening sentinels.
  const opens = new Map<number, string>();
  const closes = new Map<number, { mark: boolean; numbers: number[]; comment: boolean }>();
  const closeAt = (offset: number) => {
    let at = closes.get(offset);
    if (!at) closes.set(offset, (at = { mark: false, numbers: [], comment: false }));
    return at;
  };
  for (const { note, range } of explained) {
    const at = closeAt(range.to);
    // A highlighted explanation shows no number; only those left without a highlight need one.
    if (!highlighted.has(note)) at.numbers.push(note.number);
    if (highlighted.has(note)) {
      at.mark = true;
      opens.set(range.from, (opens.get(range.from) ?? "") + MARK_OPEN);
    }
  }
  for (const { note, range } of instructed) {
    if (!shownInstructions.has(note)) continue;
    closeAt(range.to).comment = true;
    opens.set(range.from, COMMENT_OPEN + (opens.get(range.from) ?? ""));
  }
  const offsets = [...new Set([...opens.keys(), ...closes.keys()])].sort((a, b) => b - a);
  let body = text;
  for (const offset of offsets) {
    const at = closes.get(offset);
    const closing = at
      ? (at.mark ? MARK_CLOSE : "") + at.numbers.map(superscript).join(",") + (at.comment ? COMMENT_CLOSE : "")
      : "";
    body = body.slice(0, offset) + closing + (opens.get(offset) ?? "") + body.slice(offset);
  }
  const markOf = ({ note }: { note: Footnote }): Mark => ({ text: note.meta.anchor?.quote ?? "", number: note.number });
  return {
    body,
    marks: [
      ...explained.filter(({ note }) => highlighted.has(note)).map(markOf),
      ...instructed.filter(({ note }) => shownInstructions.has(note)).map((entry) => ({ ...markOf(entry), comment: true })),
    ],
  };
}

/**
 * The reader's own comments on message `key`, in passage order, as Markdown ready to paste:
 * each passage quoted, followed by the comment.
 */
export function copyComments(text: string, key: string, notes: Footnote[]): string {
  return quoteComments(
    placedNotes(text, key, notes)
      .filter(({ note }) => note.meta.comment)
      .map(({ note, range }) => ({ quote: text.slice(range.from, range.to), comment: commentOf(note) })),
  );
}

/** Each passage quoted, followed by its comment. */
function quoteComments(entries: { quote: string; comment: string }[]): string {
  return entries
    .map(({ quote, comment }) => {
      const quoted = quote
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      // An empty comment only points at the passage.
      return comment ? `${quoted}\n\n${comment}` : quoted;
    })
    .join("\n\n");
}

/** A comment's own words: the definition starts with its bold title, such as "지시: …". */
function commentOf(note: Footnote): string {
  return note.content.replace(/^\*\*[^\n]*\*\*\s*/, "").trim();
}

/** What is known of an answer: its text, and how many turns ago it came (1: the latest). */
export interface AnswerInfo {
  text?: string;
  turnsAgo?: number;
}

/** How an answer `turnsAgo` turns back is named to the agent. */
export function answerAge(turnsAgo: number | undefined): string {
  if (turnsAgo === undefined) return "이전 답변(시점 확인 안 됨)";
  return turnsAgo <= 1 ? "직전 답변" : `${turnsAgo}턴 전 답변`;
}

/**
 * The reader's comments not yet sent to the agent and not held back, on every answer: grouped by answer, oldest
 * first, each group headed by how many turns ago its answer came and quoted the way
 * `copyComments` does. `answers` tells the text (for passage order) and age of the answers it
 * knows; comments on others still go, after their passage alone. Null when there are none.
 */
export function unsentComments(
  notes: Footnote[],
  answers: ReadonlyMap<string, AnswerInfo>,
): { block: string; labels: string[]; items: { quote: string; comment: string; turnsAgo?: number }[] } | null {
  const groups = new Map<string, Footnote[]>();
  for (const note of notes) {
    const anchor = note.meta.anchor;
    if (!note.meta.comment || note.meta.sent || note.meta.excluded || !anchor) continue;
    const group = groups.get(anchor.message);
    if (group) group.push(note);
    else groups.set(anchor.message, [note]);
  }
  if (groups.size === 0) return null;
  const byLabel = (a: Footnote, b: Footnote) => (Number(a.label) || 0) - (Number(b.label) || 0);
  const answersInOrder = [...groups].map(([key, group]) => {
    const { text, turnsAgo } = answers.get(key) ?? {};
    const at = (note: Footnote) => (text ? (anchorRange(text, note.meta.anchor as NoteAnchor)?.from ?? Infinity) : Infinity);
    const ordered = [...group].sort((a, b) => at(a) - at(b) || byLabel(a, b));
    return {
      turnsAgo,
      first: Math.min(...group.map((note) => Number(note.label) || 0)),
      entries: ordered.map((note) => ({ label: note.label, quote: (note.meta.anchor as NoteAnchor).quote, comment: commentOf(note) })),
    };
  });
  // Oldest answer first; one of unknown age lies beyond the turns looked at, so it comes first.
  answersInOrder.sort((a, b) => (b.turnsAgo ?? Infinity) - (a.turnsAgo ?? Infinity) || a.first - b.first);
  const entries = answersInOrder.flatMap(({ turnsAgo, entries }) => entries.map((entry) => ({ ...entry, turnsAgo })));
  return {
    block: answersInOrder.map(({ turnsAgo, entries }) => `### ${answerAge(turnsAgo)}\n\n${quoteComments(entries)}`).join("\n\n"),
    labels: entries.map((entry) => entry.label),
    items: entries.map(({ quote, comment, turnsAgo }) => ({ quote, comment, ...(turnsAgo !== undefined ? { turnsAgo } : {}) })),
  };
}

/**
 * How many turns ago each answer in `timeline` (oldest first) came, by message key: 1 for the
 * answers after the last user message, 2 for those before it, and so on.
 */
export function answerAges(timeline: readonly { type: string; text?: string }[]): Map<string, number> {
  const ages = new Map<string, number>();
  let userMessages = 0;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const item = timeline[i];
    if (item.type === "user_message") userMessages++;
    else if (item.type === "assistant_message" && item.text) {
      const key = messageKey(item.text);
      if (!ages.has(key)) ages.set(key, userMessages + 1);
    }
  }
  return ages;
}

/** Marks footnotes `labels` in `comments` as sent to the agent. */
export function markSent(comments: string, labels: readonly string[]): string {
  for (const note of chatNotes(comments)) {
    if (!labels.includes(note.label)) continue;
    comments = setNoteMeta(comments, note.label, { ...note.meta, sent: true }) ?? comments;
  }
  return comments;
}

/**
 * Adds a footnote on `range` of a message and appends its definition with its anchor. An AI
 * answer replaces footnotes on the same message that overlap it; a reader's comment
 * (`comment: true`) keeps them. Returns the new comment text, the new label, and the replaced
 * labels.
 */
export function annotateChat(
  comments: string,
  text: string,
  key: string,
  range: TextRange,
  heading: string,
  subject: string,
  answer: string,
  options: { comment?: boolean } = {},
): { comments: string; id: string; replaced: string[] } {
  const replaced: string[] = [];
  if (!options.comment) {
    for (const note of chatNotes(comments)) {
      if (note.meta.anchor?.message !== key) continue;
      const other = anchorRange(text, note.meta.anchor);
      if (!other || other.from >= range.to || other.to <= range.from) continue;
      comments = removeFootnote("", comments, note.label).comments;
      replaced.push(note.label);
    }
  }
  const id = nextFootnoteLabel(comments);
  const existing = comments.replace(/\s+$/, "");
  const definition = buildFootnote(id, heading, subject, answer);
  const appended = existing === "" ? `${definition}\n` : `${existing}\n\n${definition}\n`;
  const meta = { anchor: anchorAt(key, text, range), ...(options.comment ? { comment: true } : {}) };
  return { comments: setNoteMeta(appended, id, meta) ?? appended, id, replaced };
}

/** Whether completed assistant messages are drawn by the plugin so they can carry footnotes. */
export const chatSettings = defineSettings({
  id: "chat",
  scope: "host",
  version: 1,
  schema: z.object({
    annotate: z.boolean().default(false),
    /** Sends the reader's comments on the latest answer along with their next message. */
    includeComments: z.boolean().default(true),
  }),
});
