/**
 * Answers as the explainer writes them, so the side panel can show an answer before it is done.
 * A request publishes its text by request ID; subscribers follow it until they release.
 */

/** The answer being written in one turn: the agent's text after its latest tool call. */
export class AnswerDraft {
  text = "";
  private afterTool = false;
  private messageId: string | undefined;

  /** Folds one timeline item in; returns whether the text changed. */
  add(item: { type: string; text?: string; messageId?: string }): boolean {
    if (item.type === "tool_call") this.afterTool = true;
    if (item.type !== "assistant_message" || !item.text) return false;
    const newMessage = item.messageId !== undefined && this.messageId !== undefined && item.messageId !== this.messageId;
    if (this.afterTool || newMessage) this.text = "";
    this.afterTool = false;
    this.messageId = item.messageId ?? this.messageId;
    // Providers send deltas; a chunk that repeats the whole text so far is the full message instead.
    this.text = this.text && item.text.startsWith(this.text) ? item.text : this.text + item.text;
    return true;
  }
}

interface Entry {
  text: string;
  running: boolean;
  listeners: Set<(text: string) => void>;
}

const entries = new Map<string, Entry>();

function entryOf(requestId: string): Entry {
  let entry = entries.get(requestId);
  if (!entry) entries.set(requestId, (entry = { text: "", running: false, listeners: new Set() }));
  return entry;
}

function forgetIfDone(requestId: string, entry: Entry): void {
  if (!entry.running && entry.listeners.size === 0 && entries.get(requestId) === entry) entries.delete(requestId);
}

/** Records the answer of `requestId` so far and tells its followers. */
export function publishAnswer(requestId: string, text: string): void {
  const entry = entryOf(requestId);
  entry.running = true;
  entry.text = text;
  for (const listener of entry.listeners) listener(text);
}

/** Marks `requestId` finished; its text is dropped once nobody follows it. */
export function endAnswer(requestId: string): void {
  const entry = entries.get(requestId);
  if (!entry) return;
  entry.running = false;
  forgetIfDone(requestId, entry);
}

/**
 * Calls `listener` with the answer of `requestId` now, if any, and on every change. The request may
 * start after this. Returns a function that stops following.
 */
export function followAnswer(requestId: string, listener: (text: string) => void): () => void {
  const entry = entryOf(requestId);
  entry.listeners.add(listener);
  if (entry.text) listener(entry.text);
  return () => {
    entry.listeners.delete(listener);
    forgetIfDone(requestId, entry);
  };
}

/** Number of requests whose text is kept, for tests. */
export function keptAnswers(): number {
  return entries.size;
}
