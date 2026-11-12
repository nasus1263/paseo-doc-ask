import { defineRpc } from "@getpaseo/plugin";
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

/**
 * Prepares one message for display: wraps each passage with a footnote in the highlight
 * sentinels and follows it with the footnote's superscript number. Overlapping passages keep
 * the earlier one.
 */
export function chatMarks(text: string, key: string, notes: Footnote[]): { body: string; marks: Mark[] } {
  const placed = notes
    .filter((note) => note.meta.anchor?.message === key)
    .map((note) => ({ note, range: anchorRange(text, note.meta.anchor as NoteAnchor) }))
    .filter((entry): entry is { note: Footnote; range: TextRange } => entry.range !== null)
    .sort((a, b) => a.range.from - b.range.from);
  const kept: typeof placed = [];
  for (const entry of placed) {
    const last = kept[kept.length - 1];
    if (!last || entry.range.from >= last.range.to) kept.push(entry);
  }
  let body = text;
  for (const { note, range } of [...kept].reverse()) {
    body =
      body.slice(0, range.from) +
      MARK_OPEN +
      body.slice(range.from, range.to) +
      MARK_CLOSE +
      superscript(note.number) +
      body.slice(range.to);
  }
  return { body, marks: kept.map(({ note }) => ({ text: note.meta.anchor?.quote ?? "", number: note.number })) };
}

/**
 * Adds a footnote on `range` of a message: removes footnotes on the same message that overlap
 * it, then appends the new definition with its anchor. Returns the new comment text, the new
 * label, and the replaced labels.
 */
export function annotateChat(
  comments: string,
  text: string,
  key: string,
  range: TextRange,
  heading: string,
  subject: string,
  answer: string,
): { comments: string; id: string; replaced: string[] } {
  const replaced: string[] = [];
  for (const note of chatNotes(comments)) {
    if (note.meta.anchor?.message !== key) continue;
    const other = anchorRange(text, note.meta.anchor);
    if (!other || other.from >= range.to || other.to <= range.from) continue;
    comments = removeFootnote("", comments, note.label).comments;
    replaced.push(note.label);
  }
  const id = nextFootnoteLabel(comments);
  const existing = comments.replace(/\s+$/, "");
  const definition = buildFootnote(id, heading, subject, answer);
  const appended = existing === "" ? `${definition}\n` : `${existing}\n\n${definition}\n`;
  const withAnchor = setNoteMeta(appended, id, { anchor: anchorAt(key, text, range) }) ?? appended;
  return { comments: withAnchor, id, replaced };
}
