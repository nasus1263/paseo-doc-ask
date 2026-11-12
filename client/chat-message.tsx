import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { copyText, Markdown, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";
import { chatMarks } from "../shared/chat";
import { keptLength } from "../shared/markdown";
import { type MessageSelection, useChatController } from "./chat-controller";
import { QuestionModal } from "./doc-ask-panel";
import {
  ASK_ACTIONS,
  decoratePreview,
  keepSelectionOnPress,
  type PreviewDecorations,
  type RenderedSelection,
  watchSelection,
} from "./web";

/** Answers taller than this fold to `FOLDED_HEIGHT` with a 더 보기 toggle. */
const FOLD_AT = 900;
const FOLDED_HEIGHT = 600;

function formatTime(date: Date): string {
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${date.toLocaleDateString("ko-KR", { month: "short", day: "numeric" })} ${time}`;
}

/** The timeline item that replaces a completed assistant message. */
export const CHAT_MESSAGE_KIND = "doc-ask-assistant";
export const chatMessageSchema = z.object({ text: z.string(), key: z.string() });

/**
 * A completed assistant message drawn with Paseo's Markdown, plus footnotes: highlighted
 * passages with superscript numbers that open in the side panel, and 설명/질문 on selections.
 */
export function ChatMessage({
  agentId,
  item,
  theme,
  timestamp,
}: PluginTimelineItemProps<z.output<typeof chatMessageSchema>>) {
  const { text, key } = item.data;
  const toast = useToast();
  // Long answers fold like Paseo's own rows; the full height is measured before folding.
  const [fullHeight, setFullHeight] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const folds = fullHeight > FOLD_AT;
  const { controller, notes } = useChatController(agentId);
  const { body, marks } = useMemo(() => chatMarks(text, key, notes), [key, notes, text]);
  const content = useRef<View>(null);
  const actions = useRef<View>(null);
  const decorations = useRef<PreviewDecorations | null>(null);
  const [selection, setSelection] = useState<RenderedSelection | null>(null);
  const [question, setQuestion] = useState<MessageSelection | null>(null);

  useEffect(() => {
    decorations.current = decoratePreview(
      content.current,
      content.current,
      () => {},
      (number) => controller.openNoteByNumber(number),
    );
    return () => {
      decorations.current?.dispose();
      decorations.current = null;
    };
  }, [controller]);
  useEffect(() => {
    decorations.current?.setMarks(marks);
  }, [marks]);
  useEffect(
    () =>
      controller.registerRevealer(key, (number) => {
        // A folded answer may hide the passage; unfold, then scroll once the layout settles.
        setExpanded(true);
        setTimeout(() => void decorations.current?.reveal(number), 60);
      }),
    [controller, key],
  );
  useEffect(() => watchSelection(content.current, setSelection), []);
  useEffect(() => keepSelectionOnPress(actions.current), [selection !== null]);

  const styles = useMemo(
    () => ({
      actions: { position: "absolute" as const, flexDirection: "row" as const, gap: 6, zIndex: 5 },
      button: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
        backgroundColor: theme.colors.accent,
      },
      label: { color: theme.colors.accentForeground },
      folded: { maxHeight: FOLDED_HEIGHT, overflow: "hidden" as const },
      footer: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, marginTop: 4 },
      meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      link: { color: theme.colors.accent, fontSize: 12 },
    }),
    [theme],
  );

  async function copyMessage() {
    try {
      await copyText(text);
      toast.show("답변을 복사했습니다.", { variant: "success" });
    } catch {
      toast.error("복사하지 못했습니다. 텍스트를 직접 선택해 복사하세요.");
    }
  }

  return (
    <View ref={content}>
      <View style={folds && !expanded ? styles.folded : null}>
        <View onLayout={(event) => setFullHeight(event.nativeEvent.layout.height)}>
          <Markdown>{body}</Markdown>
        </View>
      </View>
      <View style={styles.footer}>
        {folds ? (
          <Pressable accessibilityRole="button" onPress={() => setExpanded(!expanded)}>
            <Text style={styles.link}>{expanded ? "접기" : "더 보기"}</Text>
          </Pressable>
        ) : null}
        <Pressable accessibilityRole="button" accessibilityLabel="답변 복사" onPress={copyMessage}>
          <Text style={styles.meta}>복사</Text>
        </Pressable>
        <Text style={styles.meta}>{formatTime(timestamp)}</Text>
      </View>
      {selection ? (
        <View ref={actions} style={[styles.actions, { top: selection.top, left: selection.left }]}>
          {ASK_ACTIONS.map((action) => (
            <Pressable
              key={action.mode}
              accessibilityRole="button"
              accessibilityLabel={`선택한 부분 ${action.label}`}
              style={styles.button}
              onPress={() => {
                const asked: MessageSelection = {
                  key,
                  source: text,
                  selected: selection.text,
                  hint: keptLength(selection.prefix),
                };
                if (action.mode === "question") setQuestion(asked);
                else void controller.askMessage(asked, action.mode);
                setSelection(null);
              }}
            >
              <Text style={styles.label}>{action.label}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <QuestionModal
        selected={question?.selected ?? null}
        theme={theme}
        onClose={() => setQuestion(null)}
        onSubmit={(asked) => {
          if (question) void controller.askMessage(question, "question", asked);
          setQuestion(null);
        }}
      />
    </View>
  );
}
