import type { PermissionPrompt } from "../shared/permission";

/** How long a permission waits for the user before it is denied, so a turn cannot hang. */
const ANSWER_TIMEOUT_MS = 5 * 60 * 1000;

type Listener = (prompts: PermissionPrompt[]) => void;

/**
 * Permissions waiting for the user. Each `ask` shows a prompt to every listening app and resolves
 * with the first answer, or `false` when no app is listening or none answers in time.
 */
export class PermissionPrompts {
  private readonly waiting = new Map<string, { prompt: PermissionPrompt; answer: (allow: boolean) => void }>();
  private readonly listeners = new Set<Listener>();
  private readonly timeoutMs: number;

  constructor(timeoutMs = ANSWER_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  ask(prompt: PermissionPrompt): Promise<boolean> {
    if (this.listeners.size === 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.respond(prompt.id, false), this.timeoutMs);
      this.waiting.set(prompt.id, {
        prompt,
        answer: (allow) => {
          clearTimeout(timer);
          resolve(allow);
        },
      });
      this.notify();
    });
  }

  /** Answers prompt `id`; false when it is no longer waiting. */
  respond(id: string, allow: boolean): boolean {
    const entry = this.waiting.get(id);
    if (!entry) return false;
    this.waiting.delete(id);
    entry.answer(allow);
    this.notify();
    return true;
  }

  /** Calls `listener` with the waiting prompts now and on every change; returns the unsubscribe. */
  listen(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.list());
    return () => {
      this.listeners.delete(listener);
      // With no app left to answer, nothing waiting can be decided.
      if (this.listeners.size === 0) for (const id of [...this.waiting.keys()]) this.respond(id, false);
    };
  }

  private list(): PermissionPrompt[] {
    return [...this.waiting.values()].map((entry) => entry.prompt);
  }

  private notify(): void {
    const prompts = this.list();
    for (const listener of this.listeners) listener(prompts);
  }
}

/** The prompts of this daemon's explainers. */
export const permissionPrompts = new PermissionPrompts();
