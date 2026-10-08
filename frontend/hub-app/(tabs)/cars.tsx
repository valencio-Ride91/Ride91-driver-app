// Cars — every car in the hub, who drives it by day and by night, and when it
// last changed hands. Tap a car to record a shift change.
import React, { useCallback, useState } from "react";
import { RefreshControl, ScrollView, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";

import { formatIST } from "@/src/i18n";
import { hubApi, useHubSession } from "@/src/hub/session";
import { useHubText } from "@/src/hub/text";
import { CarsData } from "@/src/hub/cars";
import { Empty, HubHeader, Tag, hubStyles } from "@/src/hub/ui";

export default function Cars() {
  const t = useHubText();
  const router = useRouter();
  const { session } = useHubSession();
  const hubId = session?.hubId;
  const [data, setData] = useState<CarsData | null>(null);
  const [refreshing, setRefreshing] = useState(false);

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
      <HubHeader title={t.tab_cars} />
      <ScrollView contentContainerStyle={hubStyles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        {!data ? <Empty>{t.loading}</Empty> : (
          <View style={hubStyles.card} testID="hub-car-list">
            {data.cars.length === 0 ? <Empty>{t.cars_none}</Empty> : data.cars.map((c, i) => (
              <TouchableOpacity key={c.id} style={[hubStyles.row, i === 0 ? hubStyles.rowFirst : null]}
                onPress={() => router.push(`/handover/${c.id}` as never)} testID={`hub-car-${c.id}`}>
                <View style={{ flex: 1 }}>
                  <Text style={hubStyles.name}>{c.number ?? "—"}</Text>
                  <Text style={hubStyles.sub}>
                    {t.day_short}: {c.day_driver?.name ?? t.none} · {t.night_short}: {c.night_driver?.name ?? t.none}
                  </Text>
                  <Text style={hubStyles.sub}>
                    {c.last_handover ? t.last_change(formatIST(c.last_handover.created_at)) : t.never_changed}
                    {c.current_soc != null ? ` · ${c.current_soc}%` : ""}
                  </Text>
                </View>
                {c.last_handover?.damage_note ? <Tag tone="warn">{t.damage_tag}</Tag> : null}
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
