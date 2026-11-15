import { settingsRpc } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
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
/** Whether the reader's comments on the latest answer go out with their next message. */
let includeComments = true;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

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
                  data: { text: item.text, key: messageKey(item.text) },
                },
              ],
            }
          : undefined,
    });
  } else if (!next && removeTransformer) {
    removeTransformer();
    removeTransformer = null;
  }
  emit();
}

/** Applies the saved setting. Returns the cleanup that removes the transformer. */
export function initChatAnnotations(context: PluginClientContext): () => void {
  client = context;
  void context
    .rpc(rpc.read, {})
    .then((state) => {
      if (state.status !== "ready") return;
      const values = state.values as { annotate?: boolean; includeComments?: boolean };
      includeComments = values.includeComments !== false;
      apply(values.annotate === true);
    })
    .catch((cause) => console.error("[doc-ask] Could not read chat settings", cause));
  return () => {
    removeTransformer?.();
    removeTransformer = null;
    client = null;
  };
}

/** Saves `patch` over the stored chat settings. */
async function save(patch: { annotate?: boolean; includeComments?: boolean }): Promise<void> {
  if (!client) throw new Error("플러그인이 아직 준비되지 않았습니다.");
  const current = await client.rpc(rpc.read, {});
  if (current.status !== "ready") throw new Error("설정을 읽지 못했습니다.");
  const values = { ...(current.values as { annotate?: boolean; includeComments?: boolean }), ...patch };
  const result = await client.rpc(rpc.write, { revision: current.revision, values });
  if (result.status !== "saved") throw new Error("설정을 저장하지 못했습니다. 다시 시도해 주세요.");
}

/** Turns footnotes on agent conversations on or off and saves the choice. */
export async function setChatAnnotations(next: boolean): Promise<void> {
  await save({ annotate: next });
  apply(next);
}

/** Turns sending comments with the next message on or off and saves the choice. */
export async function setIncludeComments(next: boolean): Promise<void> {
  await save({ includeComments: next });
  includeComments = next;
  emit();
}

export function includeCommentsEnabled(): boolean {
  return includeComments;
}

/** Calls `listener` whenever either chat setting changes. */
export function onChatSettingsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function chatAnnotationsEnabled(): boolean {
  return enabled;
}
