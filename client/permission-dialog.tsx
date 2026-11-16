import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { type ComponentType, useEffect, useState, useSyncExternalStore } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { type PermissionPrompt, permissionPromptsStream, permissionRespondRpc } from "../shared/permission";

let client: PluginClientContext | null = null;
let prompts: PermissionPrompt[] = [];
/** Mounted dialogs; only the latest draws, so one prompt never shows twice. */
let hosts: symbol[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Follows the explainers' permission requests while the plugin runs. Returns the cleanup. */
export function installPermissionPrompts(next: PluginClientContext): () => void {
  client = next;
  const handle = next.subscribe(permissionPromptsStream, {}, (event) => {
    prompts = event.prompts;
    notify();
  });
  handle.ready.catch((cause) => console.error("[doc-ask] Could not follow permission requests", cause));
  return () => {
    handle();
    client = null;
    prompts = [];
    notify();
  };
}

/**
 * Asks the user to allow or deny the tool an explainer wants to use while answering. Mount it in
 * every surface that may be on screen; the latest mounted one draws.
 */
export function PermissionDialog({ theme }: { theme: PluginTheme }) {
  const [token] = useState(() => Symbol("permission-dialog"));
  useEffect(() => {
    hosts = [...hosts, token];
    notify();
    return () => {
      hosts = hosts.filter((host) => host !== token);
      notify();
    };
  }, [token]);
  const prompt = useSyncExternalStore(subscribe, () => (hosts.at(-1) === token ? (prompts[0] ?? null) : null));
  const [sending, setSending] = useState(false);
  if (!prompt) return null;

  const answer = (allow: boolean) => {
    if (!client || sending) return;
    setSending(true);
    client
      .rpc(permissionRespondRpc, { id: prompt.id, allow })
      .catch((cause: unknown) => console.error("[doc-ask] Could not answer the permission request", cause))
      .finally(() => setSending(false));
  };
  const button = (allow: boolean) => (
    <Pressable
      accessibilityRole="button"
      disabled={sending}
      onPress={() => answer(allow)}
      style={({ pressed }) => ({
        paddingVertical: 8,
        paddingHorizontal: 16,
        borderRadius: 8,
        borderWidth: allow ? 0 : 1,
        borderColor: theme.colors.border,
        backgroundColor: allow ? theme.colors.accent : theme.colors.surface1,
        opacity: pressed || sending ? 0.7 : 1,
      })}
    >
      <Text style={{ color: allow ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 14 }}>
        {allow ? "승인" : "거부"}
      </Text>
    </Pressable>
  );
  return (
    <Modal transparent animationType="fade" visible onRequestClose={() => answer(false)}>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, backgroundColor: "rgba(0,0,0,0.4)" }}>
        <View
          style={{
            width: "100%",
            maxWidth: 480,
            gap: 12,
            padding: 20,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: theme.colors.border,
            backgroundColor: theme.colors.surface0,
          }}
        >
          <Text style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "600" }}>문서 질문: 권한 요청</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>
            해설 에이전트가 답하는 중에 <Text style={{ color: theme.colors.foreground }}>{prompt.tool}</Text> 도구를 쓰려고
            합니다.{prompts.length > 1 ? ` (대기 ${prompts.length}건)` : ""}
          </Text>
          {prompt.title ? <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>{prompt.title}</Text> : null}
          {prompt.detail ? (
            <ScrollView
              style={{ maxHeight: 240, borderRadius: 8, backgroundColor: theme.colors.surface1 }}
              contentContainerStyle={{ padding: 10 }}
            >
              <Text selectable style={{ color: theme.colors.foreground, fontSize: 12, fontFamily: "monospace" }}>
                {prompt.detail}
              </Text>
            </ScrollView>
          ) : null}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            {button(false)}
            {button(true)}
          </View>
        </View>
      </View>
    </Modal>
  );
}

/** `Panel` with the permission dialog mounted beside it. */
export function withPermissionDialog<Props extends { theme: PluginTheme }>(Panel: ComponentType<Props>): ComponentType<Props> {
  return function PanelWithPermissionDialog(props: Props) {
    return (
      <>
        <Panel {...props} />
        <PermissionDialog theme={props.theme} />
      </>
    );
  };
}
