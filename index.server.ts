import type { PluginServerContext } from "@getpaseo/plugin/server";
import { listWorkspaceBookmarks } from "./server/bookmarks";
import { readChatNotes, writeChatNotes } from "./server/chat-notes";
import { readComments, writeComments } from "./server/comments";
import { commitFootnotes } from "./server/commit";
import { createExplain, resetContext } from "./server/explainer";
import { resolveLinks } from "./server/links";
import { followAnswer } from "./server/stream";
import {
  bookmarksRpc,
  commentsReadRpc,
  commentsWriteRpc,
  commitRpc,
  explainRpc,
  explainStream,
  promptSettings,
  resetRpc,
} from "./shared/explain";
import { resolveLinksRpc } from "./shared/links";
import { chatNotesReadRpc, chatNotesWriteRpc, chatSettings } from "./shared/chat";

/** Shortest time between two drafts of an answer sent to the app. */
const STREAM_INTERVAL_MS = 100;

export default function contribute(server: PluginServerContext) {
  server.registerSettings(chatSettings);
  const settings = server.registerSettings(promptSettings);
  const readExtraPrompt = async () => {
    const state = await settings.read();
    return state.status === "ready" ? state.values.extraPrompt : "";
  };
  server.handle(explainRpc, createExplain(readExtraPrompt));
  server.handle(explainStream, ({ requestId }, { push, signal }) => {
    // Sends at most one draft per interval; the finished answer arrives through explainRpc.
    let latest = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = followAnswer(requestId, (text) => {
      latest = text;
      timer ??= setTimeout(() => {
        timer = undefined;
        void push({ text: latest });
      }, STREAM_INTERVAL_MS);
    });
    signal.addEventListener(
      "abort",
      () => {
        stop();
        if (timer) clearTimeout(timer);
      },
      { once: true },
    );
  });
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
