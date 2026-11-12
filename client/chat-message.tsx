import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Markdown } from "@getpaseo/plugin/client/ui";
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

/** The timeline item that replaces a completed assistant message. */
export const CHAT_MESSAGE_KIND = "doc-ask-assistant";
export const chatMessageSchema = z.object({ text: z.string(), key: z.string() });

/**
 * A completed assistant message drawn with Paseo's Markdown, plus footnotes: highlighted
 * passages with superscript numbers that open in the side panel, and 설명/질문 on selections.
 */
export function ChatMessage({ agentId, item, theme }: PluginTimelineItemProps<z.output<typeof chatMessageSchema>>) {
  const { text, key } = item.data;
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
    () => controller.registerRevealer(key, (number) => void decorations.current?.reveal(number)),
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
    }),
    [theme],
  );

  return (
    <View ref={content}>
      <Markdown>{body}</Markdown>
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
