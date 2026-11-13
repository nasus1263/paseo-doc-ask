import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Markdown } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { NoteDetail } from "./doc-ask-panel";
import { useNotes } from "./notes-store";
import type { Footnote } from "../shared/markdown";

/** Height of the footnote list: about eight one-line rows. */
const LIST_HEIGHT = 240;

/**
 * The side "주석" panel: the open footnote of the document viewer last used, and that document's
 * footnote list. Selecting a footnote in the list jumps to it in the document.
 */
export function NotesPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const notes = useNotes();
  const styles = useMemo(
    () => ({
      screen: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
      content: { padding: layout.compact ? 12 : 16, gap: 16 },
      muted: { color: theme.colors.foregroundMuted },
      document: { color: theme.colors.foregroundMuted, fontSize: 12 },
      /** The footnote list keeps one height, scrolling inside, so the detail below stays put. */
      list: {
        height: LIST_HEIGHT,
        flexGrow: 0,
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
      },
      listContent: { padding: 8, gap: 4 },
      ownHeading: { marginTop: 8 },
      text: { color: theme.colors.foreground },
      divider: { height: 1, backgroundColor: theme.colors.border },
      heading: { color: theme.colors.foregroundMuted, fontWeight: "600" as const },
      row: { flexDirection: "row" as const, gap: 8, paddingVertical: 4 },
      rowActive: { backgroundColor: theme.colors.surface1, borderRadius: 6 },
      number: { color: theme.colors.foregroundMuted, minWidth: 28 },
      body: { flex: 1, minWidth: 0, gap: 2 },
      memo: { color: theme.colors.foregroundMuted, fontSize: 12 },
    }),
    [theme, layout.compact],
  );

  if (!notes || notes.workspaceId !== workspaceId) {
    return (
      <View style={styles.screen}>
        <View style={styles.content}>
          <Text style={styles.muted}>
            문서 질문 패널로 연 문서나, AI 답변에 각주를 단 대화가 여기에 표시됩니다.
          </Text>
        </View>
      </View>
    );
  }

  const { message, actions, Dialogs } = notes;
  const openNote = message?.note === undefined ? undefined : notes.notes.find((n) => n.label === message.note);
  // The reader's own notes are listed apart: instructions on an agent answer, comments on a document.
  const chat = notes.path.startsWith("agent:");
  const ownLabel = chat ? "지시" : "주석";
  const footnotes = notes.notes.filter((note) => !note.meta.comment);
  const own = notes.notes.filter((note) => note.meta.comment);

  const row = (note: Footnote) => {
    const [title = "", ...rest] = note.content.split("\n");
    // An instruction shows no number in the answer: list it by its text, then its passage.
    const instruction = chat && note.meta.comment;
    return (
      <Pressable
        key={note.label}
        accessibilityRole="button"
        accessibilityLabel={instruction ? "지시로 이동" : `각주 ${note.number}로 이동`}
        style={[styles.row, note.label === message?.note ? styles.rowActive : null]}
        onPress={() => actions.openNote(note.label)}
      >
        <Text style={styles.number}>
          {note.meta.bookmark ? "★" : ""}
          {instruction ? "•" : `${note.number}.`}
        </Text>
        <View style={styles.body}>
          {instruction ? (
            <>
              <Text style={styles.text} numberOfLines={2}>
                {rest.join(" ").trim()}
              </Text>
              <Text style={styles.memo} numberOfLines={1}>
                “{note.meta.anchor?.quote ?? title.replace(/\*\*/g, "")}”
              </Text>
            </>
          ) : (
            <Markdown>{title}</Markdown>
          )}
          {note.meta.memo ? (
            <Text style={styles.memo} numberOfLines={2}>
              메모: {note.meta.memo}
            </Text>
          ) : null}
        </View>
      </Pressable>
    );
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.document} numberOfLines={1}>
        {notes.name}
      </Text>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent} nestedScrollEnabled>
        <Text style={styles.heading}>각주 {footnotes.length}</Text>
        {footnotes.length === 0 ? (
          <Text style={styles.muted}>아직 각주가 없습니다. 텍스트를 선택해 설명이나 질문을 요청하세요.</Text>
        ) : (
          footnotes.map(row)
        )}
        {own.length > 0 ? (
          <>
            <Text style={[styles.heading, styles.ownHeading]}>
              {ownLabel} {own.length}
            </Text>
            {own.map(row)}
          </>
        ) : null}
      </ScrollView>
      {message ? (
        <>
          <View style={styles.divider} />
          <NoteDetail
            message={message}
            theme={theme}
            note={openNote}
            onAsk={actions.ask}
            onToggleBookmark={actions.toggleBookmark}
            onEditMemo={actions.editMemo}
            onDelete={actions.deleteNote}
            onClose={actions.closeMessage}
          />
        </>
      ) : null}
      {Dialogs ? <Dialogs theme={theme} /> : null}
    </ScrollView>
  );
}
