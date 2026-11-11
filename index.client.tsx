import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DocAskPanel } from "./client/doc-ask-panel";

export default function contribute(client: PluginClientContext) {
  return client.addFilePanel({
    id: "doc-ask",
    title: "문서 질문",
    icon: "MessageCircleQuestion",
    files: { extensions: ["md", "markdown"] },
    Component: DocAskPanel,
  });
}
