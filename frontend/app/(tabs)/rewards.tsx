import React, { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppHeader } from "@/src/components/AppHeader";
import { Card } from "@/src/components/ui";
import { api } from "@/src/api";
import { useI18n, formatINR } from "@/src/i18n";
import { colors, fonts, spacing } from "@/src/theme";

interface RewardTier {
  label: string;
  target: number;
  value: number;
  qualified: boolean;
  progress: number;
  reward: number;
  all_days?: boolean;
}
interface Rewards {
  week_start: string;
  days_operated: number;
  days_required: number;
  share_rate: number;
  daily: RewardTier;
  top_car_week: RewardTier;
  top_driver_week: RewardTier;
}

export default function RewardsTab() {
  const { t } = useI18n();
  const [rewards, setRewards] = useState<Rewards | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setRewards(await api.get<Rewards>("/money/rewards"));
    } catch {
      // keep whatever we had
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 30000);
    return () => clearInterval(id);
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const allDays = (rewards?.days_operated ?? 0) >= (rewards?.days_required ?? 7);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <AppHeader title={t.rewards} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        <Card testID="rewards-week-card">
          <View style={styles.head}>
            <Text style={styles.cardTitle}>This week 🏆</Text>
            <Text style={styles.hint}>on top of your 30%</Text>
          </View>
          <View style={styles.daysRow} testID="reward-days">
            <Text style={styles.daysLabel}>Days operated</Text>
            <Text style={[styles.daysValue, allDays ? { color: colors.live } : null]}>
              {rewards?.days_operated ?? 0} / {rewards?.days_required ?? 7}
            </Text>
          </View>
          {rewards ? (
            <>
              <RewardRow tier={rewards.daily} note="yesterday's earnings" testID="reward-daily" />
              <RewardRow tier={rewards.top_car_week} note={`this week · all ${rewards.days_required} days needed`} testID="reward-car-week" />
              <RewardRow tier={rewards.top_driver_week} note="your earnings this week" testID="reward-driver-week" />
            </>
          ) : (
            <Text style={styles.hint}>Loading…</Text>
          )}
        </Card>

        <Card testID="rewards-tip-card" style={{ marginTop: spacing.md }}>
          <Text style={styles.cardTitle}>How to win</Text>
          <Text style={styles.tip}>• Keep the car running all 7 days.</Text>
          <Text style={styles.tip}>• Earn at least ₹4,000 gross every day.</Text>
          <Text style={styles.tip}>• Safe driving and good service count for Top Driver.</Text>
          <Text style={styles.tip}>Rewards are paid on top of your 30% earnings.</Text>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

const RewardRow: React.FC<{ tier: RewardTier; note: string; testID?: string }> = ({ tier, note, testID }) => {
  const pctW = `${Math.round((tier.progress ?? 0) * 100)}%` as const;
  return (
    <View style={styles.reward} testID={testID}>
      <View style={styles.rewardHead}>
        <Text style={styles.rewardLabel}>{tier.qualified ? "✅ " : ""}{tier.label}</Text>
        <Text style={styles.rewardAmount}>+{formatINR(tier.reward)}</Text>
      </View>
      <View style={styles.bar}>
        <View style={[styles.barFill, { width: pctW, backgroundColor: tier.qualified ? colors.live : colors.amber }]} />
      </View>
      <View style={styles.rewardFoot}>
        <Text style={styles.rewardProgress}>{formatINR(tier.value)} / {formatINR(tier.target)}</Text>
        <Text style={styles.rewardNote}>{note}</Text>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  scroll: { padding: spacing.md, paddingBottom: spacing.xxl * 3 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardTitle: { fontFamily: fonts.display, fontSize: 18, color: colors.ink, marginBottom: spacing.sm },
  hint: { fontFamily: fonts.uiMed, fontSize: 11, color: colors.muted },
  daysRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.line, marginBottom: 4 },
  daysLabel: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.muted },
  daysValue: { fontFamily: fonts.dataMed, fontSize: 15, color: colors.ink },
  reward: { paddingVertical: spacing.sm },
  rewardHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  rewardLabel: { fontFamily: fonts.uiBold, fontSize: 14, color: colors.ink, flexShrink: 1 },
  rewardAmount: { fontFamily: fonts.dataMed, fontSize: 14, color: colors.live },
  bar: { height: 8, borderRadius: 4, backgroundColor: colors.line, marginTop: 6, overflow: "hidden" },
  barFill: { height: 8, borderRadius: 4 },
  rewardFoot: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 4 },
  rewardProgress: { fontFamily: fonts.data, fontSize: 12, color: colors.ink },
  rewardNote: { fontFamily: fonts.ui, fontSize: 11, color: colors.muted },
  tip: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.ink, paddingVertical: 3 },
});
