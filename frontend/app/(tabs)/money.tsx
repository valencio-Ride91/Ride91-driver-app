import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppHeader } from "@/src/components/AppHeader";
import { Card } from "@/src/components/ui";
import { DepositSheet } from "@/src/components/DepositSheet";
import { EarningsUploader } from "@/src/components/EarningsUploader";
import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { useI18n, formatINR } from "@/src/i18n";
import { colors, fonts, platformColors, platformLabels, radius, spacing } from "@/src/theme";

interface MoneyToday {
  business_date: string;
  per_platform: Record<string, { cash_collected: number; status: "pending" | "provisional" | "settled" }>;
  total_cash_fares: number;
  qr_fares: number;
  deposits: number;
  cash_in_hand: number;
  cash_limit: number;
  cash_over_limit: boolean;
  you_owe: number;
}

interface MoneyWeek {
  week_start: string;
  week_end_exclusive: string;
  days_remaining: number;
  per_platform: Record<string, { settled_gross: number; provisional_gross: number }>;
  total_settled: number;
  total_provisional: number;
  estimated_gross: number;
  driver_share: number;
  share_rate: number;
  cash_held: number;
  advance: { principal: number; daily_recovery: number; days_remaining: number };
  advance_recovery_week: number;
  payable_estimate: number;
}

type ExpandKey = "share" | "cash" | "advance" | "payable" | null;

const PLATFORMS = ["uber", "rapido", "ola"] as const;

export default function Money() {
  const { t } = useI18n();
  const { driver } = useAuth();
  const [today, setToday] = useState<MoneyToday | null>(null);
  const [week, setWeek] = useState<MoneyWeek | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [expand, setExpand] = useState<ExpandKey>(null);
  const [qrOpen, setQrOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([
        api.get<MoneyToday>("/money/today"),
        api.get<MoneyWeek>("/money/week"),
      ]);
      setToday(a);
      setWeek(b);
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

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <AppHeader title={t.money} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* CARD 1 — Monday payout */}
        <Card testID="week-card">
          <Text style={styles.cardKicker}>Monday payout</Text>
          <Text style={styles.hero} testID="week-payable">
            {formatINR(Math.max(0, week?.payable_estimate ?? 0))}
          </Text>
          <View style={styles.subRow}>
            <Text style={styles.sub}>
              {(week?.days_remaining ?? 0) === 0
                ? "Payout today"
                : `${week?.days_remaining ?? 0} days to Monday`}
            </Text>
            <View style={styles.badge}>
              <Text style={styles.badgeText}>
                {(week?.total_settled ?? 0) > 0 && (week?.total_provisional ?? 0) > 0
                  ? "Mixed · settled + provisional"
                  : (week?.total_provisional ?? 0) > 0
                  ? "Provisional"
                  : "Settled"}
              </Text>
            </View>
          </View>
        </Card>

        {/* CARD 2 — Cash today (subtraction breakdown) */}
        <Card testID="cash-today-card" style={{ marginTop: spacing.md }}>
          <Text style={styles.cardTitle}>Cash today</Text>
          {PLATFORMS.map((p) => {
            const row = today?.per_platform?.[p];
            const pending = !row || row.status === "pending";
            return (
              <MoneyLine
                key={p}
                testID={`cash-line-${p}`}
                label={`${platformLabels[p]} cash collected`}
                swatch={platformColors[p]}
                value={pending ? "pending" : formatINR(row?.cash_collected ?? 0)}
                muted={pending}
              />
            );
          })}
          <View style={styles.hr} />
          <MoneyLine
            testID="cash-total-fares"
            label="Total cash fares"
            value={formatINR(today?.total_cash_fares ?? 0)}
            bold
          />
          <MoneyLine
            testID="cash-qr-fares"
            label="Paid to you by QR"
            value={`− ${formatINR(today?.qr_fares ?? 0)}`}
          />
          <MoneyLine
            testID="cash-deposits"
            label="Already deposited"
            value={`− ${formatINR(today?.deposits ?? 0)}`}
          />
          <View style={styles.hr} />
          <MoneyLine
            testID="cash-in-hand"
            label="Cash with you"
            value={formatINR(Math.max(0, today?.cash_in_hand ?? 0))}
            bold
            color={today?.cash_over_limit ? colors.alert : colors.ink}
          />
          {today?.cash_over_limit ? (
            <View style={styles.overLimitBanner} testID="over-limit-banner">
              <Text style={styles.overLimitBannerText}>
                Over ₹{today.cash_limit} — deposit now
              </Text>
            </View>
          ) : null}
          <View style={styles.cardActions}>
            <View style={{ flex: 1 }}>
              <EarningsUploader onImported={load} />
            </View>
          </View>
          <TouchableOpacity
            testID="deposit-now-btn"
            style={styles.depositCta}
            onPress={() => setQrOpen(true)}
          >
            <Text style={styles.depositCtaText}>Deposit now</Text>
          </TouchableOpacity>
        </Card>

        {/* CARD 3 — Earnings this week (settled vs provisional) */}
        <Card testID="week-earnings-card" style={{ marginTop: spacing.md }}>
          <Text style={styles.cardTitle}>Earnings this week</Text>
          {PLATFORMS.map((p) => {
            const row = week?.per_platform?.[p] ?? { settled_gross: 0, provisional_gross: 0 };
            return (
              <View style={styles.weekRow} key={p} testID={`week-line-${p}`}>
                <View style={styles.weekLeft}>
                  <View style={[styles.dot, { backgroundColor: platformColors[p] }]} />
                  <Text style={styles.weekLabel}>{platformLabels[p]}</Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  {row.settled_gross > 0 ? (
                    <Text style={styles.weekVal}>
                      {formatINR(row.settled_gross)}{" "}
                      <Text style={styles.settledBadge}>SETTLED</Text>
                    </Text>
                  ) : null}
                  {row.provisional_gross > 0 ? (
                    <Text style={styles.weekVal}>
                      {formatINR(row.provisional_gross)}{" "}
                      <Text style={styles.provBadge}>PROVISIONAL</Text>
                    </Text>
                  ) : null}
                  {row.settled_gross === 0 && row.provisional_gross === 0 ? (
                    <Text style={styles.weekMuted}>—</Text>
                  ) : null}
                </View>
              </View>
            );
          })}
        </Card>

        {/* CARD 4 — How Monday is calculated */}
        <Card testID="how-monday-card" style={{ marginTop: spacing.md }}>
          <Text style={styles.cardTitle}>How Monday is calculated</Text>
          <SettleRow
            label="Your share (30%)"
            value={formatINR(week?.driver_share ?? 0)}
            color={colors.live}
            open={expand === "share"}
            onPress={() => setExpand(expand === "share" ? null : "share")}
            testID="settle-share"
            details={
              <View>
                <DetailLine k="Estimated gross" v={formatINR(week?.estimated_gross ?? 0)} />
                <DetailLine k="Share rate" v={`${Math.round((week?.share_rate ?? 0.3) * 100)}%`} />
                <DetailLine k="= Your share" v={formatINR(week?.driver_share ?? 0)} bold />
              </View>
            }
          />
          <SettleRow
            label="− Cash with you"
            value={formatINR(week?.cash_held ?? 0)}
            open={expand === "cash"}
            onPress={() => setExpand(expand === "cash" ? null : "cash")}
            testID="settle-cash"
            details={
              <View>
                <DetailLine k="Limit" v={formatINR(today?.cash_limit ?? 1500)} />
                <DetailLine k="Held" v={formatINR(week?.cash_held ?? 0)} />
              </View>
            }
          />
          <SettleRow
            label="− Advance recovery"
            value={formatINR(week?.advance_recovery_week ?? 0)}
            open={expand === "advance"}
            onPress={() => setExpand(expand === "advance" ? null : "advance")}
            testID="settle-advance"
            details={
              <View>
                <DetailLine k="Principal" v={formatINR(week?.advance?.principal ?? 0)} />
                <DetailLine k="Daily recovery" v={formatINR(week?.advance?.daily_recovery ?? 0)} />
                <DetailLine k="Days remaining" v={`${week?.advance?.days_remaining ?? 0}`} />
                <DetailLine
                  k="This week"
                  v={formatINR(week?.advance_recovery_week ?? 0)}
                  bold
                />
              </View>
            }
          />
          <View style={styles.hr} />
          <SettleRow
            label="Payable"
            value={formatINR(Math.max(0, week?.payable_estimate ?? 0))}
            bold
            open={expand === "payable"}
            onPress={() => setExpand(expand === "payable" ? null : "payable")}
            testID="settle-payable"
            details={
              <View>
                <DetailLine k="Your share" v={formatINR(week?.driver_share ?? 0)} />
                <DetailLine k="− Cash with you" v={formatINR(week?.cash_held ?? 0)} />
                <DetailLine
                  k="− Advance recovery"
                  v={formatINR(week?.advance_recovery_week ?? 0)}
                />
                <DetailLine
                  k="= Payable"
                  v={formatINR(Math.max(0, week?.payable_estimate ?? 0))}
                  bold
                />
              </View>
            }
          />
        </Card>
      </ScrollView>

      <DepositSheet
        visible={qrOpen}
        onClose={() => setQrOpen(false)}
        driverId={driver?.id ?? ""}
        qrCode={driver?.qr_code ?? ""}
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

const SettleRow: React.FC<{
  label: string;
  value: string;
  color?: string;
  bold?: boolean;
  open: boolean;
  onPress: () => void;
  details: React.ReactNode;
  testID: string;
}> = ({ label, value, color, bold, open, onPress, details, testID }) => (
  <View>
    <TouchableOpacity style={styles.settleRow} onPress={onPress} testID={testID}>
      <Text style={styles.settleLabel}>{label}</Text>
      <View style={styles.settleRight}>
        <Text
          style={[
            styles.settleValue,
            color ? { color } : null,
            bold ? { fontFamily: fonts.dataMed } : null,
          ]}
        >
          {value}
        </Text>
        <Text style={styles.chev}>{open ? "▾" : "▸"}</Text>
      </View>
    </TouchableOpacity>
    {open ? <View style={styles.settleDetails} testID={`${testID}-details`}>{details}</View> : null}
  </View>
);

const DetailLine: React.FC<{ k: string; v: string; bold?: boolean }> = ({ k, v, bold }) => (
  <View style={styles.detailLine}>
    <Text style={[styles.detailKey, bold ? { fontFamily: fonts.uiBold } : null]}>{k}</Text>
    <Text style={[styles.detailVal, bold ? { fontFamily: fonts.dataMed } : null]}>{v}</Text>
  </View>
);

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  scroll: { padding: spacing.md, paddingBottom: spacing.xxl * 3 },
  cardKicker: { fontFamily: fonts.uiBold, fontSize: 11, color: colors.muted, letterSpacing: 1 },
  cardTitle: { fontFamily: fonts.display, fontSize: 18, color: colors.ink, marginBottom: spacing.sm },
  hero: { fontFamily: fonts.dataMed, fontSize: 40, color: colors.ink, marginTop: 4 },
  subRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4 },
  sub: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.muted },
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4, backgroundColor: colors.paper, borderWidth: 1, borderColor: colors.line },
  badgeText: { fontFamily: fonts.uiBold, fontSize: 10, color: colors.muted, letterSpacing: 0.5 },
  line: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 6 },
  lineLeft: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexShrink: 1 },
  lineLabel: { fontFamily: fonts.uiMed, fontSize: 14, color: colors.ink },
  lineVal: { fontFamily: fonts.data, fontSize: 15, color: colors.ink },
  dot: { width: 8, height: 8, borderRadius: 4 },
  hr: { height: 1, backgroundColor: colors.line, marginVertical: 4 },
  overLimitBanner: { backgroundColor: colors.alert, borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.xs, marginBottom: spacing.xs },
  overLimitBannerText: { fontFamily: fonts.uiBold, color: colors.white, fontSize: 12, textAlign: "center" },
  cardActions: { marginTop: spacing.md },
  depositCta: {
    marginTop: spacing.md,
    backgroundColor: colors.ink,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  depositCtaText: { fontFamily: fonts.uiBold, color: colors.white, fontSize: 14 },
  weekRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 6 },
  weekLeft: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  weekLabel: { fontFamily: fonts.uiMed, fontSize: 14, color: colors.ink },
  weekVal: { fontFamily: fonts.data, fontSize: 14, color: colors.ink, textAlign: "right" },
  weekMuted: { fontFamily: fonts.data, fontSize: 14, color: colors.muted },
  settledBadge: {
    fontFamily: fonts.uiBold,
    fontSize: 9,
    color: colors.live,
    letterSpacing: 0.5,
  },
  provBadge: {
    fontFamily: fonts.uiBold,
    fontSize: 9,
    color: colors.amber,
    letterSpacing: 0.5,
  },
  settleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: spacing.md },
  settleLabel: { fontFamily: fonts.uiMed, fontSize: 15, color: colors.ink },
  settleRight: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  settleValue: { fontFamily: fonts.data, fontSize: 17, color: colors.ink },
  chev: { fontFamily: fonts.ui, color: colors.muted, fontSize: 14, width: 12 },
  settleDetails: { backgroundColor: colors.paper, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  detailLine: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 4 },
  detailKey: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.muted },
  detailVal: { fontFamily: fonts.data, fontSize: 14, color: colors.ink },
});
