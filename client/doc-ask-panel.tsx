import {
  PluginFileConflictError,
  PluginFileDeletedError,
  type PluginFilePanelProps,
  useFileText,
  useRpc,
} from "@getpaseo/plugin/client";
import { copyText, Loading, Markdown, useToast } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { explainRpc } from "../shared/explain";
import { insertAnswer, type TextRange } from "../shared/markdown";
import { type DocViewerHandle, mountViewer } from "./web";

type Message =
  | { kind: "pending"; selected: string }
  | { kind: "saved"; selected: string; answer: string }
  | { kind: "failed"; selected: string; reason: string; answer: string | null };

/** Web: read-only source view that follows the disk and answers selections in place. */
function DocAskViewer({ file, theme, workspaceId }: PluginFilePanelProps) {
  const parent = useRef<View>(null);
  const viewer = useRef<DocViewerHandle | null>(null);
  const text = useRef("");
  const busy = useRef(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const explain = useRpc(explainRpc);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      text.current = await file.readText();
    } catch (cause) {
      setLoadError(messageOf(cause));
      return;
    }
    viewer.current?.setText(text.current);
    setLoadError(null);
    setLoaded(true);
  }, [file]);

  const ask = useCallback(
    async (range: TextRange, selected: string) => {
      if (busy.current) {
        toast.show("이전 질문의 답을 기다리는 중입니다.", { variant: "warning" });
        return;
      }
      busy.current = true;
      setMessage({ kind: "pending", selected });
      try {
        let answer: string;
        try {
          ({ answer } = await explain({
            workspaceId,
            path: file.path,
            document: text.current,
            selection: selected,
          }));
        } catch (cause) {
          setMessage({ kind: "failed", selected, reason: `질문 실패: ${messageOf(cause)}`, answer: null });
          return;
        }
        const failed = (reason: string) => setMessage({ kind: "failed", selected, reason, answer });
        let latest: string;
        try {
          // Merge into the newest version so edits made while waiting are kept.
          latest = await file.readText();
        } catch (cause) {
          failed(`저장 실패: 파일을 읽지 못했습니다. ${messageOf(cause)}`);
          return;
        }
        const next = insertAnswer(latest, range, selected, answer);
        if (next === null) {
          failed("저장 실패: 선택한 부분을 문서에서 찾지 못했습니다.");
          return;
        }
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
        text.current = next;
        viewer.current?.setText(next);
        setMessage({ kind: "saved", selected, answer });
      } finally {
        busy.current = false;
      }
    },
    [explain, file, toast, workspaceId],
  );

  // The editor outlives renders; route its callback through a ref to the latest `ask`.
  const askRef = useRef(ask);
  askRef.current = ask;

  useLayoutEffect(() => {
    viewer.current = mountViewer(parent.current, text.current, theme, (range, selected) => {
      void askRef.current(range, selected);
    });
    return () => {
      viewer.current?.destroy();
      viewer.current = null;
    };
  }, [theme]);

  useEffect(() => {
    void load();
    const unwatch = file.watch((event) => {
      if (event.type === "deleted") setLoadError("파일이 삭제되었습니다.");
      else void load();
    });
    return unwatch;
  }, [file, load]);

  const styles = useMemo(
    () => ({
      panel: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
      viewer: { flex: 1, minHeight: 0 },
      error: { color: theme.colors.statusDanger, paddingHorizontal: 16, paddingVertical: 8 },
    }),
    [theme],
  );

  return (
    <View style={styles.panel}>
      {loadError ? <Text style={styles.error}>{loadError}</Text> : null}
      <View ref={parent} style={styles.viewer} />
      {message ? (
        <MessageBox message={message} theme={theme} onClose={() => setMessage(null)} />
      ) : null}
      {!loaded && !loadError ? <Loading /> : null}
    </View>
  );
}

function MessageBox({
  message,
  theme,
  onClose,
}: {
  message: Message;
  theme: PluginFilePanelProps["theme"];
  onClose: () => void;
}) {
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
        질문: {message.selected}
      </Text>
      {answer ? <Markdown>{answer}</Markdown> : null}
    </ScrollView>
  );
}

/** Native has no selection API: selectable, read-only text that follows the disk. */
function DocText({ file, theme }: PluginFilePanelProps) {
  const text = useFileText(file);
  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      note: { color: theme.colors.foregroundMuted, paddingHorizontal: 16, paddingTop: 12 },
      text: { color: theme.colors.foreground, padding: 16 },
      error: { color: theme.colors.statusDanger, padding: 16 },
    }),
    [theme],
  );
  if (text.status === "loading") return <Loading />;
  if (text.status === "error") return <Text style={styles.error}>{text.error.message}</Text>;
  return (
    <ScrollView style={styles.screen}>
      <Text style={styles.note}>선택해서 묻기는 데스크톱과 웹에서만 지원합니다.</Text>
      <Text selectable style={styles.text}>
        {text.text}
      </Text>
    </ScrollView>
  );
}

export function DocAskPanel(props: PluginFilePanelProps) {
  return props.layout.platform === "web" ? <DocAskViewer {...props} /> : <DocText {...props} />;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
