import type { RpcOutput } from "@getpaseo/plugin";
import { type PluginWorkspacePanelProps, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { Icon, Markdown } from "@getpaseo/plugin/client/ui";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { bookmarksRpc } from "../shared/explain";
import { splitTitle } from "../shared/markdown";
import { IconButton, type PressState } from "./controls";
import { requestJump } from "./jumps";
import { useNotes } from "./notes-store";
import { onClickCapture } from "./web";

type BookmarkItem = RpcOutput<typeof bookmarksRpc>["items"][number];
type Order = "asc" | "desc";

/** Bookmarks loaded at a time. */
const PAGE_SIZE = 20;

const KIND_ICON: Record<string, string> = { 설명: "Lightbulb", 질문: "CircleHelp", 주석: "PenLine", 지시: "PenLine" };

/**
 * The side "북마크" panel: the bookmarked footnotes of every document in the workspace, newest
 * or oldest first, loaded a page at a time. Choosing one opens its document and shows the
 * footnote there.
 */
export function BookmarksPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const list = useRpc(bookmarksRpc);
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const [order, setOrder] = useState<Order>("desc");
  const [state, setState] = useState<
    { items: BookmarkItem[]; total: number; loading: boolean; error: string | null }
  >({ items: [], total: 0, loading: true, error: null });
  /** Discards pages of an earlier order or reload that arrive late. */
  const generation = useRef(0);

  const load = useCallback(
    async (offset: number) => {
      const mine = offset === 0 ? ++generation.current : generation.current;
      setState((current) => ({ ...current, loading: true, error: null, ...(offset === 0 ? { items: [] } : {}) }));
      try {
        const page = await list({ workspaceId, order, offset, limit: PAGE_SIZE });
        if (mine !== generation.current) return;
        setState((current) => ({
          items: offset === 0 ? page.items : [...current.items, ...page.items],
          total: page.total,
          loading: false,
          error: null,
        }));
      } catch (cause) {
        if (mine !== generation.current) return;
        setState((current) => ({ ...current, loading: false, error: cause instanceof Error ? cause.message : String(cause) }));
      }
    },
    [list, order, workspaceId],
  );
  useEffect(() => void load(0), [load]);

  // A bookmark added or removed in the open document reloads the list.
  const notes = useNotes();
  const bookmarked = notes && notes.workspaceId === workspaceId
    ? `${notes.path}|${notes.notes.filter((n) => n.meta.bookmark).map((n) => n.label).join(",")}`
    : null;
  const seen = useRef(bookmarked);
  useEffect(() => {
    if (seen.current === bookmarked) return;
    seen.current = bookmarked;
    void load(0);
  }, [bookmarked, load]);

  const pad = layout.compact ? 12 : 14;
  const styles = useMemo(
    () => ({
      screen: { flex: 1, minHeight: 0, backgroundColor: theme.colors.surface0 },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingLeft: pad,
        paddingRight: pad - 4,
        height: 36,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border,
      },
      title: { color: theme.colors.foreground, fontSize: 13 },
      count: { flex: 1, color: theme.colors.foregroundMuted, fontSize: 12 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13, padding: pad },
      danger: { color: theme.colors.statusDanger, fontSize: 13, padding: pad },
      row: { paddingHorizontal: pad, paddingVertical: 7, gap: 3 },
      line: { flexDirection: "row" as const, alignItems: "flex-start" as const, gap: 6 },
      kind: { paddingTop: 3 },
      link: { flex: 1, minWidth: 0 },
      meta: { color: theme.colors.foregroundMuted, fontSize: 12 },
      memo: { color: theme.colors.foregroundMuted, fontSize: 12 },
      more: { paddingHorizontal: pad, paddingVertical: 10, alignItems: "center" as const },
      moreLabel: { color: theme.colors.accent, fontSize: 13 },
    }),
    [theme, pad],
  );

  const relative = (path: string) => {
    const base = directory?.replace(/\\/g, "/").replace(/\/+$/, "");
    const normal = path.replace(/\\/g, "/");
    return base && normal.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? normal.slice(base.length + 1) : normal;
  };

  const { items, total, loading, error } = state;
  const remaining = total - items.length;
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Icon name="Bookmark" size={14} color={theme.colors.foregroundMuted} />
        <Text style={styles.title}>북마크</Text>
        <Text style={styles.count}>{total}개</Text>
        <IconButton
          icon={order === "desc" ? "ArrowDownWideNarrow" : "ArrowUpNarrowWide"}
          label={order === "desc" ? "최근 북마크부터 (누르면 오래된 것부터)" : "오래된 북마크부터 (누르면 최근 것부터)"}
          theme={theme}
          onPress={() => setOrder((current) => (current === "desc" ? "asc" : "desc"))}
        />
        <IconButton icon="RefreshCw" label="새로 고침" theme={theme} onPress={() => void load(0)} />
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingVertical: 4 }}>
        {items.map((item) => {
          const titled = splitTitle(`**${item.title}**`);
          return (
            <BookmarkRow
              key={`${item.documentPath}#${item.label}`}
              documentPath={item.documentPath}
              linkPath={relative(item.documentPath)}
              label={item.label}
              title={titled?.subject || item.title || `각주 ${item.label}`}
              style={styles.row}
            >
              {(link) => (
                <>
                  <View style={styles.line}>
                    <View style={styles.kind}>
                      <Icon name={KIND_ICON[titled?.kind ?? ""] ?? "Bookmark"} size={14} color={theme.colors.foregroundMuted} />
                    </View>
                    <View style={styles.link}>{link}</View>
                  </View>
                  <Text style={styles.meta} numberOfLines={1}>
                    {relative(item.documentPath)} · {formatTime(item.bookmarkedAt)}
                  </Text>
                  {item.memo ? (
                    <Text style={styles.memo} numberOfLines={2}>
                      메모: {item.memo}
                    </Text>
                  ) : null}
                </>
              )}
            </BookmarkRow>
          );
        })}
        {error ? <Text style={styles.danger}>목록을 불러오지 못했습니다: {error}</Text> : null}
        {!loading && !error && total === 0 ? (
          <Text style={styles.muted}>이 워크스페이스에 북마크한 각주가 없습니다. 주석 패널에서 각주의 ☆를 누르면 여기에 모입니다.</Text>
        ) : null}
        {loading ? <Text style={styles.muted}>불러오는 중…</Text> : null}
        {!loading && remaining > 0 ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => void load(items.length)}
            style={({ hovered }: PressState) => [styles.more, hovered ? { backgroundColor: theme.colors.surface1 } : null]}
          >
            <Text style={styles.moreLabel}>
              {Math.min(PAGE_SIZE, remaining)}개 더 불러오기 (남은 {remaining}개)
            </Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ko-KR", { year: "2-digit", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/**
 * A bookmark whose title is a Markdown file link, so Paseo opens its document in a tab; clicking
 * it first records the jump, which the document's panel takes to show the footnote.
 */
function BookmarkRow({
  documentPath,
  linkPath,
  label,
  title,
  style,
  children,
}: {
  documentPath: string;
  /** The document's path relative to the workspace root, as Paseo resolves link targets. */
  linkPath: string;
  label: string;
  title: string;
  style: object;
  children: (link: ReactNode) => ReactNode;
}) {
  const host = useRef<View>(null);
  useEffect(() => onClickCapture(host.current, () => requestJump(documentPath, label)), [documentPath, label]);
  // An absolute Windows path ("C:/…") can be taken for a URL scheme, so the link is relative.
  const text = title.replace(/[[\]\\]/g, (ch) => `\\${ch}`);
  const link = (
    <View ref={host}>
      <Markdown>{`[${text}](<${linkPath}>)`}</Markdown>
    </View>
  );
  return <View style={style}>{children(link)}</View>;
}
