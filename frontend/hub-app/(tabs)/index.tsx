// Today — what the hub manager opens the app to, in the order they need it:
//
//   1. the hub at a glance: how many are on duty, and one bar that splits
//      every driver into on duty / coming / silent / not coming / off;
//   2. the drivers who need a call right now;
//   3. the four things a manager does most (shift change, cash, earnings, map);
//   4. what is waiting on them (withdrawals, requests, messages);
//   5. who is out on the road;
//   6. the way into Hub settings (shift times for all, removed drivers,
//      password, sign out).
import React, { useCallback, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { formatINR, formatISTDate, formatISTTime } from "@/src/i18n";
import { Avatar, Icon, IconName } from "@/src/hub/kit";
import { useHubSession } from "@/src/hub/session";
import { BUCKETS, Bucket, bucketOf, doing } from "@/src/hub/status";
import { useHubText, HubText } from "@/src/hub/text";
import { Attention, useHubToday } from "@/src/hub/today";
import { Empty, HubHeader, SectionTitle, Tag, callPhone, hubStyles } from "@/src/hub/ui";
import { colors, fonts, radius, spacing } from "@/src/theme";

// The line under the driver's name: why they are on the list.
function why(a: Attention, t: HubText): string {
  const parts: string[] = [t.att[a.kind] ?? a.kind];
  if (a.kind === "not_coming") {
    const reason = a.reason_code === "other" && a.reason_note ? a.reason_note : a.reason_code ? t.reasons[a.reason_code] ?? a.reason_code : "";
    if (reason) parts.push(reason);
    if (a.back_by) parts.push(t.back_by(a.back_by));
  } else if (a.kind === "tracking_stopped") {
    parts.push(a.reason === "location_off" ? t.att_location_off : t.att_no_signal);
  } else if (a.kind === "over_cash_limit") {
    parts.push(formatINR(a.amount ?? 0));
  } else if (a.shift_start) {
    parts.push(t.shift_at(formatISTTime(a.shift_start)));
  }
  return parts.join(" · ");
}

// The bar's colours, picked to read on the dark summary card.
const BUCKET_COLOR: Record<Bucket, string> = {
  on_duty: colors.brand, coming: "#BFE5AD", silent: colors.amber, not_coming: "#E8806F", off: "#8B8F88",
};

// Problems that lose a shift or money are red; the rest are amber.
const URGENT: Record<string, boolean> = { not_coming: true, not_started: true, over_cash_limit: true };

export default function Today() {
  const t = useHubText();
  const router = useRouter();
  const { session } = useHubSession();
  const { today, refresh } = useHubToday();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  const split = useMemo(() => {
    const n: Record<Bucket, number> = { on_duty: 0, coming: 0, silent: 0, not_coming: 0, off: 0 };
    for (const d of today?.drivers ?? []) n[bucketOf(d)] += 1;
    return n;
  }, [today]);

  // The next shift still to begin, and how many drivers it is for.
  const nextShift = useMemo(() => {
    if (!today) return null;
    const now = Date.parse(today.server_ts);
    const starts = today.drivers
      .filter((d) => !d.on_duty && d.shift_start)
      .map((d) => Date.parse(d.shift_start as string))
      .filter((ms) => Number.isFinite(ms) && ms > now)
      .sort((a, b) => a - b);
    if (starts.length === 0) return null;
    return { at: new Date(starts[0]).toISOString(), drivers: starts.filter((ms) => ms - starts[0] < 60000).length };
  }, [today]);

  // Each tap is a new request (`at`), so the map opens even if the list was
  // chosen on the Drivers tab since the last one.
  const [mapTaps, setMapTaps] = useState(0);
  const openMap = useCallback(() => {
    setMapTaps(mapTaps + 1);
    router.push({ pathname: "/(tabs)/drivers", params: { view: "map", at: String(mapTaps + 1) } } as never);
  }, [router, mapTaps]);

  const onDuty = useMemo(
    () => (today?.drivers ?? []).filter((d) => d.on_duty).sort((a, b) => b.on_duty_seconds - a.on_duty_seconds),
    [today],
  );

  const c = today?.counts;
  const total = today?.drivers.length ?? 0;
  const noTime = c?.shift?.no_shift_time ?? 0;
  const labels: Record<Bucket, string> = { on_duty: t.on_duty, coming: t.coming, silent: t.no_answer, not_coming: t.not_coming, off: t.off_duty };
  const waiting = [
    { key: "withdrawals", label: t.withdrawals, n: c?.withdrawals_pending ?? 0, to: "/(tabs)/money" },
    { key: "requests", label: t.requests, n: c?.requests_pending ?? 0, to: "/(tabs)/inbox" },
    { key: "messages", label: t.messages, n: c?.unread_messages ?? 0, to: "/(tabs)/inbox" },
  ].filter((w) => w.n > 0);
  const actions = [
    { key: "shift", icon: "swap-horizontal" as IconName, title: t.shift_change, sub: t.qa_shift_sub, go: () => router.push("/(tabs)/cars" as never) },
    {
      key: "cash", icon: "cash-outline" as IconName, title: t.record_cash, alert: !!c?.over_limit,
      sub: c?.cash_owed ? t.qa_cash_sub(formatINR(c.cash_owed)) : t.nobody_owes,
      go: () => router.push("/(tabs)/money" as never),
    },
    { key: "earnings", icon: "create-outline" as IconName, title: t.enter_earnings, sub: t.qa_earn_sub, go: () => router.push("/earnings" as never) },
    { key: "map", icon: "map-outline" as IconName, title: t.view_map, sub: t.qa_map_sub, go: openMap },
  ];

  return (
    <SafeAreaView style={hubStyles.safe} edges={["top"]}>
      <HubHeader />
      <ScrollView contentContainerStyle={hubStyles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {!today ? <Empty>{t.loading}</Empty> : (
          <>
            <View style={styles.hero} testID="hub-hero">
              <View style={styles.heroTop}>
                <Text style={styles.heroLabel}>{formatISTDate(today.server_ts)}</Text>
                <Text style={styles.heroLabel} testID="hub-updated">{t.updated_at(formatISTTime(today.server_ts))}</Text>
              </View>
              <View style={styles.heroBig}>
                <Text style={styles.heroNumber} testID="hub-on-duty">{split.on_duty}</Text>
                <Text style={styles.heroOf}>{t.of_on_duty(total)}</Text>
              </View>
              <View style={styles.bar} testID="hub-bar">
                {BUCKETS.filter((b) => split[b] > 0).map((b) => (
                  <View key={b} style={{ flex: split[b], backgroundColor: BUCKET_COLOR[b] }} />
                ))}
              </View>
              <View style={styles.legend}>
                {BUCKETS.filter((b) => split[b] > 0 || b === "on_duty").map((b) => (
                  <View key={b} style={styles.legendItem} testID={`hub-split-${b}`}>
                    <View style={[styles.legendDot, { backgroundColor: BUCKET_COLOR[b] }]} />
                    <Text style={styles.legendText}>{labels[b]} <Text style={styles.legendCount}>{split[b]}</Text></Text>
                  </View>
                ))}
              </View>
              {nextShift ? (
                <Text style={styles.heroNext} testID="hub-next-shift">{t.next_shift(formatISTTime(nextShift.at), nextShift.drivers)}</Text>
              ) : null}
            </View>

            {noTime > 0 ? <Text style={[hubStyles.warn, { marginTop: spacing.md, marginBottom: 0 }]} testID="hub-no-shift-times">{t.no_shift_times(noTime)}</Text> : null}

            <SectionTitle right={today.attention.length ? <View style={styles.count}><Text style={styles.countText}>{today.attention.length}</Text></View> : null}>
              {t.needs_you}
            </SectionTitle>
            {today.attention.length === 0 ? (
              <View style={styles.clear} testID="hub-all-clear">
                <View style={styles.clearDot} />
                <Text style={styles.clearText}>{t.all_clear}</Text>
              </View>
            ) : (
              <View style={[hubStyles.card, styles.flush]} testID="hub-attention">
                {today.attention.map((a, i) => {
                  const urgent = !!URGENT[a.kind];
                  return (
                    <View key={`${a.kind}-${a.driver_id}`} style={[styles.att, i === 0 ? hubStyles.rowFirst : null]} testID={`hub-att-${a.kind}-${a.driver_id}`}>
                      <View style={[styles.attBar, { backgroundColor: urgent ? colors.alert : colors.amber }]} />
                      <TouchableOpacity style={{ flex: 1 }} onPress={() => router.push(`/driver/${a.driver_id}` as never)}>
                        <Text style={hubStyles.name}>{a.name ?? "—"}</Text>
                        <Text style={[styles.attWhy, { color: urgent ? colors.alert : "#8A5D00" }]}>{why(a, t)}</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[styles.call, !a.phone ? { opacity: 0.4 } : null]} disabled={!a.phone} onPress={() => callPhone(a.phone)} testID={`hub-call-${a.driver_id}`}>
                        <Icon name="call" size={15} color={colors.onBrand} />
                        <Text style={styles.callText}>{t.call}</Text>
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
            )}

            <SectionTitle>{t.quick_title}</SectionTitle>
            <View style={styles.grid} testID="hub-actions">
              {[actions.slice(0, 2), actions.slice(2)].map((pair, r) => (
                <View key={r} style={styles.gridRow}>
                  {pair.map((a) => (
                    <TouchableOpacity key={a.key} style={styles.action} onPress={a.go} testID={`hub-action-${a.key}`}>
                      <View style={[styles.actionIcon, a.alert ? { backgroundColor: "#F8E4E0" } : null]}>
                        <Icon name={a.icon} size={20} color={a.alert ? colors.alert : colors.live} />
                      </View>
                      <Text style={styles.actionTitle} numberOfLines={1}>{a.title}</Text>
                      <Text style={[styles.actionSub, a.alert ? { color: colors.alert, fontFamily: fonts.uiMed } : null]} numberOfLines={2}>{a.sub}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              ))}
            </View>

            {waiting.length ? (
              <>
                <SectionTitle>{t.waiting_title}</SectionTitle>
                <View style={hubStyles.card} testID="hub-waiting">
                  {waiting.map((w, i) => (
                    <TouchableOpacity key={w.key} style={[hubStyles.row, i === 0 ? hubStyles.rowFirst : null]} onPress={() => router.push(w.to as never)} testID={`hub-waiting-${w.key}`}>
                      <Text style={[hubStyles.name, { flex: 1 }]}>{w.label}</Text>
                      <View style={styles.count}><Text style={styles.countText}>{w.n}</Text></View>
                      <Icon name="chevron-forward" size={18} color={colors.muted} />
                    </TouchableOpacity>
                  ))}
                </View>
              </>
            ) : null}

            <SectionTitle right={<TouchableOpacity onPress={() => router.push("/(tabs)/drivers" as never)} testID="hub-all-drivers"><Text style={styles.link}>{t.all_drivers}</Text></TouchableOpacity>}>
              {t.on_duty_now}
            </SectionTitle>
            <View style={hubStyles.card} testID="hub-on-road">
              {onDuty.length === 0 ? <Empty>{t.nobody_on_duty}</Empty> : onDuty.map((d, i) => (
                <TouchableOpacity key={d.driver_id} style={[hubStyles.row, i === 0 ? hubStyles.rowFirst : null]} onPress={() => router.push(`/driver/${d.driver_id}` as never)} testID={`hub-road-${d.driver_id}`}>
                  <Avatar name={d.name} tone={d.tracking === "stopped" ? "warn" : "ok"} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={hubStyles.name}>{d.name ?? "—"}</Text>
                    <Text style={hubStyles.sub}>{[doing(d, t), d.vehicle_number].filter(Boolean).join(" · ")}</Text>
                  </View>
                  {d.tracking === "stopped" ? <Tag tone="warn">{t.att.tracking_stopped}</Tag> : null}
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}

        <TouchableOpacity style={[hubStyles.card, styles.footer]} onPress={() => router.push("/settings" as never)} testID="hub-settings-link">
          <View style={styles.actionIcon}><Icon name="settings-outline" size={20} color={colors.live} /></View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={hubStyles.name}>{t.settings_title}</Text>
            <Text style={hubStyles.sub} numberOfLines={1}>{session?.username}</Text>
          </View>
          <Icon name="chevron-forward" size={18} color={colors.muted} />
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const ON_DARK = "#C9CDC5";       // quiet text on the charcoal card

const styles = StyleSheet.create({
  hero: { backgroundColor: colors.ink, borderRadius: radius.xl, padding: spacing.lg },
  heroTop: { flexDirection: "row", justifyContent: "space-between", gap: spacing.sm },
  heroLabel: { fontFamily: fonts.uiMed, fontSize: 12, color: ON_DARK },
  heroBig: { flexDirection: "row", alignItems: "baseline", gap: spacing.sm, marginTop: spacing.xs },
  heroNumber: { fontFamily: fonts.display, fontSize: 56, lineHeight: 62, color: colors.white },
  heroOf: { fontFamily: fonts.uiMed, fontSize: 16, color: ON_DARK },
  bar: { flexDirection: "row", gap: 2, height: 12, borderRadius: 6, overflow: "hidden", backgroundColor: "#5C5C5C", marginTop: spacing.sm },
  legend: { flexDirection: "row", flexWrap: "wrap", columnGap: spacing.md, rowGap: 6, marginTop: spacing.md },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  legendDot: { width: 9, height: 9, borderRadius: 5 },
  legendText: { fontFamily: fonts.ui, fontSize: 13, color: ON_DARK },
  legendCount: { fontFamily: fonts.dataMed, color: colors.white },
  heroNext: {
    fontFamily: fonts.uiMed, fontSize: 13, color: colors.white, marginTop: spacing.md, paddingTop: spacing.md,
    borderTopWidth: 1, borderTopColor: "#5C5C5C",
  },
  count: { minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, backgroundColor: colors.alert, alignItems: "center", justifyContent: "center" },
  countText: { fontFamily: fonts.uiBold, fontSize: 12, color: colors.white },
  clear: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: spacing.md,
    backgroundColor: colors.brandTint, borderRadius: radius.lg,
  },
  clearDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.live },
  clearText: { flex: 1, fontFamily: fonts.uiMed, fontSize: 14, color: colors.live },
  flush: { paddingVertical: 2 },
  att: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: 12, borderTopWidth: 1, borderTopColor: colors.line },
  attBar: { width: 4, alignSelf: "stretch", borderRadius: 2 },
  attWhy: { fontFamily: fonts.uiMed, fontSize: 12, marginTop: 2, lineHeight: 17 },
  call: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.brand, borderRadius: 999, paddingVertical: 9, paddingHorizontal: 16 },
  callText: { fontFamily: fonts.uiBold, fontSize: 14, color: colors.onBrand },
  grid: { gap: spacing.sm },
  gridRow: { flexDirection: "row", gap: spacing.sm },
  action: {
    flex: 1, minWidth: 0, minHeight: 112, padding: spacing.md,
    backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line,
  },
  actionIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.brandTint, alignItems: "center", justifyContent: "center" },
  actionTitle: { fontFamily: fonts.uiBold, fontSize: 15, color: colors.ink, marginTop: spacing.sm },
  actionSub: { fontFamily: fonts.ui, fontSize: 12, color: colors.muted, marginTop: 2, lineHeight: 16 },
  link: { fontFamily: fonts.uiBold, fontSize: 13, color: colors.live },
  footer: { flexDirection: "row", alignItems: "center", gap: spacing.md, marginTop: spacing.xl },
});
