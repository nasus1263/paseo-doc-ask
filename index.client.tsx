import type { PluginClientContext } from "@getpaseo/plugin/client";
import { messageKey } from "./shared/chat";
import { CHAT_MESSAGE_KIND, ChatMessage, chatMessageSchema } from "./client/chat-message";
import { DocAskPanel } from "./client/doc-ask-panel";
import { NOTES_PANEL_ID, setPluginClient } from "./client/host";
import { NotesPanel } from "./client/notes-panel";

export default function contribute(client: PluginClientContext) {
  setPluginClient(client);
  const removals = [
    client.addFilePanel({
      id: "doc-ask",
      title: "문서 질문",
      icon: "MessageCircleQuestion",
      files: { extensions: ["md", "markdown"] },
      Component: DocAskPanel,
    }),
    client.addWorkspacePanel({
      id: NOTES_PANEL_ID,
      title: "주석",
      icon: "NotebookPen",
      locations: ["explorer", "workspace"],
      Component: NotesPanel,
    }),
    // Completed assistant messages are drawn by the plugin so they can carry footnotes. Streaming
    // messages keep Paseo's own row; user messages are left alone to keep their attachments.
    client.addTimelineTransformer({
      id: "doc-ask-assistant",
      query: { itemType: "assistant_message" },
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
    }),
    client.addTimelineRenderer({
      kind: CHAT_MESSAGE_KIND,
      version: 1,
      schema: chatMessageSchema,
      Component: ChatMessage,
    }),
  ];
  return () => {
    for (const remove of removals) remove();
    setPluginClient(null);
  };
}
