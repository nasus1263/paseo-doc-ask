import type { PluginFilePanelProps } from "@getpaseo/plugin/client";
import { type ComponentType, useSyncExternalStore } from "react";
import type { AskMode } from "../shared/explain";
import type { Footnote } from "../shared/markdown";

/**
 * What the side "주석" panel shows: the document viewer it follows, that document's footnotes,
 * and the message about the open footnote. The viewer last used publishes here; the panel only
 * reads it and calls back through `actions`.
 */

/** What the message area shows: a status line, the request title, and the answer if any. */
export interface Message {
  kind: "pending" | "saved" | "failed" | "note";
  title: string;
  status: string;
  answer: string | null;
  /** With a footnote label, the panel shows that footnote's current content instead of `answer`. */
  note?: string;
}

/**
 * A selection in a footnote shown in the side panel, or the footnote's title for a follow-up
 * asked without one; its answer joins that footnote.
 */
export interface NoteSelection {
  text: string;
  label: string;
  /** Asked about the whole footnote, not a passage of it: `text` is only its title. */
  whole?: boolean;
}

export interface NotesActions {
  /** `question` is the typed question or request, if any. */
  ask(selection: NoteSelection, mode: AskMode, question?: string): void;
  toggleBookmark(label: string): void;
  /** Holds an unsent instruction back from the next message, or lets it go again. Chat only. */
  toggleExcluded?(label: string): void;
  editMemo(label: string): void;
  /** Asks for confirmation, then removes the footnote with its highlight and references. */
  deleteNote(label: string): void;
  /** Shows the footnote in the document and in the panel. */
  openNote(label: string): void;
  closeMessage(): void;
}

export interface NotesSnapshot {
  owner: symbol;
  workspaceId: string;
  path: string;
  name: string;
  notes: Footnote[];
  message: Message | null;
  actions: NotesActions;
  /** 각주 커밋 for this source, when it is a document in git. */
  commit?: { run(): void; busy: boolean };
  /**
   * Dialogs the panel renders for this source, for sources with no mounted component of their
   * own to host them, such as an agent conversation.
   */
  Dialogs?: ComponentType<{ theme: PluginFilePanelProps["theme"] }>;
}

let current: NotesSnapshot | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

/** Publishes a viewer's state, making it the one the panel follows. */
export function publishNotes(snapshot: NotesSnapshot): void {
  current = snapshot;
  emit();
}

/** Publishes a viewer's state when the panel follows no viewer yet. */
export function publishNotesIfIdle(snapshot: NotesSnapshot): void {
  if (current === null) publishNotes(snapshot);
}

/** Updates a viewer's state only if the panel already follows it. */
export function refreshNotes(snapshot: NotesSnapshot): void {
  if (current?.owner !== snapshot.owner) return;
  current = snapshot;
  emit();
}

/** Stops following a viewer that closed. */
export function withdrawNotes(owner: symbol): void {
  if (current?.owner !== owner) return;
  current = null;
  emit();
}

export function useNotes(): NotesSnapshot | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => current,
  );
}
