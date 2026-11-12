import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { useSyncExternalStore } from "react";
import { chatSettings, messageKey } from "../shared/chat";
import { CHAT_MESSAGE_KIND } from "./chat-message";

/**
 * Footnotes on agent conversations are off by default: Paseo's own assistant rows carry
 * features a plugin cannot rebuild, such as Fork. Turning them on registers the transformer that
 * draws completed assistant messages; turning them off removes it, restoring Paseo's rows.
 */

const rpc = settingsRpc(chatSettings.id);
let client: PluginClientContext | null = null;
let removeTransformer: (() => void) | null = null;
let enabled = false;
const listeners = new Set<() => void>();

function apply(next: boolean): void {
  enabled = next;
  if (next && !removeTransformer && client) {
    removeTransformer = client.addTimelineTransformer({
      id: "doc-ask-assistant",
      query: { itemType: "assistant_message" },
      // Streaming answers keep Paseo's own row; only completed ones are replaced.
      transform: ({ item, phase }) =>
        phase === "complete"
          ? {
              items: [
                {
                  type: "plugin",
                  kind: CHAT_MESSAGE_KIND,
                  version: 1,
                  data: { text: item.text, key: messageKey(item.messageId, item.text) },
                },
              ],
            }
          : undefined,
    });
  } else if (!next && removeTransformer) {
    removeTransformer();
    removeTransformer = null;
  }
  for (const listener of listeners) listener();
}

/** Applies the saved setting. Returns the cleanup that removes the transformer. */
export function initChatAnnotations(context: PluginClientContext): () => void {
  client = context;
  void context
    .rpc(rpc.read, {})
    .then((state) => {
      if (state.status === "ready") apply((state.values as { annotate?: boolean }).annotate === true);
    })
    .catch((cause) => console.error("[doc-ask] Could not read chat settings", cause));
  return () => {
    removeTransformer?.();
    removeTransformer = null;
    client = null;
  };
}

/** Turns footnotes on agent conversations on or off and saves the choice. */
export async function setChatAnnotations(next: boolean): Promise<void> {
  if (!client) throw new Error("플러그인이 아직 준비되지 않았습니다.");
  const current = await client.rpc(rpc.read, {});
  if (current.status !== "ready") throw new Error("설정을 읽지 못했습니다.");
  const values = { ...(current.values as Record<string, unknown>), annotate: next };
  const result = await client.rpc(rpc.write, { revision: current.revision, values });
  if (result.status !== "saved") throw new Error("설정을 저장하지 못했습니다. 다시 시도해 주세요.");
  apply(next);
}

export function chatAnnotationsEnabled(): boolean {
  return enabled;
}

export function useChatAnnotations(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => enabled,
  );
}
