import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { copyText, Markdown, Modal, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";
import { chatMarks, copyComments } from "../shared/chat";
import { keptLength } from "../shared/markdown";
import { type MessageSelection, useChatController } from "./chat-controller";
import { modalStyles, QuestionModal, type Theme } from "./doc-ask-panel";
import {
  ASK_ACTIONS,
  decoratePreview,
  keepSelectionOnPress,
  type PreviewDecorations,
  type RenderedSelection,
  watchSelection,
} from "./web";

/** The actions over a selection in an answer: ask the AI, or add the reader's own comment. */
const MESSAGE_ACTIONS = [...ASK_ACTIONS, { mode: "comment", label: "주석" }] as const;

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
 * passages with superscript numbers that open in the side panel, 설명/질문 on selections, and
 * the reader's own 주석, which 모든 주석 복사 copies as quoted passages with their comments.
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
  const actions = useRef<View>(null);
  const decorations = useRef<PreviewDecorations | null>(null);
  const [selection, setSelection] = useState<RenderedSelection | null>(null);
  const [question, setQuestion] = useState<MessageSelection | null>(null);
  const [commenting, setCommenting] = useState<MessageSelection | null>(null);

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
            accessibilityLabel="이 답변에 단 모든 주석을 인용과 함께 복사"
            onPress={() => void copy(comments, "주석을 인용과 함께 복사했습니다.")}
          >
            <Text style={styles.link}>모든 주석 복사</Text>
          </Pressable>
        ) : null}
        <Text style={styles.meta}>{formatTime(timestamp)}</Text>
      </View>
      {selection ? (
        <View ref={actions} style={[styles.actions, { top: selection.top, left: selection.left }]}>
          {MESSAGE_ACTIONS.map((action) => (
            <Pressable
              key={action.mode}
              accessibilityRole="button"
              accessibilityLabel={`선택한 부분 ${action.label}`}
              style={styles.button}
              onPress={() => {
                const picked: MessageSelection = {
                  key,
                  source: text,
                  selected: selection.text,
                  hint: keptLength(selection.prefix),
                };
                if (action.mode === "comment") setCommenting(picked);
                else if (action.mode === "question") setQuestion(picked);
                else void controller.askMessage(picked, action.mode);
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
      <CommentModal
        selected={commenting?.selected ?? null}
        theme={theme}
        onClose={() => setCommenting(null)}
        onSave={async (comment) => {
          if (!commenting) return;
          const failure = await controller.addComment(commenting, comment);
          if (failure) {
            toast.error(failure);
            return;
          }
          toast.show("주석을 달았습니다.", { variant: "success" });
          setCommenting(null);
        }}
      />
    </View>
  );
}

/** Writes the reader's own comment on a passage; `selected` is null while closed. */
function CommentModal({
  selected,
  theme,
  onClose,
  onSave,
}: {
  selected: string | null;
  theme: Theme;
  onClose: () => void;
  onSave: (comment: string) => Promise<void>;
}) {
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (selected !== null) setComment("");
  }, [selected]);
  const styles = useMemo(() => modalStyles(theme), [theme]);
  const save = async () => {
    if (!comment.trim()) return;
    setSaving(true);
    try {
      await onSave(comment.trim());
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title="주석" open={selected !== null} onOpenChange={(open) => !open && onClose()}>
      <Modal.Content>
        <Text style={styles.muted} numberOfLines={3}>
          선택: {selected}
        </Text>
        <TextInput
          autoFocus
          multiline
          value={comment}
          onChangeText={setComment}
          placeholder="이 부분에 대한 내 생각이나 입장"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={[styles.input, { minHeight: 100, textAlignVertical: "top" }]}
        />
        <View style={styles.buttons}>
          <Pressable accessibilityRole="button" onPress={onClose}>
            <Text style={styles.secondary}>취소</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={!comment.trim() || saving}
            onPress={save}
            style={styles.primary}
          >
            <Text style={styles.primaryLabel}>{saving ? "저장 중…" : "주석 달기"}</Text>
          </Pressable>
        </View>
      </Modal.Content>
    </Modal>
  );
}
