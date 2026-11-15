import { Icon } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { type NoteKind, splitTitle } from "../shared/markdown";
import type { Theme } from "./doc-ask-panel";

/** The icon standing for each kind of footnote unit in place of its word. */
const KIND_ICON: Record<NoteKind, string> = {
  설명: "Lightbulb",
  질문: "CircleHelp",
  주석: "PenLine",
  지시: "PenLine",
};

/** A footnote unit's title: the kind's icon, then the subject. */
export function NoteTitle({
  kind,
  subject,
  theme,
  bold = true,
  lines,
}: {
  kind: NoteKind;
  subject: string;
  theme: Theme;
  bold?: boolean;
  lines?: number;
}) {
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 6 }}>
      <View accessibilityLabel={kind} {...({ title: kind } as object)} style={{ paddingTop: 2 }}>
        <Icon name={KIND_ICON[kind]} size={14} color={theme.colors.foregroundMuted} />
      </View>
      <Text
        numberOfLines={lines}
        style={{
          flex: 1,
          minWidth: 0,
          color: theme.colors.foreground,
          fontSize: 13,
          lineHeight: 19,
          fontWeight: bold ? ("600" as const) : ("400" as const),
        }}
      >
        {subject}
      </Text>
    </View>
  );
}

/**
 * A footnote unit with its bold `kind: subject` title line drawn as a `NoteTitle`, and its body
 * drawn by `children`. A unit without such a title is drawn by `children` whole.
 */
export function TitledUnit({
  unit,
  theme,
  children,
}: {
  unit: string;
  theme: Theme;
  children: (body: string) => ReactNode;
}) {
  const titled = splitTitle(unit);
  if (!titled) return <>{children(unit)}</>;
  return (
    <View style={{ gap: 6 }}>
      <NoteTitle kind={titled.kind} subject={titled.subject} theme={theme} />
      {titled.body.trim() ? children(titled.body) : null}
    </View>
  );
}
