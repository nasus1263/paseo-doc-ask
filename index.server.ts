import type { PluginServerContext } from "@getpaseo/plugin/server";
import { explain, resetContext } from "./server/explainer";
import { explainRpc, resetRpc } from "./shared/explain";

export default function contribute(server: PluginServerContext) {
  server.handle(explainRpc, explain);
  server.handle(resetRpc, resetContext);
  return () => {};
}
