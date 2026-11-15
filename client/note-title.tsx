import { Icon } from "@getpaseo/plugin/client/ui";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { type NoteKind, splitTitle } from "../shared/markdown";
import { Tooltip } from "./controls";
import type { Theme } from "./doc-ask-panel";

/** The icon standing for each kind of footnote unit in place of its word. */
const KIND_ICON: Record<NoteKind, string> = {
  설명: "Lightbulb",
  질문: "CircleHelp",
  주석: "PenLine",
  지시: "PenLine",
};

/** What each kind's icon means, shown on hover. */
const KIND_LABEL: Record<NoteKind, string> = {
  설명: "설명: AI가 선택한 구절을 설명한 답",
  질문: "질문: AI가 질문에 답한 내용",
  주석: "주석: 내가 남긴 메모",
  지시: "지시: 에이전트에게 전할 내 지시",
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
      <Tooltip label={KIND_LABEL[kind]} theme={theme} align="left">
        {(hover) => (
          // A plain view, not a pressable, so a click still reaches the row around it.
          <View
            accessibilityLabel={kind}
            {...({ onPointerEnter: hover.onHoverIn, onPointerLeave: hover.onHoverOut } as object)}
            style={{ paddingTop: 2 }}
          >
            <Icon name={KIND_ICON[kind]} size={14} color={theme.colors.foregroundMuted} />
          </View>
        )}
      </Tooltip>
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
