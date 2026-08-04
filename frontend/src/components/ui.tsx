// Small stateless UI components used across screens.
import React from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  ViewStyle,
} from "react-native";

import { colors, fonts, platformColors, platformLabels, radius, spacing } from "@/src/theme";

// ---- BottomSheet -----------------------------------------------------------

interface BottomSheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  testID?: string;
}

export const BottomSheet: React.FC<BottomSheetProps> = ({
  visible,
  onClose,
  title,
  children,
  testID,
}) => (
  <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
    <Pressable style={styles.sheetBackdrop} onPress={onClose} testID={`${testID}-backdrop`}>
      <Pressable style={styles.sheetCard} onPress={() => {}} testID={testID}>
        <View style={styles.sheetHandle} />
        {title ? <Text style={styles.sheetTitle}>{title}</Text> : null}
        {children}
      </Pressable>
    </Pressable>
  </Modal>
);

// ---- Platform pill ---------------------------------------------------------

export const PlatformPill: React.FC<{
  state: string;
  active?: boolean;
  onPress?: () => void;
  size?: "sm" | "md" | "lg";
  testID?: string;
}> = ({ state, active, onPress, size = "md", testID }) => {
  const bg = active ? platformColors[state] ?? colors.muted : colors.card;
  const fg = active ? colors.white : colors.ink;
  const border = active ? platformColors[state] ?? colors.muted : colors.line;
  const pad =
    size === "lg" ? spacing.lg : size === "sm" ? spacing.sm : spacing.md;
  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      disabled={!onPress}
      style={[
        styles.pill,
        {
          backgroundColor: bg,
          borderColor: border,
          paddingVertical: pad,
          paddingHorizontal: pad + 4,
        },
      ]}
    >
      <View
        style={[styles.dot, { backgroundColor: active ? colors.white : platformColors[state] }]}
      />
      <Text style={[styles.pillText, { color: fg }]}>{platformLabels[state] ?? state}</Text>
    </TouchableOpacity>
  );
};

// ---- Card ------------------------------------------------------------------

export const Card: React.FC<{ children: React.ReactNode; style?: ViewStyle; testID?: string }> = ({
  children,
  style,
  testID,
}) => (
  <View testID={testID} style={[styles.card, style]}>
    {children}
  </View>
);

// ---- Number / label rows ---------------------------------------------------

export const StatBig: React.FC<{ label: string; value: string; color?: string; testID?: string }> = ({
  label,
  value,
  color,
  testID,
}) => (
  <View style={{ flex: 1 }} testID={testID}>
    <Text style={styles.statLabel}>{label}</Text>
    <Text style={[styles.statBig, color ? { color } : null]}>{value}</Text>
  </View>
);

const styles = StyleSheet.create({
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(16,35,28,0.45)",
    justifyContent: "flex-end",
  },
  sheetCard: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.xxl,
  },
  sheetHandle: {
    alignSelf: "center",
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.line,
    marginBottom: spacing.md,
  },
  sheetTitle: {
    fontFamily: fonts.display,
    fontSize: 22,
    color: colors.ink,
    marginBottom: spacing.md,
  },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.sm,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  pillText: { fontFamily: fonts.uiBold, fontSize: 14 },
  card: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.lg,
    borderWidth: 1,
    borderColor: colors.line,
  },
  statLabel: { fontFamily: fonts.ui, fontSize: 12, color: colors.muted, marginBottom: 2 },
  statBig: { fontFamily: fonts.dataMed, fontSize: 22, color: colors.ink },
});
