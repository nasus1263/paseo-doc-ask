import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CHAT_MESSAGE_KIND, ChatMessage, chatMessageSchema } from "./client/chat-message";
import { existingChatController, onChatChange } from "./client/chat-controller";
import {
  chatAnnotationsEnabled,
  includeCommentsEnabled,
  initChatAnnotations,
  onChatSettingsChange,
  setChatAnnotations,
} from "./client/chat-toggle";
import { installCommentPills } from "./client/comment-pill";
import { BookmarksPanel } from "./client/bookmarks-panel";
import { DocAskPanel } from "./client/doc-ask-panel";
import { BOOKMARKS_PANEL_ID, NOTES_PANEL_ID, setPluginClient } from "./client/host";
import { NotesPanel } from "./client/notes-panel";
import { installPermissionPrompts, withPermissionDialog } from "./client/permission-dialog";
import { SESSIONS_SCREEN_ID, SessionsScreen, SessionsSidebarItem } from "./client/sessions-screen";
import { installCommentSendHook } from "./client/web";

/**
 * Instructions (the reader's comments) exist only on answers this plugin draws, so they go out
 * only while it draws them. Returns the cleanup.
 */
function installSendHook(): () => void {
  const pendingFor = (agentId: string) => {
    if (!chatAnnotationsEnabled() || !includeCommentsEnabled()) return null;
    const controller = existingChatController(agentId);
    const pending = controller?.outgoingComments();
    return controller && pending ? { controller, pending } : null;
  };
  const hook = installCommentSendHook(
    (agentId) => {
      const found = pendingFor(agentId);
      if (!found) return null;
      const { controller, pending } = found;
      return {
        text: `[이전 답변에 대한 사용자 지시] 각 소제목은 그 답변이 몇 턴 전 답변인지(직전 답변 = 1턴 전)이고, 그 아래 각 인용(>)은 그 답변의 구절, 그 아래가 그 구절에 대한 지시다.\n\n${pending.block}`,
        onSent: () => void controller.markCommentsSent(pending.labels),
      };
    },
    (agentId) => pendingFor(agentId) !== null,
  );
  const stopChats = onChatChange(hook.refresh);
  const stopSettings = onChatSettingsChange(hook.refresh);
  return () => {
    stopChats();
    stopSettings();
    hook.dispose();
  };
}

export default function contribute(client: PluginClientContext) {
  setPluginClient(client);
  const removals = [
    client.addFilePanel({
      id: "doc-ask",
      title: "문서 질문",
      icon: "MessageCircleQuestion",
      files: { extensions: ["md", "markdown"] },
      Component: withPermissionDialog(DocAskPanel),
    }),
    client.addWorkspacePanel({
      id: NOTES_PANEL_ID,
      title: "주석",
      icon: "NotebookPen",
      locations: ["explorer", "workspace"],
      Component: withPermissionDialog(NotesPanel),
    }),
    client.addWorkspacePanel({
      id: BOOKMARKS_PANEL_ID,
      title: "북마크",
      icon: "Bookmark",
      locations: ["explorer", "workspace"],
      Component: BookmarksPanel,
    }),
    client.addScreen({ id: SESSIONS_SCREEN_ID, title: "질문 세션", Component: SessionsScreen }),
    client.addSidebarHeaderItem({ id: SESSIONS_SCREEN_ID, title: "질문 세션", Component: SessionsSidebarItem }),
    installPermissionPrompts(client),
    client.addCommandCenterItem({
      id: "open-bookmarks",
      title: "각주 북마크 열기",
      icon: "Bookmark",
      keywords: ["북마크", "각주", "bookmark", "footnote"],
      context: "workspace",
      onSelect({ openPanel }) {
        openPanel(BOOKMARKS_PANEL_ID);
      },
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
    installCommentPills(client),
    // Instructions (the reader's comments) exist only on answers this plugin draws, so they go
    // out only while it draws them.
    installSendHook(),
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
