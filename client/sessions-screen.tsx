import type { PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { usePaseo } from "@getpaseo/plugin/client";
import { Icon, SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Pressable, ScrollView, Text, View } from "react-native";
import { EXPLAINER_LABEL } from "../shared/explain";
import { PermissionDialog } from "./permission-dialog";

export const SESSIONS_SCREEN_ID = "sessions";

type Session = { id: string; title: string; status: string; updatedAt: string };
type Group = { workspaceId: string; name: string; sessions: Session[] };

const STATUS: Record<string, string> = {
  idle: "대기",
  running: "답변 중",
  initializing: "시작 중",
  error: "오류",
  closed: "닫힘",
};

/** The explainers of every workspace, grouped by the workspace they serve. */
function useSessions() {
  const paseo = usePaseo();
  return useQuery({
    queryKey: ["doc-ask", "sessions"],
    refetchInterval: 5000,
    queryFn: async (): Promise<Group[]> => {
      const { entries } = await paseo.agents.list({ includeBackground: true, filter: { includeBackground: true } });
      const groups = new Map<string, Session[]>();
      for (const { agent } of entries) {
        const workspaceId = agent.labels?.[EXPLAINER_LABEL];
        if (!workspaceId || agent.archivedAt) continue;
        const list = groups.get(workspaceId) ?? [];
        list.push({ id: agent.id, title: agent.title ?? "문서 해설", status: agent.status, updatedAt: agent.updatedAt });
        groups.set(workspaceId, list);
      }
      return Promise.all(
        [...groups].map(async ([workspaceId, sessions]) => {
          const workspace = paseo.workspaces.ref(workspaceId);
          await workspace.refresh().catch(() => null);
          sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          return { workspaceId, name: workspace.name ?? workspace.directory ?? workspaceId, sessions };
        }),
      );
    },
  });
}

/** Lists the hidden explainer agents so the user can open one and read or continue its conversation. */
export function SessionsScreen({ theme, layout, navigation }: PluginScreenProps) {
  const { data, error, isLoading } = useSessions();
  const pad = layout.compact ? 16 : 24;
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  let body;
  if (isLoading) body = <Text style={muted}>불러오는 중…</Text>;
  else if (error) body = <Text style={muted}>세션을 불러오지 못했습니다: {String(error)}</Text>;
  else if (!data?.length) body = <Text style={muted}>아직 질문 세션이 없습니다. 문서에서 질문하면 만들어집니다.</Text>;
  else
    body = data.map((group) => (
      <View key={group.workspaceId} style={{ gap: 6 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{group.name}</Text>
        {group.sessions.map((session, index) => (
          <Pressable
            key={session.id}
            accessibilityRole="button"
            disabled={!navigation}
            onPress={() => navigation?.openAgent({ agentId: session.id })}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              padding: 12,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: theme.colors.border,
              backgroundColor: pressed ? theme.colors.surface2 : theme.colors.surface1,
            })}
          >
            <Icon name="MessageCircleQuestion" size={16} color={theme.colors.foregroundMuted} />
            <Text style={{ flex: 1, color: theme.colors.foreground, fontSize: 14 }}>
              {session.title} {index + 1}
            </Text>
            <Text style={muted}>{STATUS[session.status] ?? session.status}</Text>
          </Pressable>
        ))}
      </View>
    ));
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: pad, gap: 16 }}>
      {body}
      {navigation ? null : <Text style={muted}>이 Paseo 버전은 플러그인에서 에이전트를 열 수 없습니다.</Text>}
    </ScrollView>
  );
}

/** The sidebar button that opens the session list; it also hosts the permission dialog. */
export function SessionsSidebarItem({ theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <>
      <SidebarRow
        icon="MessageCircleQuestion"
        active={currentScreen?.screenId === SESSIONS_SCREEN_ID}
        onPress={() => openScreen({ screenId: SESSIONS_SCREEN_ID })}
      />
      <PermissionDialog theme={theme} />
    </>
  );
}
