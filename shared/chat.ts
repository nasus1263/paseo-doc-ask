import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import {
  buildFootnote,
  type Footnote,
  MARK_CLOSE,
  MARK_OPEN,
  type Mark,
  type NoteAnchor,
  nextFootnoteLabel,
  prepareFootnotes,
  removeFootnote,
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

/** A stable key for a message: its id, or a hash of its text when the provider gives none. */
export function messageKey(messageId: string | null | undefined, text: string): string {
  if (messageId) return messageId;
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

/** An agent's footnotes in label order, numbered by label. */
export function chatNotes(comments: string): Footnote[] {
  return prepareFootnotes("", comments)
    .notes.map((note, index) => ({ ...note, number: Number(note.label) || index + 1 }))
    .sort((a, b) => a.number - b.number);
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

/**
 * Prepares one message for display: wraps each passage with a footnote in the highlight
 * sentinels and follows it with the footnote's superscript number. Where passages overlap, the
 * earlier one is highlighted and the others show only their superscript, so every footnote
 * stays reachable.
 */
export function chatMarks(text: string, key: string, notes: Footnote[]): { body: string; marks: Mark[] } {
  // Most messages carry no footnote: return the text as is, with one shared empty list.
  if (!notes.some((note) => note.meta.anchor?.message === key)) return { body: text, marks: NO_MARKS };
  const placed = placedNotes(text, key, notes);
  const highlighted = new Set<Footnote>();
  let end = -1;
  for (const { note, range } of placed) {
    if (range.from >= end) {
      highlighted.add(note);
      end = range.to;
    }
  }
  // Insertions by offset: opening sentinels, then closing sentinels with the superscripts of
  // every footnote ending there, comma-separated so adjacent numbers stay distinct.
  const opens = new Map<number, number>();
  const ends = new Map<number, { close: boolean; numbers: number[] }>();
  for (const { note, range } of placed) {
    const at = ends.get(range.to) ?? { close: false, numbers: [] };
    at.numbers.push(note.number);
    if (highlighted.has(note)) {
      at.close = true;
      opens.set(range.from, (opens.get(range.from) ?? 0) + 1);
    }
    ends.set(range.to, at);
  }
  const offsets = [...new Set([...opens.keys(), ...ends.keys()])].sort((a, b) => b - a);
  let body = text;
  for (const offset of offsets) {
    const at = ends.get(offset);
    const closing = at ? (at.close ? MARK_CLOSE : "") + at.numbers.map(superscript).join(",") : "";
    const opening = MARK_OPEN.repeat(opens.get(offset) ?? 0);
    body = body.slice(0, offset) + closing + opening + body.slice(offset);
  }
  return {
    body,
    marks: placed
      .filter(({ note }) => highlighted.has(note))
      .map(({ note }) => ({ text: note.meta.anchor?.quote ?? "", number: note.number })),
  };
}

/**
 * The reader's own comments on message `key`, in passage order, as Markdown ready to paste:
 * each passage quoted, followed by the comment.
 */
export function copyComments(text: string, key: string, notes: Footnote[]): string {
  return commentEntries(text, key, notes)
    .map(({ quote, comment }) => {
      const quoted = quote
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      return `${quoted}\n\n${comment}`;
    })
    .join("\n\n");
}

/** The reader's comments on message `key` in passage order: the passage and the comment. */
function commentEntries(text: string, key: string, notes: Footnote[]): { label: string; quote: string; comment: string }[] {
  return placedNotes(text, key, notes)
    .filter(({ note }) => note.meta.comment)
    .map(({ note, range }) => ({
      label: note.label,
      quote: text.slice(range.from, range.to),
      // The definition starts with its bold title, such as "지시: …"; the comment follows it.
      comment: note.content.replace(/^\*\*[^\n]*\*\*\s*/, "").trim(),
    }));
}

/**
 * The reader's comments on message `key` not yet sent to the agent: quoted the way
 * `copyComments` does, one by one, and their labels. Null when there are none.
 */
export function unsentComments(
  text: string,
  key: string,
  notes: Footnote[],
): { block: string; labels: string[]; items: { quote: string; comment: string }[] } | null {
  const unsent = notes.filter((note) => note.meta.comment && !note.meta.sent);
  const entries = commentEntries(text, key, unsent);
  if (entries.length === 0) return null;
  return {
    block: copyComments(text, key, unsent),
    labels: entries.map((entry) => entry.label),
    items: entries.map(({ quote, comment }) => ({ quote, comment })),
  };
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
