import React, { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppHeader } from "@/src/components/AppHeader";
import { Card } from "@/src/components/ui";
import { CollectionQrCard } from "@/src/components/CollectionQrCard";
import { SalaryCard } from "@/src/components/SalaryCard";
import { api } from "@/src/api";
import { useI18n, formatINR } from "@/src/i18n";
import { useCardText } from "@/src/i18n/cards";
import { colors, fonts, platformColors, platformLabels, radius, spacing } from "@/src/theme";

// Ride91 settles on the PREVIOUS day: the driver's earnings and dues are the
// share of yesterday's settled platform report, not today's provisional takings.
interface MoneyYesterday {
  business_date: string;
  settled: boolean;
  gross: number;
  cash_collected: number;
  deposited: number;
  net_cash_from_day: number;
  share_rate: number;
  driver_share: number;
  per_platform: Record<string, { gross: number; cash: number; status: string }>;
  you_owe: number;
  in_credit: number;
  balance: number;
  cash_limit: number;
  cash_over_limit: boolean;
}

const PLATFORMS = ["uber", "rapido", "ola"] as const;

type Period = "yesterday" | "week" | "month";
interface Earnings {
  period: Period;
  label: string;
  gross: number;
  driver_share: number;
  share_rate: number;
  days_operated: number;
}
// `label` names the entry in the card dictionary, so it follows the language.
const PERIODS: { key: Period; label: "period_yesterday" | "period_week" | "period_month" }[] = [
  { key: "yesterday", label: "period_yesterday" },
  { key: "week", label: "period_week" },
  { key: "month", label: "period_month" },
];

export default function Money() {
  const { t } = useI18n();
  const c = useCardText();
  const [day, setDay] = useState<MoneyYesterday | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [period, setPeriod] = useState<Period>("yesterday");
  const [earn, setEarn] = useState<Earnings | null>(null);

  const load = useCallback(async () => {
    try {
      setDay(await api.get<MoneyYesterday>("/money/yesterday"));
    } catch {
      // keep whatever we had
    }
  }, []);

  const loadEarn = useCallback(async (p: Period) => {
    try {
      setEarn(await api.get<Earnings>(`/money/earnings?period=${p}`));
    } catch {
      // keep whatever we had
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, [load]);

  // Refetch earnings when the selected period changes, and keep it fresh.
  useEffect(() => {
    loadEarn(period);
    const id = setInterval(() => loadEarn(period), 20000);
    return () => clearInterval(id);
  }, [period, loadEarn]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await Promise.all([load(), loadEarn(period)]);
    setRefreshing(false);
  }, [load, loadEarn, period]);

  const inCredit = (day?.in_credit ?? 0) > 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <AppHeader title={t.money} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* CARD 0 — the driver's collection QR (show to riders) */}
        <CollectionQrCard />

        {/* CARD 1 — Earnings (period selector: yesterday / week / month) */}
        <Card testID="earnings-card" style={{ marginTop: spacing.md }}>
          <View style={styles.heroHead}>
            <Text style={styles.cardKicker}>{c.earnings}</Text>
            {period === "yesterday" ? (
              <View style={styles.badge}>
                <Text style={[styles.badgeText, { color: day?.settled ? colors.live : colors.amber }]}>
                  {day?.settled ? c.settled : c.pending}
                </Text>
              </View>
            ) : null}
          </View>

          {/* Period selector */}
          <View style={styles.segment} testID="earnings-period">
            {PERIODS.map((p) => {
              const on = period === p.key;
              return (
                <TouchableOpacity
                  key={p.key}
                  testID={`period-${p.key}`}
                  style={[styles.segBtn, on ? styles.segBtnOn : null]}
                  onPress={() => setPeriod(p.key)}
                >
                  <Text style={[styles.segText, on ? styles.segTextOn : null]}>{c[p.label]}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={styles.hero} testID="earnings-share">{formatINR(earn?.driver_share ?? 0)}</Text>
          <Text style={styles.sub}>
            {c.earn_sub(c[PERIODS.find((p) => p.key === period)!.label], Math.round((earn?.share_rate ?? 0.3) * 100), formatINR(earn?.gross ?? 0))}
            {period !== "yesterday" && (earn?.days_operated ?? 0) > 0 ? c.earn_days(earn!.days_operated) : ""}
          </Text>
        </Card>

        {/* Salary cash-out — what the driver can withdraw, and the button to ask for it */}
        <SalaryCard style={{ marginTop: spacing.md }} />

        {/* CARD 2 — Yesterday's cash (collected vs deposited) */}
        <Card testID="yesterday-cash-card" style={{ marginTop: spacing.md }}>
          <Text style={styles.cardTitle}>{c.yesterdays_cash}</Text>
          {PLATFORMS.map((p) => {
            const row = day?.per_platform?.[p];
            const has = !!row && (row.cash > 0 || row.gross > 0);
            return (
              <MoneyLine
                key={p}
                testID={`y-cash-${p}`}
                label={c.platform_cash(platformLabels[p])}
                swatch={platformColors[p]}
                value={has ? formatINR(row!.cash) : "—"}
                muted={!has}
              />
            );
          })}
          <View style={styles.hr} />
          <MoneyLine testID="y-cash-total" label={c.cash_collected} value={formatINR(day?.cash_collected ?? 0)} bold />
          <MoneyLine
            testID="y-deposited"
            label={c.deposited}
            value={`− ${formatINR(day?.deposited ?? 0)}`}
            color={(day?.deposited ?? 0) > 0 ? colors.live : colors.ink}
          />
          <View style={styles.hr} />
          <MoneyLine testID="y-net-cash" label={c.cash_to_settle} value={formatINR(Math.max(0, day?.net_cash_from_day ?? 0))} bold />
        </Card>

        {/* CARD 3 — Cash in hand: collection cash the driver still has to hand in */}
        <Card testID="balance-card" style={{ marginTop: spacing.md }}>
          <Text style={styles.cardTitle}>{c.your_balance}</Text>
          <MoneyLine
            testID="balance-owed"
            label={inCredit ? c.in_credit : c.you_owe}
            value={formatINR(inCredit ? day!.in_credit : Math.max(0, day?.you_owe ?? 0))}
            bold
            color={day?.cash_over_limit ? colors.alert : inCredit ? colors.live : colors.ink}
          />
          {day?.cash_over_limit ? (
            <View style={styles.overLimitBanner} testID="over-limit-banner">
              <Text style={styles.overLimitBannerText}>{c.over_limit_deposit(day.cash_limit)}</Text>
            </View>
          ) : null}
        </Card>

      </ScrollView>
    </SafeAreaView>
  );
}

const MoneyLine: React.FC<{
  label: string;
  value: string;
  swatch?: string;
  bold?: boolean;
  color?: string;
  muted?: boolean;
  testID?: string;
}> = ({ label, value, swatch, bold, color, muted, testID }) => (
  <View style={styles.line} testID={testID}>
    <View style={styles.lineLeft}>
      {swatch ? <View style={[styles.dot, { backgroundColor: swatch }]} /> : null}
      <Text style={[styles.lineLabel, bold ? { fontFamily: fonts.uiBold } : null, muted ? { color: colors.muted } : null]}>
        {label}
      </Text>
    </View>
    <Text
      style={[
        styles.lineVal,
        bold ? { fontFamily: fonts.dataMed } : null,
        color ? { color } : null,
        muted ? { color: colors.muted, fontFamily: fonts.ui, fontSize: 13 } : null,
      ]}
    >
      {value}
    </Text>
  </View>
);

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  scroll: { padding: spacing.md, paddingBottom: spacing.xxl * 3 },
  heroHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  cardKicker: { fontFamily: fonts.uiBold, fontSize: 11, color: colors.muted, letterSpacing: 1 },
  cardTitle: { fontFamily: fonts.display, fontSize: 18, color: colors.ink, marginBottom: spacing.sm },
  hero: { fontFamily: fonts.dataMed, fontSize: 40, color: colors.ink, marginTop: 4 },
  sub: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.muted, marginTop: 4 },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.line },
  badgeText: { fontFamily: fonts.uiBold, fontSize: 10, letterSpacing: 0.5 },
  segment: { flexDirection: "row", gap: 6, marginTop: spacing.sm },
  segBtn: { flex: 1, paddingVertical: 7, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, alignItems: "center", backgroundColor: colors.paper },
  segBtnOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  segText: { fontFamily: fonts.uiMed, fontSize: 12, color: colors.muted },
  segTextOn: { color: colors.white, fontFamily: fonts.uiBold },
  line: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 6 },
  lineLeft: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexShrink: 1 },
  lineLabel: { fontFamily: fonts.uiMed, fontSize: 14, color: colors.ink },
  lineVal: { fontFamily: fonts.data, fontSize: 15, color: colors.ink },
  dot: { width: 8, height: 8, borderRadius: 4 },
  hr: { height: 1, backgroundColor: colors.line, marginVertical: 4 },
  overLimitBanner: { backgroundColor: colors.alert, borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.xs, marginBottom: spacing.xs },
  overLimitBannerText: { fontFamily: fonts.uiBold, color: colors.white, fontSize: 12, textAlign: "center" },
});
