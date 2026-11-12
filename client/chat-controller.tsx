import { useAgent, useRpc } from "@getpaseo/plugin/client";
import { useEffect, useSyncExternalStore } from "react";
import { annotateChat, chatNotes, chatNotesReadRpc, chatNotesWriteRpc } from "../shared/chat";
import { type AskMode, explainRpc } from "../shared/explain";
import {
  appendToFootnote,
  type Footnote,
  locateRendered,
  type NoteMeta,
  removeFootnote,
  setNoteMeta,
} from "../shared/markdown";
import { DeleteNoteModal, MemoModal, QuestionModal, type Theme } from "./doc-ask-panel";
import { openNotesPanel } from "./host";
import { type Message, type NotesActions, publishNotes, refreshNotes } from "./notes-store";

/**
 * Footnotes on one agent's messages. Every message row of the agent shares one controller; it
 * owns the agent's footnote file contents, the request in flight, and the side panel state.
 */

type Read = (input: { agentId: string }) => Promise<{ text: string }>;
type Write = (input: { agentId: string; text: string; base: string }) => Promise<{ status: "written" | "conflict" }>;
type Explain = ReturnType<typeof useRpc<typeof explainRpc.input, typeof explainRpc.output>>;

interface Deps {
  read: Read;
  write: Write;
  explain: Explain;
  workspaceId: string | null;
  title: string | null;
}

/** A dialog the side panel shows for this agent. */
type Dialog =
  | { kind: "question"; label: string; selected: string }
  | { kind: "memo"; label: string }
  | { kind: "delete"; label: string };

interface State {
  /** The footnote file contents; null until loaded. */
  text: string | null;
  message: Message | null;
  dialog: Dialog | null;
}

/** A selection in a message: the message, its source, and where the selection sat. */
export interface MessageSelection {
  key: string;
  source: string;
  selected: string;
  /** Kept characters before the selection in the rendered message. */
  hint: number;
}

const MODE_LABEL: Record<AskMode, string> = { term: "설명", question: "질문" };

class ChatController {
  readonly owner = Symbol("doc-ask-chat");
  state: State = { text: null, message: null, dialog: null };
  private deps: Deps | null = null;
  private loading = false;
  private busy = false;
  private readonly listeners = new Set<() => void>();
  /** Message rows that can scroll a footnote into view, by message key. */
  private readonly revealers = new Map<string, (number: number) => void>();
  readonly actions: NotesActions;

  constructor(readonly agentId: string) {
    this.actions = {
      ask: (selection, mode) => {
        if (mode === "question") this.set({ dialog: { kind: "question", label: selection.label, selected: selection.text } });
        else void this.askNote(selection.label, selection.text, mode);
      },
      toggleBookmark: (label) => void this.changeMeta(label, (meta) => ({ ...meta, bookmark: !meta.bookmark })),
      editMemo: (label) => this.set({ dialog: { kind: "memo", label } }),
      deleteNote: (label) => this.set({ dialog: { kind: "delete", label } }),
      openNote: (label) => this.openNote(label),
      closeMessage: () => this.set({ message: null }),
    };
  }

  bind(deps: Deps): void {
    this.deps = deps;
    if (this.state.text === null && !this.loading) {
      this.loading = true;
      deps
        .read({ agentId: this.agentId })
        .then(({ text }) => this.set({ text }))
        .catch(() => this.set({ text: "" }))
        .finally(() => {
          this.loading = false;
        });
    }
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** The agent's footnotes, parsed once per change of the file and shared by every message row. */
  notes(): Footnote[] {
    const text = this.state.text ?? "";
    if (this.parsed?.text !== text) this.parsed = { text, notes: chatNotes(text) };
    return this.parsed.notes;
  }
  private parsed: { text: string; notes: Footnote[] } | null = null;

  registerRevealer(key: string, reveal: (number: number) => void): () => void {
    this.revealers.set(key, reveal);
    return () => {
      if (this.revealers.get(key) === reveal) this.revealers.delete(key);
    };
  }

  private set(change: Partial<State>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
    refreshNotes(this.snapshot());
  }

  private snapshot() {
    return {
      owner: this.owner,
      workspaceId: this.deps?.workspaceId ?? "",
      path: `agent:${this.agentId}`,
      name: this.deps?.title ? `대화: ${this.deps.title}` : "대화",
      notes: this.notes(),
      message: this.state.message,
      actions: this.actions,
      Dialogs: this.Dialogs,
    };
  }

  /** Makes the side panel follow this conversation and opens it. */
  private showSidePanel(): void {
    publishNotes(this.snapshot());
    if (this.deps?.workspaceId) openNotesPanel(this.deps.workspaceId);
  }

  openNote(label: string): void {
    const note = this.notes().find((n) => n.label === label);
    if (!note) return;
    this.set({ message: { kind: "note", title: "", status: `각주 ${note.number}`, answer: null, note: label } });
    this.showSidePanel();
    const key = note.meta.anchor?.message;
    if (key) this.revealers.get(key)?.(note.number);
  }

  openNoteByNumber(number: number): void {
    const note = this.notes().find((n) => n.number === number);
    if (note) this.openNote(note.label);
  }

  /** Reads the newest footnotes, applies `change`, and writes them if nobody wrote meanwhile. */
  private async update(change: (text: string) => string | null, missing: string): Promise<string | null> {
    if (!this.deps) return "연결되지 않았습니다.";
    const { text: latest } = await this.deps.read({ agentId: this.agentId });
    const next = change(latest);
    if (next === null) return missing;
    const { status } = await this.deps.write({ agentId: this.agentId, text: next, base: latest });
    if (status === "conflict") return "저장 실패: 그사이 각주가 변경되었습니다. 다시 시도해 주세요.";
    this.set({ text: next });
    return null;
  }

  /** Explains or answers a question about a selection in a message, adding a footnote. */
  async askMessage(selection: MessageSelection, mode: AskMode, question?: string): Promise<void> {
    const range = locateRendered(selection.source, selection.selected, selection.hint);
    const label = MODE_LABEL[mode];
    const subject = mode === "question" && question ? question : selection.selected;
    const title = `${label}: ${subject}`;
    if (!range) {
      this.set({ message: { kind: "failed", title, status: "선택한 부분을 메시지에서 찾지 못했습니다.", answer: null } });
      this.showSidePanel();
      return;
    }
    await this.run(title, undefined, async (deps) => {
      const { answer } = await deps.explain({
        workspaceId: deps.workspaceId ?? "",
        path: `agent:${this.agentId}`,
        document: selection.source,
        selection: selection.selected,
        mode,
        question,
      });
      let id = "";
      let replaced = 0;
      const failure = await this.update((latest) => {
        const result = annotateChat(latest, selection.source, selection.key, range, label, subject, answer);
        id = result.id;
        replaced = result.replaced.length;
        return result.comments;
      }, "");
      return { answer, failure, note: id, replaced };
    });
  }

  /**
   * Adds the reader's own comment on a selection in a message. Nothing is sent to the AI, and
   * footnotes on the same passage are kept. Returns an error message, or null when saved.
   */
  async addComment(selection: MessageSelection, comment: string): Promise<string | null> {
    const range = locateRendered(selection.source, selection.selected, selection.hint);
    if (!range) return "선택한 부분을 메시지에서 찾지 못했습니다.";
    try {
      return await this.update(
        (latest) =>
          annotateChat(latest, selection.source, selection.key, range, "주석", selection.selected, comment, {
            comment: true,
          }).comments,
        "",
      );
    } catch (cause) {
      return `저장 실패: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
  }

  /** A follow-up on a footnote shown in the side panel; the answer joins that footnote. */
  async askNote(labelOfNote: string, selected: string, mode: AskMode, question?: string): Promise<void> {
    const label = MODE_LABEL[mode];
    const subject = mode === "question" && question ? question : selected;
    const context = this.notes().find((n) => n.label === labelOfNote)?.content;
    await this.run(`${label}: ${subject}`, labelOfNote, async (deps) => {
      const { answer } = await deps.explain({
        workspaceId: deps.workspaceId ?? "",
        path: `agent:${this.agentId}`,
        document: context ?? "",
        selection: selected,
        mode,
        question,
        context,
      });
      const failure = await this.update(
        (latest) => appendToFootnote(latest, labelOfNote, label, subject, answer),
        "저장 실패: 이 각주를 찾지 못했습니다.",
      );
      return { answer, failure, note: labelOfNote, replaced: 0 };
    });
  }

  private async run(
    title: string,
    note: string | undefined,
    work: (deps: Deps) => Promise<{ answer: string; failure: string | null; note: string; replaced: number }>,
  ): Promise<void> {
    const deps = this.deps;
    if (!deps?.workspaceId) return;
    if (this.busy) {
      this.set({ message: { kind: "failed", title, status: "이전 요청의 답을 기다리는 중입니다.", answer: null, note } });
      return;
    }
    this.busy = true;
    this.set({ message: { kind: "pending", title, status: "AI에게 묻는 중…", answer: null, note } });
    this.showSidePanel();
    try {
      const result = await work(deps);
      if (result.failure) {
        this.set({ message: { kind: "failed", title, status: result.failure, answer: result.answer, note } });
        return;
      }
      const status =
        result.replaced > 0 ? `겹치던 기존 각주 ${result.replaced}개를 대체해 반영했습니다.` : "각주에 반영했습니다.";
      this.set({ message: { kind: "saved", title, status, answer: result.answer, note: result.note } });
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      this.set({ message: { kind: "failed", title, status: `요청 실패: ${reason}`, answer: null, note } });
    } finally {
      this.busy = false;
    }
  }

  async changeMeta(label: string, change: (meta: NoteMeta) => NoteMeta): Promise<boolean> {
    const current = this.notes().find((n) => n.label === label)?.meta ?? {};
    const failure = await this.update((latest) => setNoteMeta(latest, label, change(current)), "이 각주를 찾지 못했습니다.");
    if (failure) this.set({ message: { kind: "failed", title: "", status: failure, answer: null, note: label } });
    return failure === null;
  }

  async removeNote(label: string): Promise<boolean> {
    const failure = await this.update((latest) => {
      const removed = removeFootnote("", latest, label);
      return removed.found ? removed.comments : null;
    }, "이 각주를 찾지 못했습니다.");
    if (failure) {
      this.set({ message: { kind: "failed", title: "", status: failure, answer: null } });
      return false;
    }
    if (this.state.message?.note === label) this.set({ message: null });
    return true;
  }

  /** The side panel's dialogs for this conversation. */
  readonly Dialogs = ({ theme }: { theme: Theme }) => {
    const { dialog } = useChatState(this);
    const note = dialog ? (this.notes().find((n) => n.label === dialog.label) ?? null) : null;
    const close = () => this.set({ dialog: null });
    return (
      <>
        <QuestionModal
          selected={dialog?.kind === "question" ? dialog.selected : null}
          theme={theme}
          onClose={close}
          onSubmit={(question) => {
            if (dialog?.kind === "question") void this.askNote(dialog.label, dialog.selected, "question", question);
            close();
          }}
        />
        <MemoModal
          memo={dialog?.kind === "memo" ? (note?.meta.memo ?? "") : null}
          theme={theme}
          onClose={close}
          onSave={async (memo) => {
            if (dialog?.kind === "memo" && (await this.changeMeta(dialog.label, (meta) => ({ ...meta, memo })))) close();
          }}
        />
        <DeleteNoteModal
          note={dialog?.kind === "delete" ? note : null}
          theme={theme}
          onClose={close}
          onConfirm={async () => {
            if (dialog?.kind === "delete" && (await this.removeNote(dialog.label))) close();
          }}
        />
      </>
    );
  };
}

const controllers = new Map<string, ChatController>();

function controllerFor(agentId: string): ChatController {
  let controller = controllers.get(agentId);
  if (!controller) controllers.set(agentId, (controller = new ChatController(agentId)));
  return controller;
}

function useChatState(controller: ChatController): State {
  return useSyncExternalStore(controller.subscribe, () => controller.state);
}

/** The controller of `agentId`'s footnotes, bound to this component's host connection. */
export function useChatController(agentId: string): { controller: ChatController; notes: Footnote[] } {
  const controller = controllerFor(agentId);
  const read = useRpc(chatNotesReadRpc);
  const write = useRpc(chatNotesWriteRpc);
  const explain = useRpc(explainRpc);
  const agent = useAgent(agentId, (snapshot) => ({ workspaceId: snapshot.workspaceId, title: snapshot.title }));
  useEffect(() => {
    controller.bind({ read, write, explain, workspaceId: agent?.workspaceId ?? null, title: agent?.title ?? null });
  }, [agent?.title, agent?.workspaceId, controller, explain, read, write]);
  // Rows follow the footnote file only, not the request status or dialogs, so a request in
  // flight does not re-render every message.
  const notes = useSyncExternalStore(controller.subscribe, () => controller.notes());
  return { controller, notes };
}
