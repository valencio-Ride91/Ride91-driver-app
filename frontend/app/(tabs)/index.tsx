import React, { useCallback, useEffect, useState } from "react";
import {
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { AppHeader } from "@/src/components/AppHeader";
import { DutyStripe } from "@/src/components/DutyStripe";
import { DriverMap } from "@/src/components/DriverMap";
import { DepositSheet } from "@/src/components/DepositSheet";
import { colors, fonts, platformColors, platformLabels, radius, spacing } from "@/src/theme";
import { useI18n, formatDuration, formatINR } from "@/src/i18n";
import { useDuty } from "@/src/duty";
import { useTracking } from "@/src/tracking";
import { useAuth } from "@/src/auth";
import { api } from "@/src/api";

// Two clearly-labelled rows: Duty (Start/On/End) and Platform (Uber/Rapido/Ola/Not online).
// Ride91 is NOT in the platform list — Ride91 is the employment layer.
const PLATFORMS = ["uber", "rapido", "ola"] as const;

// States a driver may enter without today's walk-around capture on file.
const CAPTURE_EXEMPT_STATES = new Set(["not_online", "to_charger", "charging"]);

// The charging control is one button that walks the cycle, so the driver only
// ever sees the action that is actually valid next.
const CHARGE_NEXT: Record<string, { next: string; key: "go_to_charger" | "charging_start" | "charging_stop" }> = {
  to_charger: { next: "charging", key: "charging_start" },
  charging: { next: "not_online", key: "charging_stop" },
};

export default function Home() {
  const { t } = useI18n();
  const { today, switchState, refresh } = useDuty();
  const { lat, lng } = useTracking();
  const { vehicle } = useAuth();
  const router = useRouter();

  // Deposit banner. Driven by you_owe — the settled balance from reports up
  // to yesterday less every confirmed Razorpay payment — not by today's
  // provisional takings, which the driver has not been billed for yet.
  const [youOwe, setYouOwe] = useState(0);
  const [overLimit, setOverLimit] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        // The server compares against CASH_LIMIT, so the limit itself never
        // needs to come down the wire.
        const r = await api.get<{
          you_owe: number;
          cash_over_limit: boolean;
        }>("/money/today");
        if (!alive) return;
        setYouOwe(r.you_owe);
        setOverLimit(r.cash_over_limit);
      } catch {
        // keep previous
      }
    };
    load();
    const id = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Inspection status. Auto-redirect on first-of-day if not complete.
  const [inspectionOk, setInspectionOk] = useState<boolean | null>(null);
  const [captureOk, setCaptureOk] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [insp, cap] = await Promise.all([
          api.get<{ completed: boolean }>("/inspection/today"),
          api.get<{ completed: boolean }>("/go-online-capture/today"),
        ]);
        if (!alive) return;
        setInspectionOk(insp.completed);
        setCaptureOk(cap.completed);
      } catch {
        // keep prev
      }
    };
    load();
    const id = setInterval(load, 20000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const onDuty = !!today?.on_duty;
  const currentPlatform = today?.current_platform ?? null;
  // current_state is the raw latest row, which is what the charging cycle
  // keys off — current_platform only ever holds a platform-layer value.
  const currentState = today?.current_state ?? null;

  // Duty toggle: Start duty → routes through inspection first. End duty
  // simply appends end_duty. Both push a row into duty_states.
  const startDuty = useCallback(async () => {
    if (inspectionOk !== true) {
      router.push("/inspection");
      return;
    }
    await switchState("start_duty", () => {});
    setTimeout(refresh, 800);
  }, [inspectionOk, switchState, refresh, router]);

  const endDuty = useCallback(async () => {
    await switchState("end_duty", () => {});
    setTimeout(refresh, 800);
  }, [switchState, refresh]);

  const pickPlatform = useCallback(
    async (state: string) => {
      if (!onDuty) return;
      if (currentPlatform === state) return;
      // Gate: once per business day the driver must complete the guided
      // walk-around + selfie capture BEFORE going online on any platform.
      // Skips for "not_online" so drivers can toggle offline without
      // being forced through capture again, and for the charging states —
      // taking the car to a charger is not going online to earn, so
      // blocking it behind a walk-around would strand a flat car.
      if (!CAPTURE_EXEMPT_STATES.has(state) && captureOk === false) {
        router.push("/go-online-capture");
        return;
      }
      await switchState(state, () => {});
      setTimeout(refresh, 400);
    },
    [onDuty, currentPlatform, captureOk, switchState, refresh, router],
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <AppHeader title="Ride91" />

      {overLimit ? (
        <TouchableOpacity
          testID="deposit-banner"
          style={styles.depositBanner}
          onPress={() => setQrOpen(true)}
        >
          <Text style={styles.depositTitle} testID="deposit-banner-title">
            You owe {formatINR(youOwe)} · OVER LIMIT
          </Text>
          <Text style={styles.depositSub}>Deposit now →</Text>
        </TouchableOpacity>
      ) : youOwe > 0 ? (
        <TouchableOpacity
          testID="you-owe-banner"
          style={styles.depositBanner}
          onPress={() => setQrOpen(true)}
        >
          <Text style={styles.depositTitle}>
            You owe {formatINR(youOwe)} — deposit your cash to clear it.
          </Text>
        </TouchableOpacity>
      ) : null}

      <View style={styles.mapWrap} testID="home-map">
        <DriverMap lat={lat} lng={lng} />
      </View>

      <View style={styles.statusBar} testID="status-bar">
        {/* ROW 1 — Ride91 duty */}
        <View style={styles.rowBlock} testID="duty-row">
          <Text style={styles.rowLabel}>Ride91 duty</Text>
          {onDuty ? (
            <View style={styles.dutyRow}>
              <View style={styles.dutyPill}>
                <View style={styles.dutyDot} />
                <Text style={styles.dutyPillText}>
                  On duty · {formatDuration(today?.on_duty_seconds ?? 0)}
                </Text>
              </View>
              <TouchableOpacity
                testID="end-duty-btn"
                style={styles.endBtn}
                onPress={endDuty}
              >
                <Text style={styles.endBtnText}>End duty</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <TouchableOpacity
              testID="start-duty-btn"
              style={styles.startBtn}
              onPress={startDuty}
            >
              <Text style={styles.startBtnText}>Start duty</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* ROW 2 — Online on */}
        <View style={styles.rowBlock} testID="platform-row">
          <Text style={styles.rowLabel}>
            Online on
            {!onDuty ? (
              <Text style={styles.rowLabelHint}>  · start duty to enable</Text>
            ) : null}
          </Text>
          <View style={styles.platformRow}>
            {PLATFORMS.map((p) => {
              const active = currentPlatform === p;
              return (
                <TouchableOpacity
                  key={p}
                  testID={`platform-btn-${p}`}
                  disabled={!onDuty}
                  onPress={() => pickPlatform(p)}
                  style={[
                    styles.platformBtn,
                    {
                      backgroundColor: active
                        ? platformColors[p]
                        : colors.card,
                      borderColor: onDuty ? platformColors[p] : colors.line,
                      opacity: !onDuty ? 0.4 : 1,
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.platformDot,
                      {
                        backgroundColor: active
                          ? colors.white
                          : platformColors[p],
                      },
                    ]}
                  />
                  <Text
                    style={[
                      styles.platformBtnText,
                      { color: active ? colors.white : colors.ink },
                    ]}
                  >
                    {platformLabels[p]}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
          <TouchableOpacity
            testID="platform-btn-not_online"
            disabled={!onDuty}
            onPress={() => pickPlatform("not_online")}
            style={[
              styles.notOnlineBtn,
              currentPlatform === "not_online"
                ? { backgroundColor: colors.ink, borderColor: colors.ink }
                : null,
              !onDuty ? { opacity: 0.4 } : null,
            ]}
          >
            <Text
              style={[
                styles.notOnlineText,
                currentPlatform === "not_online"
                  ? { color: colors.white }
                  : null,
              ]}
            >
              Not online on any app
            </Text>
          </TouchableOpacity>

          {/* Charging. One button, three steps: to charger -> started ->
              stopped. Stopping returns the driver to "not online" rather
              than guessing which app they went back to. */}
          {(() => {
            const step = CHARGE_NEXT[currentState ?? ""] ?? {
              next: "to_charger",
              key: "go_to_charger" as const,
            };
            const charging = currentState === "charging";
            const heading = currentState === "to_charger" || charging;
            return (
              <TouchableOpacity
                testID={`charge-btn-${step.next}`}
                disabled={!onDuty}
                onPress={() => pickPlatform(step.next)}
                style={[
                  styles.chargeBtn,
                  heading
                    ? {
                        backgroundColor: platformColors[currentState ?? "charging"],
                        borderColor: platformColors[currentState ?? "charging"],
                      }
                    : null,
                  !onDuty ? { opacity: 0.4 } : null,
                ]}
              >
                <Text
                  style={[styles.chargeBtnText, heading ? { color: colors.white } : null]}
                >
                  {t[step.key]}
                </Text>
              </TouchableOpacity>
            );
          })()}
        </View>

        {/* Stats: distance from vehicle GPS; battery/range hidden when SoC unknown */}
        <View style={styles.statsRow}>
          <StatCol
            testID="stat-distance"
            label={t.distance}
            value={`${(today?.distance_km ?? 0).toFixed(1)} km`}
          />
          {vehicle?.current_soc != null ? (
            <>
              <StatCol
                testID="stat-battery"
                label={t.battery}
                value={`${vehicle.current_soc}%`}
                valueColor={vehicle.current_soc < 25 ? colors.alert : colors.ink}
              />
              <StatCol
                testID="stat-range"
                label={t.range}
                value={
                  vehicle.current_range_km != null
                    ? `${vehicle.current_range_km} km`
                    : "—"
                }
              />
            </>
          ) : (
            <StatCol
              testID="stat-battery-unknown"
              label={t.battery}
              value="—"
            />
          )}
        </View>
      </View>

      <View style={styles.stripeCard}>
        <DutyStripe
          segments={today?.segments ?? []}
          shiftSeconds={24 * 3600}
          workingSeconds={today?.working_seconds ?? 0}
        />
      </View>

      {/* onPaid is omitted: the /money/today poll above already refreshes
          youOwe every 15s, so the banner settles on its own. */}
      <DepositSheet
        visible={qrOpen}
        onClose={() => setQrOpen(false)}
        duesPaise={Math.round(Math.max(0, youOwe) * 100)}
      />
    </SafeAreaView>
  );
}

const StatCol: React.FC<{ label: string; value: string; valueColor?: string; testID?: string }> = ({
  label,
  value,
  valueColor,
  testID,
}) => (
  <View style={styles.statCol} testID={testID}>
    <Text style={styles.statLabel}>{label}</Text>
    <Text style={[styles.statValue, valueColor ? { color: valueColor } : null]}>{value}</Text>
  </View>
);

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  depositBanner: {
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    backgroundColor: colors.alert,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  depositTitle: { fontFamily: fonts.uiBold, fontSize: 14, color: colors.white },
  depositSub: {
    fontFamily: fonts.uiMed,
    fontSize: 12,
    color: colors.white,
    opacity: 0.9,
    marginTop: 2,
  },
  mapWrap: {
    flex: 1,
    backgroundColor: colors.line,
    marginHorizontal: spacing.md,
    marginTop: spacing.sm,
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  statusBar: {
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.line,
    gap: spacing.md,
  },
  rowBlock: { gap: 6 },
  rowLabel: {
    fontFamily: fonts.uiBold,
    fontSize: 11,
    color: colors.muted,
    letterSpacing: 1,
    textTransform: "uppercase",
  },
  rowLabelHint: {
    fontFamily: fonts.ui,
    fontSize: 11,
    color: colors.muted,
    textTransform: "none",
    letterSpacing: 0,
  },
  dutyRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  dutyPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.live,
    borderRadius: 999,
  },
  dutyDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.white },
  dutyPillText: { fontFamily: fonts.uiBold, fontSize: 13, color: colors.white },
  startBtn: {
    backgroundColor: colors.live,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  startBtnText: { fontFamily: fonts.uiBold, fontSize: 15, color: colors.white },
  endBtn: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  endBtnText: { fontFamily: fonts.uiBold, fontSize: 13, color: colors.ink },
  platformRow: { flexDirection: "row", gap: spacing.sm },
  platformBtn: {
    flex: 1,
    borderWidth: 2,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: "center",
    gap: 4,
  },
  platformDot: { width: 8, height: 8, borderRadius: 4 },
  platformBtnText: { fontFamily: fonts.uiBold, fontSize: 13 },
  notOnlineBtn: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingVertical: spacing.sm,
    alignItems: "center",
  },
  notOnlineText: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.ink },
  chargeBtn: {
    marginTop: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: platformColors.charging,
    paddingVertical: spacing.sm,
    alignItems: "center",
  },
  chargeBtnText: {
    fontFamily: fonts.uiMed,
    fontSize: 13,
    color: platformColors.charging,
  },
  statsRow: { flexDirection: "row", justifyContent: "space-between", gap: spacing.md },
  statCol: { flex: 1 },
  statLabel: { fontFamily: fonts.ui, fontSize: 11, color: colors.muted, marginBottom: 2 },
  statValue: { fontFamily: fonts.dataMed, fontSize: 18, color: colors.ink },
  stripeCard: {
    marginHorizontal: spacing.md,
    marginTop: spacing.md,
    marginBottom: spacing.md,
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.line,
  },
});
