import { Icon } from "@getpaseo/plugin/client/ui";
import { type ReactNode, useEffect, useRef } from "react";
import { Pressable, View } from "react-native";
import type { Theme } from "./doc-ask-panel";
import { hideTooltip, showTooltip } from "./web";

/** Pressable state on web also reports hover; React Native's types leave it out. */
export type PressState = { pressed: boolean; hovered?: boolean };

/** Hover time before a tooltip shows, as with native tooltips. */
const TOOLTIP_DELAY_MS = 400;

/**
 * Shows `label` in a bubble below `children` while the pointer rests on them. `align` picks the
 * edge the bubble lines up with; it stays inside the window either way.
 */
export function Tooltip({
  label,
  theme,
  align = "right",
  children,
}: {
  label: string;
  theme: Theme;
  align?: "left" | "right";
  children: (hover: { onHoverIn: () => void; onHoverOut: () => void }) => ReactNode;
}) {
  const anchor = useRef<View>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const shown = useRef(false);
  const hide = () => {
    if (timer.current) clearTimeout(timer.current);
    if (shown.current) hideTooltip();
    shown.current = false;
  };
  useEffect(() => hide, []);
  const onHoverIn = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      shown.current = true;
      showTooltip(anchor.current, label, theme, align);
    }, TOOLTIP_DELAY_MS);
  };
  return (
    <View ref={anchor} collapsable={false}>
      {children({ onHoverIn, onHoverOut: hide })}
    </View>
  );
}

/** A small icon-only button, like the ones in Paseo's panel headers: muted, filled on hover, with a tooltip. */
export function IconButton({
  icon,
  label,
  theme,
  color,
  align,
  onPress,
}: {
  icon: string;
  label: string;
  theme: Theme;
  color?: string;
  align?: "left" | "right";
  onPress: () => void;
}) {
  return (
    <Tooltip label={label} theme={theme} align={align}>
      {(hover) => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          onPress={() => {
            // A dialog or panel may open over the button; the pointer never leaves it.
            hover.onHoverOut();
            onPress();
          }}
          onHoverIn={hover.onHoverIn}
          onHoverOut={hover.onHoverOut}
          style={({ pressed, hovered }: PressState) => ({
            width: 26,
            height: 26,
            borderRadius: 6,
            alignItems: "center" as const,
            justifyContent: "center" as const,
            backgroundColor: pressed ? theme.colors.surface2 : hovered ? theme.colors.surface1 : "transparent",
          })}
        >
          <Icon name={icon} size={15} color={color ?? theme.colors.foregroundMuted} />
        </Pressable>
      )}
    </Tooltip>
  );
}
