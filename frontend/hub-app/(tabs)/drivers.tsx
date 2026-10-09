// Drivers — everyone in the hub with where they stand right now, as a list or
// on a map.
//
// List: search, then filters that count the hub (on duty, coming, needs a
// call, off). Each row is the driver's initials tinted by how they stand,
// what they are doing, their car, any cash owed, and a call button. Tap the
// row for their page (duty, activity, cash, shift time, messages).
//
// Map (Google Maps): where each driver's phone was last heard from — green on
// duty and reporting, amber on duty but quiet for over ten minutes, grey for
// an off-duty driver's last position. The square is the hub itself. Tapping a
// dot brings up that driver's card, with Call and Open.
import React, { useCallback, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";

import { formatINR } from "@/src/i18n";
import { HubMap } from "@/src/hub/HubMap";
import { Avatar, Chips, Icon, IconBtn, Segmented } from "@/src/hub/kit";
import type { MapData } from "@/src/hub/mapTypes";
import { BUCKET_TONE, Bucket, MAP_COLORS, bucketOf, doing, pinKind, seenText, tagFor } from "@/src/hub/status";
import { useHubText } from "@/src/hub/text";
import { useHubToday } from "@/src/hub/today";
import { Btn, Empty, HubHeader, Tag, callPhone, hubStyles } from "@/src/hub/ui";
import { colors, fonts, radius, spacing } from "@/src/theme";

// "call" gathers the two kinds of driver the manager has to ring: silent and not coming.
type Filter = "all" | "on_duty" | "coming" | "call" | "off";
const inFilter = (b: Bucket, f: Filter) => f === "all" || (f === "call" ? b === "silent" || b === "not_coming" : b === f);

export default function Drivers() {
  const t = useHubText();
  const router = useRouter();
  const { today, refresh } = useHubToday();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [view, setView] = useState<"list" | "map">("list");
  // The home screen's Map button opens this tab with `view=map` (and a new
  // `at` each tap, so it works again after the list was chosen here). Each
  // such request is followed once.
  const { view: wanted, at } = useLocalSearchParams<{ view?: string; at?: string }>();
  const request = wanted === "map" || wanted === "list" ? `${wanted}:${at ?? ""}` : null;
  const [followed, setFollowed] = useState<string | null>(null);
  if (request && request !== followed) {
    setFollowed(request);
    setView(wanted as "list" | "map");
  }
  const [refreshing, setRefreshing] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);     // the driver whose dot was tapped

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  const counts = useMemo(() => {
    const n: Record<Filter, number> = { all: 0, on_duty: 0, coming: 0, call: 0, off: 0 };
    for (const d of today?.drivers ?? []) {
      const b = bucketOf(d);
      n.all += 1;
      n[b === "silent" || b === "not_coming" ? "call" : b] += 1;
    }
    return n;
  }, [today]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const hit = (today?.drivers ?? []).filter((d) =>
      inFilter(bucketOf(d), filter)
      && (!needle || (d.name ?? "").toLowerCase().includes(needle) || (d.phone ?? "").includes(needle) || (d.vehicle_number ?? "").toLowerCase().includes(needle)));
    // On duty first, then by name.
    return [...hit].sort((a, b) => Number(b.on_duty) - Number(a.on_duty) || (a.name ?? "").localeCompare(b.name ?? ""));
  }, [today, q, filter]);

  const mapData = useMemo<MapData>(() => {
    const pins = (today?.drivers ?? [])
      .filter((d) => typeof d.lat === "number" && typeof d.lng === "number")
      .map((d) => ({ id: d.driver_id, lat: d.lat as number, lng: d.lng as number, kind: pinKind(d) }));
    const h = today?.hub;
    const hub = h && typeof h.lat === "number" && typeof h.lng === "number" ? { lat: h.lat, lng: h.lng } : null;
    return { pins, hub };
  }, [today]);

  const openDriver = useCallback((id: string) => router.push(`/driver/${id}` as never), [router]);
  // Read from the latest data each time, so the card keeps up while it is open.
  const pickedDriver = (picked && today?.drivers.find((d) => d.driver_id === picked && typeof d.lat === "number")) || null;
  const pickedTag = pickedDriver ? tagFor(pickedDriver, t) : null;

  return (
    <SafeAreaView style={hubStyles.safe} edges={["top"]}>
      <HubHeader title={t.tab_drivers} right={<Btn label={t.add_driver} small onPress={() => router.push("/driver-form" as never)} testID="hub-add-driver" />} />
      <Segmented
        style={styles.switch} testID="hub-drivers" value={view} onChange={setView}
        options={[{ key: "list", label: t.view_list }, { key: "map", label: t.view_map }]}
      />

      {view === "map" ? (
        <View style={{ flex: 1 }}>
          <Text style={styles.count} testID="hub-map-count">
            {!today ? t.loading : mapData.pins.length === 0 ? t.map_none : t.map_count(mapData.pins.length, today.drivers.length)}
          </Text>
          <View style={styles.map}>
            <HubMap data={mapData} selectedId={pickedDriver?.driver_id ?? null} onSelect={setPicked} fitLabel={t.map_fit} />
            {pickedDriver && pickedTag ? (
              <View style={styles.picked} testID="hub-map-card">
                <View style={styles.pickedTop}>
                  <Avatar name={pickedDriver.name} tone={BUCKET_TONE[bucketOf(pickedDriver)]} />
                  <View style={{ flex: 1 }}>
                    <Text style={hubStyles.name}>{pickedDriver.name ?? "—"}</Text>
                    <Text style={hubStyles.sub}>{doing(pickedDriver, t)}</Text>
                    <Text style={hubStyles.sub} testID="hub-map-seen">{seenText(pickedDriver.seen_minutes, t)}</Text>
                  </View>
                  <Tag tone={pickedTag.tone}>{pickedTag.label}</Tag>
                </View>
                <View style={styles.pickedBtns}>
                  <Btn label={t.call} small kind="ghost" onPress={() => callPhone(pickedDriver.phone)} style={{ flex: 1 }} testID="hub-map-call" />
                  <Btn label={t.map_open} small onPress={() => openDriver(pickedDriver.driver_id)} style={{ flex: 1 }} testID="hub-map-open" />
                </View>
              </View>
            ) : null}
          </View>
          <View style={styles.legend}>
            {([["live", t.map_live], ["quiet", t.map_quiet], ["off", t.map_off]] as const).map(([k, label]) => (
              <View key={k} style={styles.legendItem}>
                <View style={[styles.legendDot, { backgroundColor: MAP_COLORS[k] }]} />
                <Text style={styles.legendText}>{label}</Text>
              </View>
            ))}
          </View>
        </View>
      ) : (
        <ScrollView contentContainerStyle={hubStyles.scroll} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
          <View style={styles.search}>
            <Icon name="search" size={18} color={colors.muted} />
            <TextInput
              testID="hub-driver-search"
              value={q}
              onChangeText={setQ}
              placeholder={t.search}
              placeholderTextColor={colors.muted}
              style={styles.searchInput}
            />
            {q ? <TouchableOpacity onPress={() => setQ("")} hitSlop={8} testID="hub-driver-search-clear"><Icon name="close-circle" size={18} color={colors.muted} /></TouchableOpacity> : null}
          </View>
          <Chips
            testID="hub-driver-filter" value={filter} onChange={setFilter}
            options={[
              { key: "all", label: t.all, count: counts.all },
              { key: "on_duty", label: t.on_duty, count: counts.on_duty },
              { key: "coming", label: t.coming, count: counts.coming },
              { key: "call", label: t.needs_call, count: counts.call },
              { key: "off", label: t.off_duty, count: counts.off },
            ]}
          />
          {!today ? <Empty>{t.loading}</Empty> : (
            <View style={[hubStyles.card, styles.list]} testID="hub-driver-list">
              {list.length === 0 ? <Empty>{today.drivers.length ? t.no_match : t.no_drivers}</Empty> : list.map((d, i) => {
                const tag = tagFor(d, t);
                return (
                  <TouchableOpacity
                    key={d.driver_id}
                    style={[hubStyles.row, i === 0 ? hubStyles.rowFirst : null]}
                    onPress={() => openDriver(d.driver_id)}
                    testID={`hub-driver-${d.driver_id}`}
                  >
                    <Avatar name={d.name} tone={BUCKET_TONE[bucketOf(d)]} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={styles.nameRow}>
                        <Text style={[hubStyles.name, { flexShrink: 1 }]} numberOfLines={1}>{d.name ?? "—"}</Text>
                        <Tag tone={tag.tone}>{tag.label}</Tag>
                      </View>
                      <Text style={hubStyles.sub} numberOfLines={1}>{[doing(d, t), d.vehicle_number].filter(Boolean).join(" · ")}</Text>
                      {d.you_owe > 0 ? (
                        <Text style={d.over_limit ? hubStyles.subAlert : hubStyles.sub}>
                          {t.owes(formatINR(d.you_owe))}{d.over_limit ? ` · ${t.over_limit}` : ""}
                        </Text>
                      ) : null}
                    </View>
                    <IconBtn icon="call" onPress={() => callPhone(d.phone)} disabled={!d.phone} label={t.call} testID={`hub-driver-call-${d.driver_id}`} />
                  </TouchableOpacity>
                );
              })}
            </View>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  switch: { marginHorizontal: spacing.md, marginTop: spacing.xs },
  search: {
    flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, marginBottom: spacing.md,
    backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line,
  },
  searchInput: { flex: 1, paddingVertical: 11, fontFamily: fonts.uiMed, fontSize: 15, color: colors.ink },
  list: { marginTop: spacing.md, paddingVertical: 2 },
  nameRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  count: { fontFamily: fonts.ui, fontSize: 13, color: colors.muted, marginHorizontal: spacing.md, marginTop: spacing.sm, marginBottom: 6 },
  map: { flex: 1, marginHorizontal: spacing.md, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, overflow: "hidden", backgroundColor: colors.paper },
  picked: {
    position: "absolute", left: 10, right: 10, bottom: 10, padding: spacing.md, elevation: 3,
    backgroundColor: colors.card, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line,
  },
  pickedTop: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  pickedBtns: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.md },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md, rowGap: 4, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontFamily: fonts.ui, fontSize: 12, color: colors.muted },
});
