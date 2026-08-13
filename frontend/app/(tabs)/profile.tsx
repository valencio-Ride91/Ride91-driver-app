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

// Shift-start presets. The picker also lets the driver choose a shift length
// (or "no end alarm") for the shift-end alarm — so we can compute shift_end.
const SHIFT_PRESETS: { label: string; hoursFromNow: number; type: "day" | "night" }[] = [
  { label: "In 2 hours (day)", hoursFromNow: 2, type: "day" },
  { label: "In 5 hours (day)", hoursFromNow: 5, type: "day" },
  { label: "Tomorrow 6 AM", hoursFromNow: -1, type: "day" },
  { label: "Tonight 10 PM (night)", hoursFromNow: -2, type: "night" },
];

const DURATIONS: { label: string; hours: number | null }[] = [
  { label: "6 hours", hours: 6 },
  { label: "8 hours", hours: 8 },
  { label: "10 hours", hours: 10 },
  { label: "12 hours", hours: 12 },
  { label: "No end alarm", hours: null },
];

function resolveShiftStart(preset: (typeof SHIFT_PRESETS)[number]): Date {
  const now = new Date();
  if (preset.hoursFromNow > 0) {
    return new Date(now.getTime() + preset.hoursFromNow * 3600 * 1000);
  }
  // IST-based sentinels — build the IST wall-clock and convert to UTC.
  const nowIST = new Date(now.getTime() + 5.5 * 3600 * 1000);
  const y = nowIST.getUTCFullYear();
  const m = nowIST.getUTCMonth();
  const d = nowIST.getUTCDate();
  if (preset.hoursFromNow === -1) {
    const istWall = new Date(Date.UTC(y, m, d + 1, 6, 0, 0));
    return new Date(istWall.getTime() - 5.5 * 3600 * 1000);
  }
  const todayIstWall = new Date(Date.UTC(y, m, d, 22, 0, 0));
  const todayUtc = new Date(todayIstWall.getTime() - 5.5 * 3600 * 1000);
  if (todayUtc.getTime() > now.getTime()) return todayUtc;
  const tomorrowIstWall = new Date(Date.UTC(y, m, d + 1, 22, 0, 0));
  return new Date(tomorrowIstWall.getTime() - 5.5 * 3600 * 1000);
}

export default function Profile() {
  const { t } = useI18n();
  const { driver, vehicle, signOut } = useAuth();
  const { next, endEta, scheduleShift, testFireNow, refresh, nativeAvailable } = useShiftAlarm();
  const router = useRouter();

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerStep, setPickerStep] = useState<"start" | "duration">("start");
  const [chosenPreset, setChosenPreset] = useState<(typeof SHIFT_PRESETS)[number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const nextAlarm = useMemo(() => (next?.alarm_fires_at ? formatIST(next.alarm_fires_at) : null), [next]);
  const nextShift = useMemo(() => (next?.shift_start ? formatIST(next.shift_start) : null), [next]);
  const shiftEnd = useMemo(() => (next?.shift_end ? formatIST(next.shift_end) : null), [next]);

  const showToast = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(null), 2500);
  };

  const onPickPreset = useCallback((p: (typeof SHIFT_PRESETS)[number]) => {
    setChosenPreset(p);
    setPickerStep("duration");
  }, []);

  const onPickDuration = useCallback(
    async (d: (typeof DURATIONS)[number]) => {
      if (!chosenPreset || busy) return;
      setBusy(true);
      try {
        const shiftStart = resolveShiftStart(chosenPreset);
        const shiftEndIso =
          d.hours == null
            ? undefined
            : new Date(shiftStart.getTime() + d.hours * 3600 * 1000).toISOString();
        const r = await scheduleShift({
          shift_start: shiftStart.toISOString(),
          shift_type: chosenPreset.type,
          shift_end: shiftEndIso,
        });
        setPickerOpen(false);
        setPickerStep("start");
        setChosenPreset(null);
        showToast(r ? "Alarm scheduled" : "Could not schedule — try again");
      } finally {
        setBusy(false);
      }
    },
    [chosenPreset, busy, scheduleShift],
  );

  const onTestNative = useCallback(
    async (phase: "start" | "end") => {
      await testFireNow({ phase });
      showToast(`Native ${phase} alarm fired (check lock screen)`);
    },
    [testFireNow],
  );

  const onPreviewUi = useCallback(
    (phase: "start" | "end") => {
      router.push({
        pathname: "/alarm",
        params: {
          scheduleId: next?.id ?? `preview-${Date.now()}`,
          phase,
          title:
            phase === "end"
              ? "Shift ends soon — head back to hub"
              : next?.shift_type === "night"
                ? "Night shift starts in 1 hour"
                : "Shift starts in 1 hour",
          firedAt: String(Date.now()),
        },
      });
    },
    [next, router],
  );

  const hubText =
    driver?.hub_name
      ? `${driver.hub_name} · ${driver.hub_lat?.toFixed(4)}, ${driver.hub_lng?.toFixed(4)}`
      : "Hub not set";

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
          <View style={styles.kv}>
            <Text style={styles.k}>Home hub</Text>
            <Text style={styles.v} testID="profile-hub-info">{hubText}</Text>
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
              ? "Wakes your phone 1 hour before the shift starts and again when it's time to head back to the hub."
              : "Native alarm needs the production build. Use Preview to test the UI on web / Expo Go."}
          </Text>

          {/* Start alarm block */}
          <Text style={styles.section}>Start alarm</Text>
          <View style={styles.kv}>
            <Text style={styles.k}>Next shift</Text>
            <Text style={styles.v} testID="alarm-next-shift">{nextShift ?? "Not scheduled"}</Text>
          </View>
          <View style={styles.kv}>
            <Text style={styles.k}>Fires at</Text>
            <Text style={styles.v} testID="alarm-fires-at">{nextAlarm ?? "—"}</Text>
          </View>
          <View style={styles.kv}>
            <Text style={styles.k}>Status</Text>
            <Text style={styles.v}>{next?.state ?? "—"}</Text>
          </View>

          {/* End alarm block */}
          <Text style={styles.section}>End alarm (dynamic ETA)</Text>
          <View style={styles.kv}>
            <Text style={styles.k}>Shift ends</Text>
            <Text style={styles.v} testID="alarm-shift-end">{shiftEnd ?? "Not scheduled"}</Text>
          </View>
          {endEta?.has_end_alarm && endEta?.has_hub ? (
            <>
              <View style={styles.kv}>
                <Text style={styles.k}>Distance to hub</Text>
                <Text style={styles.v} testID="alarm-distance">
                  {(endEta.distance_km ?? 0).toFixed(2)} km
                </Text>
              </View>
              <View style={styles.kv}>
                <Text style={styles.k}>ETA</Text>
                <Text style={styles.v} testID="alarm-eta">
                  {Math.max(0, Math.round(endEta.eta_minutes ?? 0))} min
                  {typeof endEta.avg_speed_kmph === "number"
                    ? `  ·  avg ${endEta.avg_speed_kmph.toFixed(0)} km/h`
                    : ""}
                </Text>
              </View>
              <View style={styles.kv}>
                <Text style={styles.k}>Alarm at</Text>
                <Text style={styles.v} testID="alarm-end-fires-at">
                  {endEta.alarm_at ? formatIST(endEta.alarm_at) : "—"}
                </Text>
              </View>
              <View style={styles.kv}>
                <Text style={styles.k}>Status</Text>
                <Text style={styles.v}>
                  {endEta.should_alarm_now
                    ? "🟠 fire window open"
                    : next?.end_state ?? "—"}
                </Text>
              </View>
            </>
          ) : next?.shift_end && !endEta?.has_hub ? (
            <Text style={styles.mutedNote}>Set a home hub to enable dynamic ETA-to-hub alarm.</Text>
          ) : null}

          <View style={styles.actions}>
            <TouchableOpacity
              testID="alarm-schedule-btn"
              style={styles.primary}
              onPress={() => {
                setPickerStep("start");
                setChosenPreset(null);
                setPickerOpen(true);
              }}
            >
              <Text style={styles.primaryText}>Schedule shift</Text>
            </TouchableOpacity>
            <View style={styles.actionsRow}>
              <TouchableOpacity
                testID="alarm-preview-start-btn"
                style={styles.secondary}
                onPress={() => onPreviewUi("start")}
              >
                <Text style={styles.secondaryText}>Preview start UI</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="alarm-preview-end-btn"
                style={styles.secondary}
                onPress={() => onPreviewUi("end")}
              >
                <Text style={styles.secondaryText}>Preview end UI</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.actionsRow}>
              <TouchableOpacity
                testID="alarm-test-native-start-btn"
                style={[styles.secondary, !nativeAvailable ? styles.secondaryDisabled : null]}
                onPress={() => onTestNative("start")}
                disabled={!nativeAvailable}
              >
                <Text style={styles.secondaryText}>Fire native · start</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="alarm-test-native-end-btn"
                style={[styles.secondary, !nativeAvailable ? styles.secondaryDisabled : null]}
                onPress={() => onTestNative("end")}
                disabled={!nativeAvailable}
              >
                <Text style={styles.secondaryText}>Fire native · end</Text>
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
            {pickerStep === "start" ? (
              <>
                <Text style={styles.sheetTitle}>When is your next shift?</Text>
                {SHIFT_PRESETS.map((p) => {
                  const s = resolveShiftStart(p);
                  return (
                    <TouchableOpacity
                      key={p.label}
                      testID={`alarm-preset-${p.label.replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase()}`}
                      style={styles.sheetRow}
                      onPress={() => onPickPreset(p)}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={styles.sheetRowTitle}>{p.label}</Text>
                        <Text style={styles.sheetRowSub}>{formatIST(s)}</Text>
                      </View>
                      <Text style={styles.sheetRowChevron}>›</Text>
                    </TouchableOpacity>
                  );
                })}
              </>
            ) : (
              <>
                <Text style={styles.sheetTitle}>How long is your shift?</Text>
                <Text style={styles.sheetSub}>
                  Start: {chosenPreset ? formatIST(resolveShiftStart(chosenPreset)) : "—"}
                </Text>
                {DURATIONS.map((d) => (
                  <TouchableOpacity
                    key={d.label}
                    testID={`alarm-duration-${d.label.replace(/[^\w]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase()}`}
                    style={styles.sheetRow}
                    onPress={() => onPickDuration(d)}
                    disabled={busy}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={styles.sheetRowTitle}>{d.label}</Text>
                      {d.hours != null && chosenPreset ? (
                        <Text style={styles.sheetRowSub}>
                          Ends: {formatIST(new Date(resolveShiftStart(chosenPreset).getTime() + d.hours * 3600 * 1000))}
                        </Text>
                      ) : null}
                    </View>
                    <Text style={styles.sheetRowChevron}>{busy ? "…" : "›"}</Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity
                  testID="alarm-picker-back"
                  style={styles.ghost}
                  onPress={() => setPickerStep("start")}
                  disabled={busy}
                >
                  <Text style={styles.ghostText}>Back</Text>
                </TouchableOpacity>
              </>
            )}
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
  section: {
    fontFamily: fonts.uiBold,
    fontSize: 11,
    color: colors.muted,
    letterSpacing: 1,
    textTransform: "uppercase",
    marginTop: spacing.md,
    marginBottom: 4,
  },
  mutedNote: {
    fontFamily: fonts.ui,
    fontSize: 12,
    color: colors.muted,
    paddingVertical: spacing.sm,
  },
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
  v: { fontFamily: fonts.dataMed, color: colors.ink, fontSize: 14, textAlign: "right", maxWidth: "60%" },
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
  sheetSub: {
    fontFamily: fonts.ui,
    fontSize: 13,
    color: colors.muted,
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
