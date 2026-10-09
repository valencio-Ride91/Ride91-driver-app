// Cars — every car in the hub at a glance.
//
// The strip on top counts the cars, the driver slots still free, and the cars
// whose last inspection found a problem; the filters under it show just those.
// Each car is a card: its number plate and battery, who has it by day and by
// night (an empty slot is drawn as "Free"), and when it was last inspected and
// last changed hands. Tap a car for its page (shift change, inspection,
// service history); "+ Add car" adds one.
import React, { useCallback, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";

import { formatIST, formatISTDate } from "@/src/i18n";
import { CarsData, HubCar } from "@/src/hub/cars";
import { Chips, Icon, ProgressBar, useToast } from "@/src/hub/kit";
import { hubApi, useHubSession } from "@/src/hub/session";
import { AddCarSheet } from "@/src/hub/sheets";
import { useHubText } from "@/src/hub/text";
import { Btn, Empty, HubHeader, Tag, hubStyles } from "@/src/hub/ui";
import { colors, fonts, radius, spacing } from "@/src/theme";

type Filter = "all" | "attention" | "free" | "unchecked";
const needsAttention = (c: HubCar) => !!c.last_check?.attention.length || !!c.last_handover?.damage_note;
const freeSlots = (c: HubCar) => Number(!c.day_driver) + Number(!c.night_driver);
const matches = (c: HubCar, f: Filter) =>
  f === "all" || (f === "attention" ? needsAttention(c) : f === "free" ? freeSlots(c) > 0 : !c.last_check);
// Battery colour: red when nearly empty, amber when low, green otherwise.
const socColor = (pct: number) => (pct < 20 ? colors.alert : pct < 40 ? colors.amber : colors.brand);

export default function Cars() {
  const t = useHubText();
  const router = useRouter();
  const say = useToast();
  const { session } = useHubSession();
  const hubId = session?.hubId;
  const [data, setData] = useState<CarsData | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    if (!hubId) return;
    try {
      setData(await hubApi.get<CarsData>(`/admin/hubs/${hubId}/cars`));
    } catch {
      // keep what we had
    }
  }, [hubId]);

  // Reload whenever the tab comes back into view (e.g. after a shift change).
  useFocusEffect(useCallback(() => { load(); }, [load]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const cars = useMemo(() => data?.cars ?? [], [data]);
  const counts = useMemo(() => ({
    all: cars.length,
    attention: cars.filter(needsAttention).length,
    free: cars.filter((c) => freeSlots(c) > 0).length,
    unchecked: cars.filter((c) => !c.last_check).length,
    slots: cars.reduce((n, c) => n + freeSlots(c), 0),
  }), [cars]);
  const list = cars.filter((c) => matches(c, filter));

  const slot = (label: string, who: { name: string | null } | null) => (
    <View style={[styles.slot, who ? null : styles.slotFree]}>
      <Text style={styles.slotLabel}>{label}</Text>
      <Text style={[styles.slotName, who ? null : { color: colors.muted, fontFamily: fonts.uiMed }]} numberOfLines={1}>{who ? who.name ?? "—" : t.slot_free}</Text>
    </View>
  );

  return (
    <SafeAreaView style={hubStyles.safe} edges={["top"]}>
      <HubHeader title={t.tab_cars} right={<Btn label={t.car_add} small onPress={() => setAdding(true)} testID="hub-add-car" />} />
      <ScrollView contentContainerStyle={hubStyles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {!data ? <Empty>{t.loading}</Empty> : (
          <>
            <View style={[hubStyles.card, styles.stats]} testID="hub-car-stats">
              {([[counts.all, t.tab_cars, colors.ink], [counts.slots, t.free_slots, colors.ink], [counts.attention, t.check_attention, counts.attention ? "#8A5D00" : colors.ink]] as const).map(([n, label, color], i) => (
                <View key={label} style={[styles.stat, i ? styles.statDivider : null]}>
                  <Text style={[styles.statValue, { color }]}>{n}</Text>
                  <Text style={styles.statLabel} numberOfLines={1}>{label}</Text>
                </View>
              ))}
            </View>

            <Chips
              testID="hub-car-filter" value={filter} onChange={setFilter}
              options={[
                { key: "all", label: t.all, count: counts.all },
                { key: "attention", label: t.check_attention, count: counts.attention },
                { key: "free", label: t.car_f_free, count: counts.free },
                { key: "unchecked", label: t.car_f_unchecked, count: counts.unchecked },
              ]}
            />

            <View style={styles.list} testID="hub-car-list">
              {list.length === 0 ? <Empty>{cars.length ? t.no_match_cars : t.cars_none}</Empty> : list.map((c) => {
                const flagged = c.last_check?.attention.length ?? 0;
                return (
                  <TouchableOpacity key={c.id} style={[hubStyles.card, styles.car]} onPress={() => router.push(`/car/${c.id}` as never)} testID={`hub-car-${c.id}`}>
                    <View style={styles.carTop}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text style={styles.plate} numberOfLines={1}>{c.number ?? "—"}</Text>
                        {c.model ? <Text style={hubStyles.sub} numberOfLines={1}>{c.model}</Text> : null}
                      </View>
                      {c.current_soc != null ? (
                        <View style={styles.soc}>
                          <View style={styles.socRow}>
                            <Icon name="battery-half" size={16} color={colors.muted} />
                            <Text style={styles.socText}>{c.current_soc}%</Text>
                          </View>
                          <ProgressBar value={c.current_soc / 100} color={socColor(c.current_soc)} />
                        </View>
                      ) : null}
                      <Icon name="chevron-forward" size={18} color={colors.muted} />
                    </View>

                    <View style={styles.slots}>
                      {slot(t.day_short, c.day_driver)}
                      {slot(t.night_short, c.night_driver)}
                    </View>

                    <View style={styles.foot}>
                      <View style={styles.footLine}>
                        <Icon name={flagged ? "alert-circle" : c.last_check ? "checkmark-circle" : "help-circle-outline"} size={16} color={flagged ? colors.amber : c.last_check ? colors.live : colors.muted} />
                        <Text style={[styles.footText, flagged ? { color: "#8A5D00", fontFamily: fonts.uiMed } : null]} numberOfLines={1}>
                          {c.last_check
                            ? `${t.car_last_inspected(formatISTDate(c.last_check.created_at))}${flagged ? ` · ${t.check_n_attention(flagged)}` : ""}`
                            : t.car_never_inspected}
                        </Text>
                      </View>
                      <View style={styles.footLine}>
                        <Icon name="swap-horizontal" size={16} color={colors.muted} />
                        <Text style={styles.footText} numberOfLines={1}>{c.last_handover ? t.last_change(formatIST(c.last_handover.created_at)) : t.never_changed}</Text>
                        {c.last_handover?.damage_note ? <Tag tone="warn">{t.damage_tag}</Tag> : null}
                      </View>
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          </>
        )}
      </ScrollView>
      <AddCarSheet visible={adding} hubId={hubId ?? ""} onClose={() => setAdding(false)} onDone={(m) => { setAdding(false); say(m); load(); }} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  stats: { flexDirection: "row", paddingVertical: spacing.md, paddingHorizontal: 0, marginBottom: spacing.md },
  stat: { flex: 1, alignItems: "center", paddingHorizontal: spacing.sm },
  statDivider: { borderLeftWidth: 1, borderLeftColor: colors.line },
  statValue: { fontFamily: fonts.display, fontSize: 26, lineHeight: 30 },
  statLabel: { fontFamily: fonts.uiMed, fontSize: 12, color: colors.muted, marginTop: 2 },
  list: { gap: spacing.md, marginTop: spacing.md },
  car: { padding: spacing.md },
  carTop: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  plate: { fontFamily: fonts.dataMed, fontSize: 18, color: colors.ink },
  soc: { width: 74, gap: 4 },
  socRow: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 4 },
  socText: { fontFamily: fonts.dataMed, fontSize: 14, color: colors.ink },
  slots: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  slot: { flex: 1, minWidth: 0, paddingVertical: 8, paddingHorizontal: spacing.md, borderRadius: radius.md, backgroundColor: colors.paper },
  slotFree: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line, borderStyle: "dashed" },
  slotLabel: { fontFamily: fonts.uiBold, fontSize: 11, color: colors.muted },
  slotName: { fontFamily: fonts.uiBold, fontSize: 14, color: colors.ink, marginTop: 1 },
  foot: { marginTop: spacing.md, gap: 6 },
  footLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  footText: { flexShrink: 1, fontFamily: fonts.ui, fontSize: 13, color: colors.muted },
});
