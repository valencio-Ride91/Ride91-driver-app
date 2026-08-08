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

export default function Home() {
  const { t } = useI18n();
  const { today, switchState, refresh } = useDuty();
  const { lat, lng } = useTracking();
  const { driver, vehicle } = useAuth();
  const router = useRouter();

  // Deposit banner state (unchanged behaviour).
  const [cashHeld, setCashHeld] = useState(0);
  const [cashLimit, setCashLimit] = useState(1500);
  const [youOwe, setYouOwe] = useState(0);
  const [qrOpen, setQrOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await api.get<{
          cash_in_hand: number;
          cash_limit: number;
          you_owe: number;
        }>("/money/today");
        if (!alive) return;
        setCashHeld(r.cash_in_hand);
        setCashLimit(r.cash_limit);
        setYouOwe(r.you_owe);
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
  const overLimit = cashHeld > cashLimit;

  // Inspection status. Auto-redirect on first-of-day if not complete.
  const [inspectionOk, setInspectionOk] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await api.get<{ completed: boolean }>("/inspection/today");
        if (alive) setInspectionOk(r.completed);
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
      await switchState(state, () => {});
      setTimeout(refresh, 400);
    },
    [onDuty, currentPlatform, switchState, refresh],
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
            Cash with you {formatINR(cashHeld)} · OVER LIMIT
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

      <DepositSheet
        visible={qrOpen}
        onClose={() => setQrOpen(false)}
        driverId={driver?.id ?? ""}
        qrCode={driver?.qr_code ?? ""}
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
