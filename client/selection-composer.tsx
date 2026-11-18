import { copyText, TextInput, useToast } from "@getpaseo/plugin/client/ui";
import { type MutableRefObject, type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { AskMode } from "../shared/explain";
import { keptLength } from "../shared/markdown";
import { IconButton } from "./controls";
import type { Theme } from "./doc-ask-panel";
import { newTempNoteId, useTempNotes } from "./temp-notes";
import { ASK_ACTIONS, holdHighlight, keepSelectionOnPress, paintTempNotes, type TempPainter, watchSelection } from "./web";

/**
 * The box that opens where a selection ends, shared by documents and agent answers: a focused
 * text field (Enter asks the typed text as a question or, when empty, asks for 설명; Ctrl+Enter
 * saves it as the reader's comment, even empty; Ctrl+C when empty copies the selection;
 * Shift+Enter breaks the line; Esc cancels) and icon buttons: 설명 and 시각화, which use the typed
 * text as the request when there is one, 질문, and saving the typed text as a comment.
 */

/** Wide enough for the key hint on one line next to the buttons. */
const BAR_WIDTH = 480;
const LINE_HEIGHT = 20;
const MAX_INPUT_HEIGHT = 160;
/** Tooltips of the box's buttons, with what the typed text does and the matching key. */
const COMPOSER_TIPS: Record<AskMode, string> = {
  term: "설명: 선택한 부분을 쉽게 설명. 입력한 내용은 요청사항으로 쓴다 (입력이 비었을 때 Enter)",
  visual: "시각화: 표, 다이어그램, 그림으로 설명. 입력한 내용은 요청사항으로 쓴다",
  question: "질문: 입력한 내용을 질문으로 보낸다 (입력이 있을 때 Enter)",
};

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
  /** Text to start with: what a reopened 임시 각주 held. */
  initial?: string;
  /** The 임시 각주 this box was reopened from. */
  tempId?: string;
  /** The instruction this box edits; closing it unsaved leaves the instruction as it was. */
  editLabel?: string;
}

/** Where 임시 각주 of a view are kept: `file` names the document or agent, `scope` the message. */
export interface TempNoteTarget {
  file: string | null;
  scope: string;
}

/**
 * Follows selections inside `container`. Typing or selecting inside the box does not replace
 * the draft it belongs to. A box closed without being sent (Esc, a click elsewhere, a new
 * selection) keeps what was typed as a 임시 각주 of `temp`, painted on its passage; clicking it
 * reopens the box with that text.
 */
export function useSelectionDraft(
  container: RefObject<View | null>,
  temp?: TempNoteTarget,
): {
  draft: SelectionDraft | null;
  /** Closes the box; `submitted` when its text was sent, which consumes a reopened 임시 각주. */
  close: (submitted?: boolean) => void;
  focused: MutableRefObject<boolean>;
  /** What is typed in the open box, kept by the box. */
  typed: MutableRefObject<string>;
  /** Opens the box on `selection`, such as an instruction to edit. */
  open: (selection: Omit<SelectionDraft, "id">) => void;
} {
  const [draft, setDraft] = useState<SelectionDraft | null>(null);
  const focused = useRef(false);
  const count = useRef(0);
  const typed = useRef("");
  const open = useRef<SelectionDraft | null>(null);
  const tempNotes = useTempNotes(temp?.file ?? null, temp?.scope ?? "");
  const tempRef = useRef(tempNotes);
  tempRef.current = tempNotes;

  const replace = useCallback((next: SelectionDraft | null, submitted = false) => {
    const previous = open.current;
    if (previous && !previous.editLabel) {
      const store = tempRef.current;
      if (submitted) {
        if (previous.tempId) store.drop(previous.tempId);
      } else {
        store.keep({
          id: previous.tempId ?? newTempNoteId(),
          text: previous.text,
          hint: keptLength(previous.prefix),
          input: typed.current,
        });
      }
    }
    open.current = next;
    typed.current = next?.initial ?? "";
    if (!next) focused.current = false;
    setDraft(next);
  }, []);

  useEffect(
    () =>
      watchSelection(container.current, (selection) => {
        if (focused.current) return;
        if (!selection && !open.current) return;
        replace(selection ? { id: ++count.current, ...selection } : null);
      }),
    [container, replace],
  );
  const painter = useRef<TempPainter | null>(null);
  useEffect(() => {
    painter.current = paintTempNotes(container.current, (tempId, selection) => {
      const note = tempRef.current.find(tempId);
      if (note) replace({ id: ++count.current, ...selection, initial: note.input, tempId });
    });
    return () => {
      painter.current?.dispose();
      painter.current = null;
    };
  }, [container, replace]);
  useEffect(() => {
    painter.current?.set(tempNotes.notes);
  }, [tempNotes.notes]);
  // Leaving the view keeps what was typed too.
  useEffect(() => () => replace(null), [replace]);
  useEffect(() => (draft ? holdHighlight(draft.range) : undefined), [draft]);
  const close = useCallback((submitted?: boolean) => replace(null, submitted === true), [replace]);
  const openDraft = useCallback(
    (selection: Omit<SelectionDraft, "id">) => replace({ id: ++count.current, ...selection }),
    [replace],
  );
  return { draft, close, focused, typed, open: openDraft };
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
  typed,
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
  /** Follows the typed text, so closing the box can keep it as a 임시 각주. */
  typed: MutableRefObject<string>;
  theme: Theme;
  containerWidth: number;
  containerHeight: number;
  /** What a saved comment is called: "주석" on documents, "지시" on agent answers. */
  commentLabel?: string;
  /** Saves the typed text as a comment; resolves true when saved. Absent where there are no comments. */
  onComment?: (text: string) => Promise<boolean>;
  /** Asks the AI; `text` is the typed request or question, if any. */
  onAsk: (mode: AskMode, text: string | undefined) => void;
  /** Closes the box; `submitted` once its text was sent. */
  onClose: (submitted?: boolean) => void;
}) {
  const bar = useRef<View>(null);
  const toast = useToast();
  const [text, setText] = useState(draft.initial ?? "");
  const [saving, setSaving] = useState(false);
  const [height, setHeight] = useState(0);
  useEffect(() => {
    setText(draft.initial ?? "");
  }, [draft.id, draft.initial]);
  const edit = (next: string) => {
    typed.current = next;
    setText(next);
  };
  // Clearing the text before closing drops the 임시 각주.
  const removeTemp = () => {
    edit("");
    onClose();
  };
  // Pressing a button must not blur the text field first.
  useEffect(() => keepSelectionOnPress(bar.current), [draft.id]);

  // An empty comment is allowed: it only points the agent at the passage.
  const save = async () => {
    const comment = text.trim();
    if (saving || !onComment) return;
    setSaving(true);
    try {
      if (await onComment(comment)) onClose(true);
    } finally {
      setSaving(false);
    }
  };

  const ask = (mode: AskMode) => {
    onAsk(mode, text.trim() || undefined);
    onClose(true);
  };

  const copySelection = async () => {
    try {
      await copyText(draft.text);
      // The box and the selection stay, so the passage can still be asked about.
      toast.show("선택한 부분을 복사했습니다.", { variant: "success" });
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
      if (mod) void save();
      else if (text.trim()) ask("question");
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
        onChangeText={edit}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
        }}
        onKeyPress={(event) => onKeyPress(event as unknown as KeyEvent)}
        placeholder={draft.editLabel ? `${commentLabel} 수정` : "내용 입력"}
        placeholderTextColor={theme.colors.foregroundMuted}
        accessibilityLabel={`${commentLabel}, 또는 설명 요청이나 질문 내용`}
        style={[styles.input, { height: inputHeight }]}
      />
      <View style={styles.row}>
        {ASK_ACTIONS.map((action) => (
          <IconButton
            key={action.mode}
            icon={action.icon}
            label={COMPOSER_TIPS[action.mode]}
            theme={theme}
            align="left"
            filled
            onPress={() => ask(action.mode)}
          />
        ))}
        {onComment ? (
          <IconButton
            icon="PenLine"
            label={`${commentLabel}: 입력한 내용을 이 구절에 남긴다. 비어 있으면 구절만 남긴다. AI에게 묻지 않는다 (Ctrl+Enter)`}
            theme={theme}
            align="left"
            filled
            onPress={() => void save()}
          />
        ) : null}
        {draft.tempId ? (
          <IconButton
            icon="Trash2"
            label="임시 각주 삭제: 입력해 둔 내용을 지우고 닫는다"
            theme={theme}
            align="left"
            onPress={removeTemp}
          />
        ) : null}
        <Text style={styles.hint} numberOfLines={1}>
          {saving ? "저장 중…" : `Enter 질문(비면 설명)${onComment ? ` · Ctrl+Enter ${commentLabel}${draft.editLabel ? " 저장" : ""}` : ""} · Shift+Enter 줄바꿈 · Esc 취소`}
        </Text>
      </View>
    </View>
  );
}
