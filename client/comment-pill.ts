import type { PluginButton, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Platform } from "react-native";
import { answerAge } from "../shared/chat";
import { existingChatController, onChatChange } from "./chat-controller";
import {
  chatAnnotationsEnabled,
  includeCommentsEnabled,
  onChatSettingsChange,
  setIncludeComments,
} from "./chat-toggle";

/**
 * A switch in every agent's composer: whether the reader's unsent instructions (their comments)
 * on earlier answers go out with their next message. It shows how many are waiting and lists them
 * in its tooltip. Shown whether or not there are any, and only on web and desktop, where the
 * send hook in `web.ts` can attach them.
 */

/** How long one instruction or passage may run in the tooltip. */
const TOOLTIP_TEXT_MAX = 60;

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > TOOLTIP_TEXT_MAX ? `${flat.slice(0, TOOLTIP_TEXT_MAX)}…` : flat;
}

function button(agentId: string): Partial<PluginButton> {
  const on = includeCommentsEnabled();
  const items = chatAnnotationsEnabled() ? (existingChatController(agentId)?.outgoingComments()?.items ?? []) : [];
  const state = on
    ? "켜짐: 이전 답변들에 단 내 지시 중 아직 보내지 않은 것을 다음 메시지에 함께 보냅니다."
    : "꺼짐: 이전 답변에 단 내 지시를 보내지 않습니다.";
  const list =
    items.length === 0
      ? "보낼 지시가 없습니다."
      : items
          .map((item, i) => `${i + 1}. [${answerAge(item.turnsAgo)}] ${shorten(item.comment)} (“${shorten(item.quote)}”)`)
          .join("\n");
  return {
    title: `${state}\n${list}`,
    icon: on ? "MessageSquareQuote" : "MessageSquareOff",
    label: `${on ? "지시 포함" : "지시 제외"} ${items.length}`,
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
        button: { ...(button(agent.id) as PluginButton), behavior: { kind: "action", onPress: toggle } },
      }),
    );
  };
  const removeAll = () => {
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
  const stopFollowingSettings = onChatSettingsChange(() => {
    for (const [agentId, pill] of pills) pill.update(button(agentId));
  });
  const stopFollowingChats = onChatChange((agentId) => pills.get(agentId)?.update(button(agentId)));

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
    stopFollowingSettings();
    stopFollowingChats();
    removeAll();
  };
}
