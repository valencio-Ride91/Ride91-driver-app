// Full-screen fallback alarm UI (web / Expo Go).
// Route: /alarm?scheduleId=...&phase=start|end&title=...&firedAt=...
// On production Android the native AlarmActivity takes over — this route
// mirrors the UX for previews and web-only usage.

import React, { useCallback, useMemo, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";

import { useAuth } from "@/src/auth";
import { useShiftAlarm } from "@/src/shift-alarms";
import { colors, fonts, radius, spacing } from "@/src/theme";

const REASONS: { code: string; label: string }[] = [
  { code: "unwell", label: "Unwell" },
  { code: "family_emergency", label: "Family emergency" },
  { code: "vehicle_problem", label: "Vehicle problem" },
  { code: "transport_problem", label: "Transport problem" },
  { code: "personal", label: "Personal" },
  { code: "other", label: "Other" },
];

export default function AlarmScreen() {
  const params = useLocalSearchParams<{
    scheduleId?: string;
    phase?: string;
    title?: string;
    firedAt?: string;
  }>();
  const router = useRouter();
  const { driver } = useAuth();
  const { submitAlarmResponse, refresh, endEta } = useShiftAlarm();

  const phase: "start" | "end" = params.phase === "end" ? "end" : "start";
  const firedAt = useMemo(
    () => (params.firedAt ? Number(params.firedAt) : Date.now()),
    [params.firedAt],
  );
  const scheduleId = params.scheduleId ?? `local-${firedAt}`;
  const title =
    params.title ??
    (phase === "end" ? "Shift ends soon — head back to hub" : "Shift starts in 1 hour");

  const [mode, setMode] = useState<"choose" | "reason">("choose");
  const [reasonPickerOpen, setReasonPickerOpen] = useState(false);
  const [reasonCode, setReasonCode] = useState<string>(REASONS[0].code);
  const [submitting, setSubmitting] = useState(false);
  const [snoozed, setSnoozed] = useState(false);

  const respond = useCallback(
    async (
      response: "awake" | "not_coming" | "snooze" | "heading_back" | "delayed",
      chosenReason?: string,
    ) => {
      if (submitting) return;
      setSubmitting(true);
      try {
        await submitAlarmResponse(
          {
            scheduleId,
            response: response as "awake" | "not_coming" | "snooze",
            reasonCode: response === "not_coming" ? chosenReason ?? reasonCode : null,
            firedAt,
            respondedAt: Date.now(),
          },
          phase,
        );
        setTimeout(refresh, 400);
      } finally {
        setSubmitting(false);
      }
      if (response === "snooze") {
        setSnoozed(true);
        setTimeout(() => router.replace("/(tabs)"), 800);
        return;
      }
      router.replace("/(tabs)");
    },
    [submitting, submitAlarmResponse, scheduleId, phase, reasonCode, firedAt, refresh, router],
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top", "bottom"]}>
      <View style={styles.body}>
        <Text style={styles.kicker}>
          RIDE91 · {phase === "end" ? "SHIFT END ALARM" : "SHIFT ALARM"}
        </Text>
        <Text style={styles.title} testID="alarm-title">
          {title}
        </Text>
        {driver?.name ? <Text style={styles.driver}>Hi {driver.name}</Text> : null}

        {phase === "end" && endEta?.has_hub ? (
          <View style={styles.etaStrip} testID="alarm-eta-strip">
            <View style={styles.etaCol}>
              <Text style={styles.etaLabel}>Distance</Text>
              <Text style={styles.etaValue}>
                {(endEta.distance_km ?? 0).toFixed(1)} km
              </Text>
            </View>
            <View style={styles.etaCol}>
              <Text style={styles.etaLabel}>ETA to hub</Text>
              <Text style={styles.etaValue}>{Math.max(0, Math.round(endEta.eta_minutes ?? 0))} min</Text>
            </View>
            <View style={styles.etaCol}>
              <Text style={styles.etaLabel}>Shift ends</Text>
              <Text style={styles.etaValue}>{Math.max(0, Math.round(endEta.remaining_minutes ?? 0))} min</Text>
            </View>
          </View>
        ) : null}

        {snoozed ? (
          <Text style={styles.snoozeMsg}>Snoozed — we&apos;ll ring again in 10 minutes.</Text>
        ) : mode === "choose" ? (
          phase === "end" ? (
            <View style={styles.actions}>
              <TouchableOpacity
                testID="alarm-heading-back"
                style={styles.primary}
                onPress={() => respond("heading_back")}
                disabled={submitting}
              >
                <Text style={styles.primaryText}>Heading back to hub now</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="alarm-delayed"
                style={styles.warn}
                onPress={() => respond("delayed")}
                disabled={submitting}
              >
                <Text style={styles.warnText}>Running late — inform dispatch</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="alarm-snooze"
                style={styles.ghost}
                onPress={() => respond("snooze")}
                disabled={submitting}
              >
                <Text style={styles.ghostText}>Snooze 10 minutes (once)</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.actions}>
              <TouchableOpacity
                testID="alarm-awake"
                style={styles.primary}
                onPress={() => respond("awake")}
                disabled={submitting}
              >
                <Text style={styles.primaryText}>Awake and coming for duty</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="alarm-not-coming"
                style={styles.danger}
                onPress={() => setMode("reason")}
                disabled={submitting}
              >
                <Text style={styles.dangerText}>Not coming</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="alarm-snooze"
                style={styles.ghost}
                onPress={() => respond("snooze")}
                disabled={submitting}
              >
                <Text style={styles.ghostText}>Snooze 10 minutes (once)</Text>
              </TouchableOpacity>
            </View>
          )
        ) : (
          <View style={styles.actions}>
            <Text style={styles.reasonLabel}>Reason (required)</Text>
            <TouchableOpacity
              testID="alarm-reason-btn"
              style={styles.select}
              onPress={() => setReasonPickerOpen(true)}
            >
              <Text style={styles.selectText}>
                {REASONS.find((r) => r.code === reasonCode)?.label ?? "Choose reason"}
              </Text>
              <Text style={styles.selectCaret}>▾</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="alarm-confirm-not-coming"
              style={styles.primary}
              onPress={() => respond("not_coming", reasonCode)}
              disabled={submitting}
            >
              <Text style={styles.primaryText}>Confirm — not coming</Text>
            </TouchableOpacity>
            <TouchableOpacity
              testID="alarm-back"
              style={styles.ghost}
              onPress={() => setMode("choose")}
              disabled={submitting}
            >
              <Text style={styles.ghostText}>Back</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>

      <Modal
        transparent
        animationType="fade"
        visible={reasonPickerOpen}
        onRequestClose={() => setReasonPickerOpen(false)}
      >
        <Pressable style={styles.sheetBackdrop} onPress={() => setReasonPickerOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => undefined}>
            <Text style={styles.sheetTitle}>Choose reason</Text>
            {REASONS.map((r) => (
              <TouchableOpacity
                key={r.code}
                testID={`alarm-reason-${r.code}`}
                style={styles.sheetRow}
                onPress={() => {
                  setReasonCode(r.code);
                  setReasonPickerOpen(false);
                }}
              >
                <View style={[styles.radio, r.code === reasonCode ? styles.radioOn : null]} />
                <Text style={styles.sheetRowText}>{r.label}</Text>
              </TouchableOpacity>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.ink },
  body: { flex: 1, padding: spacing.xl, justifyContent: "center" },
  kicker: {
    fontFamily: fonts.uiBold,
    fontSize: 12,
    color: colors.live,
    letterSpacing: 2,
    marginBottom: spacing.sm,
  },
  title: {
    fontFamily: fonts.display,
    fontSize: 32,
    color: colors.white,
    lineHeight: 38,
    marginBottom: spacing.md,
  },
  driver: { fontFamily: fonts.uiMed, fontSize: 15, color: "#B7C4BE", marginBottom: spacing.lg },
  etaStrip: {
    flexDirection: "row",
    gap: spacing.md,
    backgroundColor: "#182A24",
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  etaCol: { flex: 1 },
  etaLabel: {
    fontFamily: fonts.uiBold,
    fontSize: 10,
    color: "#B7C4BE",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  etaValue: { fontFamily: fonts.dataMed, fontSize: 20, color: colors.white },
  actions: { gap: spacing.md, marginTop: spacing.sm },
  primary: {
    backgroundColor: colors.live,
    borderRadius: radius.md,
    paddingVertical: 20,
    alignItems: "center",
  },
  primaryText: { fontFamily: fonts.uiBold, color: colors.white, fontSize: 16 },
  danger: {
    backgroundColor: colors.alert,
    borderRadius: radius.md,
    paddingVertical: 20,
    alignItems: "center",
  },
  dangerText: { fontFamily: fonts.uiBold, color: colors.white, fontSize: 16 },
  warn: {
    backgroundColor: colors.amber,
    borderRadius: radius.md,
    paddingVertical: 20,
    alignItems: "center",
  },
  warnText: { fontFamily: fonts.uiBold, color: colors.ink, fontSize: 16 },
  ghost: {
    borderRadius: radius.md,
    paddingVertical: 16,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#2E403A",
  },
  ghostText: { fontFamily: fonts.uiMed, color: "#EEF1EC", fontSize: 14 },
  reasonLabel: {
    fontFamily: fonts.uiBold,
    fontSize: 12,
    color: "#B7C4BE",
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  select: {
    borderRadius: radius.md,
    backgroundColor: "#182A24",
    paddingHorizontal: spacing.lg,
    paddingVertical: 18,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  selectText: { fontFamily: fonts.uiMed, color: colors.white, fontSize: 15 },
  selectCaret: { color: "#B7C4BE", fontSize: 16 },
  snoozeMsg: {
    fontFamily: fonts.uiMed,
    color: "#EEF1EC",
    fontSize: 15,
    textAlign: "center",
    marginTop: spacing.xl,
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.lg,
  },
  sheetTitle: {
    fontFamily: fonts.display,
    fontSize: 18,
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
  sheetRowText: { fontFamily: fonts.uiMed, fontSize: 15, color: colors.ink },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: colors.muted },
  radioOn: { borderColor: colors.live, backgroundColor: colors.live },
});
