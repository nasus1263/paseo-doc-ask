import { Icon } from "@getpaseo/plugin/client/ui";
import { Pressable } from "react-native";
import type { Theme } from "./doc-ask-panel";

/** Pressable state on web also reports hover; React Native's types leave it out. */
export type PressState = { pressed: boolean; hovered?: boolean };

/** A small icon-only button, like the ones in Paseo's panel headers: muted, filled on hover. */
export function IconButton({
  icon,
  label,
  theme,
  color,
  onPress,
}: {
  icon: string;
  label: string;
  theme: Theme;
  color?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      // Web shows the label as a tooltip.
      {...({ title: label } as object)}
      onPress={onPress}
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
  );
}
