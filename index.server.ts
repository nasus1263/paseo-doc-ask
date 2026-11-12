import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listWorkspaceBookmarks } from "./server/bookmarks";
import { readChatNotes, writeChatNotes } from "./server/chat-notes";
import { readComments, writeComments } from "./server/comments";
import { commitFootnotes } from "./server/commit";
import { createExplain, resetContext } from "./server/explainer";
import { resolveLinks } from "./server/links";
import {
  bookmarksRpc,
  commentsReadRpc,
  commentsWriteRpc,
  commitRpc,
  explainRpc,
  promptSettings,
  resetRpc,
} from "./shared/explain";
import { resolveLinksRpc } from "./shared/links";
import { chatNotesReadRpc, chatNotesWriteRpc, chatSettings } from "./shared/chat";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(chatSettings);
  const settings = server.registerSettings(promptSettings);
  const readExtraPrompt = async () => {
    const state = await settings.read();
    return state.status === "ready" ? state.values.extraPrompt : "";
  };
  server.handle(explainRpc, createExplain(readExtraPrompt));
  server.handle(resetRpc, resetContext);
  server.handle(commitRpc, commitFootnotes);
  server.handle(commentsReadRpc, readComments);
  server.handle(commentsWriteRpc, writeComments);
  server.handle(bookmarksRpc, listWorkspaceBookmarks);
  server.handle(resolveLinksRpc, resolveLinks);
  server.handle(chatNotesReadRpc, readChatNotes);
  server.handle(chatNotesWriteRpc, writeChatNotes);
  return () => {};
}
