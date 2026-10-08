// Drivers — everyone in the hub with where they stand right now. Tap one for
// their page (duty, activity, cash, shift time, messages).
import React, { useCallback, useMemo, useState } from "react";
import { RefreshControl, ScrollView, Text, TextInput, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { formatINR } from "@/src/i18n";
import { doing, tagFor } from "@/src/hub/status";
import { useHubText } from "@/src/hub/text";
import { useHubToday } from "@/src/hub/today";
import { Empty, HubHeader, Tag, hubStyles } from "@/src/hub/ui";
import { colors, spacing } from "@/src/theme";

export default function Drivers() {
  const t = useHubText();
  const router = useRouter();
  const { today, refresh } = useHubToday();
  const [q, setQ] = useState("");
  const [refreshing, setRefreshing] = useState(false);

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

  return (
    <SafeAreaView style={hubStyles.safe} edges={["top"]}>
      <HubHeader title={t.tab_drivers} />
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
                  onPress={() => router.push(`/driver/${d.driver_id}` as never)}
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
    </SafeAreaView>
  );
}
