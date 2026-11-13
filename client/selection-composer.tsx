import { copyText, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { type MutableRefObject, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { AskMode } from "../shared/explain";
import type { Theme } from "./doc-ask-panel";
import { holdHighlight, keepSelectionOnPress, watchSelection } from "./web";

/**
 * The box that opens where a selection ends, shared by documents and agent answers: a focused
 * text field (Enter saves it as the reader's comment or, when empty, asks for 설명; Ctrl+Enter
 * asks it as a question; Ctrl+C when empty copies the selection; Shift+Enter breaks the line;
 * Esc cancels) and 설명, which uses the typed text as the request when there is one.
 */

/** Wide enough for the key hint on one line next to 설명. */
const BAR_WIDTH = 480;
const LINE_HEIGHT = 20;
const MAX_INPUT_HEIGHT = 160;
/** How far below the pointer the box opens; mirrors `watchSelection`'s offset. */
const POINTER_GAP = 12;

/** A finished selection waiting for input. */
export interface SelectionDraft {
  id: number;
  text: string;
  /** Rendered text before the selection; `keptLength` turns it into a source-search hint. */
  prefix: string;
  top: number;
  left: number;
  /** The selected DOM range, kept highlighted while the box has focus. */
  range: unknown;
}

/**
 * Follows selections inside `container`. Typing or selecting inside the box does not replace
 * the draft it belongs to.
 */
export function useSelectionDraft(container: RefObject<View | null>): {
  draft: SelectionDraft | null;
  close: () => void;
  focused: MutableRefObject<boolean>;
} {
  const [draft, setDraft] = useState<SelectionDraft | null>(null);
  const focused = useRef(false);
  const count = useRef(0);
  useEffect(
    () =>
      watchSelection(container.current, (selection) => {
        if (focused.current) return;
        setDraft(selection ? { id: ++count.current, ...selection } : null);
      }),
    [container],
  );
  useEffect(() => (draft ? holdHighlight(draft.range) : undefined), [draft]);
  const close = useCallback(() => {
    focused.current = false;
    setDraft(null);
  }, []);
  return { draft, close, focused };
}

/** Key events from the text field; on web `nativeEvent` is the DOM keyboard event. */
interface KeyEvent {
  nativeEvent: {
    key: string;
    shiftKey?: boolean;
    ctrlKey?: boolean;
    metaKey?: boolean;
    isComposing?: boolean;
    keyCode?: number;
  };
  preventDefault(): void;
}

export function SelectionComposer({
  draft,
  focused,
  theme,
  containerWidth,
  containerHeight,
  commentLabel = "주석",
  onComment,
  onAsk,
  onClose,
}: {
  draft: SelectionDraft;
  focused: MutableRefObject<boolean>;
  theme: Theme;
  containerWidth: number;
  containerHeight: number;
  /** What a saved comment is called: "주석" on documents, "지시" on agent answers. */
  commentLabel?: string;
  /** Saves the typed text as a comment; resolves true when saved. */
  onComment: (text: string) => Promise<boolean>;
  /** Asks the AI; `text` is the typed request or question, if any. */
  onAsk: (mode: AskMode, text: string | undefined) => void;
  onClose: () => void;
}) {
  const bar = useRef<View>(null);
  const toast = useToast();
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    setText("");
  }, [draft.id]);
  // Pressing 설명 must not blur the text field first.
  useEffect(() => keepSelectionOnPress(bar.current), [draft.id]);

  const save = async () => {
    const comment = text.trim();
    if (!comment || saving) return;
    setSaving(true);
    try {
      if (await onComment(comment)) onClose();
    } finally {
      setSaving(false);
    }
  };

  const ask = (mode: AskMode) => {
    onAsk(mode, text.trim() || undefined);
    onClose();
  };

  const copySelection = async () => {
    try {
      await copyText(draft.text);
      toast.show("선택한 부분을 복사했습니다.", { variant: "success" });
      onClose();
    } catch {
      toast.error("복사하지 못했습니다.");
    }
  };

  const onKeyPress = (event: KeyEvent) => {
    const { key, shiftKey, ctrlKey, metaKey, isComposing, keyCode } = event.nativeEvent;
    const mod = ctrlKey || metaKey;
    // Enter while an IME is composing (Korean, Japanese, …) only finishes the character.
    if (key === "Enter" && !shiftKey && !isComposing && keyCode !== 229) {
      event.preventDefault();
      if (mod) ask("question");
      else if (text.trim()) void save();
      else ask("term");
    } else if (mod && key.toLowerCase() === "c" && !text) {
      // Nothing to copy in the empty field: copy the selected passage instead.
      event.preventDefault();
      void copySelection();
    } else if (key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  // Open below the pointer; when that would leave the container (a chat row clips its
  // content), open above it instead, whichever side has more room.
  const spaceBelow = containerHeight - draft.top;
  const pointer = draft.top - POINTER_GAP;
  const above = containerHeight > 0 && height > spaceBelow && pointer > spaceBelow;
  const top = above ? Math.max(0, pointer - 8 - height) : draft.top;
  const left = Math.max(0, Math.min(draft.left, containerWidth - BAR_WIDTH));

  const styles = useMemo(
    () => ({
      bar: {
        position: "absolute" as const,
        zIndex: 5,
        width: BAR_WIDTH,
        maxWidth: "100%" as const,
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
    }),
    [theme],
  );

  const inputHeight = Math.min(MAX_INPUT_HEIGHT, text.split("\n").length * LINE_HEIGHT + 14);
  return (
    <View
      ref={bar}
      style={[styles.bar, { top, left, opacity: height > 0 ? 1 : 0 }]}
      onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
    >
      <TextInput
        key={draft.id}
        autoFocus
        multiline
        value={text}
        editable={!saving}
        onChangeText={setText}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
        }}
        onKeyPress={(event) => onKeyPress(event as unknown as KeyEvent)}
        placeholder="내용 입력"
        placeholderTextColor={theme.colors.foregroundMuted}
        accessibilityLabel={`${commentLabel}, 또는 설명 요청이나 질문 내용`}
        style={[styles.input, { height: inputHeight }]}
      />
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="선택한 부분 설명"
          style={styles.button}
          onPress={() => ask("term")}
        >
          <Text style={styles.label}>설명</Text>
        </Pressable>
        <Text style={styles.hint} numberOfLines={1}>
          {saving ? "저장 중…" : `Enter ${commentLabel}(비면 설명) · Ctrl+Enter 질문 · Shift+Enter 줄바꿈 · Esc 취소`}
        </Text>
      </View>
    </View>
  );
}
