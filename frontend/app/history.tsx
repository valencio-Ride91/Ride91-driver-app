// Payment history: everything that ever moved the driver's money, from their
// first day. Lifetime totals at the top, then one section per month (newest
// first). A month's entries load when it is opened; the current month opens
// by itself. The figures follow the same rules as the Money tab and the
// salary card, so they agree with what the hub sees.
import React, { useCallback, useEffect, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { Card } from "@/src/components/ui";
import { api } from "@/src/api";
import { useI18n, formatINR, formatIST, formatISTDate } from "@/src/i18n";
import { useCardText, CardText } from "@/src/i18n/cards";
import { colors, fonts, platformLabels, radius, spacing } from "@/src/theme";

interface Lifetime {
  fares: number;
  share: number;
  salary_paid: number;
  salary_pending: number;
  salary_available: number;
  cash_collected: number;
  cash_handed_in: number;
  you_owe: number;
  in_credit: number;
  rewards_paid: number;
  days_worked: number;
}
interface MonthSum {
  month: string;
  fares: number;
  share: number;
  cash_collected: number;
  cash_handed_in: number;
  salary_paid: number;
  rewards_paid: number;
  days_worked: number;
}
interface Summary { since: string | null; share_rate: number; lifetime: Lifetime; months: MonthSum[] }

type Entry =
  | { kind: "earning"; date: string; at: null; fares: number; cash: number; share: number; status: "settled" | "pending" | "today"; apps: Record<string, { fares: number; cash: number }> }
  | { kind: "cash_in"; id: string; date: string; at: string | null; amount: number; via: "hub" | "online" | "rider_qr"; reference: string | null; undone: boolean }
  | { kind: "cash_undone"; id: string; date: string; at: string | null; amount: number; note: string | null }
  | { kind: "salary"; id: string; date: string; at: string | null; amount: number; via: "hand" | "bank" | "upi"; status: "paid" | "processing" | "failed"; reference: string | null }
  | { kind: "salary_request"; id: string; date: string; at: string | null; amount: number; status: "pending" | "rejected"; note: string | null }
  | { kind: "reward"; id: string; date: string; at: string | null; amount: number; type: string | null; month: string | null; note: string | null };

type Filter = "all" | "earnings" | "cash" | "salary" | "rewards";
const FILTERS: Filter[] = ["all", "earnings", "cash", "salary", "rewards"];
const KINDS: Record<Filter, Entry["kind"][] | null> = {
  all: null,
  earnings: ["earning"],
  cash: ["cash_in", "cash_undone"],
  salary: ["salary", "salary_request"],
  rewards: ["reward"],
};

// A business day ("2026-11-05") shown as a date, read at noon IST so it never
// slips to the day before.
const dayLabel = (bd: string) => formatISTDate(`${bd}T12:00:00+05:30`);

export default function History() {
  const { t } = useI18n();
  const c = useCardText();
  const router = useRouter();
  const [sum, setSum] = useState<Summary | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [months, setMonths] = useState<Record<string, Entry[] | "loading" | "failed">>({});

  const loadMonth = useCallback(async (m: string) => {
    setMonths((x) => ({ ...x, [m]: x[m] && x[m] !== "failed" ? x[m] : "loading" }));
    try {
      const r = await api.get<{ entries: Entry[] }>(`/money/history/month?month=${m}`);
      setMonths((x) => ({ ...x, [m]: r.entries }));
    } catch {
      setMonths((x) => ({ ...x, [m]: "failed" }));
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const s = await api.get<Summary>("/money/history");
      setSum(s);
      setFailed(false);
      // The newest month opens by itself; any month already open is refreshed.
      const first = s.months[0]?.month;
      setOpen((o) => (Object.keys(o).length || !first ? o : { [first]: true }));
      return s;
    } catch {
      setFailed(true);
      return null;
    }
  }, []);

  useEffect(() => {
    load().then((s) => {
      const first = s?.months[0]?.month;
      if (first) loadMonth(first);
    });
  }, [load, loadMonth]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    await Promise.all(Object.keys(open).filter((m) => open[m]).map(loadMonth));
    setRefreshing(false);
  }, [load, loadMonth, open]);

  const toggle = (m: string) => {
    const next = !open[m];
    setOpen((o) => ({ ...o, [m]: next }));
    if (next && (!months[m] || months[m] === "failed")) loadMonth(m);
  };

  const L = sum?.lifetime;
  const pct = Math.round((sum?.share_rate ?? 0.3) * 100);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)/money" as never))} testID="history-back" style={styles.back}>
          <Text style={styles.backText}>‹ {t.money}</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{c.hist_title}</Text>
        <View style={styles.back} />
      </View>
      <ScrollView contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {!sum ? (
          <Text style={styles.muted}>{failed ? c.hist_load_fail : c.loading}</Text>
        ) : (
          <>
            {/* Lifetime totals */}
            <Card testID="history-lifetime">
              <Text style={styles.kicker}>{c.hist_lifetime}</Text>
              {sum.since ? <Text style={styles.muted}>{c.hist_since(dayLabel(sum.since), L!.days_worked)}</Text> : null}
              <View style={styles.grid}>
                <Stat label={c.hist_share(pct)} value={formatINR(L!.share)} big />
                <Stat label={c.hist_fares} value={formatINR(L!.fares)} />
                <Stat label={c.hist_salary_paid} value={formatINR(L!.salary_paid)} color={colors.live}
                  sub={[L!.salary_pending > 0 ? c.hist_salary_waiting(formatINR(L!.salary_pending)) : "",
                        L!.salary_available > 0 ? c.hist_salary_available(formatINR(L!.salary_available)) : ""].filter(Boolean).join("\n") || undefined} />
                <Stat label={c.hist_rewards} value={formatINR(L!.rewards_paid)} />
                <Stat label={c.hist_cash_collected} value={formatINR(L!.cash_collected)} />
                <Stat label={c.hist_cash_in} value={formatINR(L!.cash_handed_in)} />
                <Stat label={L!.in_credit > 0 ? c.hist_credit_now : c.hist_owe_now}
                  value={formatINR(L!.in_credit > 0 ? L!.in_credit : L!.you_owe)}
                  color={L!.in_credit > 0 ? colors.live : L!.you_owe > 0 ? colors.alert : undefined} />
              </View>
              <Text style={styles.note}>{c.hist_note_counts}</Text>
            </Card>

            {/* Filter */}
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} testID="history-filter">
              {FILTERS.map((f) => (
                <TouchableOpacity key={f} onPress={() => setFilter(f)} style={[styles.chip, filter === f ? styles.chipOn : null]} testID={`history-filter-${f}`}>
                  <Text style={[styles.chipText, filter === f ? styles.chipTextOn : null]}>{c.hist_filter[f]}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>

            {/* Months, newest first */}
            {sum.months.map((m) => {
              const isOpen = !!open[m.month];
              const data = months[m.month];
              const shown = Array.isArray(data) ? data.filter((e) => !KINDS[filter] || KINDS[filter]!.includes(e.kind)) : [];
              return (
                <Card key={m.month} style={{ marginTop: spacing.sm, paddingVertical: spacing.sm }} testID={`history-month-${m.month}`}>
                  <TouchableOpacity onPress={() => toggle(m.month)} style={styles.monthHead} testID={`history-month-toggle-${m.month}`}>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.monthTitle}>{c.att_month(m.month)}</Text>
                      <Text style={styles.monthSub} numberOfLines={2}>
                        {c.hist_month_line(formatINR(m.share), formatINR(m.salary_paid), formatINR(m.cash_handed_in))}
                        {m.rewards_paid > 0 ? ` · ${c.hist_month_bonus(formatINR(m.rewards_paid))}` : ""}
                        {m.days_worked > 0 ? ` · ${c.hist_month_days(m.days_worked)}` : ""}
                      </Text>
                    </View>
                    <Text style={styles.chev}>{isOpen ? "▾" : "▸"}</Text>
                  </TouchableOpacity>
                  {isOpen ? (
                    data === "loading" || !data ? <Text style={styles.muted}>{c.loading}</Text>
                    : data === "failed" ? <Text style={styles.muted}>{c.hist_load_fail}</Text>
                    : shown.length === 0 ? <Text style={styles.muted}>{data.length ? c.hist_nothing_filter : c.hist_nothing}</Text>
                    : shown.map((e, i) => <Row key={`${e.kind}-${"id" in e ? e.id : e.date}-${i}`} e={e} c={c} />)
                  ) : null}
                </Card>
              );
            })}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const Stat: React.FC<{ label: string; value: string; sub?: string; color?: string; big?: boolean }> = ({ label, value, sub, color, big }) => (
  <View style={[styles.stat, big ? styles.statBig : null]}>
    <Text style={styles.statLabel}>{label}</Text>
    <Text style={[big ? styles.statValueBig : styles.statValue, color ? { color } : null]}>{value}</Text>
    {sub ? <Text style={styles.statSub}>{sub}</Text> : null}
  </View>
);

const TONE: Record<string, string> = {
  paid: colors.live, processing: colors.amber, failed: colors.alert, pending: colors.amber, rejected: colors.alert,
};

// One line of the history: what happened, when, and the money it moved.
const Row: React.FC<{ e: Entry; c: CardText }> = ({ e, c }) => {
  let icon = "•", title = "", sub = "", amount = "", amountColor: string = colors.ink, tag: string | null = null,
    tagColor: string = colors.muted, struck = false;
  const when = e.at ? formatIST(e.at) : dayLabel(e.date);
  switch (e.kind) {
    case "earning": {
      icon = "🚗";
      title = c.hist_day;
      const apps = Object.entries(e.apps).filter(([, a]) => a.fares > 0)
        .map(([p, a]) => `${platformLabels[p as keyof typeof platformLabels] ?? p} ${formatINR(a.fares)}`).join(" · ");
      sub = `${dayLabel(e.date)} · ${c.hist_day_sub(formatINR(e.fares), formatINR(e.cash))}${apps ? `\n${apps}` : ""}`;
      amount = `+${formatINR(e.share)}`;
      amountColor = e.status === "settled" ? colors.live : colors.muted;
      if (e.status !== "settled") { tag = e.status === "today" ? c.hist_day_today : c.hist_day_pending; tagColor = colors.amber; }
      break;
    }
    case "cash_in":
      icon = e.via === "rider_qr" ? "📲" : e.via === "online" ? "💳" : "🏢";
      title = e.via === "rider_qr" ? c.hist_cash_rider : e.via === "online" ? c.hist_cash_online : c.hist_cash_hub;
      sub = [when, e.reference ? c.hist_receipt(e.reference) : ""].filter(Boolean).join(" · ");
      amount = formatINR(e.amount);
      if (e.undone) { tag = c.hist_undone_tag; tagColor = colors.alert; struck = true; amountColor = colors.muted; }
      break;
    case "cash_undone":
      icon = "↩️";
      title = c.hist_cash_undone;
      sub = [when, e.note ?? ""].filter(Boolean).join(" · ");
      amount = formatINR(e.amount);
      amountColor = colors.muted;
      break;
    case "salary":
      icon = e.via === "hand" ? "💵" : "🏦";
      title = e.via === "hand" ? c.hist_salary_hand : e.via === "upi" ? c.hist_salary_upi : c.hist_salary_bank;
      sub = [when, e.reference && e.via !== "hand" ? c.hist_ref(e.reference) : ""].filter(Boolean).join(" · ");
      amount = formatINR(e.amount);
      amountColor = e.status === "failed" ? colors.muted : colors.live;
      struck = e.status === "failed";
      tag = c.hist_status[e.status];
      tagColor = TONE[e.status] ?? colors.muted;
      break;
    case "salary_request":
      icon = "📝";
      title = c.hist_request;
      sub = [when, e.note ?? ""].filter(Boolean).join(" · ");
      amount = formatINR(e.amount);
      amountColor = colors.muted;
      tag = c.hist_status[e.status];
      tagColor = TONE[e.status] ?? colors.muted;
      break;
    case "reward":
      icon = "🏆";
      title = `${c.hist_reward[e.type ?? "other"] ?? c.hist_reward.other}${(e.type === "attendance" || e.type === "referral") && e.month ? ` · ${c.att_month(e.month)}` : ""}`;
      sub = [when, e.note ?? ""].filter(Boolean).join(" · ");
      amount = `+${formatINR(e.amount)}`;
      amountColor = colors.live;
      break;
  }
  return (
    <View style={styles.row} testID={`history-row-${e.kind}`}>
      <Text style={styles.rowIcon}>{icon}</Text>
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>{title}</Text>
        {sub ? <Text style={styles.rowSub}>{sub}</Text> : null}
        {tag ? <Text style={[styles.tag, { color: tagColor, borderColor: tagColor }]}>{tag}</Text> : null}
      </View>
      <Text style={[styles.rowAmt, { color: amountColor }, struck ? styles.struck : null]}>{amount}</Text>
    </View>
  );
};

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
  kicker: { fontFamily: fonts.uiBold, fontSize: 11, color: colors.muted, letterSpacing: 1, textTransform: "uppercase" },
  muted: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.muted, paddingVertical: spacing.sm },
  note: { fontFamily: fonts.ui, fontSize: 11, color: colors.muted, marginTop: spacing.sm },
  grid: { flexDirection: "row", flexWrap: "wrap", marginTop: spacing.xs },
  stat: { width: "50%", paddingVertical: 8, paddingRight: spacing.sm },
  statBig: { width: "100%" },
  statLabel: { fontFamily: fonts.uiMed, fontSize: 12, color: colors.muted },
  statValue: { fontFamily: fonts.dataMed, fontSize: 18, color: colors.ink, marginTop: 2 },
  statValueBig: { fontFamily: fonts.dataMed, fontSize: 32, color: colors.ink, marginTop: 2 },
  statSub: { fontFamily: fonts.ui, fontSize: 11, color: colors.muted, marginTop: 2 },
  chips: { gap: 6, paddingVertical: spacing.md },
  chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white },
  chipOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  chipText: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.muted },
  chipTextOn: { color: colors.white, fontFamily: fonts.uiBold },
  monthHead: { flexDirection: "row", alignItems: "center", paddingVertical: 4 },
  monthTitle: { fontFamily: fonts.display, fontSize: 17, color: colors.ink },
  monthSub: { fontFamily: fonts.uiMed, fontSize: 12, color: colors.muted, marginTop: 2 },
  chev: { fontSize: 18, color: colors.muted, paddingLeft: spacing.sm },
  row: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, paddingVertical: 10, borderTopWidth: 1, borderTopColor: colors.line },
  rowIcon: { fontSize: 18, width: 26, textAlign: "center", marginTop: 1 },
  rowTitle: { fontFamily: fonts.uiBold, fontSize: 14, color: colors.ink },
  rowSub: { fontFamily: fonts.ui, fontSize: 12, color: colors.muted, marginTop: 2, lineHeight: 17 },
  rowAmt: { fontFamily: fonts.dataMed, fontSize: 15, color: colors.ink, marginTop: 1 },
  struck: { textDecorationLine: "line-through" },
  tag: { alignSelf: "flex-start", fontFamily: fonts.uiBold, fontSize: 10, borderWidth: 1, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1, marginTop: 4, overflow: "hidden" },
});
