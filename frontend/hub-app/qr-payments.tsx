// QR payments — what riders paid on the hub's drivers' collection QRs.
//
// A rider who would have paid a trip in cash scans the driver's QR instead;
// the money goes to the fleet and counts against the cash that driver owes.
// This screen shows how much came in that way: today, yesterday or the last
// 7 days, the total, each driver's share (drivers with no QR yet are marked),
// and every payment. Tap a driver to see only their payments.
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { formatINR, formatIST } from "@/src/i18n";
import { Avatar, Icon, Segmented } from "@/src/hub/kit";
import { hubApi, useHubSession } from "@/src/hub/session";
import { useHubText } from "@/src/hub/text";
import { Empty, SectionTitle, hubStyles } from "@/src/hub/ui";
import { colors, fonts, radius, spacing } from "@/src/theme";

type Period = "today" | "yesterday" | "week";

interface DriverRow { driver_id: string; name: string | null; code: string | null; has_qr: boolean; total: number; count: number; last_at: string | null }
interface Payment { id: string; driver_id: string; driver_name: string | null; amount: number; occurred_at: string; ref: string | null }
interface QrData { from_date: string; to_date: string; today: string; total: number; count: number; items: DriverRow[]; payments: Payment[] }

// Step a YYYY-MM-DD date by whole days.
function shiftDate(d: string, days: number): string {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + days);
  return x.toISOString().slice(0, 10);
}

export default function QrPayments() {
  const t = useHubText();
  const router = useRouter();
  const { session } = useHubSession();
  const hubId = session?.hubId;
  const [period, setPeriod] = useState<Period>("today");
  const [data, setData] = useState<QrData | null>(null);
  const [serverToday, setServerToday] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [only, setOnly] = useState<string | null>(null);      // show one driver's payments

  const load = useCallback(async () => {
    if (!hubId) return;
    try {
      // The hub's "today" comes from the server (its day starts at 04:00 India time).
      let today = serverToday;
      let r: QrData;
      if (!today || period === "today") {
        r = await hubApi.get<QrData>(`/admin/hubs/${hubId}/qr-collections`);
        today = r.today;
        setServerToday(r.today);
      }
      if (period !== "today") {
        const from = period === "yesterday" ? shiftDate(today as string, -1) : shiftDate(today as string, -6);
        const to = period === "yesterday" ? shiftDate(today as string, -1) : (today as string);
        r = await hubApi.get<QrData>(`/admin/hubs/${hubId}/qr-collections?from_date=${from}&to_date=${to}`);
      }
      setData(r!);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [hubId, period, serverToday]);

  useEffect(() => {
    load();
    if (period !== "today") return;
    const id = setInterval(load, 30000);      // today's figures keep coming in
    return () => clearInterval(id);
  }, [load, period]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const shown = useMemo(() => (data?.payments ?? []).filter((p) => !only || p.driver_id === only), [data, only]);
  const onlyName = only ? data?.items.find((i) => i.driver_id === only)?.name ?? "—" : null;
  const back = () => (router.canGoBack() ? router.back() : router.replace("/(tabs)" as never));

  return (
    <SafeAreaView style={hubStyles.safe} edges={["top", "bottom"]}>
      <View style={styles.bar}>
        <TouchableOpacity onPress={back} style={styles.back} testID="hub-qr-back">
          <Icon name="chevron-back" size={26} color={colors.ink} />
        </TouchableOpacity>
        <Text style={styles.title} testID="hub-qr-title">{t.qr_title}</Text>
      </View>
      <Segmented
        style={styles.switch} testID="hub-qr-period" value={period} onChange={(p) => { setPeriod(p); setOnly(null); }}
        options={[{ key: "today", label: t.today_word }, { key: "yesterday", label: t.yesterday_word }, { key: "week", label: t.qr_week }]}
      />

      <ScrollView contentContainerStyle={hubStyles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {!data ? <Empty>{failed ? t.action_fail : t.loading}</Empty> : (
          <>
            <View style={styles.hero} testID="hub-qr-total">
              <Text style={styles.heroLabel}>{t.qr_total_label}</Text>
              <Text style={styles.heroAmount} numberOfLines={1} adjustsFontSizeToFit>{formatINR(data.total)}</Text>
              <Text style={styles.heroSub}>{t.qr_count(data.count)}</Text>
              <Text style={styles.heroNote}>{t.qr_explain}</Text>
            </View>

            <SectionTitle>{t.tab_drivers}</SectionTitle>
            <View style={[hubStyles.card, { paddingVertical: 2 }]} testID="hub-qr-drivers">
              {data.items.length === 0 ? <Empty>{t.no_drivers}</Empty> : data.items.map((d, i) => (
                <TouchableOpacity key={d.driver_id} style={[hubStyles.row, i === 0 ? hubStyles.rowFirst : null, only === d.driver_id ? styles.picked : null]}
                  onPress={() => setOnly(only === d.driver_id ? null : d.driver_id)} disabled={!d.count} testID={`hub-qr-driver-${d.driver_id}`}>
                  <Avatar name={d.name} tone={d.count ? "ok" : "mute"} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={hubStyles.name} numberOfLines={1}>{d.name ?? "—"}</Text>
                    <Text style={[hubStyles.sub, !d.has_qr && !d.count ? { color: "#8A5D00" } : null]} numberOfLines={1}>
                      {d.count ? `${t.qr_count(d.count)}${d.last_at ? ` · ${t.qr_last(formatIST(d.last_at))}` : ""}` : d.has_qr ? t.qr_none_driver : t.qr_no_qr}
                    </Text>
                  </View>
                  <Text style={[styles.amount, d.count ? { color: colors.live } : { color: colors.muted }]}>{formatINR(d.total)}</Text>
                </TouchableOpacity>
              ))}
            </View>

            <SectionTitle right={only ? (
              <TouchableOpacity onPress={() => setOnly(null)} style={styles.filter} testID="hub-qr-clear">
                <Text style={styles.filterText} numberOfLines={1}>{onlyName}</Text>
                <Icon name="close-circle" size={16} color={colors.muted} />
              </TouchableOpacity>
            ) : null}>
              {t.qr_payments_title}
            </SectionTitle>
            <View style={[hubStyles.card, { paddingVertical: 2 }]} testID="hub-qr-payments">
              {shown.length === 0 ? <Empty>{t.qr_none}</Empty> : shown.map((p, i) => (
                <View key={p.id} style={[hubStyles.row, i === 0 ? hubStyles.rowFirst : null]}>
                  <View style={styles.qrIcon}><Icon name="qr-code-outline" size={18} color={colors.live} /></View>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={hubStyles.name} numberOfLines={1}>{p.driver_name ?? "—"}</Text>
                    <Text style={hubStyles.sub} numberOfLines={1}>{[formatIST(p.occurred_at), p.ref ? `…${p.ref}` : null].filter(Boolean).join(" · ")}</Text>
                  </View>
                  <Text style={[styles.amount, { color: colors.live }]}>{formatINR(p.amount)}</Text>
                </View>
              ))}
            </View>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const ON_DARK = "#C9CDC5";       // quiet text on the charcoal card

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.line },
  back: { paddingHorizontal: 8, paddingVertical: 2 },
  title: { flex: 1, fontFamily: fonts.display, fontSize: 22, color: colors.ink },
  switch: { marginHorizontal: spacing.md, marginTop: spacing.md },
  hero: { backgroundColor: colors.ink, borderRadius: radius.xl, padding: spacing.lg },
  heroLabel: { fontFamily: fonts.uiMed, fontSize: 13, color: ON_DARK },
  heroAmount: { fontFamily: fonts.display, fontSize: 44, lineHeight: 52, color: colors.white, marginTop: 2 },
  heroSub: { fontFamily: fonts.uiMed, fontSize: 14, color: ON_DARK, marginTop: 2 },
  heroNote: { fontFamily: fonts.ui, fontSize: 12, color: ON_DARK, marginTop: spacing.md, lineHeight: 17 },
  picked: { backgroundColor: colors.brandTint, marginHorizontal: -spacing.md, paddingHorizontal: spacing.md },
  amount: { fontFamily: fonts.dataMed, fontSize: 16 },
  qrIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.brandTint, alignItems: "center", justifyContent: "center" },
  filter: { flexDirection: "row", alignItems: "center", gap: 4, maxWidth: 180, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  filterText: { flexShrink: 1, fontFamily: fonts.uiBold, fontSize: 12, color: colors.ink },
});
