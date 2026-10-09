// The hub app's shared look: icons, the round name badge, the two-or-three way
// switch, filter chips, a round icon button, a progress bar, and the message
// that pops up after an action. Every tab is built from these, so they read
// as one app.
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, TouchableOpacity, View, ViewStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";

import { Tone } from "@/src/hub/ui";
import { colors, fonts, radius, spacing } from "@/src/theme";

export type IconName = React.ComponentProps<typeof Ionicons>["name"];
export const iconFont = Ionicons.font;

export const Icon: React.FC<{ name: IconName; size?: number; color?: string }> = ({ name, size = 20, color = colors.ink }) => (
  <Ionicons name={name} size={size} color={color} />
);

const SOFT: Record<Tone, { bg: string; fg: string }> = {
  ok: { bg: colors.brandTint, fg: colors.live },
  bad: { bg: "#F8E4E0", fg: colors.alert },
  warn: { bg: "#FCF2D9", fg: "#8A5D00" },
  mute: { bg: "#E6E9E2", fg: colors.muted },
};

// "Abhijit Gawali" -> "AG"; one word -> its first two letters.
export function initials(name?: string | null): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "–";
  const letters = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[1][0];
  return letters.toUpperCase();
}

/** A round badge with the person's initials, tinted by how they stand. */
export const Avatar: React.FC<{ name?: string | null; tone?: Tone; size?: number }> = ({ name, tone = "mute", size = 40 }) => (
  <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: SOFT[tone].bg, alignItems: "center", justifyContent: "center" }}>
    <Text style={{ fontFamily: fonts.uiBold, fontSize: size * 0.36, color: SOFT[tone].fg }}>{initials(name)}</Text>
  </View>
);

export interface Option<T extends string> { key: T; label: string; count?: number }

/** A switch between two or three views of the same screen. */
export function Segmented<T extends string>({ options, value, onChange, testID, style }: {
  options: Option<T>[]; value: T; onChange: (v: T) => void; testID?: string; style?: ViewStyle;
}) {
  return (
    <View style={[styles.segWrap, style]}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <TouchableOpacity key={o.key} style={[styles.seg, on ? styles.segOn : null]} onPress={() => onChange(o.key)} testID={testID ? `${testID}-${o.key}` : undefined}>
            <Text style={[styles.segText, on ? styles.segTextOn : null]} numberOfLines={1}>{o.label}</Text>
            {o.count ? (
              <View style={[styles.segCount, on ? styles.segCountOn : null]}><Text style={[styles.segCountText, on ? { color: colors.white } : null]}>{o.count}</Text></View>
            ) : null}
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

/** A row of filters that scrolls sideways when there are many. */
export function Chips<T extends string>({ options, value, onChange, testID }: {
  options: Option<T>[]; value: T; onChange: (v: T) => void; testID?: string;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} style={styles.chipsWrap}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <TouchableOpacity key={o.key} style={[styles.chip, on ? styles.chipOn : null]} onPress={() => onChange(o.key)} testID={testID ? `${testID}-${o.key}` : undefined}>
            <Text style={[styles.chipText, on ? styles.chipTextOn : null]}>{o.label}</Text>
            {o.count != null ? <Text style={[styles.chipCount, on ? styles.chipTextOn : null]}>{o.count}</Text> : null}
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}

/** A round button that is only an icon: call, add, send. */
export const IconBtn: React.FC<{
  icon: IconName; onPress: () => void; tone?: Tone | "solid"; size?: number; disabled?: boolean; testID?: string; label?: string;
}> = ({ icon, onPress, tone = "ok", size = 40, disabled, testID, label }) => {
  const bg = tone === "solid" ? colors.brand : SOFT[tone].bg;
  const fg = tone === "solid" ? colors.onBrand : SOFT[tone].fg;
  return (
    <TouchableOpacity
      onPress={onPress} disabled={disabled} testID={testID} accessibilityLabel={label} hitSlop={6}
      style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: bg, alignItems: "center", justifyContent: "center", opacity: disabled ? 0.4 : 1 }}
    >
      <Ionicons name={icon} size={size * 0.48} color={fg} />
    </TouchableOpacity>
  );
};

export const ProgressBar: React.FC<{ value: number; color?: string; track?: string }> = ({ value, color = colors.brand, track = colors.line }) => (
  <View style={[styles.track, { backgroundColor: track }]}>
    <View style={{ width: `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`, backgroundColor: color, height: "100%" }} />
  </View>
);

// ---- the message that pops up after an action --------------------------------
type Say = (message: string, tone?: "ok" | "bad") => void;
const ToastCtx = createContext<Say>(() => {});

/** "Car added.", "Entry undone." — shown above the tab bar for a few seconds,
 *  wherever the screen is scrolled to. A newer message replaces an older one. */
export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const insets = useSafeAreaInsets();
  const [toast, setToast] = useState<{ message: string; tone: "ok" | "bad" } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const say = useCallback<Say>((message, tone = "ok") => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ message, tone });
    timer.current = setTimeout(() => setToast(null), 4500);
  }, []);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return (
    <ToastCtx.Provider value={say}>
      {children}
      {toast ? (
        <View pointerEvents="none" style={[styles.toastWrap, { bottom: 76 + insets.bottom }]}>
          <View style={[styles.toast, toast.tone === "bad" ? { backgroundColor: colors.alert } : null]} testID="hub-toast">
            <Ionicons name={toast.tone === "bad" ? "alert-circle" : "checkmark-circle"} size={18} color={toast.tone === "bad" ? colors.white : colors.brand} />
            <Text style={styles.toastText}>{toast.message}</Text>
          </View>
        </View>
      ) : null}
    </ToastCtx.Provider>
  );
};

export const useToast = (): Say => useContext(ToastCtx);

const styles = StyleSheet.create({
  segWrap: { flexDirection: "row", padding: 3, backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line },
  // Each part is as wide as its words need, then they share what is left, so
  // a long label is not cut short while a short one sits in empty space.
  seg: { flexGrow: 1, flexShrink: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, paddingVertical: 9, paddingHorizontal: 8, borderRadius: radius.md - 3 },
  segOn: { backgroundColor: colors.ink },
  segText: { flexShrink: 1, fontFamily: fonts.uiBold, fontSize: 13, color: colors.muted },
  segTextOn: { color: colors.white },
  segCount: { minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4, alignItems: "center", justifyContent: "center", backgroundColor: "#E6E9E2" },
  segCountOn: { backgroundColor: colors.alert },
  segCountText: { fontFamily: fonts.uiBold, fontSize: 10, color: colors.ink },
  chipsWrap: { flexGrow: 0, marginHorizontal: -spacing.md },
  chips: { gap: spacing.sm, paddingHorizontal: spacing.md },
  chip: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontFamily: fonts.uiBold, fontSize: 13, color: colors.ink },
  chipCount: { fontFamily: fonts.dataMed, fontSize: 12, color: colors.muted },
  chipTextOn: { color: colors.white },
  track: { height: 8, borderRadius: 4, overflow: "hidden" },
  toastWrap: { position: "absolute", left: spacing.md, right: spacing.md, alignItems: "center" },
  toast: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm, maxWidth: 420,
    backgroundColor: colors.ink, borderRadius: radius.lg, paddingVertical: 12, paddingHorizontal: spacing.lg, elevation: 6,
  },
  toastText: { flexShrink: 1, fontFamily: fonts.uiMed, fontSize: 14, color: colors.white, lineHeight: 19 },
});
