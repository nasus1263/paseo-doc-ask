import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { copyText, Markdown, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";
import { chatMarks, copyComments } from "../shared/chat";
import { keptLength } from "../shared/markdown";
import { type MessageSelection, useChatController } from "./chat-controller";
import { QuestionModal } from "./doc-ask-panel";
import { SelectionComposer, useSelectionDraft } from "./selection-composer";
import { decoratePreview, elementSize, type PreviewDecorations } from "./web";

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
 * passages with superscript numbers that open in the side panel. Finishing a selection opens the
 * selection box (지시, 설명, 질문). 모든 지시 복사 copies the reader's comments with the
 * passages quoted.
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
  const decorations = useRef<PreviewDecorations | null>(null);
  const [question, setQuestion] = useState<MessageSelection | null>(null);
  const { draft, close, focused } = useSelectionDraft(content);

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
  useEffect(() => controller.noteAnswer(key, text, timestamp.getTime()), [controller, key, text, timestamp]);
  useEffect(
    () => controller.registerRevealer(key, (number) => void decorations.current?.reveal(number)),
    [controller, key],
  );

  const styles = useMemo(
    () => ({
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

  const picked = (): MessageSelection | null =>
    draft ? { key, source: text, selected: draft.text, hint: keptLength(draft.prefix) } : null;
  // Measured only while the selection box is open, not on every row's layout.
  const size = draft ? elementSize(content.current) : null;

  return (
    <View ref={content}>
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
            accessibilityLabel="이 답변에 단 모든 지시를 인용과 함께 복사"
            onPress={() => void copy(comments, "지시를 인용과 함께 복사했습니다.")}
          >
            <Text style={styles.link}>모든 지시 복사</Text>
          </Pressable>
        ) : null}
        <Text style={styles.meta}>{formatTime(timestamp)}</Text>
      </View>
      {draft ? (
        <SelectionComposer
          draft={draft}
          focused={focused}
          theme={theme}
          containerWidth={size?.width ?? 0}
          containerHeight={size?.height ?? 0}
          commentLabel="지시"
          onClose={close}
          onComment={async (comment) => {
            const selection = picked();
            if (!selection) return false;
            const failure = await controller.addComment(selection, comment);
            if (failure) {
              toast.error(failure);
              return false;
            }
            toast.show("지시를 달았습니다.", { variant: "success" });
            return true;
          }}
          onAsk={(mode, typed) => {
            const selection = picked();
            if (!selection) return;
            if (mode === "question" && !typed) setQuestion(selection);
            else void controller.askMessage(selection, mode, typed);
          }}
        />
      ) : null}
      {/* Mounted only while open: a closed dialog per message adds up over a long chat. */}
      {question ? (
        <QuestionModal
          selected={question.selected}
          theme={theme}
          onClose={() => setQuestion(null)}
          onSubmit={(asked) => {
            void controller.askMessage(question, "question", asked);
            setQuestion(null);
          }}
        />
      ) : null}
    </View>
  );
}
