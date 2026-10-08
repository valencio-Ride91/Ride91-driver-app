import { Tabs } from "expo-router";
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useHubText } from "@/src/hub/text";
import { useHubToday } from "@/src/hub/today";
import { colors, fonts } from "@/src/theme";

// A dot, the tab's name, and a count when something there is waiting.
const TabIcon: React.FC<{ label: string; focused: boolean; count?: number }> = ({ label, focused, count }) => (
  <View style={styles.iconWrap}>
    <View style={[styles.dot, { backgroundColor: focused ? colors.brand : colors.line }]} />
    <Text style={[styles.iconLabel, { color: focused ? colors.ink : colors.muted }]} numberOfLines={1}>{label}</Text>
    {count ? (
      <View style={styles.badge}><Text style={styles.badgeText}>{count > 9 ? "9+" : count}</Text></View>
    ) : null}
  </View>
);

export default function HubTabs() {
  const t = useHubText();
  const { today } = useHubToday();
  const insets = useSafeAreaInsets();
  const c = today?.counts;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarShowLabel: false,
        tabBarStyle: { backgroundColor: colors.card, borderTopColor: colors.line, height: 60 + insets.bottom, paddingTop: 6, paddingBottom: insets.bottom },
      }}
    >
      <Tabs.Screen name="index" options={{ tabBarIcon: ({ focused }) => <TabIcon label={t.tab_today} focused={focused} count={today?.attention.length} />, tabBarButtonTestID: "hub-tab-today" }} />
      <Tabs.Screen name="drivers" options={{ tabBarIcon: ({ focused }) => <TabIcon label={t.tab_drivers} focused={focused} />, tabBarButtonTestID: "hub-tab-drivers" }} />
      <Tabs.Screen name="cars" options={{ tabBarIcon: ({ focused }) => <TabIcon label={t.tab_cars} focused={focused} />, tabBarButtonTestID: "hub-tab-cars" }} />
      <Tabs.Screen name="money" options={{ tabBarIcon: ({ focused }) => <TabIcon label={t.tab_money} focused={focused} count={c?.withdrawals_pending} />, tabBarButtonTestID: "hub-tab-money" }} />
      <Tabs.Screen name="inbox" options={{ tabBarIcon: ({ focused }) => <TabIcon label={t.tab_inbox} focused={focused} count={(c?.unread_messages ?? 0) + (c?.requests_pending ?? 0)} />, tabBarButtonTestID: "hub-tab-inbox" }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  iconWrap: { alignItems: "center", gap: 4, width: 66 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  iconLabel: { fontFamily: fonts.uiMed, fontSize: 11 },
  badge: { position: "absolute", top: -4, right: 4, minWidth: 16, height: 16, borderRadius: 8, backgroundColor: colors.alert, alignItems: "center", justifyContent: "center", paddingHorizontal: 3 },
  badgeText: { fontFamily: fonts.uiBold, fontSize: 9, color: colors.white },
});
