// Day by day: the driver's own month on a calendar, each day's work against
// the QR payments and cash handed in for it (see DayCalendar).
import React, { useCallback, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { api } from "@/src/api";
import { DayCalendar, CalendarMonth } from "@/src/components/DayCalendar";
import { useI18n } from "@/src/i18n";
import { useCalendarText } from "@/src/i18n/calendar";
import { colors, fonts, spacing } from "@/src/theme";

export default function Calendar() {
  const { t } = useI18n();
  const ct = useCalendarText();
  const router = useRouter();
  const [key, setKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    (m: string) => api.get<CalendarMonth>(m ? `/money/calendar?month=${m}` : "/money/calendar"),
    [],
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setKey((k) => k + 1);
    setTimeout(() => setRefreshing(false), 600);
  }, []);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => (router.canGoBack() ? router.back() : router.replace("/(tabs)/money" as never))} testID="calendar-back" style={styles.back}>
          <Text style={styles.backText}>‹ {t.money}</Text>
        </TouchableOpacity>
        <Text style={styles.headerTitle}>{ct.title}</Text>
        <View style={styles.back} />
      </View>
      <ScrollView contentContainerStyle={styles.scroll} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}>
        <DayCalendar load={load} refreshKey={key} testID="driver-calendar" />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  back: { width: 80 },
  backText: { fontFamily: fonts.uiMed, fontSize: 15, color: colors.muted },
  headerTitle: { fontFamily: fonts.display, fontSize: 18, color: colors.ink },
  scroll: { padding: spacing.md, paddingBottom: 120 },
});
