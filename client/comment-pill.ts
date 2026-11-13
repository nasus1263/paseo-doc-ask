import type { PluginButton, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import { includeCommentsEnabled, onChatSettingsChange, setIncludeComments } from "./chat-toggle";

/**
 * A switch in every agent's composer: whether the reader's comments on the previous answer go
 * out with their next message. Shown whether or not that answer has comments, and only on web
 * and desktop, where the send hook in `web.ts` can attach them.
 */

function button(): Partial<PluginButton> {
  const on = includeCommentsEnabled();
  return {
    title: on
      ? "직전 답변에 단 내 주석을 다음 메시지에 함께 보냅니다 (켜짐)"
      : "직전 답변에 단 내 주석을 보내지 않습니다 (꺼짐)",
    icon: on ? "MessageSquareQuote" : "MessageSquareOff",
    label: on ? "주석 포함" : "주석 제외",
  };
}

export function installCommentPills(client: PluginClientContext): () => void {
  if (Platform.OS !== "web") return () => {};
  const pills = new Map<string, PluginButtonRegistration>();
  const lifetime = new AbortController();

  const toggle = async () => {
    try {
      await setIncludeComments(!includeCommentsEnabled());
    } catch (cause) {
      console.error("[doc-ask] Could not save the comment switch", cause);
    }
  };
  const register = (agent: { id: string; workspaceId?: string | null }) => {
    if (lifetime.signal.aborted || !agent.workspaceId) return;
    pills.get(agent.id)?.remove();
    pills.set(
      agent.id,
      client.addComposerPill({
        id: "include-comments",
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: { ...(button() as PluginButton), behavior: { kind: "action", onPress: toggle } },
      }),
    );
  };
  const removeAll = () => {
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
  const stopFollowing = onChatSettingsChange(() => {
    const patch = button();
    for (const pill of pills.values()) pill.update(patch);
  });

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          removeAll();
          for (const { agent } of entries) register(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "upsert") return register(update.agent);
          pills.get(update.agentId)?.remove();
          pills.delete(update.agentId);
        },
      });
      return undefined;
    })
    .catch((cause: unknown) => {
      if (!lifetime.signal.aborted) console.error("[doc-ask] Could not follow agents", cause);
    });

  return () => {
    lifetime.abort();
    stopFollowing();
    removeAll();
  };
}
