import { z } from "zod";
import {
  PluginFileConflictError,
  PluginFileDeletedError,
  type PluginFilePanelProps,
  useFileText,
  useRpc,
  useSettings,
  useTabState,
} from "@getpaseo/plugin/client";
import { copyText, Loading, Markdown, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View, type ViewStyle } from "react-native";
import {
  type AskMode,
  commentsReadRpc,
  commentsWriteRpc,
  commitRpc,
  explainRpc,
  layoutSettings,
  promptSettings,
  resetRpc,
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
  prepareFootnotes,
  type TextRange,
} from "../shared/markdown";
import {
  ASK_ACTIONS,
  decoratePreview,
  type DocViewerHandle,
  type FootnoteHover,
  keepSelectionOnPress,
  mountViewer,
  type RenderedSelection,
  watchSelection,
  watchVerticalDrag,
} from "./web";

type Theme = PluginFilePanelProps["theme"];

/**
 * What the user selected, and how to find it again in the newest file text. A `note` selection
 * comes from a footnote shown in the message panel; its answer joins that footnote.
 */
type Anchor =
  | { view: "source"; text: string; range: TextRange }
  | { view: "preview"; text: string; hint: number }
  | { view: "note"; text: string; label: string };

interface AskRequest {
  anchor: Anchor;
  mode: AskMode;
  question?: string;
}

/**
 * What the message panel shows: a status line, the request title, and the answer if any. With
 * `note`, the panel shows that footnote's current content instead of `answer`.
 */
interface Message {
  kind: "pending" | "saved" | "failed" | "note";
  title: string;
  status: string;
  answer: string | null;
  note?: string;
}

const MODE_LABEL: Record<AskMode, string> = { term: "설명", question: "질문" };
const TOOLTIP_WIDTH = 380;
const TOOLTIP_MAX_HEIGHT = 300;
const MESSAGE_MIN_HEIGHT = 80;

const viewSchema = z.object({ view: z.enum(["preview", "source"]) });
const defaultView = { view: "preview" } as const;

/** Web: Paseo's Markdown preview or a read-only source view, both answering selections. */
function DocAskViewer(props: PluginFilePanelProps) {
  const { file, theme, workspaceId, tab, layout } = props;
  const [view, setView] = useTabState(tab, viewSchema, defaultView);
  const [text, setText] = useState<string | null>(null);
  const latestText = useRef("");
  const busy = useRef(false);
  const root = useRef<View>(null);
  const [rootHeight, setRootHeight] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [questionAnchor, setQuestionAnchor] = useState<Anchor | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const explain = useRpc(explainRpc);
  const readComments = useRpc(commentsReadRpc);
  const writeComments = useRpc(commentsWriteRpc);
  const toast = useToast();
  // Footnote definitions live in the companion comment file; a file without one keeps them inline.
  const hasCommentFile = commentPathOf(file.path) !== null;
  const [comments, setComments] = useState("");
  const prepared = useMemo(() => (text === null ? null : prepareFootnotes(text, comments)), [text, comments]);

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

  const ask = useCallback(
    async ({ anchor, mode, question }: AskRequest) => {
      if (busy.current) {
        toast.show("이전 요청의 답을 기다리는 중입니다.", { variant: "warning" });
        return;
      }
      busy.current = true;
      const label = MODE_LABEL[mode];
      const subject = mode === "question" && question ? question : anchor.text;
      const title = `${label}: ${subject}`;
      const note = anchor.view === "note" ? anchor.label : undefined;
      setMessage({ kind: "pending", title, status: "AI에게 묻는 중…", answer: null, note });
      try {
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
          }));
        } catch (cause) {
          setMessage({ kind: "failed", title, status: `요청 실패: ${messageOf(cause)}`, answer: null, note });
          return;
        }
        const failed = (status: string) => setMessage({ kind: "failed", title, status, answer, note });
        let latest: string;
        let latestComments: string;
        try {
          // Merge into the newest versions so edits made while waiting are kept.
          [latest, latestComments] = await Promise.all([file.readText(), loadComments()]);
        } catch (cause) {
          failed(`저장 실패: 파일을 읽지 못했습니다. ${messageOf(cause)}`);
          return;
        }

        if (anchor.view === "note") {
          // A follow-up joins the footnote it was asked from, in whichever file defines it.
          const inComments = hasCommentFile && definesFootnote(latestComments, anchor.label);
          const next = appendToFootnote(inComments ? latestComments : latest, anchor.label, label, subject, answer);
          if (next === null) {
            failed("저장 실패: 이 각주를 찾지 못했습니다.");
            return;
          }
          try {
            if (inComments) {
              const { status } = await writeComments({ path: file.path, text: next, base: latestComments });
              if (status === "conflict") {
                failed("저장 실패: 답을 기다리는 동안 주석 파일이 변경되었습니다.");
                return;
              }
              setComments(next);
            } else {
              await file.writeText(next);
              show(next);
            }
          } catch (cause) {
            failed(writeFailure(cause));
            return;
          }
          setMessage({ kind: "saved", title, status: "각주에 추가했습니다.", answer, note });
          return;
        }

        const at =
          anchor.view === "source"
            ? locateSelection(latest, anchor.range, anchor.text)
            : locateRendered(latest, anchor.text, anchor.hint);
        if (!at) {
          failed("저장 실패: 선택한 부분을 원문에서 찾지 못했습니다.");
          return;
        }
        const annotated = annotate(latest, latestComments, at, label, subject, answer);
        const nextDoc = hasCommentFile
          ? annotated.doc
          : `${annotated.doc.replace(/\s+$/, "")}\n\n${annotated.comments}`;
        // The definition goes in first, so a failed document write leaves at most an unused note.
        if (hasCommentFile) {
          try {
            const { status } = await writeComments({
              path: file.path,
              text: annotated.comments,
              base: latestComments,
            });
            if (status === "conflict") {
              failed("저장 실패: 답을 기다리는 동안 주석 파일이 변경되었습니다.");
              return;
            }
          } catch (cause) {
            failed(`저장 실패: 주석 파일을 쓰지 못했습니다. ${messageOf(cause)}`);
            return;
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
          failed(writeFailure(cause));
          return;
        }
        if (hasCommentFile) setComments(annotated.comments);
        show(nextDoc);
        const replaced = annotated.replaced.length;
        setMessage({
          kind: "saved",
          title,
          status: replaced > 0 ? `겹치던 기존 각주 ${replaced}개를 대체해 반영했습니다.` : "문서에 반영했습니다.",
          answer,
          note: annotated.id,
        });
      } finally {
        busy.current = false;
      }
    },
    [explain, file, hasCommentFile, loadComments, show, toast, workspaceId, writeComments],
  );

  // The notes as currently shown, for requests that need a footnote's latest content.
  const notesRef = useRef<Footnote[]>([]);
  notesRef.current = prepared?.notes ?? [];

  /** Shows footnote `number` in the message panel, as right after an answer. */
  const openNote = useCallback((number: number) => {
    const note = notesRef.current.find((n) => n.number === number);
    if (note) setMessage({ kind: "note", title: "", status: `각주 ${number}`, answer: null, note: note.label });
  }, []);

  const onAction = useCallback(
    (anchor: Anchor, mode: AskMode) => {
      if (mode === "question") setQuestionAnchor(anchor);
      else void ask({ anchor, mode });
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

  const reset = useRpc(resetRpc);
  const [resetting, setResetting] = useState(false);
  const resetContext = useCallback(async () => {
    setResetting(true);
    try {
      // Runs after any question in flight; the next question starts a fresh session.
      await reset({ workspaceId });
      toast.show("컨텍스트를 지웠습니다. 다음 요청부터 새 세션으로 시작합니다.", { variant: "success" });
    } catch (cause) {
      toast.error(`컨텍스트를 지우지 못했습니다: ${messageOf(cause)}`);
    } finally {
      setResetting(false);
    }
  }, [reset, toast, workspaceId]);

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

  const prompt = useSettings(promptSettings);
  const hasPrompt = prompt.status === "ready" && prompt.values.extraPrompt.trim() !== "";

  const styles = useMemo(
    () => ({
      panel: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
      toolbar: { flexDirection: "row" as const, gap: 16, paddingHorizontal: 16, paddingVertical: 10 },
      tab: { color: theme.colors.foregroundMuted },
      tabActive: { color: theme.colors.foreground, fontWeight: "600" as const },
      spacer: { flex: 1 },
      error: { color: theme.colors.statusDanger, paddingHorizontal: 16, paddingVertical: 8 },
    }),
    [theme],
  );

  return (
    <View ref={root} style={styles.panel} onLayout={(event) => setRootHeight(event.nativeEvent.layout.height)}>
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
        <View style={styles.spacer} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="이 문서의 각주 변경만 git 커밋"
          disabled={committing}
          onPress={commitFootnotes}
        >
          <Text style={styles.tab}>{committing ? "커밋 중…" : "각주 커밋"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="함께 보낼 프롬프트 설정"
          onPress={() => setPromptOpen(true)}
        >
          <Text style={hasPrompt ? styles.tabActive : styles.tab}>{hasPrompt ? "프롬프트 •" : "프롬프트"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="해설 에이전트 컨텍스트 지우기"
          disabled={resetting}
          onPress={resetContext}
        >
          <Text style={styles.tab}>{resetting ? "지우는 중…" : "컨텍스트 지우기"}</Text>
        </Pressable>
      </View>
      {loadError ? <Text style={styles.error}>{loadError}</Text> : null}
      {text === null || prepared === null ? (
        loadError ? null : <Loading />
      ) : view.view === "preview" ? (
        <PreviewView
          body={prepared.body}
          notes={prepared.notes}
          marks={prepared.marks}
          theme={theme}
          compact={layout.compact}
          overlay={root}
          onHover={onHover}
          onOpenNote={openNote}
          onAction={onAction}
        />
      ) : (
        <SourceView text={text} theme={theme} onAction={onAction} />
      )}
      {message ? (
        <MessageBox
          message={message}
          theme={theme}
          maxHeight={Math.max(MESSAGE_MIN_HEIGHT, rootHeight * 0.85)}
          noteContent={message.note === undefined ? undefined : prepared?.notes.find((n) => n.label === message.note)?.content}
          onAction={onAction}
          onClose={() => setMessage(null)}
        />
      ) : null}
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
        anchor={questionAnchor}
        theme={theme}
        onClose={() => setQuestionAnchor(null)}
        onSubmit={(question) => {
          if (questionAnchor) void ask({ anchor: questionAnchor, mode: "question", question });
          setQuestionAnchor(null);
        }}
      />
      <PromptModal open={promptOpen} theme={theme} onClose={() => setPromptOpen(false)} />
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
  notes: Footnote[];
  marks: Mark[];
  theme: Theme;
  compact: boolean;
  overlay: RefObject<View | null>;
  onHover: (hover: FootnoteHover | null) => void;
  onOpenNote: (number: number) => void;
  onAction: (anchor: Anchor, mode: AskMode) => void;
}

/**
 * Paseo's own Markdown rendering. Highlights and superscript references show their footnote on
 * hover, the notes are listed at the end, and selections get floating ask buttons.
 */
function PreviewView({ body, notes, marks, theme, compact, overlay, onHover, onOpenNote, onAction }: PreviewProps) {
  const content = useRef<View>(null);
  const actions = useRef<View>(null);
  const [selection, setSelection] = useState<RenderedSelection | null>(null);
  const decorations = useRef<ReturnType<typeof decoratePreview> | null>(null);
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;
  const onOpenRef = useRef(onOpenNote);
  onOpenRef.current = onOpenNote;

  useEffect(() => watchSelection(content.current, setSelection), []);
  useEffect(() => keepSelectionOnPress(actions.current), [selection !== null]);
  useEffect(() => {
    decorations.current = decoratePreview(
      content.current,
      overlay.current,
      (hover) => onHoverRef.current(hover),
      (number) => onOpenRef.current(number),
    );
    return () => {
      decorations.current?.dispose();
      decorations.current = null;
      onHoverRef.current(null);
    };
  }, [overlay]);
  useEffect(() => {
    decorations.current?.setMarks(marks);
  }, [marks]);

  const styles = useMemo(
    () => ({
      ...readingLayout(compact),
      scroll: { flex: 1, minHeight: 0 },
      actions: { position: "absolute" as const, flexDirection: "row" as const, gap: 6 },
      button: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
        backgroundColor: theme.colors.accent,
      },
      label: { color: theme.colors.accentForeground },
    }),
    [theme, compact],
  );

  return (
    // Scrolling moves the text away from a tooltip anchored to it.
    <ScrollView style={styles.scroll} onScroll={() => onHover(null)} scrollEventThrottle={100}>
      <View style={styles.gutter}>
        <View ref={content} style={styles.frame}>
          <Markdown>{body}</Markdown>
          <FootnoteList notes={notes} theme={theme} />
          {selection ? (
            <View ref={actions} style={[styles.actions, { top: selection.top, left: selection.left }]}>
              {ASK_ACTIONS.map((action) => (
                <Pressable
                  key={action.mode}
                  accessibilityRole="button"
                  accessibilityLabel={`선택한 부분 ${action.label}`}
                  style={styles.button}
                  onPress={() => {
                    onAction(
                      { view: "preview", text: selection.text, hint: keptLength(selection.prefix) },
                      action.mode,
                    );
                    setSelection(null);
                  }}
                >
                  <Text style={styles.label}>{action.label}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      </View>
    </ScrollView>
  );
}

/** A footnote's content floating by its reference, kept inside the panel. */
function FootnoteTooltip({
  hover,
  note,
  theme,
  onOpen,
  onHoverChange,
}: {
  hover: FootnoteHover;
  note: Footnote;
  theme: Theme;
  /** Pressing the tooltip opens the footnote in the message panel. */
  onOpen: () => void;
  onHoverChange: (over: boolean) => void;
}) {
  const width = Math.min(TOOLTIP_WIDTH, hover.width - 16);
  const left = Math.max(8, Math.min(hover.left, hover.width - width - 8));
  const spaceBelow = hover.height - hover.top - 8;
  const spaceAbove = hover.height - hover.bottom - 8;
  const below = spaceBelow >= 160 || spaceBelow >= spaceAbove;
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
      <ScrollView contentContainerStyle={{ padding: 12 }}>
        <Markdown>{note.content}</Markdown>
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
          <Text style={styles.number}>{note.number}.</Text>
          <View style={styles.body}>
            <Markdown>{note.content}</Markdown>
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
}

/** Read-only CodeMirror source; selections show the ask buttons as an editor tooltip. */
function SourceView({ text, theme, onAction }: SourceProps) {
  const parent = useRef<View>(null);
  const viewer = useRef<DocViewerHandle | null>(null);
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  const initialText = useRef(text);

  useLayoutEffect(() => {
    viewer.current = mountViewer(parent.current, initialText.current, theme, (range, selected, mode) =>
      onActionRef.current({ view: "source", text: selected, range }, mode),
    );
    return () => {
      viewer.current?.destroy();
      viewer.current = null;
    };
  }, [theme]);

  useEffect(() => {
    initialText.current = text;
    viewer.current?.setText(text);
  }, [text]);

  return <View ref={parent} style={{ flex: 1, minHeight: 0 }} />;
}

function QuestionModal({
  anchor,
  theme,
  onClose,
  onSubmit,
}: {
  anchor: Anchor | null;
  theme: Theme;
  onClose: () => void;
  onSubmit: (question: string) => void;
}) {
  const [question, setQuestion] = useState("");
  useEffect(() => {
    if (anchor) setQuestion("");
  }, [anchor]);
  const styles = useMemo(() => modalStyles(theme), [theme]);
  const submit = () => {
    if (question.trim()) onSubmit(question.trim());
  };
  return (
    <Modal title="질문" open={anchor !== null} onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <Text style={styles.muted} numberOfLines={3}>
          선택: {anchor?.text}
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
function PromptModal({ open, theme, onClose }: { open: boolean; theme: Theme; onClose: () => void }) {
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

/** The request status and answer, resizable from its top edge; the height is saved. */
function MessageBox({
  message,
  theme,
  maxHeight,
  noteContent,
  onAction,
  onClose,
}: {
  message: Message;
  theme: Theme;
  maxHeight: number;
  /** Current content of the footnote the message is about, if any. */
  noteContent: string | undefined;
  onAction: (anchor: Anchor, mode: AskMode) => void;
  onClose: () => void;
}) {
  const toast = useToast();
  // A footnote shows its latest content, which accumulates follow-ups; a failed save shows the
  // answer that could not be stored.
  const showsNote = message.note !== undefined && noteContent !== undefined && message.kind !== "failed";
  const body = showsNote ? noteContent : message.answer;
  const content = useRef<View>(null);
  const actions = useRef<View>(null);
  const [selection, setSelection] = useState<RenderedSelection | null>(null);
  useEffect(() => (showsNote ? watchSelection(content.current, setSelection) : undefined), [showsNote]);
  useEffect(() => keepSelectionOnPress(actions.current), [selection !== null]);
  const layout = useSettings(layoutSettings);
  const saved = layout.status === "ready" ? layout.values.messageHeight : 220;
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const height = Math.min(maxHeight, Math.max(MESSAGE_MIN_HEIGHT, dragHeight ?? saved));
  const handle = useRef<View>(null);
  const live = useRef({ height, start: height, maxHeight, layout });
  live.current = { ...live.current, height, maxHeight, layout };

  useEffect(
    () =>
      watchVerticalDrag(handle.current, {
        start() {
          live.current.start = live.current.height;
        },
        move(dy) {
          const next = live.current.start - dy;
          setDragHeight(Math.round(Math.min(live.current.maxHeight, Math.max(MESSAGE_MIN_HEIGHT, next))));
        },
        end() {
          const current = live.current.layout;
          const value = Math.round(live.current.height);
          if (current.status !== "ready") return;
          void current.save({ messageHeight: value }, current.revision).then(() => setDragHeight(null));
        },
      }),
    [],
  );

  const answer = body;
  const styles = useMemo(
    () => ({
      box: {
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      handle: {
        height: 8,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        // react-native-web passes the CSS cursor through; the RN type lists fewer values.
        cursor: "row-resize",
      } as unknown as ViewStyle,
      grip: { width: 36, height: 3, borderRadius: 2, backgroundColor: theme.colors.border },
      scroll: { flex: 1, minHeight: 0 },
      content: { paddingHorizontal: 16, paddingBottom: 16, gap: 8 },
      header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12 },
      status: {
        flex: 1,
        fontWeight: "600" as const,
        color:
          message.kind === "failed"
            ? theme.colors.statusDanger
            : message.kind === "saved"
              ? theme.colors.statusSuccess
              : theme.colors.foreground,
      },
      quote: { color: theme.colors.foregroundMuted },
      action: { color: theme.colors.accent },
      actions: { position: "absolute" as const, flexDirection: "row" as const, gap: 6 },
      button: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
        backgroundColor: theme.colors.accent,
      },
      buttonLabel: { color: theme.colors.accentForeground },
    }),
    [theme, message.kind],
  );
  const status = message.status;

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
    <View style={[styles.box, { height }]}>
      <View ref={handle} style={styles.handle} accessibilityLabel="메시지 창 높이 조절">
        <View style={styles.grip} />
      </View>
      <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
        <View style={styles.header}>
          <Text style={styles.status}>{status}</Text>
          {answer ? (
            <Pressable accessibilityRole="button" accessibilityLabel="내용 복사" onPress={copyAnswer}>
              <Text style={styles.action}>복사</Text>
            </Pressable>
          ) : null}
          {message.kind !== "pending" ? (
            <Pressable accessibilityRole="button" accessibilityLabel="메시지 닫기" onPress={onClose}>
              <Text style={styles.action}>닫기</Text>
            </Pressable>
          ) : null}
        </View>
        {/* A footnote starts with its own bold title. */}
        {message.title && !showsNote ? (
          <Text style={styles.quote} numberOfLines={2}>
            {message.title}
          </Text>
        ) : null}
        {answer ? (
          <View ref={content}>
            <Markdown>{answer}</Markdown>
            {selection && showsNote && message.note !== undefined ? (
              <View ref={actions} style={[styles.actions, { top: selection.top, left: selection.left }]}>
                {ASK_ACTIONS.map((action) => (
                  <Pressable
                    key={action.mode}
                    accessibilityRole="button"
                    accessibilityLabel={`각주에서 선택한 부분 ${action.label}`}
                    style={styles.button}
                    onPress={() => {
                      onAction({ view: "note", text: selection.text, label: message.note as string }, action.mode);
                      setSelection(null);
                    }}
                  >
                    <Text style={styles.buttonLabel}>{action.label}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
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

/** The save-failure line for a rejected document write. */
function writeFailure(cause: unknown): string {
  if (cause instanceof PluginFileConflictError) return "저장 실패: 답을 기다리는 동안 파일이 디스크에서 변경되었습니다.";
  if (cause instanceof PluginFileDeletedError) return "저장 실패: 파일이 삭제되었습니다.";
  return `저장 실패: ${messageOf(cause)}`;
}
