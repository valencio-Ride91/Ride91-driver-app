import React, { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppHeader } from "@/src/components/AppHeader";
import { Card } from "@/src/components/ui";
import { DepositSheet } from "@/src/components/DepositSheet";
import { PayDuesButton } from "@/src/components/PayDuesButton";
import { PayoutsHistoryCard } from "@/src/components/PayoutsHistoryCard";
import { api } from "@/src/api";
import { useI18n, formatINR } from "@/src/i18n";
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

function fmtDay(iso: string): string {
  try {
    return new Date(iso + "T00:00:00").toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
  } catch {
    return iso;
  }
}

export default function Money() {
  const { t } = useI18n();
  const [day, setDay] = useState<MoneyYesterday | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await api.get<MoneyYesterday>("/money/yesterday");
      setDay(d);
    } catch {
      // keep whatever we had
    }
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 20000);
    return () => clearInterval(id);
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const inCredit = (day?.in_credit ?? 0) > 0;

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <AppHeader title={t.money} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* CARD 1 — Yesterday's earnings (the settled figure) */}
        <Card testID="yesterday-earnings-card">
          <View style={styles.heroHead}>
            <Text style={styles.cardKicker}>Yesterday's earnings</Text>
            <View style={styles.badge}>
              <Text style={[styles.badgeText, { color: day?.settled ? colors.live : colors.amber }]}>
                {day?.settled ? "SETTLED" : "PENDING"}
              </Text>
            </View>
          </View>
          <Text style={styles.hero} testID="yesterday-share">{formatINR(day?.driver_share ?? 0)}</Text>
          <Text style={styles.sub}>
            {day ? fmtDay(day.business_date) : "—"} · your {Math.round((day?.share_rate ?? 0.3) * 100)}% of {formatINR(day?.gross ?? 0)} gross
          </Text>
        </Card>

        {/* CARD 2 — Yesterday's cash (collected vs deposited) */}
        <Card testID="yesterday-cash-card" style={{ marginTop: spacing.md }}>
          <Text style={styles.cardTitle}>Yesterday's cash</Text>
          {PLATFORMS.map((p) => {
            const row = day?.per_platform?.[p];
            const has = !!row && (row.cash > 0 || row.gross > 0);
            return (
              <MoneyLine
                key={p}
                testID={`y-cash-${p}`}
                label={`${platformLabels[p]} cash`}
                swatch={platformColors[p]}
                value={has ? formatINR(row!.cash) : "—"}
                muted={!has}
              />
            );
          })}
          <View style={styles.hr} />
          <MoneyLine testID="y-cash-total" label="Cash collected" value={formatINR(day?.cash_collected ?? 0)} bold />
          <MoneyLine
            testID="y-deposited"
            label="Deposited"
            value={`− ${formatINR(day?.deposited ?? 0)}`}
            color={(day?.deposited ?? 0) > 0 ? colors.live : colors.ink}
          />
          <View style={styles.hr} />
          <MoneyLine testID="y-net-cash" label="Cash to settle from yesterday" value={formatINR(Math.max(0, day?.net_cash_from_day ?? 0))} bold />
        </Card>

        {/* CARD 3 — Running balance (what you owe overall) */}
        <Card testID="balance-card" style={{ marginTop: spacing.md }}>
          <Text style={styles.cardTitle}>Your balance</Text>
          <MoneyLine
            testID="balance-owed"
            label={inCredit ? "In credit" : "You owe"}
            value={formatINR(inCredit ? day!.in_credit : Math.max(0, day?.you_owe ?? 0))}
            bold
            color={day?.cash_over_limit ? colors.alert : inCredit ? colors.live : colors.ink}
          />
          {day?.cash_over_limit ? (
            <View style={styles.overLimitBanner} testID="over-limit-banner">
              <Text style={styles.overLimitBannerText}>Over ₹{day.cash_limit} — deposit now</Text>
            </View>
          ) : null}
          <TouchableOpacity testID="deposit-now-btn" style={styles.depositCta} onPress={() => setQrOpen(true)}>
            <Text style={styles.depositCtaText}>Deposit now</Text>
          </TouchableOpacity>
          <PayDuesButton duesPaise={Math.round(Math.max(0, day?.you_owe ?? 0) * 100)} onPaid={load} />
        </Card>

        {/* CARD 4 — Payouts history (RazorpayX) */}
        <Card testID="payouts-card" style={{ marginTop: spacing.md }}>
          <PayoutsHistoryCard />
        </Card>
      </ScrollView>

      <DepositSheet
        visible={qrOpen}
        onClose={() => setQrOpen(false)}
        duesPaise={Math.round(Math.max(0, day?.you_owe ?? 0) * 100)}
        onPaid={load}
      />
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
  line: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 6 },
  lineLeft: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexShrink: 1 },
  lineLabel: { fontFamily: fonts.uiMed, fontSize: 14, color: colors.ink },
  lineVal: { fontFamily: fonts.data, fontSize: 15, color: colors.ink },
  dot: { width: 8, height: 8, borderRadius: 4 },
  hr: { height: 1, backgroundColor: colors.line, marginVertical: 4 },
  overLimitBanner: { backgroundColor: colors.alert, borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.xs, marginBottom: spacing.xs },
  overLimitBannerText: { fontFamily: fonts.uiBold, color: colors.white, fontSize: 12, textAlign: "center" },
  depositCta: {
    marginTop: spacing.md,
    backgroundColor: colors.ink,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  depositCtaText: { fontFamily: fonts.uiBold, color: colors.white, fontSize: 14 },
});
