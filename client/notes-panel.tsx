import { type PluginWorkspacePanelProps, useRpc, useSettings, useWorkspace } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { IconButton, type PressState } from "./controls";
import { NoteDetail, PromptModal } from "./doc-ask-panel";
import { openBookmarksPanel } from "./host";
import { NoteTitle } from "./note-title";
import { type NotesSnapshot, useNotes } from "./notes-store";
import { promptSettings, resetRpc } from "../shared/explain";
import { directoryOf } from "../shared/links";
import { type Footnote, plainLine, splitTitle } from "../shared/markdown";

/** Height of the footnote list: about eight one-line rows. */
const LIST_HEIGHT = 240;

/**
 * The side "주석" panel: the open footnote of the document viewer last used, and that document's
 * footnote list. Selecting a footnote in the list jumps to it in the document.
 */
export function NotesPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const notes = useNotes();
  const pad = layout.compact ? 12 : 14;
  // Opening a note from the list puts the cursor in its follow-up field.
  const [focusRequest, setFocusRequest] = useState(0);
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
        flexShrink: 0,
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
      detailScroll: { flex: 1, minHeight: 0 },
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
        onPress={() => {
          if (active) return actions.closeMessage();
          actions.openNote(note.label);
          setFocusRequest((n) => n + 1);
        }}
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
            <>
              <ListTitle title={title} theme={theme} />
              {shownPassage(note, title) ? (
                // The dragged passage, lined up with the title text after its kind icon.
                <Text style={[styles.memo, { marginLeft: 20 }]} numberOfLines={1} ellipsizeMode="tail">
                  {shownPassage(note, title)}
                </Text>
              ) : null}
            </>
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

  // The header and the list stay put; only the open note below them scrolls.
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Icon name={chat ? "MessageSquare" : "FileText"} size={14} color={theme.colors.foregroundMuted} />
        <Text style={styles.document} numberOfLines={1}>
          {notes.name}
        </Text>
        <PanelTools workspaceId={workspaceId} theme={theme} commit={notes.commit} />
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
        <ScrollView style={styles.detailScroll} contentContainerStyle={styles.detail}>
          <NoteDetail
            message={message}
            theme={theme}
            note={openNote}
            onAsk={actions.ask}
            onToggleBookmark={actions.toggleBookmark}
            onEditMemo={actions.editMemo}
            onDelete={actions.deleteNote}
            imageBases={imageBases}
            focusRequest={focusRequest}
          />
        </ScrollView>
      ) : null}
      {Dialogs ? <Dialogs theme={theme} /> : null}
    </View>
  );
}

/** A list row's title: the kind's icon and the subject, or the line as written. */
function ListTitle({ title, theme }: { title: string; theme: PluginWorkspacePanelProps["theme"] }) {
  const titled = splitTitle(title);
  if (!titled) {
    return (
      <Text style={{ color: theme.colors.foreground, fontSize: 13 }} numberOfLines={2}>
        {title.replace(/\*\*/g, "")}
      </Text>
    );
  }
  return <NoteTitle kind={titled.kind} subject={titled.subject} theme={theme} bold={false} lines={2} />;
}

/**
 * The side panel's header tools: the workspace's bookmarks, 각주 커밋 for the open document,
 * the prompt sent with every question (marked while one is set), and a fresh explainer session.
 */
function PanelTools({
  workspaceId,
  theme,
  commit,
}: {
  workspaceId: string;
  theme: PluginWorkspacePanelProps["theme"];
  commit: NotesSnapshot["commit"];
}) {
  const toast = useToast();
  const prompt = useSettings(promptSettings);
  const hasPrompt = prompt.status === "ready" && prompt.values.extraPrompt.trim() !== "";
  const [promptOpen, setPromptOpen] = useState(false);
  const reset = useRpc(resetRpc);
  const [resetting, setResetting] = useState(false);
  const resetContext = async () => {
    if (resetting) return;
    setResetting(true);
    try {
      // Runs after any question in flight; the next question starts a fresh session.
      await reset({ workspaceId });
      toast.show("컨텍스트를 지웠습니다. 다음 요청부터 새 세션으로 시작합니다.", { variant: "success" });
    } catch (cause) {
      toast.error(`컨텍스트를 지우지 못했습니다: ${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      setResetting(false);
    }
  };
  return (
    <>
      <IconButton icon="Bookmark" label="워크스페이스 북마크 목록" theme={theme} onPress={() => openBookmarksPanel(workspaceId)} />
      {commit ? (
        <IconButton
          icon="GitCommitHorizontal"
          label={commit.busy ? "각주 커밋 중…" : "이 문서의 각주 변경만 git 커밋"}
          theme={theme}
          color={commit.busy ? theme.colors.accent : undefined}
          onPress={() => {
            if (!commit.busy) commit.run();
          }}
        />
      ) : null}
      <View>
        <IconButton
          icon="ScrollText"
          label={hasPrompt ? "함께 보낼 프롬프트 (설정됨)" : "함께 보낼 프롬프트 설정"}
          theme={theme}
          color={hasPrompt ? theme.colors.foreground : undefined}
          onPress={() => setPromptOpen(true)}
        />
        {hasPrompt ? (
          <View
            pointerEvents="none"
            style={{
              position: "absolute",
              top: 4,
              right: 4,
              width: 6,
              height: 6,
              borderRadius: 3,
              backgroundColor: theme.colors.accent,
            }}
          />
        ) : null}
      </View>
      <IconButton
        icon="Eraser"
        label={resetting ? "컨텍스트 지우는 중…" : "해설 에이전트 컨텍스트 지우기"}
        theme={theme}
        color={resetting ? theme.colors.accent : undefined}
        onPress={() => void resetContext()}
      />
      <PromptModal open={promptOpen} theme={theme} onClose={() => setPromptOpen(false)} />
    </>
  );
}

/**
 * The dragged passage a list row shows under its title, or null when the title already is that
 * passage, as for a plain 설명: a question is titled by the question instead. A long passage is
 * cut short in the title, so its start is what must match.
 */
function shownPassage(note: Footnote, title: string): string | null {
  const passage = note.passage;
  if (!passage) return null;
  const subject = plainLine(splitTitle(title)?.subject ?? "").replace(/…$/, "");
  return subject && plainLine(passage).startsWith(subject) ? null : passage;
}
