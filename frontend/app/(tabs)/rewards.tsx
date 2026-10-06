import React, { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppHeader } from "@/src/components/AppHeader";
import { Card } from "@/src/components/ui";
import { AttendanceCard, AttendanceState } from "@/src/components/AttendanceCard";
import { LoyaltyMilestonesCard, LoyaltyState } from "@/src/components/LoyaltyMilestonesCard";
import { api } from "@/src/api";
import { useI18n, formatINR } from "@/src/i18n";
import { useCardText } from "@/src/i18n/cards";
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
interface Loyalty {
  year: string;
  loyalty: LoyaltyState;
  wallet?: { enabled: boolean; per_day: number; qualifying_days: number; daily_accrued: number; milestone_credit: number; accrued: number; paid: number; balance: number; forfeited: number; active: boolean };
  attendance?: AttendanceState;
}

export default function RewardsTab() {
  const { t } = useI18n();
  const c = useCardText();
  const [rewards, setRewards] = useState<Rewards | null>(null);
  const [loyalty, setLoyalty] = useState<Loyalty | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, l] = await Promise.all([
        api.get<Rewards>("/money/rewards"),
        api.get<Loyalty>("/money/loyalty").catch(() => null),
      ]);
      setRewards(r);
      if (l) setLoyalty(l);
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
            <Text style={styles.cardTitle}>{c.this_week}</Text>
            <Text style={styles.hint}>{c.on_top_30}</Text>
          </View>
          <View style={styles.daysRow} testID="reward-days">
            <Text style={styles.daysLabel}>{c.days_operated}</Text>
            <Text style={[styles.daysValue, allDays ? { color: colors.live } : null]}>
              {rewards?.days_operated ?? 0} / {rewards?.days_required ?? 7}
            </Text>
          </View>
          {rewards ? (
            <>
              <RewardRow tier={rewards.daily} label={c.tier_daily} note={c.note_daily} testID="reward-daily" />
              <RewardRow tier={rewards.top_car_week} label={c.tier_car_week} note={c.note_car_week(rewards.days_required)} testID="reward-car-week" />
              <RewardRow tier={rewards.top_driver_week} label={c.tier_driver_week} note={c.note_driver_week} testID="reward-driver-week" />
            </>
          ) : (
            <Text style={styles.hint}>{c.loading}</Text>
          )}
        </Card>

        {loyalty?.attendance?.enabled ? (
          <AttendanceCard data={loyalty.attendance} style={{ marginTop: spacing.md }} />
        ) : null}

        {loyalty?.wallet?.enabled ? (
          <Card testID="rewards-wallet-card" style={{ marginTop: spacing.md }}>
            <View style={styles.head}>
              <Text style={styles.cardTitle}>{c.wallet_title}</Text>
              <Text style={styles.hint}>{c.wallet_hint}</Text>
            </View>
            <Text style={[styles.hero, { color: colors.live }]}>{formatINR(loyalty.wallet.balance)}</Text>
            <Text style={styles.sub}>
              {c.wallet_from_days(formatINR(loyalty.wallet.daily_accrued), loyalty.wallet.qualifying_days)}
              {loyalty.wallet.milestone_credit > 0 ? c.wallet_milestones(formatINR(loyalty.wallet.milestone_credit)) : ""}
              {loyalty.wallet.paid > 0 ? c.wallet_paid(formatINR(loyalty.wallet.paid)) : ""}
            </Text>
            <Text style={styles.note}>{c.wallet_note}</Text>
          </Card>
        ) : null}

        {loyalty ? (
          <LoyaltyMilestonesCard data={loyalty.loyalty} style={{ marginTop: spacing.md }} />
        ) : null}

        <Card testID="rewards-tip-card" style={{ marginTop: spacing.md }}>
          <Text style={styles.cardTitle}>{c.how_to_win}</Text>
          <Text style={styles.tip}>{c.tip_all_days}</Text>
          <Text style={styles.tip}>{c.tip_safe}</Text>
          <Text style={styles.tip}>{c.tip_on_top}</Text>
        </Card>
      </ScrollView>
    </SafeAreaView>
  );
}

const RewardRow: React.FC<{ tier: RewardTier; label: string; note: string; testID?: string }> = ({ tier, label, note, testID }) => {
  const pctW = `${Math.round((tier.progress ?? 0) * 100)}%` as const;
  return (
    <View style={styles.reward} testID={testID}>
      <View style={styles.rewardHead}>
        <Text style={styles.rewardLabel}>{tier.qualified ? "✅ " : ""}{label}</Text>
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
  hero: { fontFamily: fonts.dataMed, fontSize: 34, color: colors.ink, marginTop: 2 },
  sub: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.muted, marginTop: 2 },
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
  note: { fontFamily: fonts.ui, fontSize: 11, color: colors.muted, marginTop: spacing.sm },
});
