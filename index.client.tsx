import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CHAT_MESSAGE_KIND, ChatMessage, chatMessageSchema } from "./client/chat-message";
import { chatAnnotationsEnabled, initChatAnnotations, setChatAnnotations } from "./client/chat-toggle";
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
    // The renderer stays registered so rows drawn while annotations were on keep rendering; the
    // transformer that produces them follows the "대화 주석" setting.
    client.addTimelineRenderer({
      kind: CHAT_MESSAGE_KIND,
      version: 1,
      schema: chatMessageSchema,
      Component: ChatMessage,
    }),
    initChatAnnotations(client),
    client.addCommandCenterItem({
      id: "toggle-chat-notes",
      title: "대화 주석 켜기/끄기",
      icon: "NotebookPen",
      keywords: ["주석", "각주", "대화", "annotate", "footnote"],
      context: "global",
      async onSelect() {
        await setChatAnnotations(!chatAnnotationsEnabled());
      },
    }),
  ];
  return () => {
    for (const remove of removals) remove();
    setPluginClient(null);
  };
}
