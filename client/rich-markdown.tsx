import { useRpc } from "@getpaseo/plugin/client";
import { Markdown } from "@getpaseo/plugin/client/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { Platform, Text, View } from "react-native";
import { imageReadRpc, inlineImages, localImagePaths, splitVisuals } from "../shared/visuals";
import type { Theme } from "./doc-ask-panel";
import { mountVisualFrame } from "./web";

/**
 * An explanation with its visual aids: Markdown (tables, Mermaid, web images) drawn by Paseo,
 * ```svg and ```html blocks drawn in a sandboxed frame, and images on local paths read through
 * the daemon. `bases` are the folders a relative image path is tried against, in order.
 */
export function RichMarkdown({ text, theme, bases }: { text: string; theme: Theme; bases: readonly string[] }) {
  const withImages = useLocalImages(text, bases);
  const segments = useMemo(() => splitVisuals(withImages), [withImages]);
  return (
    <>
      {segments.map((segment, i) =>
        segment.kind === "markdown" ? (
          <Markdown key={i}>{segment.text}</Markdown>
        ) : (
          <VisualFrame key={i} kind={segment.kind} code={segment.code} theme={theme} />
        ),
      )}
    </>
  );
}

function VisualFrame({ kind, code, theme }: { kind: "svg" | "html"; code: string; theme: Theme }) {
  const host = useRef<View>(null);
  useEffect(() => mountVisualFrame(host.current, kind, code, theme), [kind, code, theme]);
  if (Platform.OS !== "web") {
    return (
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        {kind === "svg" ? "그림" : "시각 자료"}은 데스크톱과 웹에서만 표시됩니다.
      </Text>
    );
  }
  return <View ref={host} style={{ marginVertical: 6 }} />;
}

/** `text` with images on local paths turned into data URLs once the daemon has read them. */
export function useLocalImages(text: string, bases: readonly string[]): string {
  const read = useRpc(imageReadRpc);
  const paths = useMemo(() => localImagePaths(text), [text]);
  const key = paths.length > 0 ? JSON.stringify([bases, paths]) : null;
  const [urls, setUrls] = useState<{ key: string; map: Map<string, string> } | null>(null);
  useEffect(() => {
    if (!key) return;
    let live = true;
    Promise.all(paths.map((path) => read({ path, bases: [...bases] }).catch(() => ({ url: null })))).then(
      (results) => {
        const map = new Map<string, string>();
        results.forEach(({ url }, i) => {
          if (url) map.set(paths[i]!, url);
        });
        if (live) setUrls({ key, map });
      },
    );
    return () => {
      live = false;
    };
    // `key` covers bases and paths.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, read]);
  return urls && urls.key === key ? inlineImages(text, urls.map) : text;
}
