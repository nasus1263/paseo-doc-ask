/**
 * Footnote jumps between panels. Opening another document from the bookmark list records the
 * footnote to show; the panel that opens or already shows that file takes it. Requests expire so
 * a link that was never followed does not jump later.
 */

const EXPIRE_MS = 10_000;

const pending = new Map<string, { label: string; at: number }>();
const listeners = new Set<(path: string) => void>();

function key(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

export function requestJump(path: string, label: string): void {
  pending.set(key(path), { label, at: Date.now() });
  for (const listener of listeners) listener(key(path));
}

/** The footnote label waiting for `path`, removing it; undefined when none or expired. */
export function takeJump(path: string): string | undefined {
  const entry = pending.get(key(path));
  pending.delete(key(path));
  return entry && Date.now() - entry.at < EXPIRE_MS ? entry.label : undefined;
}

/** Calls `listener` when a jump is requested for `path`. Returns the unsubscribe function. */
export function onJumpRequest(path: string, listener: () => void): () => void {
  const wrapped = (requested: string) => {
    if (requested === key(path)) listener();
  };
  listeners.add(wrapped);
  return () => listeners.delete(wrapped);
}
