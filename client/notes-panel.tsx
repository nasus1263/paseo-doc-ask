import { type PluginWorkspacePanelProps, useWorkspace } from "@getpaseo/plugin/client";
import { Icon, Markdown } from "@getpaseo/plugin/client/ui";
import { useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { PressState } from "./controls";
import { NoteDetail } from "./doc-ask-panel";
import { useNotes } from "./notes-store";
import { directoryOf } from "../shared/links";
import type { Footnote } from "../shared/markdown";

/** Height of the footnote list: about eight one-line rows. */
const LIST_HEIGHT = 240;

/**
 * The side "주석" panel: the open footnote of the document viewer last used, and that document's
 * footnote list. Selecting a footnote in the list jumps to it in the document.
 */
export function NotesPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const notes = useNotes();
  const pad = layout.compact ? 12 : 14;
  const root = useWorkspace(workspaceId, (workspace) => workspace.directory);
  // A relative image path is read against the document's folder, then the workspace's.
  const documentPath = notes?.path.startsWith("agent:") ? null : (notes?.path ?? null);
  const imageBases = useMemo(
    () => [...(documentPath ? [directoryOf(documentPath)] : []), ...(root ? [root] : [])],
    [documentPath, root],
  );
  const styles = useMemo(
    () => ({
      screen: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
      empty: { padding: pad, gap: 8 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
      /** A header bar like Paseo's panel headers: the document name over a bottom border. */
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingHorizontal: pad,
        height: 36,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      document: { flex: 1, minWidth: 0, color: theme.colors.foreground, fontSize: 13 },
      /** The footnote list keeps one height, scrolling inside, so the detail below stays put. */
      list: {
        height: LIST_HEIGHT,
        flexGrow: 0,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      listContent: { paddingVertical: 4 },
      section: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingHorizontal: pad,
        paddingTop: 8,
        paddingBottom: 4,
      },
      sectionLabel: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "500" as const },
      sectionCount: { color: theme.colors.foregroundMuted, fontSize: 12, opacity: 0.7 },
      listEmpty: { color: theme.colors.foregroundMuted, fontSize: 13, paddingHorizontal: pad, paddingVertical: 6 },
      text: { color: theme.colors.foreground, fontSize: 13 },
      row: {
        flexDirection: "row" as const,
        alignItems: "flex-start" as const,
        gap: 8,
        paddingHorizontal: pad,
        paddingVertical: 5,
      },
      number: {
        color: theme.colors.foregroundMuted,
        fontSize: 12,
        minWidth: 18,
        textAlign: "right" as const,
        paddingTop: 2,
      },
      body: { flex: 1, minWidth: 0, gap: 2 },
      memo: { color: theme.colors.foregroundMuted, fontSize: 12 },
      detail: { padding: pad },
    }),
    [theme, pad],
  );

  if (!notes || notes.workspaceId !== workspaceId) {
    return (
      <View style={styles.screen}>
        <View style={styles.empty}>
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
    const active = note.label === message?.note;
    return (
      <Pressable
        key={note.label}
        accessibilityRole="button"
        accessibilityLabel={instruction ? "지시로 이동" : `각주 ${note.number}로 이동`}
        style={({ pressed, hovered }: PressState) => [
          styles.row,
          {
            backgroundColor:
              active || pressed ? theme.colors.surface2 : hovered ? theme.colors.surface1 : "transparent",
          },
        ]}
        // Clicking the open item again closes it.
        onPress={() => (note.label === message?.note ? actions.closeMessage() : actions.openNote(note.label))}
      >
        <Text style={styles.number}>{instruction ? "•" : note.number}</Text>
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
        {note.meta.bookmark ? <Icon name="Star" size={13} color={theme.colors.statusWarning} /> : null}
      </Pressable>
    );
  };

  return (
    <ScrollView style={styles.screen}>
      <View style={styles.header}>
        <Icon name={chat ? "MessageSquare" : "FileText"} size={14} color={theme.colors.foregroundMuted} />
        <Text style={styles.document} numberOfLines={1}>
          {notes.name}
        </Text>
      </View>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent} nestedScrollEnabled>
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>각주</Text>
          <Text style={styles.sectionCount}>{footnotes.length}개</Text>
        </View>
        {footnotes.length === 0 ? (
          <Text style={styles.listEmpty}>아직 각주가 없습니다. 텍스트를 선택해 설명이나 질문을 요청하세요.</Text>
        ) : (
          footnotes.map(row)
        )}
        {own.length > 0 ? (
          <>
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>{ownLabel}</Text>
              <Text style={styles.sectionCount}>{own.length}개</Text>
            </View>
            {own.map(row)}
          </>
        ) : null}
      </ScrollView>
      {message ? (
        <View style={styles.detail}>
          <NoteDetail
            message={message}
            theme={theme}
            note={openNote}
            onAsk={actions.ask}
            onToggleBookmark={actions.toggleBookmark}
            onEditMemo={actions.editMemo}
            onDelete={actions.deleteNote}
            imageBases={imageBases}
          />
        </View>
      ) : null}
      {Dialogs ? <Dialogs theme={theme} /> : null}
    </ScrollView>
  );
}
