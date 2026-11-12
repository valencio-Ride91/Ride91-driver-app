// A month calendar of a driver's days: the work done (fares, cash fares, the
// driver's share) against the money that came in for it (riders paying the
// driver's QR, cash handed in), what that left with the driver, and what was
// owed at the end of the day. A coloured dot marks each day:
//   green  covered: the day's cash fares were paid on the QR or handed in
//   amber  cash kept: some of the day's cash fares were not
//   grey   fares not in yet (today, or the hub has not entered the day)
// Used by the driver (their own month) and by the Hub app (one driver's).
// The figures come from the server (GET /money/calendar and
// /admin/drivers/{id}/calendar), which uses the same rules as the balance.
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, TouchableOpacity, View } from "react-native";

import { formatINR } from "@/src/i18n";
import { useCalendarText } from "@/src/i18n/calendar";
import { colors, fonts, platformColors, platformLabels, radius, spacing } from "@/src/theme";

export type DayStatus = "ok" | "short" | "waiting" | "none";

export interface CalendarDay {
  date: string;
  today: boolean;
  status: DayStatus;
  on_duty: boolean;
  fares: number;
  share: number;
  cash_fares: number;
  fares_final: boolean;
  apps: Record<string, { fares: number; cash: number }>;
  qr: number;
  qr_count: number;
  handed_in: number;
  left: number;
  owed_after: number;
}

export interface CalendarMonth {
  month: string;
  first_month: string;
  start_date?: string;          // the first day shown: onboarding, or an earlier record
  joined?: string | null;       // the day the driver was onboarded
  today: string;
  share_rate: number;
  opening_owed: number;
  closing_owed: number;
  totals: { fares: number; share: number; cash_fares: number; qr: number; handed_in: number; days_worked: number; days_short: number; days_waiting: number };
  days: CalendarDay[];
}

const DOT: Record<DayStatus, string | null> = {
  ok: colors.brand,
  short: colors.amber,
  waiting: colors.line,
  none: null,
};

const monthAdd = (ym: string, n: number): string => {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${yy}-${String(mm + 1).padStart(2, "0")}`;
};

// Day of the week of a business date, Monday = 0. Read at noon UTC so the
// date never shifts.
const weekday = (bd: string): number => (new Date(`${bd}T12:00:00Z`).getUTCDay() + 6) % 7;
const daysInMonth = (ym: string): number => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();

export const DayCalendar: React.FC<{
  load: (month: string) => Promise<CalendarMonth>;
  refreshKey?: number;
  testID?: string;
}> = ({ load, refreshKey = 0, testID = "day-calendar" }) => {
  const t = useCalendarText();
  const [month, setMonth] = useState<string | null>(null);   // null: the current month
  const [data, setData] = useState<CalendarMonth | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [picked, setPicked] = useState<string | null>(null);
  const wanted = useRef<string | null>(null);

  const fetchMonth = useCallback(async (m: string | null, quiet = false) => {
    wanted.current = m;
    if (!quiet) setBusy(true);
    try {
      const d = await load(m ?? "");
      if (wanted.current !== m) return;          // a newer month was asked for
      setData(d);
      setFailed(false);
    } catch {
      if (wanted.current === m && !quiet) setFailed(true);
    } finally {
      if (wanted.current === m) setBusy(false);
    }
  }, [load]);

  useEffect(() => { fetchMonth(month); }, [month, fetchMonth, refreshKey]);

  // The current month changes during the day (QR payments): keep it fresh.
  useEffect(() => {
    if (month && data && month !== data.today.slice(0, 7)) return;
    const id = setInterval(() => fetchMonth(month, true), 30000);
    return () => clearInterval(id);
  }, [month, data, fetchMonth]);

  const shown = data && data.month === (month ?? data.today.slice(0, 7)) ? data : null;
  const current = shown?.today.slice(0, 7);
  const byDate = useMemo(() => {
    const m: Record<string, CalendarDay> = {};
    shown?.days.forEach((d) => { m[d.date] = d; });
    return m;
  }, [shown]);

  // The day shown below the grid: the one tapped, else today, else the last day.
  const sel = (picked && byDate[picked]) || byDate[shown?.today ?? ""] || shown?.days[shown.days.length - 1] || null;

  const go = (n: number) => {
    if (!shown) return;
    const next = monthAdd(shown.month, n);
    if (next < shown.first_month || (current && next > current)) return;
    setPicked(null);
    setMonth(next === current ? null : next);
  };

  if (!shown) {
    return (
      <View style={styles.card} testID={testID}>
        {failed ? <Text style={styles.muted}>{t.failed}</Text> : <ActivityIndicator color={colors.ink} />}
      </View>
    );
  }

  const ym = shown.month;
  const lead = weekday(`${ym}-01`);
  const total = daysInMonth(ym);
  const cells: (string | null)[] = [...Array(lead).fill(null)];
  for (let i = 1; i <= total; i++) cells.push(`${ym}-${String(i).padStart(2, "0")}`);
  while (cells.length % 7) cells.push(null);
  const canBack = monthAdd(ym, -1) >= shown.first_month;
  const canFwd = !!current && monthAdd(ym, 1) <= current;
  const pct = Math.round(shown.share_rate * 100);

  return (
    <View testID={testID}>
      <View style={styles.card}>
        <View style={styles.monthRow}>
          <TouchableOpacity onPress={() => go(-1)} disabled={!canBack} style={styles.arrow} testID={`${testID}-prev`} accessibilityLabel={t.prev}>
            <Text style={[styles.arrowText, !canBack && styles.off]}>‹</Text>
          </TouchableOpacity>
          <Text style={styles.monthTitle} testID={`${testID}-month`}>
            {t.months[Number(ym.slice(5, 7)) - 1]} {ym.slice(0, 4)}
          </Text>
          <TouchableOpacity onPress={() => go(1)} disabled={!canFwd} style={styles.arrow} testID={`${testID}-next`} accessibilityLabel={t.next}>
            <Text style={[styles.arrowText, !canFwd && styles.off]}>›</Text>
          </TouchableOpacity>
        </View>
        {busy ? <ActivityIndicator size="small" color={colors.muted} style={styles.spin} /> : null}
        {shown.joined && shown.joined.slice(0, 7) === ym ? (
          <Text style={styles.joined} testID={`${testID}-joined`}>
            {t.joined(`${Number(shown.joined.slice(8))} ${t.months[Number(shown.joined.slice(5, 7)) - 1]} ${shown.joined.slice(0, 4)}`)}
          </Text>
        ) : null}

        <View style={styles.totals} testID={`${testID}-totals`}>
          <Total label={t.month_fares} value={formatINR(shown.totals.fares)} />
          <Total label={t.month_qr} value={formatINR(shown.totals.qr)} />
          <Total label={t.month_handed} value={formatINR(shown.totals.handed_in)} />
        </View>
        {shown.totals.days_short > 0 ? (
          <Text style={styles.shortNote} testID={`${testID}-short-days`}>{t.month_short_days(shown.totals.days_short)}</Text>
        ) : null}

        <View style={styles.week}>
          {t.weekdays.map((w) => <Text key={w} style={styles.weekday}>{w}</Text>)}
        </View>
        <View style={styles.grid}>
          {cells.map((bd, i) => {
            if (!bd) return <View key={`e${i}`} style={styles.cell} />;
            const d = byDate[bd];
            const dot = d ? DOT[d.status] : null;
            const isSel = sel?.date === bd;
            return (
              <TouchableOpacity
                key={bd}
                style={styles.cell}
                disabled={!d}
                onPress={() => setPicked(bd)}
                testID={`${testID}-day-${bd}`}
              >
                <View style={[styles.dayBox, isSel && styles.daySel, d?.today && !isSel && styles.dayToday]}>
                  <Text style={[styles.dayNum, !d && styles.off, isSel && styles.dayNumSel]}>{Number(bd.slice(8))}</Text>
                  <View style={[styles.dot, { backgroundColor: dot ?? "transparent" }]} />
                </View>
              </TouchableOpacity>
            );
          })}
        </View>
        <View style={styles.legend}>
          <Legend color={DOT.ok!} label={t.legend_ok} />
          <Legend color={DOT.short!} label={t.legend_short} />
          <Legend color={DOT.waiting!} label={t.legend_waiting} />
        </View>
      </View>

      {sel ? <DayDetail d={sel} pct={pct} joined={shown.joined === sel.date} testID={`${testID}-detail`} /> : null}
    </View>
  );
};

const DayDetail: React.FC<{ d: CalendarDay; pct: number; joined?: boolean; testID: string }> = ({ d, pct, joined, testID }) => {
  const t = useCalendarText();
  const wd = t.days_short[weekday(d.date)];
  const title = `${d.today ? `${t.today} · ` : ""}${wd} ${Number(d.date.slice(8))} ${t.months[Number(d.date.slice(5, 7)) - 1]}`;
  const apps = Object.entries(d.apps).filter(([, v]) => v.fares > 0 || v.cash > 0);
  const status =
    d.status === "ok" ? t.st_ok
      : d.status === "short" ? t.st_short(formatINR(d.left))
        : d.status === "waiting" ? (d.today ? t.st_waiting_today : t.st_waiting)
          : t.st_none;
  const tone = d.status === "ok" ? styles.toneOk : d.status === "short" ? styles.toneShort : styles.toneMute;

  return (
    <View style={[styles.card, { marginTop: spacing.md }]} testID={testID}>
      <Text style={styles.dayTitle}>{title}</Text>
      {joined ? <Text style={styles.joinedDay}>{t.joined_day}</Text> : null}
      <View style={[styles.status, tone]} testID={`${testID}-status`}>
        <Text style={styles.statusText}>{status}</Text>
      </View>

      <Text style={styles.kicker}>{t.work}</Text>
      {d.fares > 0 ? (
        <>
          <Line label={t.fares} value={formatINR(d.fares)} bold />
          <Line label={t.share(pct)} value={formatINR(d.share)} color={colors.live} />
          {apps.map(([k, v]) => (
            <Line key={k} label={platformLabels[k] ?? k} swatch={platformColors[k]} value={t.app_line(formatINR(v.fares), formatINR(v.cash))} small />
          ))}
        </>
      ) : (
        <Text style={styles.muted}>{d.on_duty ? t.on_duty_no_fares : t.no_work}</Text>
      )}

      <Text style={[styles.kicker, { marginTop: spacing.md }]}>{t.cash}</Text>
      <Line label={t.cash_fares} value={formatINR(d.cash_fares)} testID={`${testID}-cash-fares`} />
      <Line label={t.qr(d.qr_count)} value={`− ${formatINR(d.qr)}`} color={d.qr > 0 ? colors.live : undefined} testID={`${testID}-qr`} />
      <Line label={t.handed_in} value={`− ${formatINR(d.handed_in)}`} color={d.handed_in > 0 ? colors.live : undefined} />
      <View style={styles.hr} />
      {d.left >= 0 ? (
        <Line label={t.left} value={formatINR(d.left)} bold color={d.status === "short" ? colors.alert : undefined} testID={`${testID}-left`} />
      ) : (
        <Line label={t.paid_older} value={formatINR(-d.left)} bold color={colors.live} testID={`${testID}-left`} />
      )}
      <Line
        label={d.owed_after >= 0 ? t.owed_after : t.in_credit_after}
        value={formatINR(Math.abs(d.owed_after))}
        testID={`${testID}-owed`}
      />
    </View>
  );
};

const Total: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <View style={styles.total}>
    <Text style={styles.totalValue}>{value}</Text>
    <Text style={styles.totalLabel}>{label}</Text>
  </View>
);

const Legend: React.FC<{ color: string; label: string }> = ({ color, label }) => (
  <View style={styles.legendItem}>
    <View style={[styles.dot, { backgroundColor: color }]} />
    <Text style={styles.legendText}>{label}</Text>
  </View>
);

const Line: React.FC<{ label: string; value: string; bold?: boolean; small?: boolean; color?: string; swatch?: string; testID?: string }> = ({ label, value, bold, small, color, swatch, testID }) => (
  <View style={styles.line} testID={testID}>
    <View style={styles.lineLeft}>
      {swatch ? <View style={[styles.swatch, { backgroundColor: swatch }]} /> : null}
      <Text style={[styles.lineLabel, bold && styles.bold, small && styles.small]}>{label}</Text>
    </View>
    <Text style={[styles.lineValue, bold && styles.bold, small && styles.small, color ? { color } : null]}>{value}</Text>
  </View>
);

const styles = StyleSheet.create({
  card: { backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, padding: spacing.lg },
  monthRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  arrow: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  arrowText: { fontFamily: fonts.uiBold, fontSize: 30, lineHeight: 32, color: colors.ink },
  off: { color: colors.line },
  monthTitle: { fontFamily: fonts.display, fontSize: 18, color: colors.ink },
  joined: { fontFamily: fonts.uiMed, fontSize: 12, color: colors.live, textAlign: "center", marginTop: 2 },
  joinedDay: { fontFamily: fonts.uiMed, fontSize: 12, color: colors.live, marginTop: 2 },
  spin: { position: "absolute", top: spacing.lg, right: 64 },
  totals: { flexDirection: "row", marginTop: spacing.sm, gap: spacing.sm },
  total: { flex: 1, backgroundColor: colors.paper, borderRadius: radius.md, paddingVertical: spacing.sm, alignItems: "center" },
  totalValue: { fontFamily: fonts.dataMed, fontSize: 14, color: colors.ink },
  totalLabel: { fontFamily: fonts.ui, fontSize: 11, color: colors.muted, marginTop: 2 },
  shortNote: { fontFamily: fonts.uiMed, fontSize: 12, color: colors.alert, marginTop: spacing.sm, textAlign: "center" },
  week: { flexDirection: "row", marginTop: spacing.md },
  weekday: { flex: 1, textAlign: "center", fontFamily: fonts.uiMed, fontSize: 11, color: colors.muted },
  grid: { flexDirection: "row", flexWrap: "wrap", marginTop: 4 },
  cell: { width: `${100 / 7}%`, aspectRatio: 1, padding: 2 },
  dayBox: { flex: 1, borderRadius: radius.sm, alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "transparent" },
  daySel: { backgroundColor: colors.ink, borderColor: colors.ink },
  dayToday: { borderColor: colors.brand },
  dayNum: { fontFamily: fonts.dataMed, fontSize: 14, color: colors.ink },
  dayNumSel: { color: colors.white },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 3 },
  legend: { flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: spacing.md, marginTop: spacing.sm },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 4 },
  legendText: { fontFamily: fonts.ui, fontSize: 11, color: colors.muted },
  dayTitle: { fontFamily: fonts.display, fontSize: 17, color: colors.ink },
  status: { borderRadius: radius.sm, padding: spacing.sm, marginTop: spacing.sm, marginBottom: spacing.md },
  statusText: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.ink },
  toneOk: { backgroundColor: colors.brandTint },
  toneShort: { backgroundColor: "#FBEFD5" },
  toneMute: { backgroundColor: colors.paper },
  kicker: { fontFamily: fonts.uiBold, fontSize: 11, color: colors.muted, letterSpacing: 1, textTransform: "uppercase", marginBottom: 4 },
  muted: { fontFamily: fonts.ui, fontSize: 13, color: colors.muted, paddingVertical: 4 },
  line: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 5 },
  lineLeft: { flexDirection: "row", alignItems: "center", flexShrink: 1, paddingRight: spacing.sm },
  swatch: { width: 8, height: 8, borderRadius: 4, marginRight: 6 },
  lineLabel: { fontFamily: fonts.ui, fontSize: 14, color: colors.ink, flexShrink: 1 },
  lineValue: { fontFamily: fonts.data, fontSize: 14, color: colors.ink },
  bold: { fontFamily: fonts.uiBold },
  small: { fontSize: 12, color: colors.muted },
  hr: { height: 1, backgroundColor: colors.line, marginVertical: spacing.sm },
});
