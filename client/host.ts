import type { PluginClientContext } from "@getpaseo/plugin/client";

/** The panel id of the side "주석" panel. */
export const NOTES_PANEL_ID = "notes";

/** The plugin's client context, kept so components can open panels. */
let client: PluginClientContext | null = null;

export function setPluginClient(next: PluginClientContext | null): void {
  client = next;
}

/** Opens the side "주석" panel in the Explorer of `workspaceId`. */
export function openNotesPanel(workspaceId: string): void {
  client?.openPanel(NOTES_PANEL_ID, { workspaceId, location: "explorer" });
}
