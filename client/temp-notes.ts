import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { removeTempNote, type TempNote, tempNotesReadRpc, tempNotesWriteRpc, upsertTempNote } from "../shared/temp-notes";

/**
 * 임시 각주 of one file (a document or an agent's conversation), shared by every view of it:
 * an agent's messages each show their own scope of the same list.
 */
interface Entry {
  notes: TempNote[];
  loaded: Promise<void> | null;
  listeners: Set<() => void>;
}

const entries = new Map<string, Entry>();

function entryOf(file: string): Entry {
  let entry = entries.get(file);
  if (!entry) {
    entry = { notes: [], loaded: null, listeners: new Set() };
    entries.set(file, entry);
  }
  return entry;
}

export interface TempNotes {
  /** This scope's notes. */
  notes: TempNote[];
  find(id: string): TempNote | undefined;
  /** Saves `input` for the passage, or drops the note when `input` is blank. */
  keep(note: Omit<TempNote, "updatedAt" | "scope">): void;
  drop(id: string): void;
}

/** The 임시 각주 of `file` in `scope`; `file` null keeps none. */
export function useTempNotes(file: string | null, scope: string): TempNotes {
  const read = useRpc(tempNotesReadRpc);
  const write = useRpc(tempNotesWriteRpc);
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (!file) return;
    const entry = entryOf(file);
    const listener = () => setVersion((v) => v + 1);
    entry.listeners.add(listener);
    entry.loaded ??= read({ file })
      .then(({ notes }) => {
        entry.notes = notes;
        for (const notify of entry.listeners) notify();
      })
      .catch((cause: unknown) => {
        entry.loaded = null;
        console.error("[doc-ask] Could not read 임시 각주", cause);
      });
    return () => {
      entry.listeners.delete(listener);
    };
  }, [file, read]);

  const update = useCallback(
    (change: (notes: TempNote[]) => TempNote[]) => {
      if (!file) return;
      const entry = entryOf(file);
      entry.notes = change(entry.notes);
      for (const notify of entry.listeners) notify();
      write({ file, notes: entry.notes }).catch((cause: unknown) =>
        console.error("[doc-ask] Could not save 임시 각주", cause),
      );
    },
    [file, write],
  );

  const all = file ? entryOf(file).notes : [];
  const notes = useMemo(() => all.filter((n) => n.scope === scope), [all, scope]);
  return {
    notes,
    find: (id) => all.find((n) => n.id === id),
    keep: (note) => {
      if (!note.input.trim()) {
        if (all.some((n) => n.id === note.id)) update((list) => removeTempNote(list, note.id));
        return;
      }
      update((list) => upsertTempNote(list, { ...note, scope, updatedAt: Date.now() }));
    },
    drop: (id) => {
      if (all.some((n) => n.id === id)) update((list) => removeTempNote(list, id));
    },
  };
}

export function newTempNoteId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
