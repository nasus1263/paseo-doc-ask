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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { type AskMode, explainRpc, promptSettings, resetRpc } from "../shared/explain";
import {
  addFootnote,
  type Footnote,
  fromSuperscript,
  keptLength,
  locateRendered,
  locateSelection,
  prepareFootnotes,
  type TextRange,
} from "../shared/markdown";
import {
  ASK_ACTIONS,
  type DocViewerHandle,
  type FootnoteHover,
  keepSelectionOnPress,
  mountViewer,
  type RenderedSelection,
  watchFootnoteHover,
  watchSelection,
} from "./web";

type Theme = PluginFilePanelProps["theme"];

/** What the user selected, and how to find it again in the newest file text. */
type Anchor =
  | { view: "source"; text: string; range: TextRange }
  | { view: "preview"; text: string; hint: number };

interface AskRequest {
  anchor: Anchor;
  mode: AskMode;
  question?: string;
}

type Message =
  | { kind: "pending"; title: string }
  | { kind: "saved"; title: string; answer: string }
  | { kind: "failed"; title: string; reason: string; answer: string | null };

const MODE_LABEL: Record<AskMode, string> = { term: "설명", question: "질문" };

const viewSchema = z.object({ view: z.enum(["preview", "source"]) });
const defaultView = { view: "preview" } as const;

/** Web: Paseo's Markdown preview or a read-only source view, both answering selections. */
function DocAskViewer(props: PluginFilePanelProps) {
  const { file, theme, workspaceId, tab, layout } = props;
  const [view, setView] = useTabState(tab, viewSchema, defaultView);
  const [text, setText] = useState<string | null>(null);
  const latestText = useRef("");
  const busy = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [questionAnchor, setQuestionAnchor] = useState<Anchor | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);
  const explain = useRpc(explainRpc);
  const toast = useToast();

  const show = useCallback((next: string) => {
    latestText.current = next;
    setText(next);
  }, []);

  const load = useCallback(async () => {
    try {
      show(await file.readText());
      setLoadError(null);
    } catch (cause) {
      setLoadError(messageOf(cause));
    }
  }, [file, show]);

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
      setMessage({ kind: "pending", title });
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
          }));
        } catch (cause) {
          setMessage({ kind: "failed", title, reason: `요청 실패: ${messageOf(cause)}`, answer: null });
          return;
        }
        const failed = (reason: string) => setMessage({ kind: "failed", title, reason, answer });
        let latest: string;
        try {
          // Merge into the newest version so edits made while waiting are kept.
          latest = await file.readText();
        } catch (cause) {
          failed(`저장 실패: 파일을 읽지 못했습니다. ${messageOf(cause)}`);
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
        const next = addFootnote(latest, at, label, subject, answer);
        try {
          await file.writeText(next);
        } catch (cause) {
          if (cause instanceof PluginFileConflictError) {
            failed("저장 실패: 답을 기다리는 동안 파일이 디스크에서 변경되었습니다.");
          } else if (cause instanceof PluginFileDeletedError) {
            failed("저장 실패: 파일이 삭제되었습니다.");
          } else {
            failed(`저장 실패: ${messageOf(cause)}`);
          }
          return;
        }
        show(next);
        setMessage({ kind: "saved", title, answer });
      } finally {
        busy.current = false;
      }
    },
    [explain, file, show, toast, workspaceId],
  );

  const onAction = useCallback(
    (anchor: Anchor, mode: AskMode) => {
      if (mode === "question") setQuestionAnchor(anchor);
      else void ask({ anchor, mode });
    },
    [ask],
  );

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
    <View style={styles.panel}>
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
      {text === null ? (
        loadError ? null : <Loading />
      ) : view.view === "preview" ? (
        <PreviewView text={text} theme={theme} compact={layout.compact} onAction={onAction} />
      ) : (
        <SourceView text={text} theme={theme} onAction={onAction} />
      )}
      {message ? <MessageBox message={message} theme={theme} onClose={() => setMessage(null)} /> : null}
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

interface ViewProps {
  text: string;
  theme: Theme;
  onAction: (anchor: Anchor, mode: AskMode) => void;
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

/**
 * Paseo's own Markdown rendering. Footnote references show as superscript numbers with a hover
 * tooltip, the notes are listed at the end, and selections get floating ask buttons.
 */
function PreviewView({ text, theme, compact, onAction }: ViewProps & { compact: boolean }) {
  const content = useRef<View>(null);
  const actions = useRef<View>(null);
  const [selection, setSelection] = useState<RenderedSelection | null>(null);
  const [hover, setHover] = useState<FootnoteHover | null>(null);
  const overTip = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const { body, notes } = useMemo(() => prepareFootnotes(text), [text]);

  useEffect(() => watchSelection(content.current, setSelection), []);
  useEffect(() => keepSelectionOnPress(actions.current), [selection !== null]);
  useEffect(() => {
    const stop = watchFootnoteHover(content.current, (next) => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      if (next) setHover(next);
      else {
        hideTimer.current = setTimeout(() => {
          if (!overTip.current) setHover(null);
        }, 200);
      }
    });
    return () => {
      stop();
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  const hovered = hover ? notes.find((note) => note.number === fromSuperscript(hover.text)) : undefined;

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
      tooltip: {
        position: "absolute" as const,
        width: 380,
        maxWidth: "90%" as const,
        maxHeight: 300,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
        shadowColor: "#000",
        shadowOpacity: 0.2,
        shadowRadius: 12,
        shadowOffset: { width: 0, height: 4 },
      },
      tooltipContent: { padding: 12 },
    }),
    [theme, compact],
  );

  return (
    <ScrollView style={styles.scroll}>
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
          {hover && hovered ? (
            <Pressable
              accessibilityRole="none"
              style={[styles.tooltip, { top: hover.top, left: hover.left }]}
              onHoverIn={() => {
                overTip.current = true;
              }}
              onHoverOut={() => {
                overTip.current = false;
                setHover(null);
              }}
            >
              <ScrollView contentContainerStyle={styles.tooltipContent}>
                <Markdown>{hovered.content}</Markdown>
              </ScrollView>
            </Pressable>
          ) : null}
        </View>
      </View>
    </ScrollView>
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

/** Read-only CodeMirror source; selections show the ask buttons as an editor tooltip. */
function SourceView({ text, theme, onAction }: ViewProps) {
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

function MessageBox({ message, theme, onClose }: { message: Message; theme: Theme; onClose: () => void }) {
  const toast = useToast();
  const answer = message.kind === "pending" ? null : message.answer;
  const styles = useMemo(
    () => ({
      box: {
        maxHeight: "45%" as const,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      },
      content: { padding: 16, gap: 8 },
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
    }),
    [theme, message.kind],
  );
  const status =
    message.kind === "pending"
      ? "AI에게 묻는 중…"
      : message.kind === "saved"
        ? "문서에 각주로 반영했습니다."
        : message.reason;

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
    <ScrollView style={styles.box} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.status}>{status}</Text>
        {answer ? (
          <Pressable accessibilityRole="button" accessibilityLabel="답 복사" onPress={copyAnswer}>
            <Text style={styles.action}>복사</Text>
          </Pressable>
        ) : null}
        {message.kind !== "pending" ? (
          <Pressable accessibilityRole="button" accessibilityLabel="메시지 닫기" onPress={onClose}>
            <Text style={styles.action}>닫기</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.quote} numberOfLines={2}>
        {message.title}
      </Text>
      {answer ? <Markdown>{answer}</Markdown> : null}
    </ScrollView>
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
