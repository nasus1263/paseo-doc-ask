import { z } from "zod";
import {
  PluginFileConflictError,
  PluginFileDeletedError,
  type PluginFilePanelProps,
  useFileText,
  useRpc,
  useTabState,
} from "@getpaseo/plugin/client";
import { copyText, Loading, Markdown, useToast } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { explainRpc, resetRpc } from "../shared/explain";
import {
  insertAnswer,
  keptLength,
  locateRendered,
  locateSelection,
  type TextRange,
} from "../shared/markdown";
import {
  type DocViewerHandle,
  keepSelectionOnPress,
  mountViewer,
  type RenderedSelection,
  watchSelection,
} from "./web";

type Theme = PluginFilePanelProps["theme"];

/** What the user selected, and how to find it again in the newest file text. */
type Question =
  | { view: "source"; text: string; range: TextRange }
  | { view: "preview"; text: string; hint: number };

type Message =
  | { kind: "pending"; question: string }
  | { kind: "saved"; question: string; answer: string }
  | { kind: "failed"; question: string; reason: string; answer: string | null };

const viewSchema = z.object({ view: z.enum(["preview", "source"]) });
const defaultView = { view: "preview" } as const;

/** Web: Paseo's Markdown preview or a read-only source view, both answering selections. */
function DocAskViewer(props: PluginFilePanelProps) {
  const { file, theme, workspaceId, tab } = props;
  const [view, setView] = useTabState(tab, viewSchema, defaultView);
  const [text, setText] = useState<string | null>(null);
  const latestText = useRef("");
  const busy = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
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
    async (question: Question) => {
      if (busy.current) {
        toast.show("이전 질문의 답을 기다리는 중입니다.", { variant: "warning" });
        return;
      }
      busy.current = true;
      const quoted = question.text;
      setMessage({ kind: "pending", question: quoted });
      try {
        let answer: string;
        try {
          ({ answer } = await explain({
            workspaceId,
            path: file.path,
            document: latestText.current,
            selection: quoted,
          }));
        } catch (cause) {
          setMessage({ kind: "failed", question: quoted, reason: `질문 실패: ${messageOf(cause)}`, answer: null });
          return;
        }
        const failed = (reason: string) =>
          setMessage({ kind: "failed", question: quoted, reason, answer });
        let latest: string;
        try {
          // Merge into the newest version so edits made while waiting are kept.
          latest = await file.readText();
        } catch (cause) {
          failed(`저장 실패: 파일을 읽지 못했습니다. ${messageOf(cause)}`);
          return;
        }
        const at =
          question.view === "source"
            ? locateSelection(latest, question.range, question.text)
            : locateRendered(latest, question.text, question.hint);
        if (!at) {
          failed("저장 실패: 선택한 부분을 원문에서 찾지 못했습니다.");
          return;
        }
        const next = insertAnswer(latest, at, quoted, answer);
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
        setMessage({ kind: "saved", question: quoted, answer });
      } finally {
        busy.current = false;
      }
    },
    [explain, file, show, toast, workspaceId],
  );

  const reset = useRpc(resetRpc);
  const [resetting, setResetting] = useState(false);
  const resetContext = useCallback(async () => {
    setResetting(true);
    try {
      // Runs after any question in flight; the next question starts a fresh session.
      await reset({ workspaceId });
      toast.show("컨텍스트를 지웠습니다. 다음 질문부터 새 세션으로 시작합니다.", { variant: "success" });
    } catch (cause) {
      toast.error(`컨텍스트를 지우지 못했습니다: ${messageOf(cause)}`);
    } finally {
      setResetting(false);
    }
  }, [reset, toast, workspaceId]);

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
        <PreviewView text={text} theme={theme} compact={props.layout.compact} onAsk={ask} />
      ) : (
        <SourceView text={text} theme={theme} onAsk={ask} />
      )}
      {message ? <MessageBox message={message} theme={theme} onClose={() => setMessage(null)} /> : null}
    </View>
  );
}

interface ViewProps {
  text: string;
  theme: Theme;
  onAsk: (question: Question) => void;
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

/** Paseo's own Markdown rendering with a floating ask button over the selection. */
function PreviewView({ text, theme, compact, onAsk }: ViewProps & { compact: boolean }) {
  const content = useRef<View>(null);
  const button = useRef<View>(null);
  const [selection, setSelection] = useState<RenderedSelection | null>(null);

  useEffect(() => watchSelection(content.current, setSelection), []);
  useEffect(() => keepSelectionOnPress(button.current), [selection !== null]);

  const styles = useMemo(
    () => ({
      ...readingLayout(compact),
      scroll: { flex: 1, minHeight: 0 },
      button: {
        position: "absolute" as const,
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
    <ScrollView style={styles.scroll}>
      <View style={styles.gutter}>
        <View ref={content} style={styles.frame}>
          <Markdown>{text}</Markdown>
          {selection ? (
            <View ref={button} style={[styles.button, { top: selection.top, left: selection.left }]}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="선택한 부분을 AI에게 묻기"
                onPress={() => {
                  onAsk({ view: "preview", text: selection.text, hint: keptLength(selection.prefix) });
                  setSelection(null);
                }}
              >
                <Text style={styles.label}>AI에게 묻기</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      </View>
    </ScrollView>
  );
}

/** Read-only CodeMirror source; selections show the ask button as an editor tooltip. */
function SourceView({ text, theme, onAsk }: ViewProps) {
  const parent = useRef<View>(null);
  const viewer = useRef<DocViewerHandle | null>(null);
  const onAskRef = useRef(onAsk);
  onAskRef.current = onAsk;
  const initialText = useRef(text);

  useLayoutEffect(() => {
    viewer.current = mountViewer(parent.current, initialText.current, theme, (range, selected) =>
      onAskRef.current({ view: "source", text: selected, range }),
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
      title: {
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
  const title =
    message.kind === "pending"
      ? "AI에게 묻는 중…"
      : message.kind === "saved"
        ? "문서에 반영했습니다."
        : message.reason;

  async function copyAnswer() {
    if (!answer) return;
    try {
      await copyText(answer);
      toast.show("설명을 복사했습니다.", { variant: "success" });
    } catch {
      toast.error("복사하지 못했습니다. 텍스트를 직접 선택해 복사하세요.");
    }
  }

  return (
    <ScrollView style={styles.box} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.title}>{title}</Text>
        {answer ? (
          <Pressable accessibilityRole="button" accessibilityLabel="설명 복사" onPress={copyAnswer}>
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
        질문: {message.question}
      </Text>
      {answer ? <Markdown>{answer}</Markdown> : null}
    </ScrollView>
  );
}

/** Native has no selection API: Paseo's Markdown preview that follows the disk. */
function NativePreview({ file, theme, layout }: PluginFilePanelProps) {
  const text = useFileText(file);
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
          <Markdown>{text.text}</Markdown>
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
