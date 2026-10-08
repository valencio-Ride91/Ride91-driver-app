// Small building blocks shared by the hub manager app's screens.

import React from "react";
import { ActivityIndicator, Linking, StyleSheet, Text, TouchableOpacity, View, ViewStyle } from "react-native";

import { useI18n } from "@/src/i18n";
import { useHubSession } from "@/src/hub/session";
import { useHubToday } from "@/src/hub/today";
import { useHubText } from "@/src/hub/text";
import { colors, fonts, radius, spacing } from "@/src/theme";

export type Tone = "ok" | "bad" | "warn" | "mute";

const TONES: Record<Tone, { bg: string; fg: string }> = {
  ok: { bg: colors.brandTint, fg: colors.live },
  bad: { bg: "#F8E4E0", fg: colors.alert },
  warn: { bg: "#FCF2D9", fg: "#8A5D00" },
  mute: { bg: colors.paper, fg: colors.muted },
};

/** How loud each shift status is on a tag. */
export const STATUS_TONE: Record<string, Tone> = {
  started: "ok", coming: "ok", ringing: "warn", alarm_pending: "mute", no_shift_time: "mute",
  no_answer: "bad", not_coming: "bad", late: "bad", not_started: "bad",
};

export const Tag: React.FC<{ tone: Tone; children: React.ReactNode; testID?: string }> = ({ tone, children, testID }) => (
  <View style={[styles.tag, { backgroundColor: TONES[tone].bg }]} testID={testID}>
    <Text style={[styles.tagText, { color: TONES[tone].fg }]}>{children}</Text>
  </View>
);

export const Btn: React.FC<{
  label: string;
  onPress: () => void;
  kind?: "primary" | "ghost" | "danger";
  small?: boolean;
  busy?: boolean;
  disabled?: boolean;
  style?: ViewStyle;
  testID?: string;
}> = ({ label, onPress, kind = "primary", small, busy, disabled, style, testID }) => {
  const fg = kind === "primary" ? colors.onBrand : kind === "danger" ? colors.alert : colors.ink;
  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      disabled={disabled || busy}
      style={[
        styles.btn,
        small ? styles.btnSmall : null,
        kind === "primary" ? styles.btnPrimary : styles.btnGhost,
        kind === "danger" ? { borderColor: colors.alert } : null,
        disabled || busy ? { opacity: 0.45 } : null,
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={fg} /> : <Text style={[styles.btnText, small ? { fontSize: 13 } : null, { color: fg }]}>{label}</Text>}
    </TouchableOpacity>
  );
};

/** Ring a driver from the phone's own dialler. */
export const callPhone = (phone?: string | null) => {
  if (!phone) return;
  const digits = phone.replace(/[^\d+]/g, "");
  Linking.openURL(`tel:${digits.startsWith("+") || digits.length !== 10 ? digits : "+91" + digits}`).catch(() => {});
};

export const Tile: React.FC<{ value: string; label: string; tone?: Tone; onPress?: () => void; testID?: string }> = ({ value, label, tone, onPress, testID }) => (
  <TouchableOpacity style={styles.tile} onPress={onPress} disabled={!onPress} testID={testID}>
    <Text style={[styles.tileValue, tone && tone !== "mute" ? { color: TONES[tone].fg } : null]} numberOfLines={1} adjustsFontSizeToFit>{value}</Text>
    <Text style={styles.tileLabel} numberOfLines={2}>{label}</Text>
  </TouchableOpacity>
);

/** Top of every tab: the hub's name (or a title), the language switch, and
 *  the "no connection" strip when the last refresh failed. */
export const HubHeader: React.FC<{ title?: string; right?: React.ReactNode }> = ({ title, right }) => {
  const { lang, setLang } = useI18n();
  const { session } = useHubSession();
  const { failed } = useHubToday();
  const t = useHubText();
  return (
    <View style={styles.header}>
      <View style={styles.headerRow}>
        <Text style={styles.headerTitle} numberOfLines={1} testID="hub-header-title">{title ?? session?.hubName ?? t.app_name}</Text>
        {right}
        <TouchableOpacity style={styles.langPill} onPress={() => setLang(lang === "hi" ? "en" : "hi")} testID="hub-lang">
          <Text style={styles.langText}>{lang === "hi" ? "हिं" : "EN"}</Text>
        </TouchableOpacity>
      </View>
      {failed ? <Text style={styles.offline} testID="hub-offline">{t.offline}</Text> : null}
    </View>
  );
};

export const SectionTitle: React.FC<{ children: React.ReactNode; right?: React.ReactNode }> = ({ children, right }) => (
  <View style={styles.sectionRow}>
    <Text style={styles.section}>{children}</Text>
    {right}
  </View>
);

export const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => <Text style={styles.empty}>{children}</Text>;

export const hubStyles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  scroll: { padding: spacing.md, paddingBottom: spacing.xxl * 2 },
  card: { backgroundColor: colors.card, borderRadius: radius.lg, padding: spacing.md, borderWidth: 1, borderColor: colors.line },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.line, gap: spacing.sm },
  rowFirst: { borderTopWidth: 0 },
  name: { fontFamily: fonts.uiBold, fontSize: 15, color: colors.ink },
  sub: { fontFamily: fonts.ui, fontSize: 12, color: colors.muted, marginTop: 1 },
  subAlert: { fontFamily: fonts.uiMed, fontSize: 12, color: colors.alert, marginTop: 1 },
  input: {
    borderWidth: 1, borderColor: colors.line, borderRadius: radius.md, backgroundColor: colors.card,
    paddingHorizontal: spacing.md, paddingVertical: 11, fontFamily: fonts.uiMed, fontSize: 15, color: colors.ink,
  },
  label: { fontFamily: fonts.uiBold, fontSize: 12, color: colors.muted, marginTop: spacing.sm, marginBottom: 4 },
  err: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.alert, marginTop: spacing.sm },
  done: {
    fontFamily: fonts.uiBold, fontSize: 13, color: colors.live, backgroundColor: colors.brandTint, borderRadius: radius.md,
    overflow: "hidden", paddingVertical: spacing.sm, paddingHorizontal: spacing.md, marginBottom: spacing.sm,
  },
  warn: {
    fontFamily: fonts.uiMed, fontSize: 13, color: "#8A5D00", backgroundColor: "#FCF2D9", borderRadius: radius.md,
    overflow: "hidden", paddingVertical: spacing.sm, paddingHorizontal: spacing.md, marginBottom: spacing.sm, lineHeight: 19,
  },
});

const styles = StyleSheet.create({
  tag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, alignSelf: "flex-start" },
  tagText: { fontFamily: fonts.uiBold, fontSize: 11 },
  btn: { borderRadius: radius.md, paddingVertical: 13, paddingHorizontal: spacing.md, alignItems: "center", justifyContent: "center" },
  btnSmall: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: radius.sm },
  btnPrimary: { backgroundColor: colors.brand },
  btnGhost: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  btnText: { fontFamily: fonts.uiBold, fontSize: 15 },
  tile: { flex: 1, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, paddingVertical: 10, paddingHorizontal: 10, minWidth: 0 },
  tileValue: { fontFamily: fonts.dataMed, fontSize: 22, color: colors.ink },
  tileLabel: { fontFamily: fonts.uiMed, fontSize: 11, color: colors.muted, marginTop: 2 },
  header: { backgroundColor: colors.paper, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.md, borderBottomWidth: 1, borderBottomColor: colors.line },
  headerRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  headerTitle: { flex: 1, fontFamily: fonts.display, fontSize: 22, color: colors.ink },
  langPill: { paddingHorizontal: spacing.md, paddingVertical: 6, borderRadius: radius.lg, backgroundColor: colors.ink },
  langText: { fontFamily: fonts.uiBold, fontSize: 12, color: colors.white },
  offline: { fontFamily: fonts.uiMed, fontSize: 12, color: "#8A5D00", marginTop: 6 },
  sectionRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: spacing.lg, marginBottom: spacing.sm },
  section: { fontFamily: fonts.uiBold, fontSize: 13, color: colors.ink },
  empty: { fontFamily: fonts.ui, fontSize: 13, color: colors.muted, paddingVertical: spacing.sm },
});
