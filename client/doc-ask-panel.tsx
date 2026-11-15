import { z } from "zod";
import {
  PluginFileConflictError,
  PluginFileDeletedError,
  type PluginFilePanelProps,
  useFileText,
  useRpc,
  useSettings,
  useTabState,
  useWorkspace,
} from "@getpaseo/plugin/client";
import { copyText, Loading, Markdown, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { type MutableRefObject, type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type TextInput as NativeTextInput, Pressable, ScrollView, Text, View, type ViewStyle } from "react-native";
import {
  type AskMode,
  commentsReadRpc,
  commentsWriteRpc,
  commitRpc,
  explainRpc,
  promptSettings,
} from "../shared/explain";
import {
  annotate,
  appendToFootnote,
  commentPathOf,
  definesFootnote,
  type Footnote,
  keptLength,
  locateRendered,
  locateSelection,
  type Mark,
  type NoteMeta,
  prepareFootnotes,
  removeFootnote,
  setNoteMeta,
  toggledBookmark,
  splitFollowUps,
  splitTitle,
  type TextRange,
} from "../shared/markdown";
import {
  ASK_ACTIONS,
  decoratePreview,
  type DocViewerHandle,
  type FootnoteHover,
  keepSelectionOnPress,
  mountViewer,
  onEnterKey,
  type PreviewSearch,
  type RenderedSelection,
  searchPreview,
  watchFindShortcut,
  watchSelection,
  watchShown,
} from "./web";
import { stepMatch } from "../shared/search";
import { onJumpRequest, takeJump } from "./jumps";
import { SelectionComposer, useSelectionDraft } from "./selection-composer";
import { IconButton } from "./controls";
import { NoteTitle, TitledUnit } from "./note-title";
import { RichMarkdown } from "./rich-markdown";
import { followAnswer, newRequestId, openNotesPanel } from "./host";
import {
  type Message,
  type NoteSelection,
  type NotesActions,
  type NotesSnapshot,
  publishNotes,
  publishNotesIfIdle,
  refreshNotes,
  withdrawNotes,
} from "./notes-store";
import { useLinkedMarkdown } from "./links";

export type Theme = PluginFilePanelProps["theme"];

/**
 * What the user selected, and how to find it again in the newest file text. A `note` selection
 * comes from a footnote shown in the message panel; its answer joins that footnote.
 */
type Anchor =
  | { view: "source"; text: string; range: TextRange }
  | { view: "preview"; text: string; hint: number }
  | { view: "note"; text: string; label: string; whole?: boolean };

/**
 * What the search bar asks the views to show. `nonce` changes on every request, so the view
 * scrolls back to the current match even when the query and index stay the same.
 */
interface SearchRequest {
  query: string;
  index: number;
  nonce: number;
}

interface AskRequest {
  anchor: Anchor;
  mode: AskMode;
  question?: string;
}


const MODE_LABEL: Record<AskMode, string> = { term: "설명", question: "질문", visual: "시각화" };
const TOOLTIP_WIDTH = 380;
const TOOLTIP_MAX_HEIGHT = 300;

const viewSchema = z.object({ view: z.enum(["preview", "source"]) });
const defaultView = { view: "preview" } as const;

/** Web: Paseo's Markdown preview or a read-only source view, both answering selections. */
function DocAskViewer(props: PluginFilePanelProps) {
  const { file, theme, workspaceId, tab, layout } = props;
  const [view, setView] = useTabState(tab, viewSchema, defaultView);
  const [text, setText] = useState<string | null>(null);
  const latestText = useRef("");
  /** The newest request; it owns the side panel's message. */
  const latestRequest = useRef(0);
  /** The save in progress, which the next answer waits for. */
  const saving = useRef<Promise<unknown>>(Promise.resolve());
  const root = useRef<View>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  // The side "주석" panel follows this viewer once it publishes; the latest state is kept here.
  const owner = useRef(Symbol("doc-ask-viewer")).current;
  const snapshotRef = useRef<NotesSnapshot | null>(null);
  /** Makes the side panel follow this document and opens it. */
  const showSidePanel = useCallback(() => {
    if (snapshotRef.current) publishNotes(snapshotRef.current);
    openNotesPanel(workspaceId);
  }, [workspaceId]);
  const [questionAnchor, setQuestionAnchor] = useState<Anchor | null>(null);
  const explain = useRpc(explainRpc);
  const readComments = useRpc(commentsReadRpc);
  const writeComments = useRpc(commentsWriteRpc);
  const toast = useToast();
  // Footnote definitions live in the companion comment file; a file without one keeps them inline.
  const hasCommentFile = commentPathOf(file.path) !== null;
  const [comments, setComments] = useState("");
  const prepared = useMemo(() => (text === null ? null : prepareFootnotes(text, comments)), [text, comments]);
  const workspaceDirectory = useWorkspace(workspaceId, (workspace) => workspace?.directory ?? null);
  const linkedBody = useLinkedMarkdown(prepared?.body ?? null, file.path, workspaceDirectory);

  const show = useCallback((next: string) => {
    latestText.current = next;
    setText(next);
  }, []);

  const loadComments = useCallback(async () => {
    if (!hasCommentFile) return "";
    const { text: loaded } = await readComments({ path: file.path });
    setComments(loaded);
    return loaded;
  }, [file, hasCommentFile, readComments]);

  const load = useCallback(async () => {
    try {
      const [doc] = await Promise.all([file.readText(), loadComments()]);
      show(doc);
      setLoadError(null);
    } catch (cause) {
      setLoadError(messageOf(cause));
    }
  }, [file, loadComments, show]);

  useEffect(() => {
    void load();
    return file.watch((event) => {
      if (event.type === "deleted") setLoadError("파일이 삭제되었습니다.");
      else void load();
    });
  }, [file, load]);

  /**
   * Writes an annotated document and its comment file. The definition goes in first, so a failed
   * document write leaves at most an unused note. Returns a failure message, or null when saved.
   */
  const saveAnnotated = useCallback(
    async (
      latest: string,
      latestComments: string,
      annotated: { doc: string; comments: string },
    ): Promise<string | null> => {
      const nextDoc = hasCommentFile
        ? annotated.doc
        : `${annotated.doc.replace(/\s+$/, "")}\n\n${annotated.comments}`;
      if (hasCommentFile) {
        try {
          const { status } = await writeComments({ path: file.path, text: annotated.comments, base: latestComments });
          if (status === "conflict") return "저장 실패: 그사이 주석 파일이 변경되었습니다.";
        } catch (cause) {
          return `저장 실패: 주석 파일을 쓰지 못했습니다. ${messageOf(cause)}`;
        }
      }
      try {
        await file.writeText(nextDoc);
      } catch (cause) {
        if (hasCommentFile) {
          // Take the definition back out; best effort, the note is harmless if it stays.
          void writeComments({ path: file.path, text: latestComments, base: annotated.comments })
            .then(() => loadComments())
            .catch(() => undefined);
        }
        return writeFailure(cause);
      }
      if (hasCommentFile) setComments(annotated.comments);
      show(nextDoc);
      return null;
    },
    [file, hasCommentFile, loadComments, show, writeComments],
  );

  const ask = useCallback(
    async ({ anchor, mode, question }: AskRequest) => {
      // Requests run together; the side panel shows the newest, older ones report by toast.
      const request = ++latestRequest.current;
      const label = MODE_LABEL[mode];
      const subject = mode === "question" && question ? question : anchor.text;
      const title = `${label}: ${subject}`;
      const note = anchor.view === "note" ? anchor.label : undefined;
      const report = (outcome: Message) => {
        if (latestRequest.current === request) setMessage(outcome);
        else if (outcome.kind === "failed") toast.error(`${shortTitle(title)} — ${outcome.status}`);
        else toast.show(`${shortTitle(title)} — ${outcome.status}`, { variant: "success" });
      };
      setMessage({ kind: "pending", title, status: "AI에게 묻는 중…", answer: null, note });
      showSidePanel();
      // The answer shows while it is written, as long as this request owns the panel.
      const requestId = newRequestId();
      const stopFollowing = followAnswer(requestId, (draft) => {
        if (latestRequest.current !== request) return;
        setMessage((current) =>
          current?.kind === "pending" && current.title === title ? { ...current, answer: draft } : current,
        );
      });
      let answer: string;
      try {
        ({ answer } = await explain({
          workspaceId,
          path: file.path,
          document: latestText.current,
          selection: anchor.text,
          mode,
          question,
          context: note === undefined ? undefined : notesRef.current.find((n) => n.label === note)?.content,
          requestId,
        }));
      } catch (cause) {
        report({ kind: "failed", title, status: `요청 실패: ${messageOf(cause)}`, answer: null, note });
        return;
      } finally {
        stopFollowing();
      }

      const failed = (status: string): Message => ({ kind: "failed", title, status, answer, note });
      const save = async (): Promise<Message> => {
        let latest: string;
        let latestComments: string;
        try {
          // Merge into the newest versions so edits made while waiting are kept.
          [latest, latestComments] = await Promise.all([file.readText(), loadComments()]);
        } catch (cause) {
          return failed(`저장 실패: 파일을 읽지 못했습니다. ${messageOf(cause)}`);
        }

        if (anchor.view === "note") {
          // A follow-up joins the footnote it was asked from, in whichever file defines it.
          const inComments = hasCommentFile && definesFootnote(latestComments, anchor.label);
          // A question asked about a passage of the footnote names that passage under its heading.
          const quote = anchor.whole || subject === anchor.text ? undefined : anchor.text;
          const next = appendToFootnote(inComments ? latestComments : latest, anchor.label, label, subject, answer, quote);
          if (next === null) return failed("저장 실패: 이 각주를 찾지 못했습니다.");
          try {
            if (inComments) {
              const { status } = await writeComments({ path: file.path, text: next, base: latestComments });
              if (status === "conflict") return failed("저장 실패: 답을 기다리는 동안 주석 파일이 변경되었습니다.");
              setComments(next);
            } else {
              await file.writeText(next);
              show(next);
            }
          } catch (cause) {
            return failed(writeFailure(cause));
          }
          return { kind: "saved", title, status: "각주에 추가했습니다.", answer, note };
        }

        const at =
          anchor.view === "source"
            ? locateSelection(latest, anchor.range, anchor.text)
            : locateRendered(latest, anchor.text, anchor.hint);
        if (!at) return failed("저장 실패: 선택한 부분을 원문에서 찾지 못했습니다.");
        const annotated = annotate(latest, latestComments, at, label, subject, answer);
        const failure = await saveAnnotated(latest, latestComments, annotated);
        if (failure) return failed(failure);
        const replaced = annotated.replaced.length;
        return {
          kind: "saved",
          title,
          status: replaced > 0 ? `겹치던 기존 각주 ${replaced}개를 대체해 반영했습니다.` : "문서에 반영했습니다.",
          answer,
          note: annotated.id,
        };
      };
      // Answers are saved one at a time, so two arriving together do not overwrite each other.
      const saved = saving.current.then(save);
      saving.current = saved.catch(() => undefined);
      try {
        report(await saved);
      } catch (cause) {
        report(failed(`저장 실패: ${messageOf(cause)}`));
      }
    },
    [explain, file, hasCommentFile, loadComments, saveAnnotated, show, showSidePanel, toast, workspaceId, writeComments],
  );

  /**
   * Saves the reader's own comment on a selection as a footnote. Nothing goes to the AI, and
   * existing footnotes are kept. Resolves true when saved; failures show as toasts.
   */
  const addComment = useCallback(
    async (anchor: Anchor, comment: string): Promise<boolean> => {
      try {
        const [latest, latestComments] = await Promise.all([file.readText(), loadComments()]);
        const at =
          anchor.view === "source"
            ? locateSelection(latest, anchor.range, anchor.text)
            : anchor.view === "preview"
              ? locateRendered(latest, anchor.text, anchor.hint)
              : null;
        if (!at) {
          toast.error("선택한 부분을 원문에서 찾지 못했습니다.");
          return false;
        }
        const annotated = annotate(latest, latestComments, at, "주석", anchor.text, comment, { comment: true });
        const failure = await saveAnnotated(latest, latestComments, annotated);
        if (failure) {
          toast.error(failure);
          return false;
        }
        toast.show("주석을 달았습니다.", { variant: "success" });
        return true;
      } catch (cause) {
        toast.error(`저장 실패: ${messageOf(cause)}`);
        return false;
      }
    },
    [file, loadComments, saveAnnotated, toast],
  );

  // The notes as currently shown, for requests that need a footnote's latest content.
  const notesRef = useRef<Footnote[]>([]);
  notesRef.current = prepared?.notes ?? [];

  /** Shows footnote `number` in the side panel, as right after an answer. */
  const openNote = useCallback((number: number) => {
    const note = notesRef.current.find((n) => n.number === number);
    if (!note) return;
    setMessage({ kind: "note", title: "", status: `각주 ${number}`, answer: null, note: note.label });
    showSidePanel();
  }, [showSidePanel]);

  /** Rewrites footnote `label`'s bookmark and memo in whichever file defines it. */
  const updateMeta = useCallback(
    async (label: string, change: (meta: NoteMeta) => NoteMeta) => {
      try {
        const [latest, latestComments] = await Promise.all([file.readText(), loadComments()]);
        const inComments = hasCommentFile && definesFootnote(latestComments, label);
        const current = notesRef.current.find((n) => n.label === label)?.meta ?? {};
        const next = setNoteMeta(inComments ? latestComments : latest, label, change(current));
        if (next === null) {
          toast.error("이 각주를 찾지 못했습니다.");
          return false;
        }
        if (inComments) {
          const { status } = await writeComments({ path: file.path, text: next, base: latestComments });
          if (status === "conflict") {
            toast.error("저장 실패: 주석 파일이 그사이 변경되었습니다. 다시 시도해 주세요.");
            return false;
          }
          setComments(next);
        } else {
          await file.writeText(next);
          show(next);
        }
        return true;
      } catch (cause) {
        toast.error(writeFailure(cause));
        return false;
      }
    },
    [file, hasCommentFile, loadComments, show, toast, writeComments],
  );
  const [memoLabel, setMemoLabel] = useState<string | null>(null);
  const [deleteLabel, setDeleteLabel] = useState<string | null>(null);

  /**
   * Removes footnote `label`: highlights and references from the document, then the definition.
   * The document goes first, so a failed second write leaves only an unused definition.
   */
  const deleteNote = useCallback(
    async (label: string) => {
      try {
        const [latest, latestComments] = await Promise.all([file.readText(), loadComments()]);
        const removed = removeFootnote(latest, hasCommentFile ? latestComments : "", label);
        if (!removed.found) {
          toast.error("이 각주를 찾지 못했습니다.");
          return false;
        }
        if (removed.doc !== latest) {
          await file.writeText(removed.doc);
          show(removed.doc);
        }
        if (hasCommentFile && removed.comments !== latestComments) {
          const { status } = await writeComments({ path: file.path, text: removed.comments, base: latestComments });
          if (status === "conflict") {
            toast.error("본문에서는 지웠지만 주석 파일이 그사이 변경되어 정의는 남았습니다.");
            return false;
          }
          setComments(removed.comments);
        }
        setMessage((current) => (current?.note === label ? null : current));
        toast.show("각주를 삭제했습니다.", { variant: "success" });
        return true;
      } catch (cause) {
        toast.error(writeFailure(cause).replace("저장 실패", "삭제 실패"));
        return false;
      }
    },
    [file, hasCommentFile, loadComments, show, toast, writeComments],
  );

  // Jumps: show the preview, scroll footnote `label` into view, and open it in the panel. The
  // preview hands over its reveal function once mounted.
  const revealRef = useRef<((number: number) => Promise<boolean>) | null>(null);
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);
  const revealTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const jumpTo = useCallback(
    (label: string) => {
      setView({ view: "preview" });
      setJumpTarget(label);
    },
    [setView],
  );
  useEffect(() => {
    if (jumpTarget === null || !prepared || view.view !== "preview" || !revealRef.current) return;
    setJumpTarget(null);
    const note = prepared.notes.find((n) => n.label === jumpTarget);
    if (!note) {
      toast.error("이 문서에서 해당 각주를 찾지 못했습니다.");
      return;
    }
    // Open the panel first: it shrinks the preview, which would cut a scroll already under way.
    openNote(note.number);
    const reveal = revealRef.current;
    if (revealTimer.current) clearTimeout(revealTimer.current);
    revealTimer.current = setTimeout(() => void reveal(note.number), 150);
  }, [jumpTarget, openNote, prepared, toast, view.view]);
  useEffect(
    () => () => {
      if (revealTimer.current) clearTimeout(revealTimer.current);
    },
    [],
  );
  // A bookmark in another panel may have opened this file to show one of its footnotes.
  useEffect(() => {
    const pending = takeJump(file.path);
    if (pending) jumpTo(pending);
    return onJumpRequest(file.path, () => {
      // Let Paseo switch to this tab first.
      setTimeout(() => {
        const label = takeJump(file.path);
        if (label) jumpTo(label);
      }, 300);
    });
  }, [file, jumpTo]);

  /** 설명 or 질문 on a selection; `text` typed in the selection box is the request or question. */
  const onAction = useCallback(
    (anchor: Anchor, mode: AskMode, text?: string) => {
      if (mode === "question" && !text) setQuestionAnchor(anchor);
      else void ask({ anchor, mode, question: text });
    },
    [ask],
  );

  // Footnote tooltip. It lives at the panel root so it draws above the message panel; it stays
  // open briefly after the pointer leaves the reference so the pointer can move onto it.
  const [hover, setHover] = useState<FootnoteHover | null>(null);
  const overTip = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onHover = useCallback((next: FootnoteHover | null) => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (next) setHover(next);
    else {
      hideTimer.current = setTimeout(() => {
        if (!overTip.current) setHover(null);
      }, 200);
    }
  }, []);
  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    },
    [],
  );
  const hoveredNote = hover ? prepared?.notes.find((note) => note.number === hover.number) : undefined;

  const commit = useRpc(commitRpc);
  const [committing, setCommitting] = useState(false);
  const commitFootnotes = useCallback(async () => {
    const title = `각주 커밋: ${file.name}`;
    setCommitting(true);
    setMessage({ kind: "pending", title, status: "해설 세션이 각주 변경만 골라 커밋하는 중…", answer: null });
    try {
      // Queued behind any question in flight on the same explainer session.
      const { committed, summary } = await commit({ workspaceId, path: file.path });
      setMessage({
        kind: committed ? "saved" : "failed",
        title,
        status: committed ? "각주 변경을 커밋했습니다." : "커밋하지 않았습니다.",
        answer: summary,
      });
    } catch (cause) {
      setMessage({ kind: "failed", title, status: `커밋 요청 실패: ${messageOf(cause)}`, answer: null });
    } finally {
      setCommitting(false);
    }
  }, [commit, file, workspaceId]);

  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState<SearchRequest>({ query: "", index: 0, nonce: 0 });
  const [searchCount, setSearchCount] = useState(0);
  const searchInput = useRef<NativeTextInput>(null);
  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setTimeout(() => searchInput.current?.focus(), 0);
  }, []);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearch((current) => ({ query: "", index: 0, nonce: current.nonce + 1 }));
    setSearchCount(0);
  }, []);
  const setSearchQuery = useCallback(
    (query: string) => setSearch((current) => ({ query, index: 0, nonce: current.nonce + 1 })),
    [],
  );
  const stepSearch = useCallback(
    (step: number) =>
      setSearch((current) => ({
        ...current,
        index: stepMatch(current.index, searchCount, step),
        nonce: current.nonce + 1,
      })),
    [searchCount],
  );
  useEffect(() => watchFindShortcut(root.current, openSearch), [openSearch]);

  // What the side panel shows and does for this document. Actions stay stable and call the latest.
  const actionsRef = useRef<NotesActions | null>(null);
  actionsRef.current = {
    ask: (selection, mode, question) =>
      onAction({ view: "note", text: selection.text, label: selection.label, whole: selection.whole }, mode, question),
    toggleBookmark: (label) => void updateMeta(label, toggledBookmark),
    editMemo: setMemoLabel,
    deleteNote: setDeleteLabel,
    openNote: jumpTo,
    closeMessage: () => setMessage(null),
  };
  const actions = useMemo<NotesActions>(
    () => ({
      ask: (selection, mode, question) => actionsRef.current?.ask(selection, mode, question),
      toggleBookmark: (label) => actionsRef.current?.toggleBookmark(label),
      editMemo: (label) => actionsRef.current?.editMemo(label),
      deleteNote: (label) => actionsRef.current?.deleteNote(label),
      openNote: (label) => actionsRef.current?.openNote(label),
      closeMessage: () => actionsRef.current?.closeMessage(),
    }),
    [],
  );
  snapshotRef.current = {
    owner,
    workspaceId,
    path: file.path,
    name: file.name,
    notes: prepared?.notes ?? [],
    message,
    actions,
    commit: { run: () => void commitFootnotes(), busy: committing },
  };
  useEffect(() => {
    if (snapshotRef.current) refreshNotes(snapshotRef.current);
  }, [prepared, message, file, committing]);
  useEffect(() => {
    // A panel with nothing to show follows the document that opened first.
    if (snapshotRef.current) publishNotesIfIdle(snapshotRef.current);
    return () => withdrawNotes(owner);
  }, [owner]);
  // Opening this document's tab makes the side panel follow it.
  useEffect(
    () =>
      watchShown(root.current, (shown) => {
        if (shown && snapshotRef.current) publishNotes(snapshotRef.current);
      }),
    [],
  );

  const styles = useMemo(
    () => ({
      panel: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
      toolbar: { flexDirection: "row" as const, gap: 16, paddingHorizontal: 16, paddingVertical: 10 },
      tab: { color: theme.colors.foregroundMuted },
      tabActive: { color: theme.colors.foreground, fontWeight: "600" as const },
      error: { color: theme.colors.statusDanger, paddingHorizontal: 16, paddingVertical: 8 },
    }),
    [theme],
  );

  return (
    <View ref={root} style={styles.panel}>
      <View style={styles.toolbar}>
        {(["preview", "source"] as const).map((id) => (
          <Pressable
            key={id}
            accessibilityRole="button"
            accessibilityState={{ selected: view.view === id }}
            onPress={() => setView({ view: id })}
          >
            <Text style={view.view === id ? styles.tabActive : styles.tab}>
              {id === "preview" ? "Preview" : "Source"}
            </Text>
          </Pressable>
        ))}
      </View>
      {searchOpen ? (
        <SearchBar
          theme={theme}
          inputRef={searchInput}
          search={search}
          count={searchCount}
          onQuery={setSearchQuery}
          onStep={stepSearch}
          onClose={closeSearch}
        />
      ) : null}
      {loadError ? <Text style={styles.error}>{loadError}</Text> : null}
      {text === null || prepared === null ? (
        loadError ? null : <Loading />
      ) : view.view === "preview" ? (
        <PreviewView
          body={linkedBody ?? prepared.body}
          marks={prepared.marks}
          theme={theme}
          compact={layout.compact}
          overlay={root}
          onHover={onHover}
          onOpenNote={openNote}
          revealRef={revealRef}
          onAction={onAction}
          onComment={addComment}
          search={search}
          onSearchCount={setSearchCount}
        />
      ) : (
        <SourceView text={text} theme={theme} onAction={onAction} search={search} onSearchCount={setSearchCount} />
      )}
      {hover && hoveredNote ? (
        <FootnoteTooltip
          hover={hover}
          note={hoveredNote}
          theme={theme}
          onOpen={() => {
            openNote(hover.number);
            overTip.current = false;
            setHover(null);
          }}
          onHoverChange={(over) => {
            overTip.current = over;
            if (!over) setHover(null);
          }}
        />
      ) : null}
      <QuestionModal
        selected={questionAnchor?.text ?? null}
        theme={theme}
        onClose={() => setQuestionAnchor(null)}
        onSubmit={(question) => {
          if (questionAnchor) void ask({ anchor: questionAnchor, mode: "question", question });
          setQuestionAnchor(null);
        }}
      />
      <DeleteNoteModal
        note={deleteLabel === null ? null : (prepared?.notes.find((n) => n.label === deleteLabel) ?? null)}
        theme={theme}
        onClose={() => setDeleteLabel(null)}
        onConfirm={async () => {
          if (deleteLabel !== null && (await deleteNote(deleteLabel))) setDeleteLabel(null);
        }}
      />
      <MemoModal
        memo={memoLabel === null ? null : (prepared?.notes.find((n) => n.label === memoLabel)?.meta.memo ?? "")}
        theme={theme}
        onClose={() => setMemoLabel(null)}
        onSave={async (memo) => {
          if (memoLabel !== null && (await updateMeta(memoLabel, (meta) => ({ ...meta, memo })))) setMemoLabel(null);
        }}
      />
    </View>
  );
}

/** Paseo's built-in Markdown preview layout: a gutter around a centered reading column. */
const CONTENT_MAX_WIDTH = 820;

function readingLayout(compact: boolean) {
  return {
    gutter: { width: "100%" as const, paddingHorizontal: compact ? 12 : 16, paddingVertical: 16 },
    frame: {
      width: "100%" as const,
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: "center" as const,
      paddingHorizontal: 8,
    },
  };
}

interface PreviewProps {
  body: string;
  marks: Mark[];
  theme: Theme;
  compact: boolean;
  overlay: RefObject<View | null>;
  onHover: (hover: FootnoteHover | null) => void;
  onOpenNote: (number: number) => void;
  /** Receives the preview's reveal function while it is mounted. */
  revealRef: MutableRefObject<((number: number) => Promise<boolean>) | null>;
  onAction: (anchor: Anchor, mode: AskMode, text?: string) => void;
  onComment: (anchor: Anchor, comment: string) => Promise<boolean>;
  search: SearchRequest;
  onSearchCount: (count: number) => void;
}

/**
 * Paseo's own Markdown rendering. Highlights and superscript references show their footnote on
 * hover, the notes are listed at the end, and a finished selection opens the selection box
 * (comment, 설명, 질문).
 */
function PreviewView({
  body,
  marks,
  theme,
  compact,
  overlay,
  onHover,
  onOpenNote,
  revealRef,
  onAction,
  onComment,
  search,
  onSearchCount,
}: PreviewProps) {
  const content = useRef<View>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const { draft, close, focused } = useSelectionDraft(content);
  const decorations = useRef<ReturnType<typeof decoratePreview> | null>(null);
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;
  const onOpenRef = useRef(onOpenNote);
  onOpenRef.current = onOpenNote;

  useEffect(() => {
    decorations.current = decoratePreview(
      content.current,
      overlay.current,
      (hover) => onHoverRef.current(hover),
      (number) => onOpenRef.current(number),
    );
    revealRef.current = (number) => decorations.current?.reveal(number) ?? Promise.resolve(false);
    return () => {
      revealRef.current = null;
      decorations.current?.dispose();
      decorations.current = null;
      onHoverRef.current(null);
    };
  }, [overlay, revealRef]);
  useEffect(() => {
    decorations.current?.setMarks(marks);
  }, [marks]);

  const finder = useRef<PreviewSearch | null>(null);
  const onSearchCountRef = useRef(onSearchCount);
  onSearchCountRef.current = onSearchCount;
  useEffect(() => {
    finder.current = searchPreview(content.current, (count) => onSearchCountRef.current(count));
    return () => {
      finder.current?.dispose();
      finder.current = null;
    };
  }, []);
  useEffect(() => {
    finder.current?.update(search.query, search.index);
  }, [search]);

  const styles = useMemo(
    () => ({
      ...readingLayout(compact),
      scroll: { flex: 1, minHeight: 0 },
    }),
    [compact],
  );
  const anchor = (): Anchor | null =>
    draft ? { view: "preview", text: draft.text, hint: keptLength(draft.prefix) } : null;

  return (
    // Scrolling moves the text away from a tooltip anchored to it.
    <ScrollView style={styles.scroll} onScroll={() => onHover(null)} scrollEventThrottle={100}>
      <View style={styles.gutter}>
        <View ref={content} style={styles.frame} onLayout={(event) => setSize(event.nativeEvent.layout)}>
          <Markdown>{body}</Markdown>
          {draft ? (
            <SelectionComposer
              draft={draft}
              focused={focused}
              theme={theme}
              containerWidth={size.width}
              containerHeight={size.height}
              onClose={close}
              onComment={async (comment) => {
                const picked = anchor();
                return picked ? onComment(picked, comment) : false;
              }}
              onAsk={(mode, typed) => {
                const picked = anchor();
                if (picked) onAction(picked, mode, typed);
              }}
            />
          ) : null}
        </View>
      </View>
    </ScrollView>
  );
}

/** A footnote's content floating by its reference, kept inside the panel. */
export function FootnoteTooltip({
  hover,
  note,
  theme,
  room,
  onOpen,
  onHoverChange,
}: {
  hover: FootnoteHover;
  note: Footnote;
  theme: Theme;
  /**
   * Visible space above and below the reference when it is not the overlay's own, as in a chat
   * row. Rows drawn later cover the space below a row, so the tooltip opens above when it fits.
   */
  room?: { above: number; below: number };
  /** Pressing the tooltip opens the footnote in the message panel. */
  onOpen: () => void;
  onHoverChange: (over: boolean) => void;
}) {
  const width = Math.min(TOOLTIP_WIDTH, hover.width - 16);
  const left = Math.max(8, Math.min(hover.left, hover.width - width - 8));
  const spaceBelow = room ? room.below - 8 : hover.height - hover.top - 8;
  const spaceAbove = room ? room.above - 8 : hover.height - hover.bottom - 8;
  const below = room
    ? spaceAbove < 160 && spaceBelow > spaceAbove
    : spaceBelow >= 160 || spaceBelow >= spaceAbove;
  const place: ViewStyle = below
    ? { top: hover.top, maxHeight: Math.min(TOOLTIP_MAX_HEIGHT, spaceBelow) }
    : { bottom: hover.bottom, maxHeight: Math.min(TOOLTIP_MAX_HEIGHT, spaceAbove) };
  const style = useMemo(
    () => ({
      position: "absolute" as const,
      zIndex: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface2,
      shadowColor: "#000",
      shadowOpacity: 0.2,
      shadowRadius: 12,
      shadowOffset: { width: 0, height: 4 },
    }),
    [theme],
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="이 각주를 아래 창에 열기"
      style={[style, place, { left, width }]}
      onPress={onOpen}
      onHoverIn={() => onHoverChange(true)}
      onHoverOut={() => onHoverChange(false)}
    >
      <ScrollView contentContainerStyle={{ padding: 12, gap: 6 }}>
        {note.meta.memo ? (
          <Text style={{ color: theme.colors.foregroundMuted }} numberOfLines={3}>
            메모: {note.meta.memo}
          </Text>
        ) : null}
        {splitFollowUps(note.content).map((unit, i) => (
          <TitledUnit key={i} unit={unit} theme={theme}>
            {(body) => <Markdown>{body}</Markdown>}
          </TitledUnit>
        ))}
      </ScrollView>
    </Pressable>
  );
}

/** The document's footnotes, numbered, below a divider. */
function FootnoteList({ notes, theme }: { notes: Footnote[]; theme: Theme }) {
  const styles = useMemo(
    () => ({
      section: {
        marginTop: 32,
        paddingTop: 16,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        gap: 12,
      },
      heading: { color: theme.colors.foregroundMuted, fontWeight: "600" as const },
      row: { flexDirection: "row" as const, gap: 8 },
      number: { color: theme.colors.foregroundMuted, minWidth: 24, paddingTop: 2 },
      body: { flex: 1, minWidth: 0 },
    }),
    [theme],
  );
  if (notes.length === 0) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.heading}>각주</Text>
      {notes.map((note) => (
        <View key={note.label} style={styles.row}>
          <Text style={styles.number}>
            {note.meta.bookmark ? "★" : ""}
            {note.number}.
          </Text>
          <View style={styles.body}>
            {splitFollowUps(note.content).map((unit, i) => (
              <TitledUnit key={i} unit={unit} theme={theme}>
                {(body) => <Markdown>{body}</Markdown>}
              </TitledUnit>
            ))}
          </View>
        </View>
      ))}
    </View>
  );
}

interface SourceProps {
  text: string;
  theme: Theme;
  onAction: (anchor: Anchor, mode: AskMode) => void;
  search: SearchRequest;
  onSearchCount: (count: number) => void;
}

/** The find bar under the toolbar: Enter goes to the next match, Shift+Enter back, Esc closes. */
function SearchBar({
  theme,
  inputRef,
  search,
  count,
  onQuery,
  onStep,
  onClose,
}: {
  theme: Theme;
  inputRef: RefObject<NativeTextInput | null>;
  search: SearchRequest;
  count: number;
  onQuery: (query: string) => void;
  onStep: (step: number) => void;
  onClose: () => void;
}) {
  const styles = useMemo(
    () => ({
      bar: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 10,
        paddingHorizontal: 16,
        paddingBottom: 8,
      },
      input: {
        flex: 1,
        minWidth: 0,
        maxWidth: 420,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 6,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        color: theme.colors.foreground,
      },
      count: { color: theme.colors.foregroundMuted, minWidth: 52 },
      button: { color: theme.colors.foreground },
      disabled: { color: theme.colors.foregroundMuted },
    }),
    [theme],
  );
  const current = count === 0 ? 0 : Math.min(search.index, count - 1) + 1;
  return (
    <View style={styles.bar}>
      <TextInput
        ref={inputRef}
        value={search.query}
        onChangeText={onQuery}
        placeholder="문서에서 검색"
        placeholderTextColor={theme.colors.foregroundMuted}
        accessibilityLabel="문서에서 검색"
        selectTextOnFocus
        blurOnSubmit={false}
        onKeyPress={(event) => {
          const { key, shiftKey } = event.nativeEvent as { key: string; shiftKey?: boolean };
          if (key === "Enter") {
            event.preventDefault();
            onStep(shiftKey ? -1 : 1);
          } else if (key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
        style={styles.input}
      />
      <Text style={styles.count}>{search.query ? `${current}/${count}` : ""}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="이전 결과" disabled={count === 0} onPress={() => onStep(-1)}>
        <Text style={count === 0 ? styles.disabled : styles.button}>↑</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="다음 결과" disabled={count === 0} onPress={() => onStep(1)}>
        <Text style={count === 0 ? styles.disabled : styles.button}>↓</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="검색 닫기" onPress={onClose}>
        <Text style={styles.button}>✕</Text>
      </Pressable>
    </View>
  );
}

/** Read-only CodeMirror source; selections show the ask buttons as an editor tooltip. */
function SourceView({ text, theme, onAction, search, onSearchCount }: SourceProps) {
  const parent = useRef<View>(null);
  const viewer = useRef<DocViewerHandle | null>(null);
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  const onSearchCountRef = useRef(onSearchCount);
  onSearchCountRef.current = onSearchCount;
  const searchRef = useRef(search);
  searchRef.current = search;
  const initialText = useRef(text);

  useLayoutEffect(() => {
    viewer.current = mountViewer(
      parent.current,
      initialText.current,
      theme,
      (range, selected, mode) => onActionRef.current({ view: "source", text: selected, range }, mode),
      (count) => onSearchCountRef.current(count),
    );
    // A theme change mounts a new editor; keep the current search on it.
    if (searchRef.current.query) viewer.current?.search(searchRef.current.query, searchRef.current.index);
    return () => {
      viewer.current?.destroy();
      viewer.current = null;
    };
  }, [theme]);

  useEffect(() => {
    initialText.current = text;
    viewer.current?.setText(text);
  }, [text]);

  useEffect(() => {
    viewer.current?.search(search.query, search.index);
  }, [search]);

  return <View ref={parent} style={{ flex: 1, minHeight: 0 }} />;
}

export function QuestionModal({
  selected,
  theme,
  onClose,
  onSubmit,
}: {
  /** The selected passage; null while closed. */
  selected: string | null;
  theme: Theme;
  onClose: () => void;
  onSubmit: (question: string) => void;
}) {
  const [question, setQuestion] = useState("");
  useEffect(() => {
    if (selected !== null) setQuestion("");
  }, [selected]);
  const styles = useMemo(() => modalStyles(theme), [theme]);
  const submit = () => {
    if (question.trim()) onSubmit(question.trim());
  };
  return (
    <Modal title="질문" open={selected !== null} onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <Text style={styles.muted} numberOfLines={3}>
          선택: {selected}
        </Text>
        <TextInput
          autoFocus
          value={question}
          onChangeText={setQuestion}
          onSubmitEditing={submit}
          returnKeyType="send"
          placeholder="이 부분에 대해 무엇이 궁금한가요?"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.input}
        />
        <View style={styles.buttons}>
          <Pressable accessibilityRole="button" onPress={onClose}>
            <Text style={styles.secondary}>취소</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={!question.trim()} onPress={submit} style={styles.primary}>
            <Text style={styles.primaryLabel}>질문하기</Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
}

/** Edits the extra instructions sent with every request, stored in the host's plugin settings. */
export function PromptModal({ open, theme, onClose }: { open: boolean; theme: Theme; onClose: () => void }) {
  const settings = useSettings(promptSettings);
  const [draft, setDraft] = useState("");
  const revision = useRef<string | null>(null);
  const ready = settings.status === "ready";
  useEffect(() => {
    if (open && settings.status === "ready") {
      setDraft(settings.values.extraPrompt);
      revision.current = settings.revision;
    }
    // Seed the draft once per opening; later saves must not overwrite typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ready]);
  const styles = useMemo(() => modalStyles(theme), [theme]);
  const save = async () => {
    if (!revision.current) return;
    if (await settings.save({ extraPrompt: draft }, revision.current)) onClose();
  };
  return (
    <Modal title="함께 보낼 프롬프트" open={open} onOpenChange={(next) => !next && onClose()}>
      <Modal.Content>
        <Text style={styles.muted}>모든 설명·질문 요청에 함께 전달됩니다. 예: 간단간결히 설명한다.</Text>
        {ready ? (
          <TextInput
            multiline
            value={draft}
            onChangeText={setDraft}
            placeholder="예: 간단간결히 설명한다."
            placeholderTextColor={theme.colors.foregroundMuted}
            style={[styles.input, { minHeight: 120, textAlignVertical: "top" }]}
          />
        ) : (
          <Text style={styles.muted}>
            {settings.status === "loading" ? "불러오는 중…" : `설정을 읽지 못했습니다: ${settings.error}`}
          </Text>
        )}
        {settings.saveError ? <Text style={styles.danger}>저장 실패: {settings.saveError}</Text> : null}
        <View style={styles.buttons}>
          <Pressable accessibilityRole="button" onPress={onClose}>
            <Text style={styles.secondary}>취소</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={!ready || settings.saving}
            onPress={save}
            style={styles.primary}
          >
            <Text style={styles.primaryLabel}>{settings.saving ? "저장 중…" : "저장"}</Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
}

/** Confirms removing a footnote; `note` is null while closed. */
export function DeleteNoteModal({
  note,
  theme,
  onClose,
  onConfirm,
}: {
  note: Footnote | null;
  theme: Theme;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [deleting, setDeleting] = useState(false);
  const styles = useMemo(
    () => ({
      ...modalStyles(theme),
      title: { color: theme.colors.foreground, fontWeight: "600" as const },
      danger: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 6, backgroundColor: theme.colors.statusDanger },
      dangerLabel: { color: "#ffffff" },
    }),
    [theme],
  );
  const confirm = async () => {
    if (deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    try {
      await onConfirm();
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  };
  // Enter confirms the deletion, whichever control has focus (the close button usually does).
  const deletingRef = useRef(false);
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
  const open = note !== null;
  useEffect(() => (open ? onEnterKey(() => void confirmRef.current()) : undefined), [open]);
  const extras = [note?.meta.bookmark ? "북마크" : null, note?.meta.memo ? "메모" : null].filter(Boolean);
  return (
    <Modal title="각주 삭제" open={open} onOpenChange={(next) => !next && onClose()}>
      <Modal.Content>
        <Text style={styles.title} numberOfLines={2}>
          {note ? `${note.number}. ${(note.content.split("\n")[0] ?? "").replace(/\*\*/g, "")}` : ""}
        </Text>
        <Text style={styles.muted}>
          이 각주의 형광펜, 본문 참조, 내용{extras.length > 0 ? `(${extras.join("·")} 포함)` : ""}을 모두 지웁니다. 되돌릴 수
          없습니다.
        </Text>
        <View style={styles.buttons}>
          <Pressable accessibilityRole="button" onPress={onClose}>
            <Text style={styles.secondary}>취소</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={deleting} onPress={confirm} style={styles.danger}>
            <Text style={styles.dangerLabel}>{deleting ? "삭제 중…" : "삭제"}</Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
}

/** Edits one footnote's memo; `memo` is null while closed. */
export function MemoModal({
  memo,
  theme,
  onClose,
  onSave,
}: {
  memo: string | null;
  theme: Theme;
  onClose: () => void;
  onSave: (memo: string) => Promise<void>;
}) {
  const open = memo !== null;
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open) setDraft(memo ?? "");
    // Seed once per opening; a later file reload must not overwrite typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const styles = useMemo(() => modalStyles(theme), [theme]);
  const save = async () => {
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title="메모" open={open} onOpenChange={(next) => !next && onClose()}>
      <Modal.Content>
        <Text style={styles.muted}>이 각주에 남길 메모입니다. 비우고 저장하면 지워집니다.</Text>
        <TextInput
          autoFocus
          multiline
          value={draft}
          onChangeText={setDraft}
          placeholder="메모"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={[styles.input, { minHeight: 100, textAlignVertical: "top" }]}
        />
        <View style={styles.buttons}>
          <Pressable accessibilityRole="button" onPress={onClose}>
            <Text style={styles.secondary}>취소</Text>
          </Pressable>
          <Pressable accessibilityRole="button" disabled={saving} onPress={save} style={styles.primary}>
            <Text style={styles.primaryLabel}>{saving ? "저장 중…" : "저장"}</Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
}


function modalStyles(theme: Theme) {
  return {
    muted: { color: theme.colors.foregroundMuted },
    danger: { color: theme.colors.statusDanger },
    input: {
      color: theme.colors.foreground,
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    buttons: {
      flexDirection: "row" as const,
      justifyContent: "flex-end" as const,
      alignItems: "center" as const,
      gap: 16,
    },
    secondary: { color: theme.colors.foregroundMuted },
    primary: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 6, backgroundColor: theme.colors.accent },
    primaryLabel: { color: theme.colors.accentForeground },
  };
}

/**
 * The open footnote, or a request's status and answer, as the side "주석" panel shows it.
 * Selecting text in a shown footnote offers 설명/질문, and the field below it asks about the whole
 * footnote; the answers join that footnote.
 */
export function NoteDetail({
  message,
  theme,
  note,
  onAsk,
  onToggleBookmark,
  onEditMemo,
  onDelete,
  imageBases,
  focusRequest,
}: {
  message: Message;
  theme: Theme;
  /** The footnote the message is about, with its current content, if any. */
  note: Footnote | undefined;
  onAsk: (selection: NoteSelection, mode: AskMode, question?: string) => void;
  onToggleBookmark: (label: string) => void;
  onEditMemo: (label: string) => void;
  onDelete: (label: string) => void;
  /** Folders a relative image path in the footnote is tried against, in order. */
  imageBases: readonly string[];
  /** Changes whenever the follow-up field should take focus, such as on opening from the list. */
  focusRequest?: number;
}) {
  const toast = useToast();
  // A footnote shows its latest content, which accumulates follow-ups; a failed save shows the
  // answer that could not be stored.
  const showsNote = message.note !== undefined && note !== undefined && message.kind !== "failed";
  const answer = showsNote ? note.content : message.answer;
  // A follow-up being written shows below the footnote it will join.
  const draft = showsNote && message.kind === "pending" ? message.answer : null;
  const memo = showsNote ? note.meta.memo : undefined;
  const content = useRef<View>(null);
  const actions = useRef<View>(null);
  const [selection, setSelection] = useState<RenderedSelection | null>(null);
  useEffect(() => (showsNote ? watchSelection(content.current, setSelection) : undefined), [showsNote]);
  useEffect(() => keepSelectionOnPress(actions.current), [selection !== null]);
  const [followUp, setFollowUp] = useState("");
  const followUpField = useRef<NativeTextInput>(null);
  useEffect(() => {
    if (focusRequest) followUpField.current?.focus();
  }, [focusRequest]);
  useEffect(() => setFollowUp(""), [message.note]);

  /** Asks the typed question about the whole footnote, named by its title line. */
  const askFollowUp = () => {
    const question = followUp.trim();
    if (!question || !showsNote) return;
    const title = (note.content.split("\n")[0] ?? "").replace(/\*\*/g, "").trim() || `각주 ${note.number}`;
    onAsk({ text: title, label: note.label, whole: true }, "question", question);
    setFollowUp("");
  };

  const styles = useMemo(
    () => ({
      box: { gap: 10 },
      header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 2 },
      status: {
        flex: 1,
        minWidth: 0,
        fontSize: 12,
        fontWeight: "500" as const,
        color:
          message.kind === "failed"
            ? theme.colors.statusDanger
            : message.kind === "saved"
              ? theme.colors.statusSuccess
              : theme.colors.foregroundMuted,
      },
      actions: { position: "absolute" as const, flexDirection: "row" as const, gap: 6 },
      memo: {
        borderLeftWidth: 2,
        borderLeftColor: theme.colors.statusWarning,
        paddingLeft: 10,
        paddingVertical: 2,
        gap: 2,
      },
      memoLabel: { color: theme.colors.foregroundMuted, fontSize: 12 },
      memoText: { color: theme.colors.foreground, fontSize: 13 },
      units: { gap: 8 },
      unit: {
        backgroundColor: theme.colors.surface1,
        borderRadius: 8,
        paddingHorizontal: 12,
        paddingVertical: 8,
      },
      followUp: {
        color: theme.colors.foreground,
        fontSize: 13,
        backgroundColor: theme.colors.surface1,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
      },
    }),
    [theme, message.kind],
  );

  async function copyAnswer() {
    if (!answer) return;
    try {
      await copyText(answer);
      toast.show("답을 복사했습니다.", { variant: "success" });
    } catch {
      toast.error("복사하지 못했습니다. 텍스트를 직접 선택해 복사하세요.");
    }
  }

  return (
    <View style={styles.box}>
      <View style={styles.header}>
        <Text style={styles.status}>{message.status}</Text>
        {showsNote ? (
          <>
            <IconButton
              icon="Star"
              label={note.meta.bookmark ? "북마크 해제" : "북마크"}
              theme={theme}
              color={note.meta.bookmark ? theme.colors.statusWarning : undefined}
              onPress={() => onToggleBookmark(note.label)}
            />
            <IconButton icon="StickyNote" label="메모 편집" theme={theme} onPress={() => onEditMemo(note.label)} />
          </>
        ) : null}
        {answer ? <IconButton icon="Copy" label="내용 복사" theme={theme} onPress={copyAnswer} /> : null}
        {showsNote ? (
          <IconButton
            icon="Trash2"
            label="각주 삭제"
            theme={theme}
            color={theme.colors.statusDanger}
            onPress={() => onDelete(note.label)}
          />
        ) : null}
      </View>
      {memo ? (
        <View style={styles.memo}>
          <Text style={styles.memoLabel}>메모</Text>
          <Text selectable style={styles.memoText}>
            {memo}
          </Text>
        </View>
      ) : null}
      {/* A footnote starts with its own bold title. */}
      {message.title && !showsNote ? <RequestTitle title={message.title} theme={theme} /> : null}
      {answer ? (
        <View ref={content} style={styles.units}>
          {/* A footnote shows its original note and each follow-up as a unit of its own. */}
          {showsNote ? (
            splitFollowUps(answer).map((unit, i) => (
              <View key={i} style={styles.unit}>
                <TitledUnit unit={unit} theme={theme}>
                  {(body) => <RichMarkdown text={body} theme={theme} bases={imageBases} />}
                </TitledUnit>
              </View>
            ))
          ) : (
            <RichMarkdown text={answer} theme={theme} bases={imageBases} />
          )}
          {draft ? (
            <View style={styles.unit}>
              <RichMarkdown text={draft} theme={theme} bases={imageBases} />
            </View>
          ) : null}
          {selection && showsNote && message.note !== undefined ? (
            <View ref={actions} style={[styles.actions, { top: selection.top, left: selection.left }]}>
              {ASK_ACTIONS.map((action) => (
                <IconButton
                  key={action.mode}
                  icon={action.icon}
                  label={action.tooltip}
                  theme={theme}
                  align="left"
                  filled
                  onPress={() => {
                    onAsk({ text: selection.text, label: message.note as string }, action.mode);
                    setSelection(null);
                  }}
                />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
      {showsNote ? (
        <TextInput
          ref={followUpField}
          value={followUp}
          onChangeText={setFollowUp}
          onSubmitEditing={askFollowUp}
          returnKeyType="send"
          editable={message.kind !== "pending"}
          placeholder="이 각주에 대해 후속 질문 (Enter 전송)"
          placeholderTextColor={theme.colors.foregroundMuted}
          accessibilityLabel="이 각주에 대한 후속 질문"
          style={styles.followUp}
        />
      ) : null}
    </View>
  );
}

/** Native has no selection or hover: Paseo's Markdown preview with footnotes listed at the end. */
function NativePreview({ file, theme, layout }: PluginFilePanelProps) {
  const text = useFileText(file);
  const prepared = useMemo(
    () => (text.status === "ready" ? prepareFootnotes(text.text) : null),
    [text],
  );
  const styles = useMemo(
    () => ({
      ...readingLayout(layout.compact),
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      note: { color: theme.colors.foregroundMuted, marginBottom: 12 },
      error: { color: theme.colors.statusDanger, padding: 16 },
    }),
    [theme, layout.compact],
  );
  if (text.status === "loading") return <Loading />;
  if (text.status === "error") return <Text style={styles.error}>{text.error.message}</Text>;
  return (
    <ScrollView style={styles.screen}>
      <View style={styles.gutter}>
        <View style={styles.frame}>
          <Text style={styles.note}>선택해서 묻기는 데스크톱과 웹에서만 지원합니다.</Text>
          <Markdown>{prepared?.body ?? ""}</Markdown>
          <FootnoteList notes={prepared?.notes ?? []} theme={theme} />
        </View>
      </View>
    </ScrollView>
  );
}

export function DocAskPanel(props: PluginFilePanelProps) {
  return props.layout.platform === "web" ? <DocAskViewer {...props} /> : <NativePreview {...props} />;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** A request's title cut short for a toast. */
export function shortTitle(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}

/** The save-failure line for a rejected document write. */
function writeFailure(cause: unknown): string {
  if (cause instanceof PluginFileConflictError) return "저장 실패: 답을 기다리는 동안 파일이 디스크에서 변경되었습니다.";
  if (cause instanceof PluginFileDeletedError) return "저장 실패: 파일이 삭제되었습니다.";
  return `저장 실패: ${messageOf(cause)}`;
}

/** A request's `kind: subject` title, as the side panel shows it while it runs or after it fails. */
function RequestTitle({ title, theme }: { title: string; theme: Theme }) {
  const titled = splitTitle(`**${title.replace(/\s+/g, " ").trim()}**`);
  if (!titled) {
    return (
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }} numberOfLines={2}>
        {title}
      </Text>
    );
  }
  return <NoteTitle kind={titled.kind} subject={titled.subject} theme={theme} bold={false} lines={2} />;
}
