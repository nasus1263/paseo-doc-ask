import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { Markdown, useToast } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { setChatAnnotations, useChatAnnotations } from "./chat-toggle";
import { NoteDetail } from "./doc-ask-panel";
import { useNotes } from "./notes-store";

/**
 * The side "주석" panel: the open footnote of the document viewer last used, and that document's
 * footnote list. Selecting a footnote in the list jumps to it in the document.
 */
/** The "대화 주석" switch: on, completed assistant answers can carry footnotes but lose Fork. */
function ChatToggle({ theme }: { theme: PluginWorkspacePanelProps["theme"] }) {
  const on = useChatAnnotations();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const toggle = async () => {
    setSaving(true);
    try {
      await setChatAnnotations(!on);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      disabled={saving}
      onPress={toggle}
      style={{ gap: 2 }}
    >
      <Text style={{ color: on ? theme.colors.accent : theme.colors.foregroundMuted, fontWeight: "600" }}>
        대화 주석 {on ? "켜짐" : "꺼짐"}
      </Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        {on
          ? "완료된 AI 답변에 각주를 달 수 있습니다. 이 동안 답변의 포크·읽어주기는 사라집니다."
          : "켜면 AI 답변에 각주를 달 수 있습니다. 꺼져 있으면 Paseo 기본 답변(포크 포함)이 보입니다."}
      </Text>
    </Pressable>
  );
}

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
          <ChatToggle theme={theme} />
          <View style={styles.divider} />
          <Text style={styles.muted}>
            문서 질문 패널로 연 문서나, AI 답변에 각주를 단 대화가 여기에 표시됩니다.
          </Text>
        </View>
      </View>
    );
  }

  const { message, actions, Dialogs } = notes;
  const openNote = message?.note === undefined ? undefined : notes.notes.find((n) => n.label === message.note);
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <ChatToggle theme={theme} />
      <View style={styles.divider} />
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
          onDelete={actions.deleteNote}
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
      {Dialogs ? <Dialogs theme={theme} /> : null}
    </ScrollView>
  );
}
