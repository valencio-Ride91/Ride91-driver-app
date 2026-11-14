// Referral earnings: what the driver earned this month (or an earlier month)
// from the drivers they referred, one line per day. Only the bonus is shown,
// never the friend's fares. Each month is paid into salary after the 5th of
// the next month.
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { api } from "@/src/api";
import { Card } from "@/src/components/ui";
import { useI18n } from "@/src/i18n";
import { useCalendarText } from "@/src/i18n/calendar";
import { fmtRupees, useDayLabel, useReferralText, type ReferralMonth } from "@/src/i18n/referrals";
import { colors, fonts, spacing } from "@/src/theme";

function shiftMonth(ym: string, by: number) {
  const y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) - 1 + by;
  const yy = y + Math.floor(m / 12), mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}`;
}

export default function Referrals() {
  const { t } = useI18n();
  const ct = useCalendarText();
  const rt = useReferralText();
  const dayLabel = useDayLabel();
  const router = useRouter();
  const [month, setMonth] = useState<string>("");          // "" = this month
  const [data, setData] = useState<ReferralMonth | null>(null);
  const [current, setCurrent] = useState<string>("");
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const d = await api.get<ReferralMonth>(month ? `/money/referrals?month=${month}` : "/money/referrals");
      setData(d);
      if (!month) setCurrent(d.month);
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }, [month]);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const ym = data?.month ?? month;
  const canPrev = !!data && ym > data.first_month;
  const canNext = !!data && !!current && ym < current;
  const pct = data ? String(Math.round(data.rate * 1000) / 10) : "";
  const title = ym ? `${ct.months[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}` : "";

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)/money" as never))} testID="referrals-back" style={styles.back}>
          <Text style={styles.backText}>‹ {t.money}</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{rt.title}</Text>
        <View style={styles.back} />
      </View>
      <ScrollView contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        <View style={styles.monthRow}>
          <TouchableOpacity onPress={() => canPrev && setMonth(shiftMonth(ym, -1))} disabled={!canPrev} testID="referrals-prev"
            accessibilityLabel={rt.prev} style={[styles.arrow, !canPrev && styles.arrowOff]}>
            <Text style={styles.arrowText}>‹</Text>
          </TouchableOpacity>
          <Text style={styles.monthTitle} testID="referrals-month">{title}</Text>
          <TouchableOpacity onPress={() => canNext && setMonth(shiftMonth(ym, 1))} disabled={!canNext} testID="referrals-next"
            accessibilityLabel={rt.next} style={[styles.arrow, !canNext && styles.arrowOff]}>
            <Text style={styles.arrowText}>›</Text>
          </TouchableOpacity>
        </View>

        {failed && !data ? <Text style={styles.note}>{rt.failed}</Text> : null}
        {busy && !data ? <ActivityIndicator color={colors.muted} style={{ marginTop: spacing.lg }} /> : null}

        {data ? (
          <>
            <Card testID="referrals-total">
              <Text style={styles.kicker}>{rt.month_total}</Text>
              <Text style={styles.total}>{fmtRupees(data.total)}</Text>
              <Text style={[styles.status, { color: data.paid ? colors.live : colors.amber }]} testID="referrals-status">
                {data.paid ? `✓ ${rt.paid}` : rt.to_be_paid(dayLabel(data.pay_date))}
              </Text>
              {!data.enabled ? <Text style={styles.note}>{rt.off}</Text> : null}
            </Card>

            <Card style={{ marginTop: spacing.md }} testID="referrals-days">
              <Text style={styles.kicker}>{rt.days}</Text>
              {data.days.length === 0 ? (
                <Text style={styles.note}>{rt.no_days}</Text>
              ) : (
                data.days.map((d, i) => (
                  <View key={`${d.date}-${d.name}-${i}`} style={[styles.row, i > 0 && styles.rowLine]}>
                    <Text style={styles.rowDate}>{dayLabel(d.date)}</Text>
                    <Text style={styles.rowName} numberOfLines={1}>{d.name}</Text>
                    <Text style={styles.rowAmt}>+{fmtRupees(d.amount)}</Text>
                  </View>
                ))
              )}
            </Card>

            {data.people.length > 0 ? (
              <Card style={{ marginTop: spacing.md }} testID="referrals-people">
                <Text style={styles.kicker}>{rt.friends}</Text>
                {data.people.map((p, i) => (
                  <View key={`${p.name}-${i}`} style={[styles.row, i > 0 && styles.rowLine]}>
                    <Text style={styles.rowName}>{p.name}</Text>
                    <Text style={[styles.rowSince, !p.active && { color: colors.muted }]}>
                      {p.active ? rt.since(dayLabel(p.since)) : rt.left}
                    </Text>
                  </View>
                ))}
              </Card>
            ) : null}

            <Text style={[styles.note, { marginTop: spacing.md }]}>{rt.rule(pct, fmtRupees(data.daily_min))}</Text>
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  back: { width: 80 },
  backText: { fontFamily: fonts.uiMed, fontSize: 15, color: colors.muted },
  headerTitle: { fontFamily: fonts.display, fontSize: 18, color: colors.ink },
  scroll: { padding: spacing.md, paddingBottom: 120 },
  monthRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: spacing.md },
  arrow: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: 22, borderWidth: 1, borderColor: colors.line },
  arrowOff: { opacity: 0.3 },
  arrowText: { fontFamily: fonts.uiBold, fontSize: 22, color: colors.ink },
  monthTitle: { fontFamily: fonts.display, fontSize: 18, color: colors.ink },
  kicker: { fontFamily: fonts.uiBold, fontSize: 12, color: colors.muted, textTransform: "uppercase", letterSpacing: 0.6, marginBottom: spacing.sm },
  total: { fontFamily: fonts.display, fontSize: 32, color: colors.ink },
  status: { fontFamily: fonts.uiBold, fontSize: 14, marginTop: spacing.xs },
  note: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.muted, lineHeight: 19 },
  row: { flexDirection: "row", alignItems: "center", paddingVertical: 10, gap: spacing.sm },
  rowLine: { borderTopWidth: 1, borderTopColor: colors.line },
  rowDate: { fontFamily: fonts.uiMed, fontSize: 14, color: colors.muted, width: 92 },
  rowName: { flex: 1, fontFamily: fonts.uiMed, fontSize: 15, color: colors.ink },
  rowAmt: { fontFamily: fonts.uiBold, fontSize: 15, color: colors.live },
  rowSince: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.ink },
});
