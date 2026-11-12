import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Markdown } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { NoteDetail } from "./doc-ask-panel";
import { useNotes } from "./notes-store";

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
      section: { gap: 10 },
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
          <Text style={styles.muted}>문서 질문 패널로 연 문서가 없습니다.</Text>
        </View>
      </View>
    );
  }

  const { message, actions } = notes;
  const openNote = message?.note === undefined ? undefined : notes.notes.find((n) => n.label === message.note);
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.document} numberOfLines={1}>
        {notes.name}
      </Text>
      {message ? (
        <NoteDetail
          message={message}
          theme={theme}
          note={openNote}
          onAsk={actions.ask}
          onToggleBookmark={actions.toggleBookmark}
          onEditMemo={actions.editMemo}
          onClose={actions.closeMessage}
        />
      ) : null}
      <View style={styles.divider} />
      <View style={styles.section}>
        <Text style={styles.heading}>각주 {notes.notes.length}</Text>
        {notes.notes.length === 0 ? (
          <Text style={styles.muted}>아직 각주가 없습니다. 문서에서 텍스트를 선택해 설명이나 질문을 요청하세요.</Text>
        ) : (
          notes.notes.map((note) => (
            <Pressable
              key={note.label}
              accessibilityRole="button"
              accessibilityLabel={`각주 ${note.number}로 이동`}
              style={[styles.row, note.label === message?.note ? styles.rowActive : null]}
              onPress={() => actions.openNote(note.label)}
            >
              <Text style={styles.number}>
                {note.meta.bookmark ? "★" : ""}
                {note.number}.
              </Text>
              <View style={styles.body}>
                <Markdown>{note.content.split("\n")[0] ?? ""}</Markdown>
                {note.meta.memo ? (
                  <Text style={styles.memo} numberOfLines={2}>
                    메모: {note.meta.memo}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          ))
        )}
      </View>
    </ScrollView>
  );
}
