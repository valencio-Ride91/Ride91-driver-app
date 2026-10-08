// Today — what the hub manager opens the app to: how the coming shift looks,
// and the short list of drivers who need a call right now.
import React, { useCallback, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { formatINR, formatISTTime } from "@/src/i18n";
import { useHubSession } from "@/src/hub/session";
import { useHubText, HubText } from "@/src/hub/text";
import { Attention, useHubToday } from "@/src/hub/today";
import { Btn, Empty, HubHeader, SectionTitle, Tile, callPhone, hubStyles } from "@/src/hub/ui";
import { colors, fonts, spacing } from "@/src/theme";

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

export default function Today() {
  const t = useHubText();
  const router = useRouter();
  const { session, signOut, chooseHub } = useHubSession();
  const { today, refresh } = useHubToday();
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  const c = today?.counts;
  const shift = c?.shift ?? {};
  const coming = (shift.coming ?? 0) + (shift.started ?? 0);
  const silent = (shift.no_answer ?? 0) + (shift.not_started ?? 0) + (shift.late ?? 0);
  const noTime = shift.no_shift_time ?? 0;
  // A fleet manager or owner can hop to another hub; a hub manager cannot.
  const canChangeHub = session?.role !== "hub_manager";

  return (
    <SafeAreaView style={hubStyles.safe} edges={["top"]}>
      <HubHeader />
      <ScrollView contentContainerStyle={hubStyles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {!today ? <Empty>{t.loading}</Empty> : (
          <>
            {/* Two rows of two, so the labels never have to squeeze on a narrow phone. */}
            <View testID="hub-shift-tiles" style={{ gap: spacing.sm }}>
              <View style={styles.tiles}>
                <Tile value={String(coming)} label={t.coming} tone="ok" testID="hub-tile-coming" />
                <Tile value={String(shift.not_coming ?? 0)} label={t.not_coming} tone={shift.not_coming ? "bad" : "mute"} testID="hub-tile-notcoming" />
              </View>
              <View style={styles.tiles}>
                <Tile value={String(silent)} label={t.no_answer} tone={silent ? "warn" : "mute"} testID="hub-tile-silent" />
                <Tile value={String(c?.on_duty ?? 0)} label={t.on_duty_now} testID="hub-tile-onduty" />
              </View>
            </View>

            {noTime > 0 ? <Text style={[hubStyles.warn, { marginTop: spacing.md, marginBottom: 0 }]} testID="hub-no-shift-times">{t.no_shift_times(noTime)}</Text> : null}

            <SectionTitle>{t.needs_you}</SectionTitle>
            <View style={hubStyles.card} testID="hub-attention">
              {today.attention.length === 0 ? <Empty>{t.all_clear}</Empty> : today.attention.map((a, i) => (
                <View key={`${a.kind}-${a.driver_id}`} style={[hubStyles.row, i === 0 ? hubStyles.rowFirst : null]} testID={`hub-att-${a.kind}-${a.driver_id}`}>
                  <TouchableOpacity style={{ flex: 1 }} onPress={() => router.push(`/driver/${a.driver_id}` as never)}>
                    <Text style={hubStyles.name}>{a.name ?? "—"}</Text>
                    <Text style={hubStyles.subAlert}>{why(a, t)}</Text>
                  </TouchableOpacity>
                  <Btn label={t.call} small kind="ghost" onPress={() => callPhone(a.phone)} disabled={!a.phone} />
                </View>
              ))}
            </View>

            <View style={[styles.tiles, { marginTop: spacing.lg }]}>
              <Tile value={formatINR(c?.cash_owed ?? 0)} label={t.cash_to_collect} tone={c?.over_limit ? "bad" : undefined} onPress={() => router.push("/(tabs)/money" as never)} testID="hub-tile-cash" />
              <Tile value={String(c?.withdrawals_pending ?? 0)} label={t.withdrawals} onPress={() => router.push("/(tabs)/money" as never)} testID="hub-tile-withdrawals" />
            </View>
          </>
        )}

        <View style={styles.footer}>
          <Text style={styles.who}>{session?.username}</Text>
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            {canChangeHub ? <Btn label={t.change_hub} small kind="ghost" onPress={() => chooseHub("", "")} testID="hub-change-hub" /> : null}
            <Btn label={t.sign_out} small kind="ghost" onPress={signOut} testID="hub-sign-out" />
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  tiles: { flexDirection: "row", gap: spacing.sm },
  footer: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: spacing.xl },
  who: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.muted },
});
