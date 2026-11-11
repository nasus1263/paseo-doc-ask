import type { PluginServerContext } from "@getpaseo/plugin/server";
import { explain } from "./server/explainer";
import { explainRpc } from "./shared/explain";

export default function contribute(server: PluginServerContext) {
  server.handle(explainRpc, explain);
  return () => {};
}
