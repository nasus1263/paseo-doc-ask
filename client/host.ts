import type { PluginClientContext } from "@getpaseo/plugin/client";
import { explainStream } from "../shared/explain";

/** The panel id of the side "주석" panel. */
export const NOTES_PANEL_ID = "notes";

/** The plugin's client context, kept so components can open panels. */
let client: PluginClientContext | null = null;

export function setPluginClient(next: PluginClientContext | null): void {
  client = next;
}

/** The items of an agent's latest `limit` timeline entries, oldest first; empty without a connection. */
export async function recentTimeline(agentId: string, limit: number): Promise<{ type: string; text?: string }[]> {
  if (!client) return [];
  const page = await client.paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit, projection: "projected" });
  return page.entries.map((entry) => entry.item);
}

/** Puts the cursor in `agentId`'s message box, like Ctrl+L. */
export function focusComposer(agentId: string): void {
  const composer = client?.composers({ agentId })[0];
  composer?.focus().catch((cause: unknown) => console.error("[doc-ask] Could not focus the composer", cause));
}

/** A fresh ID naming one explain request, for `followAnswer`. */
export function newRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Calls `onText` with the answer of request `requestId` while the explainer writes it. Returns a
 * function that stops following; without a connection it does nothing.
 */
export function followAnswer(requestId: string, onText: (text: string) => void): () => void {
  if (!client) return () => {};
  const handle = client.subscribe(explainStream, { requestId }, (event) => onText(event.text));
  handle.ready.catch((cause) => console.error("[doc-ask] Could not follow the answer", cause));
  return () => handle();
}

/** Opens the side "주석" panel in the Explorer of `workspaceId`. */
export function openNotesPanel(workspaceId: string): void {
  client?.openPanel(NOTES_PANEL_ID, { workspaceId, location: "explorer" });
}

/** The panel id of the side "북마크" panel. */
export const BOOKMARKS_PANEL_ID = "bookmarks";

/** Opens the side "북마크" panel in the Explorer of `workspaceId`. */
export function openBookmarksPanel(workspaceId: string): void {
  client?.openPanel(BOOKMARKS_PANEL_ID, { workspaceId, location: "explorer" });
}
