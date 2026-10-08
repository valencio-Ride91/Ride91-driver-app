// Drivers — everyone in the hub with where they stand right now, as a list or
// on a map. Tap one for their page (duty, activity, cash, shift time,
// messages).
//
// The map shows where each driver's phone was last heard from: green while on
// duty and reporting, amber when on duty but quiet for over ten minutes, grey
// for an off-duty driver's last position. The square is the hub itself.
import React, { useCallback, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { formatINR } from "@/src/i18n";
import { HubMap } from "@/src/hub/HubMap";
import { MapData, MapLabels } from "@/src/hub/mapHtml";
import { MAP_COLORS, doing, dotFor, seenText, tagFor } from "@/src/hub/status";
import { useHubText } from "@/src/hub/text";
import { useHubToday } from "@/src/hub/today";
import { Btn, Empty, HubHeader, Tag, hubStyles } from "@/src/hub/ui";
import { colors, fonts, radius, spacing } from "@/src/theme";

export default function Drivers() {
  const t = useHubText();
  const router = useRouter();
  const { today, refresh } = useHubToday();
  const [q, setQ] = useState("");
  const [view, setView] = useState<"list" | "map">("list");
  const [refreshing, setRefreshing] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const [mapKey, setMapKey] = useState(0);        // bumped to load the map page afresh

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = today?.drivers ?? [];
    const hit = needle ? all.filter((d) => (d.name ?? "").toLowerCase().includes(needle) || (d.phone ?? "").includes(needle)) : all;
    // On duty first, then by name.
    return [...hit].sort((a, b) => Number(b.on_duty) - Number(a.on_duty) || (a.name ?? "").localeCompare(b.name ?? ""));
  }, [today, q]);

  const mapData = useMemo<MapData>(() => {
    const pins = (today?.drivers ?? [])
      .filter((d) => typeof d.lat === "number" && typeof d.lng === "number")
      .map((d) => ({
        id: d.driver_id, lat: d.lat as number, lng: d.lng as number,
        name: d.name ?? "—", line: doing(d, t), seen: seenText(d.seen_minutes, t), ...dotFor(d),
      }));
    const h = today?.hub;
    const hub = h && typeof h.lat === "number" && typeof h.lng === "number"
      ? { lat: h.lat, lng: h.lng, name: h.name ?? t.map_hub } : null;
    return { pins, hub };
  }, [today, t]);

  const labels = useMemo<MapLabels>(() => ({ open: t.map_open, hub: t.map_hub, fit: t.map_fit, failed: t.map_failed }), [t]);
  const openDriver = useCallback((id: string) => router.push(`/driver/${id}` as never), [router]);
  const onMapFailed = useCallback(() => setMapFailed(true), []);

  return (
    <SafeAreaView style={hubStyles.safe} edges={["top"]}>
      <HubHeader title={t.tab_drivers} />
      <View style={styles.switch}>
        {(["list", "map"] as const).map((v) => (
          <TouchableOpacity key={v} style={[styles.seg, view === v ? styles.segOn : null]} onPress={() => setView(v)} testID={`hub-drivers-${v}`}>
            <Text style={[styles.segText, view === v ? styles.segTextOn : null]}>{v === "list" ? t.view_list : t.view_map}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {view === "map" ? (
        <View style={{ flex: 1 }}>
          <Text style={styles.count} testID="hub-map-count">
            {!today ? t.loading : mapData.pins.length === 0 ? t.map_none : t.map_count(mapData.pins.length, today.drivers.length)}
          </Text>
          <View style={styles.map}>
            {mapFailed ? (
              <View style={styles.failed}>
                <Text style={styles.failedText} testID="hub-map-failed">{t.map_failed}</Text>
                <Btn label={t.map_retry} small kind="ghost" onPress={() => { setMapFailed(false); setMapKey((k) => k + 1); }} testID="hub-map-retry" />
              </View>
            ) : (
              <HubMap key={mapKey} data={mapData} labels={labels} onOpen={openDriver} onFailed={onMapFailed} />
            )}
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
          <TextInput
            testID="hub-driver-search"
            value={q}
            onChangeText={setQ}
            placeholder={t.search}
            placeholderTextColor={colors.muted}
            style={[hubStyles.input, { marginBottom: spacing.md }]}
          />
          {!today ? <Empty>{t.loading}</Empty> : (
            <View style={hubStyles.card} testID="hub-driver-list">
              {list.length === 0 ? <Empty>{t.no_drivers}</Empty> : list.map((d, i) => {
                const tag = tagFor(d, t);
                return (
                  <TouchableOpacity
                    key={d.driver_id}
                    style={[hubStyles.row, i === 0 ? hubStyles.rowFirst : null]}
                    onPress={() => openDriver(d.driver_id)}
                    testID={`hub-driver-${d.driver_id}`}
                  >
                    <View style={{ flex: 1 }}>
                      <Text style={hubStyles.name}>{d.name ?? "—"}</Text>
                      <Text style={hubStyles.sub}>{doing(d, t)}</Text>
                      {d.you_owe > 0 ? (
                        <Text style={d.over_limit ? hubStyles.subAlert : hubStyles.sub}>
                          {t.owes(formatINR(d.you_owe))}{d.over_limit ? ` · ${t.over_limit}` : ""}
                        </Text>
                      ) : null}
                    </View>
                    <Tag tone={tag.tone}>{tag.label}</Tag>
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
  switch: {
    flexDirection: "row", marginHorizontal: spacing.md, marginTop: spacing.sm, padding: 3,
    backgroundColor: colors.card, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line,
  },
  seg: { flex: 1, alignItems: "center", paddingVertical: 8, borderRadius: radius.md - 2 },
  segOn: { backgroundColor: colors.brand },
  segText: { fontFamily: fonts.uiBold, fontSize: 14, color: colors.muted },
  segTextOn: { color: colors.onBrand },
  count: { fontFamily: fonts.ui, fontSize: 12, color: colors.muted, marginHorizontal: spacing.md, marginTop: spacing.sm, marginBottom: 6 },
  map: { flex: 1, marginHorizontal: spacing.md, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, overflow: "hidden", backgroundColor: colors.paper },
  failed: { flex: 1, alignItems: "center", justifyContent: "center", padding: spacing.lg, gap: spacing.md },
  failedText: { fontFamily: fonts.ui, fontSize: 14, color: colors.muted, textAlign: "center" },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md, rowGap: 4, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontFamily: fonts.ui, fontSize: 11, color: colors.muted },
});
