import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * A 임시 각주: what was typed in the selection box when it closed without being sent. It only
 * keeps the typed text at its passage so the reader can pick it up again; it asks nothing,
 * is never sent to an agent, and is never written into the document.
 */
export const tempNoteSchema = z.object({
  id: z.string(),
  /** Which view inside the file it belongs to: a message key on agents, empty on documents. */
  scope: z.string(),
  /** The selected passage as rendered. */
  text: z.string(),
  /** Kept characters before the passage in the rendered view, to pick among repeats. */
  hint: z.number(),
  /** What was typed. */
  input: z.string(),
  updatedAt: z.number(),
});
export type TempNote = z.output<typeof tempNoteSchema>;

/** `file` names the owner: `doc:<document path>` or `agent:<agent id>`. */
export const tempNotesReadRpc = defineRpc({
  name: "doc-ask.temp-notes.read",
  input: z.object({ file: z.string() }),
  output: z.object({ notes: z.array(tempNoteSchema) }),
});

export const tempNotesWriteRpc = defineRpc({
  name: "doc-ask.temp-notes.write",
  input: z.object({ file: z.string(), notes: z.array(tempNoteSchema) }),
  output: z.object({}),
});

/** Replaces the note with the same id, or adds it. */
export function upsertTempNote(notes: readonly TempNote[], note: TempNote): TempNote[] {
  const at = notes.findIndex((n) => n.id === note.id);
  if (at === -1) return [...notes, note];
  return notes.map((n, i) => (i === at ? note : n));
}

export function removeTempNote(notes: readonly TempNote[], id: string): TempNote[] {
  return notes.filter((n) => n.id !== id);
}

/** Start of the occurrence of `needle` in `haystack` nearest to `hint`, or -1. */
export function nearestOccurrence(haystack: string, needle: string, hint: number): number {
  if (!needle) return -1;
  let best = -1;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + 1)) {
    if (best === -1 || Math.abs(i - hint) < Math.abs(best - hint)) best = i;
  }
  return best;
}

/** A short stable file name for `file` (FNV-1a, two seeds). */
export function tempNotesFileName(file: string): string {
  const hash = (seed: number) => {
    let h = seed >>> 0;
    for (let i = 0; i < file.length; i++) {
      h ^= file.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  };
  return `${hash(0x811c9dc5)}${hash(0x2b992ddf)}.json`;
}
