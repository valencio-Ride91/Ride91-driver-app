import React, { useCallback, useEffect, useState } from "react";
import {
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppHeader } from "@/src/components/AppHeader";
import { BottomSheet } from "@/src/components/ui";
import { DutyStripe } from "@/src/components/DutyStripe";
import { DriverMap } from "@/src/components/DriverMap";
import { colors, fonts, platformColors, platformLabels, radius, spacing } from "@/src/theme";
import { useI18n, formatDuration } from "@/src/i18n";
import { useDuty } from "@/src/duty";
import { useTracking } from "@/src/tracking";
import { useAuth } from "@/src/auth";
import { useSync } from "@/src/sync";

const PLATFORMS = ["ride91", "uber", "rapido", "ola"] as const;

interface CloseOutTarget {
  platform: string;
  from_ts: string;
  to_ts: string;
}

export default function Home() {
  const { t } = useI18n();
  const { today, switchState, refresh } = useDuty();
  const { lat, lng } = useTracking();
  const { vehicle } = useAuth();
  const { enqueue } = useSync();

  const [selectorOpen, setSelectorOpen] = useState(false);
  const [closeOut, setCloseOut] = useState<CloseOutTarget | null>(null);
  const [trips, setTrips] = useState("");
  const [amount, setAmount] = useState("");
  const [cash, setCash] = useState("");

  // If driver hasn't picked a state yet today, open the sheet automatically.
  useEffect(() => {
    if (today && !today.current_state) {
      setSelectorOpen(true);
    }
  }, [today]);

  const current = today?.current_state ?? null;

  const handleSwitch = useCallback(
    async (state: string) => {
      setSelectorOpen(false);
      await switchState(state, (info) => {
        setCloseOut(info);
        setTrips("");
        setAmount("");
        setCash("");
      });
    },
    [switchState],
  );

  const saveCloseOut = useCallback(async () => {
    if (!closeOut) return;
    await enqueue("/close-out", {
      platform: closeOut.platform,
      from_ts: closeOut.from_ts,
      to_ts: closeOut.to_ts,
      trips: parseInt(trips || "0", 10),
      gross_amount: parseFloat(amount || "0"),
      cash_collected: parseFloat(cash || "0"),
    });
    setCloseOut(null);
    setTimeout(refresh, 800);
  }, [closeOut, trips, amount, cash, enqueue, refresh]);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <AppHeader title="Ride91" />

      <View style={styles.mapWrap} testID="home-map">
        <DriverMap lat={lat} lng={lng} />
      </View>

      {/* Sticky status bar pinned above the map */}
      <View style={styles.statusBar} testID="status-bar">
        <TouchableOpacity
          testID="status-current-platform"
          onPress={() => setSelectorOpen(true)}
          style={[
            styles.currentPill,
            {
              backgroundColor: current ? platformColors[current] ?? colors.muted : colors.ink,
            },
          ]}
        >
          <Text style={styles.currentPillText}>
            {current ? platformLabels[current] : t.pick_platform}
          </Text>
        </TouchableOpacity>

        <View style={styles.statsRow}>
          <StatCol
            testID="stat-on-duty"
            label={t.on_duty}
            value={formatDuration(today?.working_seconds ?? 0)}
          />
          <StatCol
            testID="stat-distance"
            label={t.distance}
            value={`${(today?.distance_km ?? 0).toFixed(1)} km`}
          />
          <StatCol
            testID="stat-battery"
            label={t.battery}
            value={`${vehicle?.current_soc ?? "—"}%`}
            valueColor={(vehicle?.current_soc ?? 100) < 25 ? colors.alert : colors.ink}
          />
          <StatCol
            testID="stat-range"
            label={t.range}
            value={`${vehicle?.current_range_km ?? "—"} km`}
          />
        </View>
      </View>

      <View style={styles.stripeCard}>
        <DutyStripe
          segments={today?.segments ?? []}
          shiftSeconds={today?.shift_seconds ?? 0}
          workingSeconds={today?.working_seconds ?? 0}
        />
      </View>

      {/* Platform selector sheet */}
      <BottomSheet
        visible={selectorOpen}
        onClose={() => setSelectorOpen(false)}
        title={t.pick_platform}
        testID="platform-sheet"
      >
        <View style={styles.grid}>
          {PLATFORMS.map((p) => (
            <TouchableOpacity
              key={p}
              testID={`platform-btn-${p}`}
              onPress={() => handleSwitch(p)}
              style={[
                styles.gridBtn,
                {
                  backgroundColor: current === p ? platformColors[p] : colors.card,
                  borderColor: platformColors[p],
                },
              ]}
            >
              <View style={[styles.gridDot, { backgroundColor: platformColors[p] }]} />
              <Text
                style={[
                  styles.gridBtnText,
                  { color: current === p ? colors.white : colors.ink },
                ]}
              >
                {platformLabels[p]}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        <TouchableOpacity
          testID="platform-btn-offline"
          onPress={() => handleSwitch("offline")}
          style={[
            styles.offlineBtn,
            current === "offline" ? { backgroundColor: colors.ink, borderColor: colors.ink } : null,
          ]}
        >
          <Text
            style={[
              styles.offlineText,
              current === "offline" ? { color: colors.white } : null,
            ]}
          >
            {t.go_offline}
          </Text>
        </TouchableOpacity>
      </BottomSheet>

      {/* Close-out sheet */}
      <BottomSheet
        visible={!!closeOut}
        onClose={() => setCloseOut(null)}
        title={t.close_out_title}
        testID="close-out-sheet"
      >
        {closeOut ? (
          <>
            <Text style={styles.closeOutHint}>
              {t.close_out_hint}  ·  {platformLabels[closeOut.platform]}
            </Text>
            <FieldRow label={t.trips}>
              <TextInput
                testID="close-out-trips"
                value={trips}
                onChangeText={setTrips}
                keyboardType="number-pad"
                style={styles.field}
                placeholder="0"
                placeholderTextColor={colors.muted}
              />
            </FieldRow>
            <FieldRow label={t.amount_earned}>
              <TextInput
                testID="close-out-amount"
                value={amount}
                onChangeText={setAmount}
                keyboardType="numeric"
                style={styles.field}
                placeholder="₹0"
                placeholderTextColor={colors.muted}
              />
            </FieldRow>
            <FieldRow label={t.cash_collected}>
              <TextInput
                testID="close-out-cash"
                value={cash}
                onChangeText={setCash}
                keyboardType="numeric"
                style={styles.field}
                placeholder="₹0"
                placeholderTextColor={colors.muted}
              />
            </FieldRow>
            <View style={styles.sheetActions}>
              <TouchableOpacity
                testID="close-out-cancel"
                style={styles.secondaryBtn}
                onPress={() => setCloseOut(null)}
              >
                <Text style={styles.secondaryText}>{t.cancel}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                testID="close-out-save"
                style={styles.primaryBtn}
                onPress={saveCloseOut}
              >
                <Text style={styles.primaryText}>{t.save}</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : null}
      </BottomSheet>
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

const FieldRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <View style={styles.fieldRow}>
    <Text style={styles.fieldLabel}>{label}</Text>
    {children}
  </View>
);

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
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
  currentPill: {
    alignSelf: "flex-start",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
  },
  currentPillText: { fontFamily: fonts.uiBold, fontSize: 16, color: colors.white },
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
  grid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  gridBtn: {
    width: "48%",
    borderRadius: radius.md,
    borderWidth: 2,
    padding: spacing.lg,
    alignItems: "center",
    gap: spacing.sm,
  },
  gridDot: { width: 10, height: 10, borderRadius: 5 },
  gridBtnText: { fontFamily: fonts.uiBold, fontSize: 16 },
  offlineBtn: {
    marginTop: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    padding: spacing.lg,
    alignItems: "center",
    backgroundColor: colors.card,
  },
  offlineText: { fontFamily: fonts.uiBold, fontSize: 15, color: colors.ink },
  closeOutHint: {
    fontFamily: fonts.uiMed,
    fontSize: 13,
    color: colors.muted,
    marginBottom: spacing.md,
  },
  fieldRow: { marginBottom: spacing.md },
  fieldLabel: {
    fontFamily: fonts.uiMed,
    fontSize: 13,
    color: colors.muted,
    marginBottom: spacing.xs,
  },
  field: {
    backgroundColor: colors.paper,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontFamily: fonts.dataMed,
    fontSize: 18,
    color: colors.ink,
  },
  sheetActions: { flexDirection: "row", gap: spacing.md, marginTop: spacing.md },
  primaryBtn: {
    flex: 1,
    backgroundColor: colors.live,
    borderRadius: radius.md,
    padding: spacing.lg,
    alignItems: "center",
  },
  primaryText: { fontFamily: fonts.uiBold, fontSize: 16, color: colors.white },
  secondaryBtn: {
    flex: 1,
    borderColor: colors.line,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.lg,
    alignItems: "center",
  },
  secondaryText: { fontFamily: fonts.uiBold, fontSize: 16, color: colors.ink },
});
