// Cars — every car in the hub, who drives it by day and by night, when it
// last changed hands and when it was last inspected. Tap a car for its page
// (shift change, inspection, service history); "+ Add car" adds one.
import React, { useCallback, useRef, useState } from "react";
import { RefreshControl, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";

import { formatIST, formatISTDate } from "@/src/i18n";
import { hubApi, useHubSession } from "@/src/hub/session";
import { useHubText } from "@/src/hub/text";
import { CarsData } from "@/src/hub/cars";
import { AddCarSheet } from "@/src/hub/sheets";
import { Btn, Empty, HubHeader, Tag, hubStyles } from "@/src/hub/ui";

export default function Cars() {
  const t = useHubText();
  const router = useRouter();
  const { session } = useHubSession();
  const hubId = session?.hubId;
  const [data, setData] = useState<CarsData | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  return (
    <SafeAreaView style={hubStyles.safe} edges={["top"]}>
      <HubHeader title={t.tab_cars} right={<Btn label={t.car_add} small onPress={() => setAdding(true)} testID="hub-add-car" />} />
      <ScrollView contentContainerStyle={hubStyles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {msg ? <Text style={hubStyles.done} testID="hub-cars-msg">{msg}</Text> : null}
        {!data ? <Empty>{t.loading}</Empty> : (
          <View style={hubStyles.card} testID="hub-car-list">
            {data.cars.length === 0 ? <Empty>{t.cars_none}</Empty> : data.cars.map((c, i) => (
              <TouchableOpacity key={c.id} style={[hubStyles.row, i === 0 ? hubStyles.rowFirst : null]}
                onPress={() => router.push(`/car/${c.id}` as never)} testID={`hub-car-${c.id}`}>
                <View style={{ flex: 1 }}>
                  <Text style={hubStyles.name}>{c.number ?? "—"}</Text>
                  <Text style={hubStyles.sub}>
                    {t.day_short}: {c.day_driver?.name ?? t.none} · {t.night_short}: {c.night_driver?.name ?? t.none}
                  </Text>
                  <Text style={hubStyles.sub}>
                    {c.last_handover ? t.last_change(formatIST(c.last_handover.created_at)) : t.never_changed}
                    {c.current_soc != null ? ` · ${c.current_soc}%` : ""}
                  </Text>
                  <Text style={hubStyles.sub}>
                    {c.last_check ? t.car_last_inspected(formatISTDate(c.last_check.created_at)) : t.car_never_inspected}
                  </Text>
                </View>
                {c.last_check?.attention.length
                  ? <Tag tone="warn">{t.check_n_attention(c.last_check.attention.length)}</Tag>
                  : c.last_handover?.damage_note ? <Tag tone="warn">{t.damage_tag}</Tag> : null}
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>
      <AddCarSheet visible={adding} hubId={hubId ?? ""} onClose={() => setAdding(false)} onDone={(m) => {
        setAdding(false);
        if (msgTimer.current) clearTimeout(msgTimer.current);
        setMsg(m);
        msgTimer.current = setTimeout(() => setMsg(null), 4000);
        load();
      }} />
    </SafeAreaView>
  );
}
