import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { copyText, Markdown, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";
import { chatMarks, copyComments } from "../shared/chat";
import { keptLength } from "../shared/markdown";
import { type MessageSelection, useChatController } from "./chat-controller";
import { QuestionModal } from "./doc-ask-panel";
import {
  ASK_ACTIONS,
  decoratePreview,
  holdHighlight,
  keepSelectionOnPress,
  type PreviewDecorations,
  watchSelection,
} from "./web";

/** Width of the comment box that opens over a selection. */
const BAR_WIDTH = 360;
const LINE_HEIGHT = 20;
const MAX_INPUT_HEIGHT = 160;

function formatTime(date: Date): string {
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${date.toLocaleDateString("ko-KR", { month: "short", day: "numeric" })} ${time}`;
}

/** The timeline item that replaces a completed assistant message. */
export const CHAT_MESSAGE_KIND = "doc-ask-assistant";
export const chatMessageSchema = z.object({ text: z.string(), key: z.string() });

/** A finished selection waiting for a comment, and where its box sits. */
interface Draft {
  id: number;
  picked: MessageSelection;
  top: number;
  left: number;
  /** The selected DOM range, kept highlighted while the comment box has focus. */
  range: unknown;
}

/** Key events from the comment box; on web `nativeEvent` is the DOM keyboard event. */
interface KeyEvent {
  nativeEvent: { key: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number };
  preventDefault(): void;
}

/**
 * A completed assistant message drawn with Paseo's Markdown, plus footnotes: highlighted
 * passages with superscript numbers that open in the side panel. Finishing a selection opens a
 * focused comment box over it (Enter saves, Shift+Enter breaks the line, Esc cancels), next to
 * 설명/질문 for the AI. 모든 주석 복사 copies the reader's comments with the passages quoted.
 */
export function ChatMessage({
  agentId,
  item,
  theme,
  timestamp,
}: PluginTimelineItemProps<z.output<typeof chatMessageSchema>>) {
  const { text, key } = item.data;
  const toast = useToast();
  const { controller, notes } = useChatController(agentId);
  const { body, marks } = useMemo(() => chatMarks(text, key, notes), [key, notes, text]);
  const comments = useMemo(() => copyComments(text, key, notes), [key, notes, text]);
  const content = useRef<View>(null);
  const bar = useRef<View>(null);
  const decorations = useRef<PreviewDecorations | null>(null);
  const [width, setWidth] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [question, setQuestion] = useState<MessageSelection | null>(null);
  const inputFocused = useRef(false);
  const draftCount = useRef(0);

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
    () => controller.registerRevealer(key, (number) => void decorations.current?.reveal(number)),
    [controller, key],
  );
  useEffect(
    () =>
      watchSelection(content.current, (selection) => {
        // Typing or selecting inside the comment box must not replace the draft it belongs to.
        if (inputFocused.current) return;
        if (!selection) {
          setDraft(null);
          return;
        }
        setDraft({
          id: ++draftCount.current,
          picked: { key, source: text, selected: selection.text, hint: keptLength(selection.prefix) },
          top: selection.top,
          left: selection.left,
          range: selection.range,
        });
      }),
    [key, text],
  );
  useEffect(() => {
    setComment("");
    return draft ? holdHighlight(draft.range) : undefined;
  }, [draft]);
  // Pressing 설명/질문 must not blur the comment box first.
  useEffect(() => keepSelectionOnPress(bar.current), [draft?.id]);

  const close = () => {
    inputFocused.current = false;
    setDraft(null);
  };

  const saveComment = async () => {
    if (!draft || !comment.trim() || saving) return;
    setSaving(true);
    try {
      const failure = await controller.addComment(draft.picked, comment.trim());
      if (failure) {
        toast.error(failure);
        return;
      }
      toast.show("주석을 달았습니다.", { variant: "success" });
      close();
    } finally {
      setSaving(false);
    }
  };

  const onKeyPress = (event: KeyEvent) => {
    const { key: pressed, shiftKey, isComposing, keyCode } = event.nativeEvent;
    // Enter while an IME is composing (Korean, Japanese, …) only finishes the character.
    if (pressed === "Enter" && !shiftKey && !isComposing && keyCode !== 229) {
      event.preventDefault();
      void saveComment();
    } else if (pressed === "Escape") {
      event.preventDefault();
      close();
    }
  };

  const styles = useMemo(
    () => ({
      bar: {
        position: "absolute" as const,
        zIndex: 5,
        width: BAR_WIDTH,
        gap: 6,
        padding: 8,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        shadowColor: "#000",
        shadowOpacity: 0.18,
        shadowRadius: 10,
        shadowOffset: { width: 0, height: 3 },
      },
      input: {
        color: theme.colors.foreground,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 6,
        paddingHorizontal: 8,
        paddingVertical: 6,
        lineHeight: LINE_HEIGHT,
        textAlignVertical: "top" as const,
      },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      button: {
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
        backgroundColor: theme.colors.accent,
      },
      label: { color: theme.colors.accentForeground },
      hint: { flex: 1, textAlign: "right" as const, color: theme.colors.foregroundMuted, fontSize: 11 },
      footer: { flexDirection: "row" as const, alignItems: "center" as const, gap: 12, marginTop: 4 },
      meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      link: { color: theme.colors.accent, fontSize: 12 },
    }),
    [theme],
  );

  async function copy(value: string, done: string) {
    try {
      await copyText(value);
      toast.show(done, { variant: "success" });
    } catch {
      toast.error("복사하지 못했습니다. 텍스트를 직접 선택해 복사하세요.");
    }
  }

  const inputHeight = Math.min(MAX_INPUT_HEIGHT, comment.split("\n").length * LINE_HEIGHT + 14);
  const barLeft = draft ? Math.max(0, Math.min(draft.left, width - BAR_WIDTH)) : 0;

  return (
    <View ref={content} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      <Markdown>{body}</Markdown>
      <View style={styles.footer}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="답변 복사"
          onPress={() => void copy(text, "답변을 복사했습니다.")}
        >
          <Text style={styles.meta}>복사</Text>
        </Pressable>
        {comments ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="이 답변에 단 모든 주석을 인용과 함께 복사"
            onPress={() => void copy(comments, "주석을 인용과 함께 복사했습니다.")}
          >
            <Text style={styles.link}>모든 주석 복사</Text>
          </Pressable>
        ) : null}
        <Text style={styles.meta}>{formatTime(timestamp)}</Text>
      </View>
      {draft ? (
        <View ref={bar} style={[styles.bar, { top: draft.top, left: barLeft }]}>
          <TextInput
            key={draft.id}
            autoFocus
            multiline
            value={comment}
            editable={!saving}
            onChangeText={setComment}
            onFocus={() => {
              inputFocused.current = true;
            }}
            onBlur={() => {
              inputFocused.current = false;
            }}
            onKeyPress={(event) => onKeyPress(event as unknown as KeyEvent)}
            placeholder="주석 입력 후 Enter"
            placeholderTextColor={theme.colors.foregroundMuted}
            accessibilityLabel="선택한 부분에 대한 주석"
            style={[styles.input, { height: inputHeight }]}
          />
          <View style={styles.row}>
            {ASK_ACTIONS.map((action) => (
              <Pressable
                key={action.mode}
                accessibilityRole="button"
                accessibilityLabel={`선택한 부분 ${action.label}`}
                style={styles.button}
                onPress={() => {
                  if (action.mode === "question") setQuestion(draft.picked);
                  else void controller.askMessage(draft.picked, action.mode);
                  close();
                }}
              >
                <Text style={styles.label}>{action.label}</Text>
              </Pressable>
            ))}
            <Text style={styles.hint}>{saving ? "저장 중…" : "Enter 저장 · Shift+Enter 줄바꿈 · Esc 취소"}</Text>
          </View>
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
