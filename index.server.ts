import type { PluginServerContext } from "@getpaseo/plugin/server";
import { commitFootnotes } from "./server/commit";
import { createExplain, resetContext } from "./server/explainer";
import { commitRpc, explainRpc, layoutSettings, promptSettings, resetRpc } from "./shared/explain";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(layoutSettings);
  const settings = server.registerSettings(promptSettings);
  const readExtraPrompt = async () => {
    const state = await settings.read();
    return state.status === "ready" ? state.values.extraPrompt : "";
  };
  server.handle(explainRpc, createExplain(readExtraPrompt));
  server.handle(resetRpc, resetContext);
  server.handle(commitRpc, commitFootnotes);
  return () => {};
}
