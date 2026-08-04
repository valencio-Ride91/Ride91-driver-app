import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppHeader } from "@/src/components/AppHeader";
import { BottomSheet, Card } from "@/src/components/ui";
import { EarningsUploader } from "@/src/components/EarningsUploader";
import { api } from "@/src/api";
import { useAuth } from "@/src/auth";
import { useI18n, formatINR } from "@/src/i18n";
import { colors, fonts, platformColors, platformLabels, radius, spacing } from "@/src/theme";

interface MoneyToday {
  gross_by_platform: Record<string, { gross: number; trips: number; cash: number }>;
  gross: number;
  driver_share: number;
  share_rate: number;
  cash_held: number;
  cash_limit: number;
  cash_over_limit: boolean;
  advance: { principal: number; daily_recovery: number; days_remaining: number };
  advance_recovery_today: number;
  payable: number;
}

interface Weekly {
  days: { date: string; gross: number; share: number }[];
}

type ExpandKey = "share" | "cash" | "advance" | "payable" | null;

export default function Money() {
  const { t } = useI18n();
  const { driver } = useAuth();
  const [today, setToday] = useState<MoneyToday | null>(null);
  const [weekly, setWeekly] = useState<Weekly | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [expand, setExpand] = useState<ExpandKey>(null);
  const [qrOpen, setQrOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([
        api.get<MoneyToday>("/money/today"),
        api.get<Weekly>("/money/weekly"),
      ]);
      setToday(a);
      setWeekly(b);
    } catch {
      // keep whatever we had
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const platforms = useMemo(
    () => ["ride91", "uber", "rapido", "ola"] as const,
    [],
  );

  const maxShare = useMemo(
    () => Math.max(1, ...(weekly?.days.map((d) => d.share) ?? [0])),
    [weekly],
  );

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <AppHeader title={t.money} />
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* Today's gross by platform */}
        <Card testID="money-gross-card">
          <Text style={styles.h2}>{t.todays_gross}</Text>
          <Text style={styles.hero} testID="money-gross-total">
            {formatINR(today?.gross ?? 0)}
          </Text>
          <View style={styles.platformList}>
            {platforms.map((p) => {
              const r = today?.gross_by_platform?.[p] ?? { gross: 0, trips: 0, cash: 0 };
              return (
                <View style={styles.platformRow} key={p} testID={`money-platform-${p}`}>
                  <View style={styles.platformLeft}>
                    <View
                      style={[styles.platformSwatch, { backgroundColor: platformColors[p] }]}
                    />
                    <Text style={styles.platformName}>{platformLabels[p]}</Text>
                  </View>
                  <View style={{ alignItems: "flex-end" }}>
                    <Text style={styles.platformAmount}>{formatINR(r.gross)}</Text>
                    <Text style={styles.platformTrips}>{r.trips} {t.trips.toLowerCase()}</Text>
                  </View>
                </View>
              );
            })}
          </View>
        </Card>

        <Card style={{ marginTop: spacing.md }} testID="upload-card">
          <EarningsUploader onImported={load} />
        </Card>

        {/* Settlement */}
        <Card testID="money-settlement-card" style={{ marginTop: spacing.md }}>
          <Text style={styles.h2}>{t.settlement}</Text>

          <SettleRow
            label={t.driver_share}
            value={formatINR(today?.driver_share ?? 0)}
            color={colors.live}
            open={expand === "share"}
            onPress={() => setExpand(expand === "share" ? null : "share")}
            testID="settle-share"
            details={
              <View>
                <DetailLine k="Gross" v={formatINR(today?.gross ?? 0)} />
                <DetailLine k="Share rate" v={`${Math.round((today?.share_rate ?? 0.3) * 100)}%`} />
                <DetailLine
                  k="= Share"
                  v={formatINR(today?.driver_share ?? 0)}
                  bold
                />
              </View>
            }
          />

          <SettleRow
            label={t.cash_held}
            value={formatINR(today?.cash_held ?? 0)}
            color={today?.cash_over_limit ? colors.alert : colors.ink}
            trailing={
              today?.cash_over_limit ? (
                <Text style={styles.overLimit}>{t.over_limit}</Text>
              ) : null
            }
            open={expand === "cash"}
            onPress={() => setExpand(expand === "cash" ? null : "cash")}
            testID="settle-cash"
            details={
              <View>
                <DetailLine k="Limit" v={formatINR(today?.cash_limit ?? 1500)} />
                <DetailLine k="Held" v={formatINR(today?.cash_held ?? 0)} />
                <TouchableOpacity
                  testID="deposit-cash-btn"
                  style={styles.depositBtn}
                  onPress={() => setQrOpen(true)}
                >
                  <Text style={styles.depositText}>{t.deposit_cash}</Text>
                </TouchableOpacity>
              </View>
            }
          />

          <SettleRow
            label={t.advance}
            value={`− ${formatINR(today?.advance_recovery_today ?? 0)}`}
            color={colors.muted}
            open={expand === "advance"}
            onPress={() => setExpand(expand === "advance" ? null : "advance")}
            testID="settle-advance"
            details={
              <View>
                <DetailLine
                  k={t.principal}
                  v={formatINR(today?.advance?.principal ?? 0)}
                />
                <DetailLine
                  k={t.daily_recovery}
                  v={formatINR(today?.advance?.daily_recovery ?? 0)}
                />
                <DetailLine
                  k={t.days_remaining}
                  v={`${today?.advance?.days_remaining ?? 0}`}
                />
              </View>
            }
          />

          <View style={styles.divider} />

          <SettleRow
            label={t.payable}
            value={formatINR(today?.payable ?? 0)}
            color={colors.ink}
            bold
            open={expand === "payable"}
            onPress={() => setExpand(expand === "payable" ? null : "payable")}
            testID="settle-payable"
            details={
              <View>
                <DetailLine k={t.driver_share} v={formatINR(today?.driver_share ?? 0)} />
                <DetailLine k={`− ${t.cash_held}`} v={formatINR(today?.cash_held ?? 0)} />
                <DetailLine
                  k={`− ${t.advance}`}
                  v={formatINR(today?.advance_recovery_today ?? 0)}
                />
                <DetailLine
                  k={`= ${t.payable}`}
                  v={formatINR(today?.payable ?? 0)}
                  bold
                />
              </View>
            }
          />
        </Card>

        {/* Weekly chart */}
        <Card style={{ marginTop: spacing.md }} testID="weekly-card">
          <Text style={styles.h2}>{t.weekly}</Text>
          <View style={styles.chart}>
            {(weekly?.days ?? []).map((d, i) => {
              const h = Math.max(4, (d.share / maxShare) * 120);
              const label = new Date(d.date).toLocaleDateString(undefined, { weekday: "short" });
              const isToday = i === (weekly?.days.length ?? 0) - 1;
              return (
                <View style={styles.chartCol} key={d.date} testID={`chart-day-${i}`}>
                  <Text style={styles.chartValue}>
                    {d.share > 0 ? formatINR(d.share) : ""}
                  </Text>
                  <View
                    style={[
                      styles.chartBar,
                      { height: h, backgroundColor: isToday ? colors.live : colors.ink },
                    ]}
                  />
                  <Text style={styles.chartLabel}>{label}</Text>
                </View>
              );
            })}
          </View>
        </Card>
      </ScrollView>

      <BottomSheet
        visible={qrOpen}
        onClose={() => setQrOpen(false)}
        title={t.deposit_cash}
        testID="deposit-sheet"
      >
        <Text style={styles.qrHint}>{t.scan_to_deposit}</Text>
        <View style={styles.qrBox} testID="deposit-qr">
          <View style={styles.qrGrid}>
            {Array.from({ length: 49 }).map((_, i) => (
              <View
                key={i}
                style={[
                  styles.qrCell,
                  {
                    backgroundColor:
                      // deterministic pseudo-QR from driver id + index
                      hashDot(driver?.id ?? "x", i) ? colors.ink : colors.card,
                  },
                ]}
              />
            ))}
          </View>
        </View>
        <Text style={styles.qrCode} testID="deposit-qr-code">
          {driver?.qr_code}
        </Text>
      </BottomSheet>
    </SafeAreaView>
  );
}

const hashDot = (s: string, i: number): boolean => {
  let h = 5381;
  for (let k = 0; k < s.length; k++) h = ((h << 5) + h) ^ s.charCodeAt(k);
  h = (h ^ (i * 2654435761)) >>> 0;
  return (h & 1) === 1;
};

const SettleRow: React.FC<{
  label: string;
  value: string;
  color?: string;
  bold?: boolean;
  open: boolean;
  trailing?: React.ReactNode;
  onPress: () => void;
  details: React.ReactNode;
  testID: string;
}> = ({ label, value, color, bold, open, trailing, onPress, details, testID }) => (
  <View>
    <TouchableOpacity style={styles.settleRow} onPress={onPress} testID={testID}>
      <Text style={styles.settleLabel}>{label}</Text>
      <View style={styles.settleRight}>
        {trailing}
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
  scroll: { padding: spacing.md, paddingBottom: spacing.xxl * 2 },
  h2: { fontFamily: fonts.display, fontSize: 18, color: colors.ink, marginBottom: spacing.xs },
  hero: { fontFamily: fonts.dataMed, fontSize: 36, color: colors.ink, marginBottom: spacing.md },
  platformList: { gap: spacing.sm },
  platformRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  platformLeft: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  platformSwatch: { width: 12, height: 12, borderRadius: 2 },
  platformName: { fontFamily: fonts.uiMed, fontSize: 15, color: colors.ink },
  platformAmount: { fontFamily: fonts.dataMed, fontSize: 16, color: colors.ink },
  platformTrips: { fontFamily: fonts.ui, fontSize: 12, color: colors.muted },
  settleRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: spacing.md,
  },
  settleLabel: { fontFamily: fonts.uiMed, fontSize: 15, color: colors.ink },
  settleRight: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  settleValue: { fontFamily: fonts.data, fontSize: 17, color: colors.ink },
  chev: { fontFamily: fonts.ui, color: colors.muted, fontSize: 14, width: 12 },
  settleDetails: {
    backgroundColor: colors.paper,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  detailLine: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  detailKey: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.muted },
  detailVal: { fontFamily: fonts.data, fontSize: 14, color: colors.ink },
  overLimit: {
    fontFamily: fonts.uiBold,
    fontSize: 11,
    color: colors.white,
    backgroundColor: colors.alert,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  depositBtn: {
    marginTop: spacing.sm,
    backgroundColor: colors.ink,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  depositText: { fontFamily: fonts.uiBold, fontSize: 14, color: colors.white },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: spacing.xs },
  chart: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    marginTop: spacing.md,
    height: 170,
  },
  chartCol: { alignItems: "center", flex: 1 },
  chartBar: { width: 22, borderTopLeftRadius: 4, borderTopRightRadius: 4 },
  chartLabel: { fontFamily: fonts.ui, fontSize: 11, color: colors.muted, marginTop: 6 },
  chartValue: { fontFamily: fonts.data, fontSize: 10, color: colors.muted, marginBottom: 4 },
  qrHint: { fontFamily: fonts.ui, fontSize: 13, color: colors.muted, marginBottom: spacing.md },
  qrBox: {
    aspectRatio: 1,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    padding: spacing.md,
    alignSelf: "center",
    width: "80%",
  },
  qrGrid: { flex: 1, flexDirection: "row", flexWrap: "wrap" },
  qrCell: { width: `${100 / 7}%`, aspectRatio: 1 },
  qrCode: {
    marginTop: spacing.md,
    fontFamily: fonts.dataMed,
    textAlign: "center",
    color: colors.ink,
    fontSize: 14,
  },
});
