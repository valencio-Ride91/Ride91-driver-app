// Attendance bonus — written so a driver can read it cold and know three
// things: what the bonus is, exactly what makes a day count, and where they
// stand this month (how many more days they need and whether there is still
// time to get there).

import React from "react";
import { StyleSheet, Text, View, ViewStyle } from "react-native";

import { Card } from "@/src/components/ui";
import { formatINR } from "@/src/i18n";
import { useCardText } from "@/src/i18n/cards";
import { colors, fonts, radius, spacing } from "@/src/theme";

export interface AttendanceState {
  enabled: boolean;
  month: string;               // "YYYY-MM"
  good_days: number;
  min_days: number;
  bonus: number;
  qualified: boolean;
  require_ontime: boolean;
  daily_target: number;
  paid: boolean;
  month_gross?: number;
  min_gross?: number;
  // Sent by newer servers; the card degrades gracefully without them.
  grace_minutes?: number;
  shift_start_time?: string | null;   // "HH:MM", set by the hub
  days_left?: number;                 // days left this month, today included
}

const LIVE_TINT = "#E3F1EA";
const AMBER_TINT = "#FCF2D9";
const AMBER_INK = "#8A5D00";
const ALERT_TINT = "#F8E4E0";

// "06:30" (+10 min) → "6:40 AM" / "सुबह 6:40", via the language's own clock format.
function clock(hhmm: string, addMin: number, fmt: (h24: number, m: number) => string): string | null {
  const [h, m] = hhmm.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  const t = (((h * 60 + m + addMin) % 1440) + 1440) % 1440;
  const hh = Math.floor(t / 60);
  const mm = t % 60;
  return fmt(hh, mm);
}

export const AttendanceCard: React.FC<{ data: AttendanceState; style?: ViewStyle }> = ({ data, style }) => {
  const c = useCardText();
  const need = Math.max(0, data.min_days - data.good_days);
  const pct = data.min_days ? Math.round(Math.min(1, data.good_days / data.min_days) * 100) : 0;
  const minGross = data.min_gross ?? 0;
  const monthGross = data.month_gross ?? 0;
  const grossShort = minGross > 0 ? Math.max(0, minGross - monthGross) : 0;
  const daysLeft = data.days_left;
  const outOfTime = !data.qualified && daysLeft != null && need > daysLeft;

  const grace = data.grace_minutes ?? 0;
  const shift = data.shift_start_time ? clock(data.shift_start_time, 0, c.clock) : null;
  const cutoff = data.shift_start_time ? clock(data.shift_start_time, grace, c.clock) : null;
  const shiftMissing = data.require_ontime && data.shift_start_time === null;

  // One line that says where the driver stands right now.
  let tone: "done" | "go" | "warn" = "go";
  let status: string;
  if (data.paid) {
    tone = "done";
    status = c.att_paid;
  } else if (data.qualified) {
    tone = "done";
    status = c.att_qualified;
  } else if (outOfTime) {
    tone = "warn";
    status = c.att_out_of_reach(need, daysLeft!);
  } else if (need > 0) {
    status = c.att_need(need) + (daysLeft != null ? c.att_left(daysLeft) : "");
  } else {
    // Enough days, but the monthly earnings floor isn't met yet.
    status = grossShort > 0 ? c.att_days_done_gross(formatINR(grossShort)) : c.att_days_done;
  }

  return (
    <Card testID="rewards-attendance-card" style={style}>
      <View style={styles.head}>
        <Text style={styles.title}>{c.att_title}</Text>
        <Text style={styles.hint}>{c.att_month(data.month)}</Text>
      </View>

      {/* Where the driver stands */}
      <View style={styles.summary}>
        <View style={styles.summaryCol}>
          <Text style={styles.kicker}>{c.att_counted_days}</Text>
          <Text style={styles.hero} testID="attendance-days">
            {data.good_days}
            <Text style={styles.heroOf}> / {data.min_days}</Text>
          </Text>
        </View>
        <View style={[styles.summaryCol, styles.summaryRight]}>
          <Text style={styles.kicker}>{c.att_bonus}</Text>
          <Text style={[styles.hero, data.qualified ? styles.heroLive : null]} testID="attendance-bonus">
            +{formatINR(data.bonus)}
          </Text>
        </View>
      </View>
      <View style={styles.bar}>
        <View
          style={[
            styles.barFill,
            { width: `${pct}%` as const, backgroundColor: data.qualified ? colors.live : outOfTime ? colors.alert : colors.amber },
          ]}
        />
      </View>
      <Text
        style={[styles.status, tone === "done" ? styles.statusDone : tone === "warn" ? styles.statusWarn : styles.statusGo]}
        testID="attendance-status"
      >
        {status}
      </Text>

      {/* The rules, in plain words */}
      <Text style={styles.section}>{c.att_day_counts}</Text>
      <Rule n={1} text={c.att_rule_earn(formatINR(data.daily_target))} />
      {data.require_ontime ? (
        shiftMissing ? (
          <Rule
            n={2}
            warn
            text={c.att_rule_no_shift}
          />
        ) : cutoff ? (
          <Rule
            n={2}
            text={c.att_rule_start_by(cutoff, shift, grace)}
          />
        ) : (
          <Rule n={2} text={c.att_rule_on_time(grace)} />
        )
      ) : null}

      <Text style={styles.section}>{c.att_to_get_bonus}</Text>
      <Rule check={data.good_days >= data.min_days} text={c.att_rule_days(data.min_days)} />
      {minGross > 0 ? (
        <Rule
          check={monthGross >= minGross}
          text={c.att_rule_month_gross(formatINR(minGross), formatINR(monthGross))}
        />
      ) : null}

      <Text style={styles.note}>
        {c.att_note}
      </Text>
    </Card>
  );
};

const Rule: React.FC<{ text: string; n?: number; check?: boolean; warn?: boolean }> = ({ text, n, check, warn }) => (
  <View style={[styles.rule, warn ? styles.ruleWarn : null]}>
    <View style={[styles.bullet, check ? styles.bulletDone : null, warn ? styles.bulletWarn : null]}>
      <Text style={[styles.bulletText, check ? styles.bulletTextDone : null, warn ? styles.bulletTextWarn : null]}>
        {check ? "✓" : warn ? "!" : n ?? "•"}
      </Text>
    </View>
    <Text style={[styles.ruleText, warn ? styles.ruleTextWarn : null]}>{text}</Text>
  </View>
);

const styles = StyleSheet.create({
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { fontFamily: fonts.display, fontSize: 18, color: colors.ink, marginBottom: spacing.sm },
  hint: { fontFamily: fonts.uiMed, fontSize: 11, color: colors.muted },

  summary: {
    flexDirection: "row",
    backgroundColor: colors.paper,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
  },
  summaryCol: { flex: 1 },
  summaryRight: { alignItems: "flex-end" },
  kicker: { fontFamily: fonts.uiBold, fontSize: 10, color: colors.muted, letterSpacing: 0.8 },
  hero: { fontFamily: fonts.dataMed, fontSize: 22, color: colors.ink, marginTop: 2 },
  heroOf: { fontFamily: fonts.data, fontSize: 15, color: colors.muted },
  heroLive: { color: colors.live },

  bar: { height: 8, borderRadius: 4, backgroundColor: colors.line, marginTop: spacing.md, overflow: "hidden" },
  barFill: { height: 8, borderRadius: 4 },
  status: {
    fontFamily: fonts.uiBold,
    fontSize: 13,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    marginTop: spacing.sm,
    overflow: "hidden",
  },
  statusGo: { backgroundColor: AMBER_TINT, color: AMBER_INK },
  statusDone: { backgroundColor: LIVE_TINT, color: colors.live },
  statusWarn: { backgroundColor: ALERT_TINT, color: colors.alert },

  section: {
    fontFamily: fonts.uiBold,
    fontSize: 10,
    color: colors.muted,
    letterSpacing: 0.8,
    marginTop: spacing.lg,
    marginBottom: spacing.xs,
  },
  rule: { flexDirection: "row", alignItems: "flex-start", paddingVertical: 5 },
  ruleWarn: { backgroundColor: AMBER_TINT, borderRadius: radius.md, paddingHorizontal: spacing.sm, marginHorizontal: -spacing.sm },
  bullet: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: colors.line,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.sm,
    marginTop: 1,
  },
  bulletDone: { backgroundColor: colors.live, borderColor: colors.live },
  bulletWarn: { borderColor: colors.amber, backgroundColor: colors.card },
  bulletText: { fontFamily: fonts.dataMed, fontSize: 11, color: colors.muted },
  bulletTextDone: { color: colors.white, fontFamily: fonts.uiBold },
  bulletTextWarn: { color: AMBER_INK, fontFamily: fonts.uiBold },
  ruleText: { flex: 1, fontFamily: fonts.uiMed, fontSize: 13, color: colors.ink, lineHeight: 19 },
  ruleTextWarn: { color: AMBER_INK },

  note: { fontFamily: fonts.ui, fontSize: 11, color: colors.muted, marginTop: spacing.md },
});
