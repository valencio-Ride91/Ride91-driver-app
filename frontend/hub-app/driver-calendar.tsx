// One driver's month, day by day: each day's work against the QR payments and
// cash handed in for it. The same calendar the driver sees in their app.
import React, { useCallback, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";

import { DayCalendar, CalendarMonth } from "@/src/components/DayCalendar";
import { useCalendarText } from "@/src/i18n/calendar";
import { hubApi } from "@/src/hub/session";
import { Icon } from "@/src/hub/kit";
import { hubStyles } from "@/src/hub/ui";
import { colors, fonts, spacing } from "@/src/theme";

export default function DriverCalendar() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const ct = useCalendarText();
  const router = useRouter();
  const [key, setKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    (m: string) => hubApi.get<CalendarMonth>(`/admin/drivers/${encodeURIComponent(id ?? "")}/calendar${m ? `?month=${m}` : ""}`),
    [id],
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setKey((k) => k + 1);
    setTimeout(() => setRefreshing(false), 600);
  }, []);

  return (
    <SafeAreaView style={hubStyles.safe} edges={["top", "bottom"]}>
      <View style={styles.bar}>
        <TouchableOpacity
          onPress={() => (router.canGoBack() ? router.back() : router.replace(`/driver/${id}` as never))}
          style={styles.back}
          testID="hub-calendar-back"
        >
          <Icon name="chevron-back" size={26} color={colors.ink} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.title} numberOfLines={1}>{ct.title}</Text>
          {name ? <Text style={styles.sub} numberOfLines={1}>{name}</Text> : null}
        </View>
      </View>
      <ScrollView contentContainerStyle={hubStyles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        <DayCalendar load={load} refreshKey={key} testID="hub-calendar" />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.line },
  back: { paddingHorizontal: 8, paddingVertical: 2 },
  title: { fontFamily: fonts.display, fontSize: 22, color: colors.ink },
  sub: { fontFamily: fonts.uiMed, fontSize: 13, color: colors.muted },
});
