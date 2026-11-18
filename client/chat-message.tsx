import { type PluginTimelineItemProps, useAgent, useWorkspace } from "@getpaseo/plugin/client";
import { copyText, Markdown, useToast } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";
import { chatMarks, copyComments } from "../shared/chat";
import { keptLength } from "../shared/markdown";
import { type MessageSelection, useChatController } from "./chat-controller";
import { FootnoteTooltip, QuestionModal } from "./doc-ask-panel";
import { focusComposer } from "./host";
import { useResolvedMarkdown } from "./links";
import { SelectionComposer, useSelectionDraft } from "./selection-composer";
import {
  chatViewport,
  decoratePreview,
  elementSize,
  type FootnoteHover,
  type PreviewDecorations,
  setSendDiscColors,
  watchShown,
} from "./web";

function formatTime(date: Date): string {
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? time : `${date.toLocaleDateString("ko-KR", { month: "short", day: "numeric" })} ${time}`;
}

/** The timeline item that replaces a completed assistant message. */
export const CHAT_MESSAGE_KIND = "doc-ask-assistant";
export const chatMessageSchema = z.object({ text: z.string(), key: z.string() });

/**
 * A completed assistant message drawn with Paseo's Markdown, plus footnotes: AI explanations as
 * yellow passages with superscript numbers, the reader's instructions as pink passages without
 * one. Hovering either shows it; clicking opens it in the side panel. Finishing a selection opens the
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
  // File links point at the files they mean: as written from the agent's cwd, then under the
  // workspace root, then by file name. The link text stays the same, so the marks still line up.
  const cwd = useAgent(agentId, (agent) => agent.cwd) ?? "";
  const workspaceId = useAgent(agentId, (agent) => agent.workspaceId);
  const directory = useWorkspace(workspaceId ?? "", (workspace) => workspace?.directory ?? null);
  const root = directory || cwd;
  const linkedBody = useResolvedMarkdown(body, [cwd || root, root], root) ?? body;
  const comments = useMemo(() => copyComments(text, key, notes), [key, notes, text]);
  const content = useRef<View>(null);
  const decorations = useRef<PreviewDecorations | null>(null);
  const [question, setQuestion] = useState<MessageSelection | null>(null);
  const tempTarget = useMemo(() => ({ file: `agent:${agentId}`, scope: key }), [agentId, key]);
  const { draft, close, focused, typed } = useSelectionDraft(content, tempTarget);

  // Footnote tooltip; it stays open briefly after the pointer leaves the passage so the pointer
  // can move onto it.
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
  const hoveredNote = hover ? notes.find((note) => note.number === hover.number) : undefined;

  useEffect(() => {
    decorations.current = decoratePreview(content.current, content.current, onHover, (number) =>
      controller.openNoteByNumber(number),
    );
    return () => {
      decorations.current?.dispose();
      decorations.current = null;
    };
  }, [controller, onHover]);
  // Opening the agent's tab shows its rows: the side panel then follows this conversation.
  useEffect(() => {
    let shown = false;
    const stop = watchShown(content.current, (next) => {
      shown = next;
      controller.rowShown(next);
    });
    return () => {
      stop();
      if (shown) controller.rowShown(false);
    };
  }, [controller]);
  useEffect(() => {
    decorations.current?.setMarks(marks);
  }, [marks]);
  useEffect(() => controller.noteAnswer(key, text), [controller, key, text]);
  // The composer's send disc is drawn outside React; it takes the theme from here.
  useEffect(
    () => setSendDiscColors(theme.colors.accent, theme.colors.accentForeground),
    [theme.colors.accent, theme.colors.accentForeground],
  );
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
  // Room for the tooltip in the visible part of the chat, not just this row.
  const viewport = hover ? chatViewport(content.current) : null;
  const room =
    hover && viewport
      ? {
          above: viewport.top + hover.height - hover.bottom,
          below: viewport.height - viewport.top - hover.top,
        }
      : undefined;

  return (
    // The tooltip sits outside `content` so its text is not searched, selected or decorated.
    <View>
      <View ref={content}>
        <Markdown>{linkedBody}</Markdown>
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
            typed={typed}
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
              // Next comes the message the instruction goes out with: focus the composer (as Ctrl+L),
              // once the selection box has closed.
              setTimeout(() => focusComposer(agentId), 0);
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
      {hover && hoveredNote ? (
        <FootnoteTooltip
          hover={hover}
          note={hoveredNote}
          theme={theme}
          room={room}
          onOpen={() => {
            controller.openNote(hoveredNote.label);
            overTip.current = false;
            setHover(null);
          }}
          onHoverChange={(over) => {
            overTip.current = over;
            if (!over) setHover(null);
          }}
        />
      ) : null}
    </View>
  );
}
