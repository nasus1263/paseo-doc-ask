import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DocAskPanel } from "./client/doc-ask-panel";
import { NOTES_PANEL_ID, setPluginClient } from "./client/host";
import { NotesPanel } from "./client/notes-panel";

export default function contribute(client: PluginClientContext) {
  setPluginClient(client);
  const removeFilePanel = client.addFilePanel({
    id: "doc-ask",
    title: "문서 질문",
    icon: "MessageCircleQuestion",
    files: { extensions: ["md", "markdown"] },
    Component: DocAskPanel,
  });
  const removeNotesPanel = client.addWorkspacePanel({
    id: NOTES_PANEL_ID,
    title: "주석",
    icon: "NotebookPen",
    locations: ["explorer", "workspace"],
    Component: NotesPanel,
  });
  return () => {
    removeFilePanel();
    removeNotesPanel();
    setPluginClient(null);
  };
}
