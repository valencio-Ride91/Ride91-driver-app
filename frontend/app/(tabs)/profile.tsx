import React, { useCallback, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { AppHeader } from "@/src/components/AppHeader";
import { Card } from "@/src/components/ui";
import { useAuth } from "@/src/auth";
import { useI18n, formatIST } from "@/src/i18n";
import { useShiftAlarm } from "@/src/shift-alarms";
import { colors, fonts, radius, spacing } from "@/src/theme";

// Presets are relative to "now" — no calendar picker needed at MVP. Each
// preset schedules the SHIFT start time; the 1-hour-before alarm is computed
// server-side and pushed to the native module.
const SHIFT_PRESETS: { label: string; hoursFromNow: number; type: "day" | "night" }[] = [
  { label: "In 2 hours (day)", hoursFromNow: 2, type: "day" },
  { label: "In 5 hours (day)", hoursFromNow: 5, type: "day" },
  { label: "Tomorrow 6 AM", hoursFromNow: -1, type: "day" }, // sentinel — computed below
  { label: "Tonight 10 PM (night)", hoursFromNow: -2, type: "night" }, // sentinel
];

function resolveShiftStart(preset: (typeof SHIFT_PRESETS)[number]): Date {
  const now = new Date();
  if (preset.hoursFromNow > 0) {
    return new Date(now.getTime() + preset.hoursFromNow * 3600 * 1000);
  }
  // For preset sentinels we build an IST wall-clock moment, then convert to
  // UTC by subtracting 5:30. Doing it this way avoids Intl/Timezone lib deps.
  const nowIST = new Date(now.getTime() + 5.5 * 3600 * 1000);
  const y = nowIST.getUTCFullYear();
  const m = nowIST.getUTCMonth();
  const d = nowIST.getUTCDate();
  if (preset.hoursFromNow === -1) {
    // Tomorrow 6:00 AM IST
    const istWall = new Date(Date.UTC(y, m, d + 1, 6, 0, 0));
    return new Date(istWall.getTime() - 5.5 * 3600 * 1000);
  }
  // -2 → next 22:00 IST (today if still future, else tomorrow)
  const todayIstWall = new Date(Date.UTC(y, m, d, 22, 0, 0));
  const todayUtc = new Date(todayIstWall.getTime() - 5.5 * 3600 * 1000);
  if (todayUtc.getTime() > now.getTime()) return todayUtc;
  const tomorrowIstWall = new Date(Date.UTC(y, m, d + 1, 22, 0, 0));
  return new Date(tomorrowIstWall.getTime() - 5.5 * 3600 * 1000);
}

export default function Profile() {
  const { t } = useI18n();
  const { driver, vehicle, signOut } = useAuth();
  const { next, scheduleShift, testFireNow, refresh, nativeAvailable } = useShiftAlarm();
  const router = useRouter();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [busyPreset, setBusyPreset] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const nextAlarm = useMemo(() => (next?.alarm_fires_at ? formatIST(next.alarm_fires_at) : null), [next]);
  const nextShift = useMemo(() => (next?.shift_start ? formatIST(next.shift_start) : null), [next]);

  const onPickPreset = useCallback(
    async (preset: (typeof SHIFT_PRESETS)[number]) => {
      setBusyPreset(preset.label);
      try {
        const shiftStart = resolveShiftStart(preset);
        const r = await scheduleShift({ shift_start: shiftStart.toISOString(), shift_type: preset.type });
        setPickerOpen(false);
        setToast(r ? "Alarm scheduled" : "Could not schedule — try again");
        setTimeout(() => setToast(null), 2500);
      } finally {
        setBusyPreset(null);
      }
    },
    [scheduleShift],
  );

  const onTestNative = useCallback(async () => {
    await testFireNow();
    setToast("Native alarm fired (check lock screen)");
    setTimeout(() => setToast(null), 2500);
  }, [testFireNow]);

  const onPreviewUi = useCallback(() => {
    // Open the fallback full-screen UI so the driver / QA can see what the
    // alarm looks like even inside Expo Go / web.
    router.push({
      pathname: "/alarm",
      params: {
        scheduleId: next?.id ?? `preview-${Date.now()}`,
        title: next?.shift_type === "night" ? "Night shift starts in 1 hour" : "Shift starts in 1 hour",
        firedAt: String(Date.now()),
      },
    });
  }, [next, router]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <AppHeader title={t.profile} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <Card testID="profile-driver-card">
          <Text style={styles.name}>{driver?.name ?? "—"}</Text>
          <Text style={styles.mono}>{driver?.phone}</Text>
        </Card>

        <Card testID="profile-vehicle-card" style={{ marginTop: spacing.md }}>
          <Text style={styles.h2}>Vehicle</Text>
          <View style={styles.kv}>
            <Text style={styles.k}>Number</Text>
            <Text style={styles.v}>{driver?.vehicle_number ?? "—"}</Text>
          </View>
          <View style={styles.kv}>
            <Text style={styles.k}>Model</Text>
            <Text style={styles.v}>{vehicle?.model ?? "Citroën ëC3"}</Text>
          </View>
          <View style={styles.kv}>
            <Text style={styles.k}>Battery</Text>
            <Text style={styles.v}>{vehicle?.current_soc ?? "—"}%</Text>
          </View>
        </Card>

        <Card testID="profile-alarm-card" style={{ marginTop: spacing.md }}>
          <View style={styles.rowBetween}>
            <Text style={styles.h2}>Shift alarm</Text>
            <View style={[styles.badge, nativeAvailable ? styles.badgeOn : styles.badgeOff]}>
              <Text style={[styles.badgeText, nativeAvailable ? styles.badgeTextOn : styles.badgeTextOff]}>
                {nativeAvailable ? "Native ready" : "Preview only"}
              </Text>
            </View>
          </View>
          <Text style={styles.sub}>
            {nativeAvailable
              ? "Wakes your phone 1 hour before your shift. Survives Doze and reboot."
              : "Native alarm needs the production build. Use preview to test the UI."}
          </Text>

          <View style={styles.kv}>
            <Text style={styles.k}>Next shift</Text>
            <Text style={styles.v} testID="alarm-next-shift">{nextShift ?? "Not scheduled"}</Text>
          </View>
          <View style={styles.kv}>
            <Text style={styles.k}>Alarm at</Text>
            <Text style={styles.v} testID="alarm-fires-at">{nextAlarm ?? "—"}</Text>
          </View>
          <View style={styles.kv}>
            <Text style={styles.k}>Status</Text>
            <Text style={styles.v}>{next?.state ?? "—"}</Text>
          </View>

          <View style={styles.actions}>
            <TouchableOpacity
              testID="alarm-schedule-btn"
              style={styles.primary}
              onPress={() => setPickerOpen(true)}
            >
              <Text style={styles.primaryText}>Schedule shift</Text>
            </TouchableOpacity>
            <View style={styles.actionsRow}>
              <TouchableOpacity
                testID="alarm-test-native-btn"
                style={[styles.secondary, !nativeAvailable ? styles.secondaryDisabled : null]}
                onPress={onTestNative}
                disabled={!nativeAvailable}
              >
                <Text style={styles.secondaryText}>Fire native alarm</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="alarm-preview-btn"
                style={styles.secondary}
                onPress={onPreviewUi}
              >
                <Text style={styles.secondaryText}>Preview UI</Text>
              </TouchableOpacity>
            </View>
            <TouchableOpacity
              testID="alarm-refresh-btn"
              style={styles.ghost}
              onPress={refresh}
            >
              <Text style={styles.ghostText}>Refresh</Text>
            </TouchableOpacity>
          </View>
        </Card>

        <TouchableOpacity onPress={signOut} style={styles.logout} testID="logout-btn">
          <Text style={styles.logoutText}>{t.logout}</Text>
        </TouchableOpacity>
      </ScrollView>

      {toast ? (
        <View style={styles.toast} pointerEvents="none" testID="alarm-toast">
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}

      <Modal
        transparent
        animationType="slide"
        visible={pickerOpen}
        onRequestClose={() => setPickerOpen(false)}
      >
        <Pressable style={styles.sheetBackdrop} onPress={() => setPickerOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <View style={styles.sheetHandle} />
            <Text style={styles.sheetTitle}>When is your next shift?</Text>
            {SHIFT_PRESETS.map((p) => {
              const shiftStart = resolveShiftStart(p);
              return (
                <TouchableOpacity
                  key={p.label}
                  testID={`alarm-preset-${p.label.replace(/\W+/g, "-").toLowerCase()}`}
                  style={styles.sheetRow}
                  onPress={() => onPickPreset(p)}
                  disabled={busyPreset !== null}
                >
                  <View style={{ flex: 1 }}>
                    <Text style={styles.sheetRowTitle}>{p.label}</Text>
                    <Text style={styles.sheetRowSub}>{formatIST(shiftStart)}</Text>
                  </View>
                  <Text style={styles.sheetRowChevron}>
                    {busyPreset === p.label ? "…" : "›"}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  scroll: { padding: spacing.md, paddingBottom: 120 },
  name: { fontFamily: fonts.display, fontSize: 24, color: colors.ink },
  mono: { fontFamily: fonts.dataMed, fontSize: 14, color: colors.muted, marginTop: 4 },
  h2: { fontFamily: fonts.display, fontSize: 18, color: colors.ink, marginBottom: spacing.sm },
  sub: { fontFamily: fonts.ui, fontSize: 13, color: colors.muted, marginBottom: spacing.sm },
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.xs,
  },
  badge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999 },
  badgeOn: { backgroundColor: "#E7F3EC" },
  badgeOff: { backgroundColor: "#F3E3DF" },
  badgeText: { fontFamily: fonts.uiBold, fontSize: 11, letterSpacing: 0.6 },
  badgeTextOn: { color: colors.live },
  badgeTextOff: { color: colors.alert },
  kv: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  k: { fontFamily: fonts.uiMed, color: colors.muted, fontSize: 13 },
  v: { fontFamily: fonts.dataMed, color: colors.ink, fontSize: 14 },
  actions: { gap: spacing.sm, marginTop: spacing.md },
  actionsRow: { flexDirection: "row", gap: spacing.sm },
  primary: {
    backgroundColor: colors.live,
    borderRadius: radius.md,
    paddingVertical: 14,
    alignItems: "center",
  },
  primaryText: { fontFamily: fonts.uiBold, color: colors.white, fontSize: 15 },
  secondary: {
    flex: 1,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingVertical: 12,
    alignItems: "center",
    backgroundColor: colors.card,
  },
  secondaryDisabled: { opacity: 0.4 },
  secondaryText: { fontFamily: fonts.uiBold, color: colors.ink, fontSize: 13 },
  ghost: { paddingVertical: 10, alignItems: "center" },
  ghostText: { fontFamily: fonts.uiMed, color: colors.muted, fontSize: 13 },
  logout: {
    marginTop: spacing.xl,
    borderColor: colors.alert,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.lg,
    alignItems: "center",
  },
  logoutText: { fontFamily: fonts.uiBold, color: colors.alert, fontSize: 15 },
  toast: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    bottom: 100,
    backgroundColor: colors.ink,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  toastText: { fontFamily: fonts.uiMed, color: colors.white, fontSize: 13 },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(16,35,28,0.45)",
    justifyContent: "flex-end",
  },
  sheet: {
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
  sheetRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  sheetRowTitle: { fontFamily: fonts.uiBold, fontSize: 15, color: colors.ink },
  sheetRowSub: { fontFamily: fonts.ui, fontSize: 12, color: colors.muted, marginTop: 2 },
  sheetRowChevron: { fontFamily: fonts.uiBold, fontSize: 22, color: colors.muted },
});
